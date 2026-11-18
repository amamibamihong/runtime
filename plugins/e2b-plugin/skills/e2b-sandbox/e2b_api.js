'use strict';
/**
 * E2B 能力层（唯一实现）。
 *
 * 本模块是插件内所有 E2B 能力的源头：CLI（e2b_ctl.js）与其它技能脚本
 * （executor / agent / playwright）都只调用这里，不各自重写连接、续租、执行逻辑。
 *
 * 为什么用 Node 而不是 Python 实现守护部分：
 *   Python 的守护线程受 GIL 与「信号只投递主线程」两条限制——纯 CPU 段落会把
 *   看门狗饿住，而心跳线程里又没法用 SIGALRM 做超时。Node 的事件循环里
 *   `setInterval` 不会被同进程的 I/O 阻塞（I/O 本身是异步的），续租与截止
 *   天然是独立时序，不需要另起线程，也就不存在共享客户端对象的竞态。
 *
 * 设计约束：
 *   1. 零 CLI 语义：不打 usage、不 process.exit、不解析 argv；失败一律抛异常。
 *   2. import 无副作用：不读配置、不改 process.env，直到显式调用。
 *   3. 租期永远显式：所有连接点必须显式传 timeoutMs，否则会用 SDK 内置默认。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const SKILL_DIR = __dirname;

// ==========================================
// 目录约定
// ==========================================

/** 按 XDG 约定解析用户级目录；不往安装目录里写任何东西。 */
function xdgDir(envKey, fallbackRel) {
  const explicit = process.env[envKey];
  if (explicit) return path.resolve(explicit.replace(/^~(?=$|\/)/, os.homedir()));
  const [xdgVar, xdgSub] = envKey.includes('CONFIG')
    ? ['XDG_CONFIG_HOME', '.config']
    : ['XDG_STATE_HOME', '.local/state'];
  const base = process.env[xdgVar]
    ? path.resolve(process.env[xdgVar])
    : path.join(os.homedir(), xdgSub);
  return path.join(base, fallbackRel);
}

/** 用户配置目录（含 API Key）。默认 `~/.config/e2b-plugin`。 */
function configDir() {
  return xdgDir('E2B_PLUGIN_CONFIG_DIR', 'e2b-plugin');
}

/** 运行时状态目录（会话文件、锁、守护进程日志）。默认 `~/.local/state/e2b-plugin`。 */
function stateDir() {
  return xdgDir('E2B_PLUGIN_STATE_DIR', 'e2b-plugin');
}

function configFile() {
  return path.join(configDir(), 'config.json');
}

/** 旧版本把 config.json 放在技能目录里；仍然读它，但不再往里写。 */
function legacyConfigFile() {
  return path.join(SKILL_DIR, 'config.json');
}

// ==========================================
// 常量
// ==========================================

const DEFAULTS = {
  api_url: process.env.E2B_API_URL || 'http://192.168.36.222:3000',
  sandbox_url: process.env.E2B_SANDBOX_URL || 'http://192.168.36.222:3002',
  default_template: 'claudecode',
  default_timeout_seconds: 300,
};

const DEFAULT_LEASE = 300;               // 秒
const DEFAULT_COMMAND_DEADLINE = 0;      // 前台（有人值守）不设硬截止
const DEFAULT_UNATTENDED_DEADLINE = 3600; // 后台/无人值守的失控兜底
const DEFAULT_REPORT_INTERVAL = 300;     // 静默进度报告间隔

const EXIT_STALLED = 124;         // 硬截止 / 显式判定卡死
const EXIT_LEASE_LOST = 125;      // 沙箱已被回收
const EXIT_IDLE_RECLAIMED = 126;  // 沙箱因空闲被回收

// ==========================================
// 异常
// ==========================================

class E2BError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

class DependencyError extends E2BError {}
class TemplateError extends E2BError {}

/** 沙箱已被回收（连续续租失败）。携带最后一次续租错误。 */
class LeaseLost extends E2BError {
  constructor(sandboxId, lastError) {
    const detail = lastError ? ` (last renewal error: ${lastError})` : '';
    super(`sandbox ${sandboxId} lease lost${detail}`);
    this.sandboxId = sandboxId;
    this.lastError = lastError;
  }
}

/** 沙箱内命令以非零码退出。退出码是正常结果，不是执行器故障。 */
class CommandFailed extends E2BError {
  constructor(exitCode, stdout = '', stderr = '') {
    super(`command exited with code ${exitCode}`);
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** 命令达到硬截止被终止，或连接超时。 */
class E2BTimeout extends E2BError {}

// ==========================================
// 配置
// ==========================================

function readJsonSync(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

class Config {
  constructor({ apiUrl, sandboxUrl, apiKey, template, lease, network, dnsServers, sources }) {
    this.apiUrl = apiUrl;
    this.sandboxUrl = sandboxUrl;
    this.apiKey = apiKey;
    this.template = template;
    this.lease = lease;
    // 原样保存 SDK `network` 选项（allowOut / denyOut / dnsServers / rules / egressProxy …），
    // 不在这里做任何改写；没配置就是 undefined，创建沙箱时整项不传。
    this.network = network;
    // 沙箱内 /etc/resolv.conf 的 nameserver 列表，沙箱创建后由 applyDnsServers 写入。
    // 与 network.dnsServers 是两件事：后者只决定防火墙放行哪个 DNS 的流量，
    // 不改 resolv.conf（见 api.gen.go 中 DnsServers 字段的注释）。
    this.dnsServers = Array.isArray(dnsServers) ? dnsServers : undefined;
    this.sources = sources || {};
  }

  /** 把配置写进环境变量，供 SDK 自己读取。只在需要连接时调用。 */
  applyToEnv() {
    process.env.E2B_API_URL = this.apiUrl;
    process.env.E2B_SANDBOX_URL = this.sandboxUrl;
    if (this.apiKey) process.env.E2B_API_KEY = this.apiKey;
    return this;
  }

  masked() {
    const key = this.apiKey || '';
    const shown = key.length > 12 ? `${key.slice(0, 8)}...${key.slice(-4)}` : (key ? '***' : '');
    return {
      api_url: this.apiUrl,
      sandbox_url: this.sandboxUrl,
      api_key: shown,
      default_template: this.template,
      default_timeout_seconds: this.lease,
      ...(this.network ? { network: this.network } : {}),
      ...(this.dnsServers ? { dns_servers: this.dnsServers } : {}),
      config_file: configFile(),
      sources: this.sources,
    };
  }
}

/**
 * 解析连接配置：环境变量 > config.json > 默认值。
 *
 * `extraFiles` 是高优先级配置文件列表，排在用户配置目录之前尝试——供其它
 * 技能读取自己的覆盖文件，同时仍能回落到 `~/.config/e2b-plugin/config.json`。
 * 本函数不修改 process.env，需要时由调用方显式 applyToEnv()。
 */
function loadConfig(extraFiles = []) {
  const candidates = [...extraFiles, configFile(), legacyConfigFile()];
  let cfg = {};
  let sourceFile = null;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const data = readJsonSync(candidate);
    if (data && Object.keys(data).length) {
      cfg = data;
      sourceFile = candidate;
      break;
    }
  }

  const pick = (envKey, cfgKey, dflt) => {
    if (process.env[envKey]) return [process.env[envKey], 'ENV'];
    if (cfg[cfgKey] !== undefined && cfg[cfgKey] !== null && cfg[cfgKey] !== '') {
      return [cfg[cfgKey], sourceFile || 'config.json'];
    }
    return [dflt, 'default'];
  };

  const [apiUrl, sApi] = pick('E2B_API_URL', 'api_url', DEFAULTS.api_url);
  const [sandboxUrl, sSbx] = pick('E2B_SANDBOX_URL', 'sandbox_url', DEFAULTS.sandbox_url);
  const [apiKey, sKey] = pick('E2B_API_KEY', 'api_key', '');
  const [template, sTpl] = pick('E2B_DEFAULT_TEMPLATE', 'default_template', DEFAULTS.default_template);
  const [leaseRaw, sLease] = pick('E2B_DEFAULT_TIMEOUT', 'default_timeout_seconds', DEFAULT_LEASE);
  const lease = Number.isFinite(Number(leaseRaw)) ? Number(leaseRaw) : DEFAULT_LEASE;

  // 出网规则整体作为一个 JSON 对象配置，字段名与官方 SDK `Sandbox.create({ network })`
  // 完全一致，这里不解析、不改写；没有配置时 network 为 undefined。
  const network = cfg.network && typeof cfg.network === 'object' && !Array.isArray(cfg.network)
    ? cfg.network
    : undefined;

  // 沙箱内 resolv.conf 的 nameserver 列表。单个字符串也接受。
  const dnsRaw = cfg.dns_servers;
  const dnsServers = Array.isArray(dnsRaw)
    ? dnsRaw.map(String).filter(Boolean)
    : (typeof dnsRaw === 'string' && dnsRaw.trim() ? [dnsRaw.trim()] : undefined);

  return new Config({
    apiUrl, sandboxUrl, apiKey, template, lease, network, dnsServers,
    sources: {
      api_url: sApi,
      sandbox_url: sSbx,
      api_key: sKey,
      default_template: sTpl,
      default_timeout_seconds: sLease,
      ...(network ? { network: sourceFile || 'config.json' } : {}),
      ...(dnsServers ? { dns_servers: sourceFile || 'config.json' } : {}),
    },
  });
}

/** 把部分字段合并写回 config.json，返回 { path, changed }。 */
function saveConfig(values) {
  const target = readJsonSync(
    fs.existsSync(configFile())
      ? configFile()
      : (fs.existsSync(legacyConfigFile()) ? legacyConfigFile() : configFile())
  );
  const changed = {};
  const mapping = {
    api_key: 'api_key',
    api_url: 'api_url',
    sandbox_url: 'sandbox_url',
    template: 'default_template',
    lease: 'default_timeout_seconds',
    network: 'network',
    dnsServers: 'dns_servers',
  };
  for (const [key, cfgKey] of Object.entries(mapping)) {
    if (values[key] === undefined || values[key] === null) continue;
    target[cfgKey] = values[key];
    changed[cfgKey] = values[key];
  }
  if (values.clear_template) {
    delete target.default_template;
    changed.default_template = null;
  }
  if (values.clear_network) {
    delete target.network;
    changed.network = null;
  }
  if (values.clear_dns_servers) {
    delete target.dns_servers;
    changed.dns_servers = null;
  }
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configFile(), `${JSON.stringify(target, null, 2)}\n`, 'utf8');
  try { fs.chmodSync(configFile(), 0o600); } catch { /* 存的是 API Key，权限失败不阻断 */ }
  return { path: configFile(), changed };
}

// ==========================================
// SDK 装载
// ==========================================

let _sdk = null;

/**
 * 运行时装在哪：优先按正常模块解析（NODE_PATH / 项目 node_modules），
 * 回落到 bootstrap 安装的私有目录 `~/.cache/e2b-plugin/node_modules`。
 */
function runtimeDirs() {
  const explicit = process.env.E2B_PLUGIN_NODE_MODULES;
  const dirs = [];
  if (explicit) dirs.push(path.resolve(explicit.replace(/^~(?=$|\/)/, os.homedir())));
  dirs.push(path.join(os.homedir(), '.cache', 'e2b-plugin', 'node_modules'));
  return dirs;
}

/** 延迟 require 并缓存 e2b SDK。缺失时抛 DependencyError，不退出进程。 */
function sdk() {
  if (!_sdk) {
    const failures = [];
    try {
      _sdk = require('e2b');
    } catch (e) {
      failures.push(e.message);
      for (const dir of runtimeDirs()) {
        try {
          _sdk = require(path.join(dir, 'e2b'));
          break;
        } catch (inner) {
          failures.push(`${dir}: ${inner.message}`);
        }
      }
      if (!_sdk) {
        throw new DependencyError(
          `e2b npm package is missing; run \`node ${path.join(__dirname, '..', '..', 'bootstrap.js')} install\`. ` +
          `Tried: ${failures.join(' | ')}`
        );
      }
    }
  }
  return _sdk;
}

function commandExitException() {
  return sdk().CommandExitError;
}

/** 秒 → 毫秒；0/undefined/null 表示不限。 */
function ms(seconds) {
  if (seconds === undefined || seconds === null) return 0;
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
}

function sdkOpts(cfg) {
  return { apiKey: cfg.apiKey, apiUrl: cfg.apiUrl, sandboxUrl: cfg.sandboxUrl };
}

// ==========================================
// 租期守护
// ==========================================

/** 续租周期：租期的 1/3，夹在 1~60 秒。 */
function heartbeatInterval(leaseSeconds) {
  return Math.max(1, Math.min(60, Math.floor(Number(leaseSeconds) / 3)));
}

/**
 * 长操作期间的租期守护。
 *
 * 沙箱租期是「最后活动时间 + timeout」，单次续租覆盖不了几十分钟的构建；
 * 这里周期续租，并在**连续 3 次失败**后判定租期丢失：
 *   - 设置 `.lost`，让正在阻塞的调用方有机会提前失败；
 *   - 调用 `onLost(this)` 回调，把「怎么报错、用什么退出码」交给调用方，
 *     本类不打印、不退出。
 *
 * 与 Python 版的区别：这里用 `setTimeout` 自调度而不是线程。事件循环里
 * 定时器不会被同进程的 I/O 阻塞，所以续租不会因为主流程在等命令而饿死；
 * 也不需要两个线程共享同一个客户端对象。
 */
class LeaseMonitor {
  static FAILURE_THRESHOLD = 3;

  /**
   * @param {object} opts
   * @param {object} [opts.sandbox]  已连接的沙箱实例
   * @param {string} [opts.sandboxId] 只给 id 时，每次续租都重新连接（连接即续租）
   * @param {number} [opts.lease]    租期秒数
   * @param {Function} [opts.onLost] 丢失回调
   * @param {number} [opts.interval] 续租周期秒数
   * @param {Config} [opts.config]
   */
  constructor({ sandbox, sandboxId, lease = DEFAULT_LEASE, onLost, interval, config } = {}) {
    if (!sandbox && !sandboxId) {
      throw new TypeError('LeaseMonitor needs either a sandbox or a sandboxId');
    }
    this.sandbox = sandbox || null;
    this.sandboxId = sandboxId || (sandbox && sandbox.sandboxId) || null;
    this.lease = Number(lease);
    this.interval = Number(interval || heartbeatInterval(this.lease)) * 1000;
    this.onLost = onLost || null;
    this.config = config || null;
    this.errors = 0;
    this.lastError = null;
    this.lost = false;
    this.stopped = false;
    this._timer = null;
    this._renewing = false;
  }

  _renew() {
    // 上一次续租还没回来就跳过本轮：避免失败调用堆积，把一次网络抖动
    // 放大成「连续 3 次失败」而误判租期丢失。
    if (this._renewing) return;
    this._renewing = true;
    const lease = this.lease;
    const job = this.sandbox
      ? this.sandbox.setTimeout(lease * 1000)
      : sdk().Sandbox.connect(this.sandboxId, {
        timeoutMs: lease * 1000,
        ...(this.config ? sdkOpts(this.config) : {}),
      });

    Promise.resolve(job)
      .then(() => {
        this.errors = 0;
      })
      .catch((e) => {
        this.errors += 1;
        this.lastError = `${e.name || 'Error'}: ${e.message}`;
        if (this.errors >= LeaseMonitor.FAILURE_THRESHOLD) {
          // 先置位再回调：回调自己出错也不能让调用方错过「租期已丢」
          this.lost = true;
          this.stop();
          if (this.onLost) {
            try {
              this.onLost(this);
            } catch (cbError) {
              this.lastError = `${this.lastError}; onLost raised ${cbError.name}: ${cbError.message}`;
            }
          }
        }
      })
      .finally(() => {
        this._renewing = false;
      });
  }

  start() {
    if (this._timer || this.stopped) return this;
    this._timer = setInterval(() => this._renew(), this.interval);
    // 守护不该拖住进程退出
    if (typeof this._timer.unref === 'function') this._timer.unref();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    return this;
  }
}

/** 给沙箱挂一个 LeaseMonitor（幂等，同一个沙箱只挂一个）。 */
function startMonitor(sandbox, lease, onLost) {
  if (sandbox._e2bLeaseMonitor) return sandbox._e2bLeaseMonitor;
  const monitor = new LeaseMonitor({ sandbox, lease, onLost }).start();
  try { sandbox._e2bLeaseMonitor = monitor; } catch { /* 冻结对象忽略 */ }
  return monitor;
}

/**
 * 连接并在整个操作期间续租，退出时停止守护。
 *
 * 这是「任务不因沙箱寿命被打断」的统一入口：**任何可能超过一个租期的操作**
 * （大文件传输、长构建、批量读写）都必须走这里，而不是裸 connect()。
 *
 * `preserve: true` 用于操作「派发后不管」的长寿沙箱：连接只延长、不缩短它
 * 当前的租期，续租也按延长后的值进行。
 *
 * @returns {Promise<{ sandbox: object, monitor: LeaseMonitor, stop: Function }>}
 */
async function session(sandboxId, { lease, config, onLost, preserve = false } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  const leaseSeconds = Number(lease || cfg.lease);
  const sandbox = preserve
    ? await connectPreserve(sandboxId, { lease: leaseSeconds, config: cfg })
    : await connectWithLease(sandboxId, leaseSeconds, cfg);
  // 守护必须按**实际生效**的租期续租：preserve 模式可能把租期放大了，
  // 仍按请求值续租会在第一次心跳时把它缩回去，等于把长任务提前砍掉。
  const effective = Number(sandbox._e2bLeaseSeconds || leaseSeconds);
  const monitor = startMonitor(sandbox, effective, onLost);
  return {
    sandbox,
    monitor,
    stop() { monitor.stop(); sandbox._e2bLeaseMonitor = undefined; },
  };
}

/** 显式带上租期连接。 */
async function connectWithLease(sandboxId, leaseSeconds, cfg) {
  const { Sandbox } = sdk();
  return Sandbox.connect(sandboxId, {
    timeoutMs: Math.max(1, Math.round(Number(leaseSeconds) * 1000)),
    ...(cfg ? sdkOpts(cfg) : {}),
  });
}

/**
 * 连接沙箱，但**只延长、不缩短**它当前的租期。
 *
 * 连接本身就是一次设租期：用默认的 300s 去看一眼「派发后不管」的沙箱，
 * 会把它从还剩几小时一刀砍到 5 分钟，等于把无人值守任务提前杀掉。
 * 所以查看/操作这类沙箱时先读到剩余租期，再按「取大」的值连接。
 */
async function connectPreserve(sandboxId, { lease, config } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  const target = Number(lease || cfg.lease);
  let current = null;
  try {
    const info = await getInfo(sandboxId, { config: cfg });
    if (info && info.endAt) current = Math.round((new Date(info.endAt).getTime() - Date.now()) / 1000);
  } catch {
    // 读不到剩余租期（沙箱已暂停/不存在）就按请求值连，让调用方拿到真实错误
  }
  const effective = current && current > target ? current : target;
  const sandbox = await connectWithLease(sandboxId, effective, cfg);
  // 租期是最后活动时间 + timeout，连接这一刻就把有效值钉住，
  // 让续租守护沿用同一个值（否则下一次心跳会把放大的租期缩回去）。
  sandbox._e2bLeaseSeconds = effective;
  return sandbox;
}

/** 显式刷新一次租期。返回是否成功。 */
async function renew(sandbox, leaseSeconds) {
  try {
    await sandbox.setTimeout(Math.max(1, Math.round(Number(leaseSeconds) * 1000)));
    return true;
  } catch {
    return false;
  }
}

// ==========================================
// 沙箱生命周期
// ==========================================

async function create({ template, lease, metadata, envs, network, mounts, dnsServers, lifecycle, config } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  const { Sandbox } = sdk();
  const opts = { timeoutMs: Math.round(Number(lease || cfg.lease) * 1000), ...sdkOpts(cfg) };
  if (metadata) opts.metadata = metadata;
  if (envs) opts.envs = envs;
  // 到期行为：不传就沿用控制面默认（当前是 kill）。
  // `pause` 到点把沙箱连同内存快照挂起，之后能 resume 回原状态，适合长任务。
  if (lifecycle) opts.lifecycle = lifecycle;
  // 显式传入优先；否则用配置里的 network；都没有就整项不传，沿用控制面默认策略。
  const effective = network !== undefined ? network : cfg.network;
  if (effective) opts.network = effective;
  const volumeMounts = mountsToSdk(mounts);
  if (volumeMounts) opts.volumeMounts = volumeMounts;
  const sandbox = await Sandbox.create(template || cfg.template, opts);
  // 显式传入优先；否则用配置里的 dns_servers。
  await applyDnsServers(sandbox, dnsServers !== undefined ? dnsServers : cfg.dnsServers);
  return sandbox;
}

/**
 * 把配置里的 DNS 服务器写进沙箱的 /etc/resolv.conf。
 *
 * 模板里这个文件是构建时写死的 `nameserver 8.8.8.8`（rootfs/files/resolv.conf.tpl），
 * 构建收尾会 `chattr -i` 解锁，所以运行时可以覆盖，不必重建模板。
 * `network.dnsServers` 做不到这件事：它只让防火墙放行该 DNS 的流量。
 *
 * 写入失败不阻断创建——沙箱照常可用，只是仍用模板自带的 nameserver。
 */
async function applyDnsServers(sandbox, servers) {
  const list = (servers || []).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return false;
  const body = list.map((s) => `nameserver ${s}`).join('\n');
  const script = [
    'f=/etc/resolv.conf',
    'chattr -i "$f" 2>/dev/null || true',
    'printf \'%s\\n\' "$RESOLV_BODY" > "$f"',
  ].join('; ');
  try {
    const result = await run(sandbox, script, {
      user: 'root',
      envs: { RESOLV_BODY: body },
      deadline: 30,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** 在线修改出网规则。SDK 语义是整组替换：没传的字段会被清空。 */
async function updateNetwork(sandboxId, network, { config } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  const { Sandbox } = sdk();
  return Sandbox.updateNetwork(sandboxId, network, sdkOpts(cfg));
}

async function connect(sandboxId, { lease, config } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  return connectWithLease(sandboxId, Number(lease || cfg.lease), cfg);
}

async function kill(sandboxId, { config } = {}) {
  // 不连接——connect 会续租、还可能唤醒已暂停的沙箱
  const cfg = (config || loadConfig()).applyToEnv();
  const { Sandbox } = sdk();
  return Sandbox.kill(sandboxId, sdkOpts(cfg));
}

async function pause(sandboxId, { filesystemOnly = false, config } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  const { Sandbox } = sdk();
  const opts = sdkOpts(cfg);
  // 只存磁盘：跳过内存导出，快得多、快照小得多，但 resume 会冷启动。
  if (filesystemOnly) opts.mode = 'filesystem';
  return Sandbox.pause(sandboxId, opts);
}

/** 恢复暂停的沙箱：SDK 没有独立 resume，connect 会唤醒并续租。 */
async function resume(sandboxId, { lease, config } = {}) {
  return connect(sandboxId, { lease, config });
}

async function getInfo(sandboxId, { config } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  const { Sandbox } = sdk();
  return Sandbox.getInfo(sandboxId, sdkOpts(cfg));
}

/** 沙箱剩余租期秒数；查不到返回 null（查询失败不等于沙箱没了）。 */
async function remainingLease(sandbox) {
  try {
    const info = await sandbox.getInfo();
    if (!info || !info.endAt) return null;
    return Math.round((new Date(info.endAt).getTime() - Date.now()) / 1000);
  } catch {
    return null;
  }
}

async function metrics(sandboxId, { start, end, lease, config } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  const { Sandbox } = sdk();
  const opts = { ...sdkOpts(cfg) };
  if (start) opts.start = start instanceof Date ? start : new Date(start);
  if (end) opts.end = end instanceof Date ? end : new Date(end);
  return Sandbox.getMetrics(sandboxId, opts);
}

/**
 * 列出沙箱，自动翻页。
 * `allStates=false` 时只列运行中的；SDK 分页器一次只返回一页，这里循环到底。
 */
async function listSandboxes({ allStates = false, limit, config } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  const { Sandbox } = sdk();
  const opts = { ...sdkOpts(cfg) };
  if (!allStates) opts.query = { state: ['running'] };
  if (limit) opts.limit = limit;

  const paginator = Sandbox.list(opts);
  const items = [];
  while (paginator.hasNext) {
    const page = await paginator.nextItems();
    if (!page || !page.length) break;
    items.push(...page);
  }
  return items;
}

/**
 * 读取沙箱结构化日志。
 * JS SDK 没有导出日志端点，直接打 REST；与模板接口同样用裸 HTTP，
 * 私有化部署的字段命名与生成客户端未必一致。
 */
async function logs(sandboxId, { start, limit = 1000, config } = {}) {
  const cfg = config || loadConfig();
  const url = new URL(`/sandboxes/${encodeURIComponent(sandboxId)}/logs`, cfg.apiUrl.replace(/\/$/, ''));
  url.searchParams.set('limit', String(limit));
  if (start !== undefined && start !== null) url.searchParams.set('start', String(Math.trunc(start)));

  const res = await fetch(url, { headers: { 'X-API-KEY': cfg.apiKey, Accept: 'application/json' } });
  if (!res.ok) throw new E2BError(`failed to fetch logs for ${sandboxId}: HTTP ${res.status}`);
  return res.json();
}

// ==========================================
// 持久卷（Volume）
// ==========================================
//
// 卷是团队级的持久存储：内容独立于沙箱存在，沙箱销毁后仍在。
// 卷通过挂载路径进入沙箱（`create({ mounts: [{ name, path }] })`），
// 也可以不挂沙箱、由 CLI 直接读写（走 volume-content API）。
//
// 前提条件（都属于部署侧，不是本模块能决定的）：
//   - API 的 `VOLUME_TOKEN_ENABLED` 与 JWT 签发参数必须配置，否则创建卷返回 501；
//   - LaunchDarkly `can-use-persistent-volumes` 需对该团队开启；
//   - orchestrator 需配置 `PERSISTENT_VOLUME_MOUNTS`；
//   - 模板的 envd 版本需支持卷挂载。

const VOLUME_ROOT = '/';

/** 校验卷名。服务端也校验，这里提前拦一次，少一次往返。 */
function validateVolumeName(name) {
  const s = String(name === undefined || name === null ? '' : name);
  if (!s) throw new E2BError('volume name is required');
  // 与服务端 `validVolumeNameRegex` 同口径：^[a-zA-Z0-9_-]+$
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new E2BError(
      `invalid volume name '${s}': use letters, digits, '_' or '-' (the server rejects anything else)`
    );
  }
  return s;
}

function volumeOpts(cfg) {
  return sdkOpts(cfg);
}

/**
 * 把 name / id 统一解析成 Volume 实例。
 *
 * 卷的 ID 不是 UUID（服务端生成），无法用格式区分 name 与 id，
 * 所以先按名字在团队卷列表里找，找不到再当成 ID 去 getInfo。
 */
async function resolveVolume(identifier, { config } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  const { Volume } = sdk();
  const key = String(identifier === undefined || identifier === null ? '' : identifier).trim();
  if (!key) throw new E2BError('volume identifier is required');

  let list;
  try {
    list = await Volume.list(volumeOpts(cfg));
  } catch (e) {
    throw new E2BError(`failed to list volumes: ${e.message}`, { cause: e });
  }
  const byName = list.find((v) => v.name === key);
  if (byName) {
    return Volume.connect(byName.volumeId, volumeOpts(cfg));
  }
  // 名字没命中：可能是 ID。getInfo 对不存在的卷抛 VolumeNotFoundError。
  try {
    return await Volume.connect(key, volumeOpts(cfg));
  } catch (e) {
    throw new E2BError(`volume '${key}' not found (not a team volume name, and getInfo failed: ${e.message})`, { cause: e });
  }
}

async function volumeCreate(name, { config } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  const { Volume } = sdk();
  const clean = validateVolumeName(name);
  try {
    const vol = await Volume.create(clean, volumeOpts(cfg));
    return { volume_id: vol.volumeId, name: vol.name };
  } catch (e) {
    // 501 是部署侧没开卷签发，不是调用方式错了——把该改哪个开关写清楚
    if (/content token signing is not supported|not implemented|501/i.test(e.message || '') ||
        /503|not implemented/i.test(String(e.statusCode || ''))) {
      throw new E2BError(
        `${e.message} — volumes need the API's VOLUME_TOKEN_ENABLED plus the JWT signing vars ` +
        '(VOLUME_TOKEN_ISSUER / SIGNING_METHOD / SIGNING_KEY / SIGNING_KEY_NAME), the LaunchDarkly ' +
        'flag can-use-persistent-volumes, and orchestrator PERSISTENT_VOLUME_MOUNTS.',
        { cause: e }
      );
    }
    throw new E2BError(e.message, { cause: e });
  }
}

async function volumeList({ config } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  const { Volume } = sdk();
  try {
    const list = await Volume.list(volumeOpts(cfg));
    return list.map((v) => ({ volume_id: v.volumeId, name: v.name }));
  } catch (e) {
    throw new E2BError(`failed to list volumes: ${e.message}`, { cause: e });
  }
}

async function volumeGet(identifier, { config } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  const vol = await resolveVolume(identifier, { config: cfg });
  // token 是访问内容 API 的凭证，不回显
  return { volume_id: vol.volumeId, name: vol.name };
}

async function volumeDestroy(identifier, { config } = {}) {
  const cfg = (config || loadConfig()).applyToEnv();
  const vol = await resolveVolume(identifier, { config: cfg });
  const { Volume } = sdk();
  try {
    const ok = await Volume.destroy(vol.volumeId, volumeOpts(cfg));
    return { volume_id: vol.volumeId, destroyed: Boolean(ok) };
  } catch (e) {
    throw new E2BError(`failed to destroy volume '${identifier}': ${e.message}`, { cause: e });
  }
}

async function volumeLs(identifier, dirPath, { depth = 1, config } = {}) {  const vol = await resolveVolume(identifier, { config });
  const p = dirPath || VOLUME_ROOT;
  try {
    const entries = await vol.list(p, { depth: Number(depth) || 1 });
    return entries.map((e) => ({
      path: e.path,
      name: e.name,
      type: e.type,
      size: e.size,
      mode: e.mode,
      target: e.target,
      mtime: e.mtime instanceof Date ? e.mtime.toISOString() : e.mtime,
    }));
  } catch (e) {
    throw new E2BError(`failed to list '${p}' in volume '${identifier}': ${e.message}`, { cause: e });
  }
}

async function volumeStat(identifier, volumePath, { config } = {}) {
  const vol = await resolveVolume(identifier, { config });
  try {
    const e = await vol.getInfo(volumePath);
    return {
      path: e.path, name: e.name, type: e.type, size: e.size, mode: e.mode,
      mtime: e.mtime instanceof Date ? e.mtime.toISOString() : e.mtime,
    };
  } catch (err) {
    throw new E2BError(`failed to stat '${volumePath}' in volume '${identifier}': ${err.message}`, { cause: err });
  }
}

async function volumeRead(identifier, volumePath, { config } = {}) {
  const vol = await resolveVolume(identifier, { config });
  try {
    return await vol.readFile(volumePath, { format: 'text' });
  } catch (e) {
    throw new E2BError(`failed to read '${volumePath}' from volume '${identifier}': ${e.message}`, { cause: e });
  }
}

async function volumeWrite(identifier, volumePath, data, { force = true, config } = {}) {
  const vol = await resolveVolume(identifier, { config });
  try {
    const stat = await vol.writeFile(volumePath, data, { force: Boolean(force) });
    return { path: stat.path, size: stat.size };
  } catch (e) {
    throw new E2BError(`failed to write '${volumePath}' to volume '${identifier}': ${e.message}`, { cause: e });
  }
}

async function volumeMkdir(identifier, volumePath, { config } = {}) {
  const vol = await resolveVolume(identifier, { config });
  try {
    const stat = await vol.makeDir(volumePath, { force: true });
    return { path: stat.path };
  } catch (e) {
    throw new E2BError(`failed to create '${volumePath}' in volume '${identifier}': ${e.message}`, { cause: e });
  }
}

async function volumeRemove(identifier, volumePath, { config } = {}) {
  const vol = await resolveVolume(identifier, { config });
  try {
    await vol.remove(volumePath);
    return true;
  } catch (e) {
    throw new E2BError(`failed to remove '${volumePath}' from volume '${identifier}': ${e.message}`, { cause: e });
  }
}

/**
 * 解析 `name:/mount/path` 形式的挂载参数。
 *
 * 只切成两段：卷名里不允许出现 `:`，路径必须以 `/` 开头，因此第一个 `:` 就是分隔符。
 * 结构合法性（绝对路径、不含 . / ..、同一路径不重复）以服务端校验为准，
 * 这里只做能让错误更早暴露的检查。
 */
function parseMount(spec) {
  const raw = String(spec === undefined || spec === null ? '' : spec).trim();
  const i = raw.indexOf(':');
  if (i <= 0) {
    throw new E2BError(`invalid mount '${raw}': expected <volume-name>:<absolute-path>, e.g. work:/mnt/data`);
  }
  const name = validateVolumeName(raw.slice(0, i));
  const mountPath = raw.slice(i + 1);
  if (!mountPath.startsWith('/')) {
    throw new E2BError(`invalid mount path '${mountPath}': must be absolute`);
  }
  return { name, path: mountPath };
}

/** 把 [{ name, path }] 转成 SDK 的 `volumeMounts`（路径 → 卷名）。 */
function mountsToSdk(mounts) {
  if (!mounts || !mounts.length) return undefined;
  const out = {};
  for (const m of mounts) {
    if (out[m.path]) throw new E2BError(`duplicate mount path '${m.path}'`);
    out[m.path] = m.name;
  }
  return out;
}

// ==========================================
// 命令执行
// ==========================================

function shellQuote(value) {
  const s = String(value);
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 包装成登录 shell 执行，兼容 bash 与仅有 sh 的极简镜像。
 *
 * 传入 `exitFile` 时不用 `exec`：命令内部 `exit N` 之后外层仍能捕获 `$?`
 * 写进文件，后台任务才不会永远停在「运行中」。
 */
function shellWrap(command, exitFile) {
  const quoted = shellQuote(command);
  if (exitFile) {
    return (
      `if command -v bash >/dev/null 2>&1; then bash -lc ${quoted}; else sh -lc ${quoted}; fi; ` +
      `echo $? > ${shellQuote(exitFile)}`
    );
  }
  return `if command -v bash >/dev/null 2>&1; then exec bash -lc ${quoted}; else exec sh -lc ${quoted}; fi`;
}

function commandOpts({ cwd, user, envs, deadline, onStdout, onStderr, signal, retainOutput } = {}) {
  const opts = {};
  if (cwd) opts.cwd = cwd;
  if (user) opts.user = user;
  opts.envs = envs || {};
  // timeoutMs: 0 = 不限（已实测：命令照常跑完）
  opts.timeoutMs = ms(deadline);
  if (onStdout) opts.onStdout = onStdout;
  if (onStderr) opts.onStderr = onStderr;
  if (signal) opts.signal = signal;
  // 只靠回调透传的场景（执行器）关掉内存累积，否则长时间大输出会把本地内存吃光
  if (retainOutput === false) opts.retainOutput = false;
  return opts;
}

/**
 * 以 background 方式启动命令，返回 SDK 句柄。
 * 给需要自行等待、流式接收输出、或读取 pid 的调用方（如执行器的静默观察）；
 * 只是「跑完拿结果」的场景请直接用 run()。
 */
async function startCommand(sandbox, command, opts = {}) {
  return sandbox.commands.run(command, { background: true, ...commandOpts(opts) });
}

// ==========================================
// 纯后端任务（派发后不再管）
// ==========================================

const DETACHED_DIR = '/tmp/e2b-detach';

/**
 * 解析 `90` / `90s` / `15m` / `2h` / `1d`，也接受 `1h30m` 这类组合。
 * 返回秒数；无法解析或非正数返回 null。
 */
function parseDuration(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim().toLowerCase().replace(/\s+/g, '');
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    return n > 0 ? Math.round(n) : null;
  }
  if (!/^(\d+(?:\.\d+)?[smhd])+$/.test(raw)) return null;
  const units = { s: 1, m: 60, h: 3600, d: 86400 };
  let total = 0;
  for (const m of raw.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) total += Number(m[1]) * units[m[2]];
  return total > 0 ? Math.round(total) : null;
}

/**
 * 纯后端任务的租期：调用方声明的期望时长 + **按比例**计算的余量。
 *
 * 这里刻意没有放之四海的固定值——固定值对短任务太长（白计费），
 * 对长任务太短（跑到一半被回收）。余量取期望时长的 20%，夹在 1~10 分钟，
 * 只覆盖启动开销与收尾，不改变任务本身需要多久的判断。
 */
function leaseForDuration(seconds) {
  const expected = Math.max(1, Math.round(Number(seconds) || 0));
  const cushion = Math.min(600, Math.max(60, Math.round(expected * 0.2)));
  return expected + cushion;
}

/**
 * 在沙箱里拉起一个与本地连接解耦的进程：本地退出后它继续跑，
 * 直到沙箱租期到期被整体回收。不等待、不轮询、不续租——这正是
 * 「启动完就不管了」的语义，寿命完全由租期决定。
 *
 * 退出码写到 `exitPath`，只为事后可选地查一眼，不影响派发本身。
 * 返回 { name, pid, scriptPath, logPath, exitPath }。
 */
async function detach(sandbox, command, {
  cwd, user, envs, name, logPath, exitPath, deadline = 60,
} = {}) {
  const jobName = String(name || `job-${Date.now()}`).replace(/[^A-Za-z0-9_.-]/g, '_') || `job-${Date.now()}`;
  const scriptPath = `${DETACHED_DIR}/${jobName}.sh`;
  const log = logPath || `${DETACHED_DIR}/${jobName}.log`;
  const exit = exitPath || `${DETACHED_DIR}/${jobName}.exit`;

  // 命令写成脚本再执行：绕过 `sh -c` 的多层引号，也让本地断开后
  // 进程拥有独立的会话（setsid），不会随 envd 的连接收尾被带走。
  const lines = [
    '#!/bin/sh',
    `cd ${shellQuote(cwd || '/home/user')} || exit 1`,
    `if command -v bash >/dev/null 2>&1; then bash -lc ${shellQuote(command)}; else sh -lc ${shellQuote(command)}; fi`,
    `echo $? > ${shellQuote(exit)}`,
  ];

  const dirs = [path.posix.dirname(scriptPath), path.posix.dirname(log), path.posix.dirname(exit)];
  await ensureDirs(sandbox, dirs);
  await writeFile(sandbox, scriptPath, `${lines.join('\n')}\n`);
  const chmod = await run(sandbox, `chmod +x ${shellQuote(scriptPath)}`, { deadline: 30 });
  if (chmod.exitCode !== 0) throw new E2BError(`failed to prepare detached script: ${chmod.stderr || chmod.stdout}`);

  const launcher = (
    `rm -f ${shellQuote(exit)} ${shellQuote(log)}; ` +
    'if command -v setsid >/dev/null 2>&1; then ' +
    `setsid ${shellQuote(scriptPath)} > ${shellQuote(log)} 2>&1 < /dev/null & ` +
    'else ' +
    `nohup ${shellQuote(scriptPath)} > ${shellQuote(log)} 2>&1 < /dev/null & ` +
    'fi; echo $!'
  );
  const result = await run(sandbox, launcher, { envs: envs || {}, user, deadline });
  const pid = (result.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  if (!/^\d+$/.test(pid)) {
    throw new E2BError(`failed to start detached process: ${result.stderr || result.stdout}`);
  }
  return { name: jobName, pid, scriptPath, logPath: log, exitPath: exit };
}

/**
 * 在沙箱内执行命令并返回 { exitCode, stdout, stderr }。
 *
 * - `deadline` 是**命令连接**的硬截止（秒），0/undefined 表示不限；
 *   它与沙箱租期是两个独立量，不要互相顶替。
 * - 非零退出码作为正常结果返回；`check=true` 时才抛 CommandFailed。
 * - 若传入的 `monitor` 已判定租期丢失，优先抛 LeaseLost 而不是底层网络错误。
 *
 * 注意：SDK 的 `timeoutMs` 是**客户端**超时，到点只会让本地调用失败，
 * 不会杀死沙箱内的进程。需要真正终止的调用方（如后台任务硬截止）
 * 必须显式发信号，见 executor 的 `_enforce_deadlines`。
 */
async function run(sandbox, command, {
  cwd, user, envs, deadline, onStdout, onStderr, check = false, monitor, signal,
} = {}) {
  const CommandExitError = commandExitException();
  try {
    const result = await sandbox.commands.run(
      command,
      commandOpts({ cwd, user, envs, deadline, onStdout, onStderr, signal })
    );
    const out = {
      exitCode: result.exitCode === undefined ? 0 : result.exitCode,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
    if (check && out.exitCode !== 0) {
      throw new CommandFailed(out.exitCode, out.stdout, out.stderr);
    }
    return out;
  } catch (e) {
    if (monitor && monitor.lost) throw new LeaseLost(monitor.sandboxId, monitor.lastError);
    if (e instanceof CommandExitError) {
      const failed = new CommandFailed(e.exitCode === undefined ? 1 : e.exitCode, e.stdout || '', e.stderr || '');
      if (check) throw failed;
      return { exitCode: failed.exitCode, stdout: failed.stdout, stderr: failed.stderr };
    }
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new E2BTimeout(e.message, { cause: e });
    }
    if (e instanceof E2BError) throw e;
    throw new E2BError(e && e.message ? e.message : String(e), { cause: e });
  }
}

// ==========================================
// 文件
// ==========================================

async function readFile(sandbox, remotePath, { binary = false } = {}) {
  return binary
    ? Buffer.from(await sandbox.files.read(remotePath, { format: 'bytes' }))
    : sandbox.files.read(remotePath);
}

async function writeFile(sandbox, remotePath, content) {
  await writeFileOverwrite(sandbox, remotePath, content);
  return content && content.length ? content.length : 0;
}

/** 按批 `mkdir -p`；目录多时避免拼出超长命令行。 */
async function ensureDirs(sandbox, directories, chunkSize = 50) {
  const dirs = [...new Set((directories || []).filter(Boolean).map(String))].sort();
  for (let i = 0; i < dirs.length; i += chunkSize) {
    const chunk = dirs.slice(i, i + chunkSize);
    const result = await run(sandbox, `mkdir -p ${chunk.map(shellQuote).join(' ')}`, { deadline: 60 });
    if (result.exitCode !== 0) {
      throw new E2BError(`failed to create remote directories: ${result.stderr || result.stdout}`);
    }
  }
}

/** 远端路径的类型：`dir` / `file` / `none`（不存在）。 */
async function remoteKind(sandbox, remotePath) {
  const p = shellQuote(remotePath);
  const result = await run(
    sandbox,
    `p=${p}; if [ -d "$p" ]; then echo dir; elif [ -e "$p" ]; then echo file; else echo none; fi`,
    { deadline: 30 }
  );
  return (result.stdout || '').trim() || 'none';
}

const isRemoteDir = async (sandbox, remotePath) => (await remoteKind(sandbox, remotePath)) === 'dir';

/**
 * 写单个文件；环境里 write 覆盖已存在的文件可能报 permission denied
 * （踩到过 /tmp：sticky 目录下 envd 的 rename 会被内核拒绝），
 * 这种情况先删掉目标再写一次，语义仍是「覆盖」。
 */
async function writeFileOverwrite(sandbox, remote, data) {
  try {
    await sandbox.files.write(remote, data);
  } catch (e) {
    if (!/permission denied/i.test(e.message || '')) throw e;
    await run(sandbox, `rm -f ${shellQuote(remote)}`, { deadline: 60 }).catch(() => {});
    await sandbox.files.write(remote, data);
  }
}

/**
 * 上传文件或整个目录，返回 { files, bytes }。
 *
 * 目录上传按文件逐个写，不做整包 tar：SDK 的 write 已经支持
 * Uint8Array，逐个写能保留进度、也让失败点更明确。
 */
async function upload(sandbox, localPath, remotePath) {
  const stat = fs.statSync(localPath);
  const remote = String(remotePath).replace(/\/$/, '');

  if (stat.isFile()) {
    const parent = path.posix.dirname(remote);
    if (parent && parent !== '.') await ensureDirs(sandbox, [parent]);
    const data = await fsp.readFile(localPath);
    await writeFileOverwrite(sandbox, remote, data);
    return { files: 1, bytes: data.length };
  }

  const kind = await remoteKind(sandbox, remote);
  if (kind === 'file') {
    throw new E2BError(`remote path exists and is not a directory: ${remotePath}`);
  }

  const files = [];
  const walk = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const local = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(local);
      else if (entry.isFile()) files.push(local);
    }
  };
  await walk(localPath);

  const targets = files.map((f) => path.posix.join(remote, path.relative(localPath, f).split(path.sep).join('/')));
  await ensureDirs(sandbox, [remote, ...[...new Set(targets.map((t) => path.posix.dirname(t)))]].filter(Boolean));

  let bytes = 0;
  for (let i = 0; i < files.length; i += 1) {
    const data = await fsp.readFile(files[i]);
    await writeFileOverwrite(sandbox, targets[i], data);
    bytes += data.length;
  }
  return { files: files.length, bytes };
}

/**
 * 下载文件或整个目录，返回 { files, bytes }。
 *
 * 一律按字节读：文本模式会把二进制内容解码成字符串（非 UTF-8 字节变成
 * U+FFFD），下载图片/压缩包后文件就坏了。
 */
async function download(sandbox, remotePath, localPath) {
  const local = path.resolve(localPath);

  if (!(await isRemoteDir(sandbox, remotePath))) {
    const raw = Buffer.from(await sandbox.files.read(remotePath, { format: 'bytes' }));
    await fsp.mkdir(path.dirname(local), { recursive: true });
    await fsp.writeFile(local, raw);
    return { files: 1, bytes: raw.length };
  }

  await fsp.mkdir(local, { recursive: true });
  const listing = await run(
    sandbox,
    `cd ${shellQuote(remotePath)} && find . -type f`,
    { deadline: 120 }
  );
  const rels = (listing.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith('./') ? line.slice(2) : line));

  let bytes = 0;
  for (const rel of rels) {
    const remoteFile = `${String(remotePath).replace(/\/$/, '')}/${rel}`;
    const raw = Buffer.from(await sandbox.files.read(remoteFile, { format: 'bytes' }));
    const target = path.join(local, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, raw);
    bytes += raw.length;
  }
  return { files: rels.length, bytes };
}

// ==========================================
// 模板（镜像）
// ==========================================

async function restJson(cfg, method, pathname, { body, query } = {}) {
  const url = new URL(pathname, cfg.apiUrl.replace(/\/$/, ''));
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      'X-API-KEY': cfg.apiKey,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    throw new E2BError(`${method} ${url.pathname} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return parsed;
}

/**
 * 列出集群模板。
 *
 * 直接打 REST `/templates`，而不是走 SDK 的生成客户端——私有化部署的
 * 字段命名与 SDK 模型未必一致，裸 HTTP 更宽容。
 */
async function listTemplates({ config } = {}) {
  const cfg = config || loadConfig();
  try {
    return await restJson(cfg, 'GET', '/templates');
  } catch (e) {
    throw new E2BError(`failed to query templates: ${e.message}`, { cause: e });
  }
}

/**
 * 构建并部署模板，阻塞到构建结束。
 *
 * `template` 是 `new Template().fromDockerfile(...)` 之类的 builder 链结果。
 * `onLogs` 收到构建日志对象，由调用方决定如何打印；本函数不碰 stdout。
 */
async function buildTemplate(template, {
  alias, cpu = 2, memory = 1024, disk, skipCache = false, onLogs, config,
} = {}) {
  let Template;
  try {
    ({ Template } = sdk());
  } catch (e) {
    throw new DependencyError('e2b npm package is missing (npm install e2b)', { cause: e });
  }
  const cfg = (config || loadConfig()).applyToEnv();
  const opts = {
    ...sdkOpts(cfg),
    cpuCount: Number(cpu),
    memoryMB: Number(memory),
    skipCache: Boolean(skipCache),
  };
  // 构建完成后要求的根分区最小空闲空间（MiB）。不传则由团队默认值决定。
  // Docker 这类要把镜像层摊在本地的场景必须显式给足，否则镜像一装就撑爆根分区。
  if (disk !== undefined && disk !== null) opts.minFreeDiskMb = Number(disk);
  if (onLogs) opts.onBuildLogs = onLogs;
  try {
    // 新版 SDK：build(template, name, opts)；旧版把 alias 放 opts 里
    return await Template.build(template, alias, opts);
  } catch (e) {
    try {
      return await Template.build(template, { ...opts, alias });
    } catch (e2) {
      throw new TemplateError(e.message, { cause: e });
    }
  }
}

/** 查询一次构建状态；status 取值 building/error/ready/waiting。 */
async function buildStatus(templateId, buildId, { config } = {}) {
  const cfg = config || loadConfig();
  try {
    return await restJson(cfg, 'GET', `/templates/${encodeURIComponent(templateId)}/builds/${encodeURIComponent(buildId)}/status`);
  } catch (e) {
    throw new TemplateError(e.message, { cause: e });
  }
}

/** 拉取构建日志（分页）。返回日志条目列表。 */
async function buildLogs(templateId, buildId, {
  cursor, limit = 100, direction, level, config,
} = {}) {
  const cfg = config || loadConfig();
  try {
    const res = await restJson(
      cfg,
      'GET',
      `/templates/${encodeURIComponent(templateId)}/builds/${encodeURIComponent(buildId)}/logs`,
      { query: { cursor, limit, direction, level } }
    );
    return (res && res.logs) || [];
  } catch (e) {
    throw new TemplateError(e.message, { cause: e });
  }
}

async function deleteTemplate(templateId, { config } = {}) {
  const cfg = config || loadConfig();
  try {
    await restJson(cfg, 'DELETE', `/templates/${encodeURIComponent(templateId)}`);
    return true;
  } catch (e) {
    throw new TemplateError(e.message, { cause: e });
  }
}

/**
 * 更新模板可见性。
 * 注意：REST `PATCH /templates/{id}` 只接受 `public`；别名在构建时确定，
 * 没有单独改别名的端点。需要换别名只能重新构建。
 */
async function updateTemplate(templateId, { public: isPublic, config } = {}) {
  if (isPublic === undefined || isPublic === null) {
    throw new E2BError("nothing to update (only 'public' is supported)");
  }
  const cfg = config || loadConfig();
  try {
    await restJson(cfg, 'PATCH', `/templates/${encodeURIComponent(templateId)}`, { body: { public: Boolean(isPublic) } });
    return true;
  } catch (e) {
    throw new TemplateError(e.message, { cause: e });
  }
}

// ==========================================
// 导出
// ==========================================

module.exports = {
  // 目录与配置
  SKILL_DIR,
  configDir, stateDir, configFile, legacyConfigFile,
  Config, loadConfig, saveConfig,
  DEFAULT_LEASE, DEFAULT_COMMAND_DEADLINE, DEFAULT_UNATTENDED_DEADLINE, DEFAULT_REPORT_INTERVAL,
  EXIT_STALLED, EXIT_LEASE_LOST, EXIT_IDLE_RECLAIMED,
  // 异常
  E2BError, DependencyError, TemplateError, LeaseLost, CommandFailed, E2BTimeout, commandExitException,
  // SDK
  sdk,
  // 租期
  heartbeatInterval, LeaseMonitor, startMonitor, session, connectWithLease, connectPreserve, renew,
  // 生命周期
  create, connect, kill, pause, resume, getInfo, remainingLease, updateNetwork,
  applyDnsServers,
  listSandboxes, logs, metrics,
  // 持久卷
  parseMount, mountsToSdk, resolveVolume,
  volumeCreate, volumeList, volumeGet, volumeDestroy,
  volumeLs, volumeStat, volumeRead, volumeWrite, volumeMkdir, volumeRemove,
  // 命令
  shellWrap, shellQuote, startCommand, run,
  // 纯后端任务
  parseDuration, leaseForDuration, detach, DETACHED_DIR,
  // 文件
  readFile, writeFile, ensureDirs, remoteKind, isRemoteDir, upload, download,
  // 模板
  listTemplates, buildTemplate, buildStatus, buildLogs, deleteTemplate, updateTemplate,
};
