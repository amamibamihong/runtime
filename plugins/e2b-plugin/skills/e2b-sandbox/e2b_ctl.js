#!/usr/bin/env node
'use strict';
/**
 * E2B Sandbox CLI。
 *
 * 全量命令行的唯一入口；实现层在 `e2b_api.js`。本文件只负责：
 * 解析参数 → 调用 `e2b_api` → 打印结果 → 把异常映射成退出码。
 *
 * 「模板」不常用，面向 Agent 的用法说明单独放在 `../e2b-template/SKILL.md`，
 * 脚本只有这一份。
 */

const api = require('./e2b_api.js');

function die(message, code = 1) {
  process.stderr.write(`[e2b] ${message}\n`);
  process.exit(code);
}

function out(text) {
  process.stdout.write(text);
}

function quoteTable(rows, headers, widths) {
  const fmt = (cells) => cells.map((c, i) => String(c === undefined || c === null ? '' : c).padEnd(widths[i])).join(' ');
  out(`${fmt(headers)}\n${'-'.repeat(widths.reduce((a, b) => a + b, 0) + widths.length - 1)}\n`);
  for (const row of rows) out(`${fmt(row)}\n`);
}

function parseEnvPairs(pairs) {
  const envs = {};
  for (const pair of pairs || []) {
    const i = pair.indexOf('=');
    if (i > 0) envs[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return envs;
}

/**
 * 到期行为：`kill`（默认，直接回收）或 `pause`（连同内存快照挂起，之后能 resume）。
 *
 * `pause` 的意义是长任务不会跑到一半被连根拔掉：租期到点先挂起保留现场，
 * 需要时 `resume` 接着跑。代价是占用团队快照配额，且不主动 resume 就一直挂着。
 *
 * 用 `--on-timeout pause:filesystem` 只存磁盘（丢弃内存，resume 时冷启动），
 * 快照更小，但跑着的进程和连接会丢。
 *
 * `--auto-resume` 让挂起的沙箱在收到入站流量时自动唤醒，不用人工 resume。
 * 它要求 onTimeout 为 pause，且不能和 pause:filesystem 同用（磁盘快照没有内存
 * 可原地恢复，只能冷启动，无法被流量透明唤醒）。
 */
function parseLifecycle(args) {
  const raw = args.onTimeout;
  const autoResume = args.autoResume === true;
  if (raw === undefined) {
    if (autoResume) die('--auto-resume requires --on-timeout pause');
    return undefined;
  }
  if (raw === true) die('--on-timeout needs a value: kill | pause | pause:filesystem');

  const [action, mode] = String(raw).split(':');
  if (action === 'kill') {
    if (mode) die('--on-timeout kill takes no mode; only pause supports :filesystem');
    if (autoResume) die('--auto-resume can only be used with --on-timeout pause');
    return { onTimeout: { action: 'kill' } };
  }
  if (action !== 'pause') {
    die(`--on-timeout must be kill | pause | pause:filesystem, got "${raw}"`);
  }
  if (mode && mode !== 'filesystem') {
    die(`--on-timeout pause mode must be "filesystem", got "${mode}"`);
  }
  if (autoResume && mode === 'filesystem') {
    die('--auto-resume cannot be combined with pause:filesystem: '
      + 'a filesystem-only snapshot cannot be woken by traffic and must be resumed explicitly');
  }
  return {
    onTimeout: mode ? { action: 'pause', mode: 'filesystem' } : { action: 'pause' },
    ...(autoResume ? { autoResume: true } : {}),
  };
}

function readStdinSync() {
  try {
    return require('fs').readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// ==========================================
// 配置
// ==========================================

/**
 * 出网规则按官方 SDK 的 `network` 选项原样透传，这里只校验它是 JSON 对象，
 * 字段结构（allowOut / denyOut / rules …）交给 SDK 与服务端解析。
 */
function parseNetworkJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    die(`--network is not valid JSON: ${e.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    die('--network must be a JSON object, e.g. \'{"allowOut":["192.168.36.1/24"]}\'');
  }
  return value;
}

function parseDnsArg(value) {
  const list = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [];
}

function cmdConfigGet(args) {
  const cfg = api.loadConfig();
  const payload = { ...cfg.masked(), config_file_exists: require('fs').existsSync(api.configFile()) };
  if (args.json) {
    out(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  out(`ConfigFile: ${payload.config_file} (exists: ${payload.config_file_exists})\n`);
  out(`API_URL   : ${cfg.apiUrl}\n`);
  out(`SANDBOX   : ${cfg.sandboxUrl}\n`);
  out(`API_KEY   : ${payload.api_key}\n`);
  out(`TEMPLATE  : ${cfg.template || '(未设置，创建时请用 -t 指定)'}\n`);
  out(`TIMEOUT   : ${cfg.lease}s\n`);
  if (cfg.network) out(`NETWORK   : ${JSON.stringify(cfg.network)}\n`);
  if (cfg.dnsServers) out(`DNS       : ${cfg.dnsServers.join(', ')}\n`);
  return 0;
}

function cmdConfigSet(args) {
  const values = {};
  if (args.apiKey !== undefined) values.api_key = args.apiKey;
  if (args.apiUrl !== undefined) values.api_url = args.apiUrl;
  if (args.sandboxUrl !== undefined) values.sandbox_url = args.sandboxUrl;
  if (args.template !== undefined) values.template = args.template;
  if (args.timeout !== undefined) values.lease = args.timeout;
  if (args.clearTemplate) values.clear_template = true;
  if (args.network !== undefined) values.network = parseNetworkJson(args.network);
  if (args.networkStdin) values.network = parseNetworkJson(readStdinSync());
  if (args.dns !== undefined) values.dnsServers = parseDnsArg(args.dns);

  if (!Object.keys(values).length) {
    die('nothing to update: pass --api-key/--api-url/--sandbox-url/-t/--timeout/--network/--dns');
  }

  let result;
  try {
    result = api.saveConfig(values);
  } catch (e) {
    die(`failed to write configuration file ${api.configFile()}: ${e.message}`);
  }
  // 回显时遮蔽 Key；直接掩码刚写入的值，不能重新 loadConfig()——
  // 环境变量优先级高于文件，那样会显示出环境里的 Key 而非写进文件的那个。
  const changed = result.changed;
  if (typeof changed.api_key === 'string') {
    const key = changed.api_key;
    changed.api_key = key.length > 12 ? `${key.slice(0, 8)}...${key.slice(-4)}` : '***';
  }
  if (args.json) {
    out(`${JSON.stringify({ config_file: result.path, changed }, null, 2)}\n`);
  } else {
    out(`Configuration saved to ${result.path}\n`);
    for (const [k, v] of Object.entries(changed)) out(`  ${k} = ${v}\n`);
  }
  return 0;
}

async function cmdSetup() {
  const cfg = api.loadConfig();
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

  out('=== E2B Sandbox Skill 快速配置向导 ===\n');
  out(`配置文件路径: ${api.configFile()}\n\n`);

  const key = (await ask(`请输入 E2B API Key [${cfg.masked().api_key}]: `)).trim() || cfg.apiKey;
  const apiUrl = (await ask(`请输入 E2B API 服务地址 [${cfg.apiUrl}]: `)).trim() || cfg.apiUrl;
  const sandboxUrl = (await ask(`请输入 E2B 沙箱网关地址 [${cfg.sandboxUrl}]: `)).trim() || cfg.sandboxUrl;
  const template = (await ask(`请输入默认模板别名 [${cfg.template || '未设置，使用时可 -t 指定'}]: `)).trim() || cfg.template;
  const leaseRaw = (await ask(`请输入默认超时时间(秒) [${cfg.lease}]: `)).trim() || String(cfg.lease);
  const dnsHint = cfg.dnsServers ? cfg.dnsServers.join(',') : '留空则用模板自带 nameserver';
  const dnsRaw = (await ask(`沙箱内 DNS 服务器（逗号分隔）[${dnsHint}]: `)).trim();
  rl.close();

  const result = api.saveConfig({
    api_key: key,
    api_url: apiUrl,
    sandbox_url: sandboxUrl,
    template,
    lease: Number(leaseRaw),
    ...(dnsRaw ? { dnsServers: parseDnsArg(dnsRaw) } : {}),
  });
  out(`\n[OK] 配置已成功保存至 ${result.path}！\n`);
  return 0;
}

// ==========================================
// 模板（镜像）
// ==========================================

async function cmdListTemplates(args) {
  let data;
  try {
    data = await api.listTemplates();
  } catch (e) {
    die(e.message);
  }
  if (args.json) {
    out(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }
  if (!Array.isArray(data) || !data.length) {
    out('No templates found.\n');
    return 0;
  }
  const rows = data.map((tpl) => {
    const aliases = tpl.aliases || [];
    return [
      aliases[0] || tpl.templateID || '',
      tpl.templateID || '',
      tpl.cpuCount || 0,
      tpl.memoryMB || 0,
      tpl.diskSizeMB || 0,
    ];
  });
  quoteTable(rows, ['TEMPLATE NAME', 'TEMPLATE ID', 'VCPUS', 'RAM (MB)', 'DISK (MB)'], [24, 22, 6, 10, 10]);
  return 0;
}

function stampOf(ts) {
  if (!ts) return '--:--:--';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toTimeString().slice(0, 8);
}

function printBuildLog(entry) {
  out(`${stampOf(entry.timestamp)} [${entry.level || 'info'}] ${entry.message || JSON.stringify(entry)}\n`);
}

async function cmdBuildTemplate(args) {
  let Template;
  try {
    ({ Template } = api.sdk());
  } catch (e) {
    die('e2b npm package is missing (npm install e2b)');
  }

  const fs = require('fs');
  let builder;
  if (args.dockerfile) {
    if (!fs.existsSync(args.dockerfile)) die(`dockerfile not found: ${args.dockerfile}`);
    builder = new Template().fromDockerfile(args.dockerfile);
  } else if (args.fromImage) {
    builder = new Template().fromImage(args.fromImage);
  } else if (args.fromTemplate) {
    builder = new Template().fromTemplate(args.fromTemplate);
  } else {
    die('one of --dockerfile / --from-image / --from-template is required');
  }

  for (const cmd of args.runCmd || []) builder = builder.runCmd(cmd);

  const started = Date.now();
  let info;
  try {
    info = await api.buildTemplate(builder, {
      alias: args.alias,
      cpu: args.cpu,
      memory: args.memory,
      disk: args.disk,
      skipCache: args.skipCache,
      onLogs: args.quiet ? undefined : printBuildLog,
    });
  } catch (e) {
    die(`template build failed: ${e.message}`);
  }

  const payload = {
    alias: (info && (info.alias || info.name)) || args.alias,
    template_id: info && (info.templateId || info.template_id),
    build_id: info && (info.buildId || info.build_id),
    elapsed_seconds: Math.round((Date.now() - started) / 100) / 10,
  };
  if (args.json) {
    out(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    out(`Template built: ${payload.alias} (template_id=${payload.template_id}, ` +
      `build_id=${payload.build_id}, ${payload.elapsed_seconds}s)\n`);
  }
  return 0;
}

async function cmdBuildStatus(args) {
  let data;
  try {
    data = await api.buildStatus(args.templateId, args.buildId);
  } catch (e) {
    die(e.message);
  }
  if (args.json) {
    out(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }
  out(`Build ${args.buildId} of template ${args.templateId}: ${data && data.status}\n`);
  for (const field of ['cpuCount', 'memoryMB', 'diskSizeMB', 'createdAt', 'finishedAt']) {
    if (data && data[field] !== undefined && data[field] !== null) out(`  ${field}: ${data[field]}\n`);
  }
  return 0;
}

async function cmdBuildLogs(args) {
  let entries;
  try {
    entries = await api.buildLogs(args.templateId, args.buildId, {
      cursor: args.cursor,
      limit: args.limit,
      direction: args.direction,
      level: args.level,
    });
  } catch (e) {
    die(e.message);
  }
  if (args.json) {
    out(`${JSON.stringify(entries, null, 2)}\n`);
    return 0;
  }
  for (const entry of entries) printBuildLog(entry);
  return 0;
}

async function cmdDeleteTemplate(args) {
  try {
    await api.deleteTemplate(args.templateId);
  } catch (e) {
    die(e.message);
  }
  out(`Template ${args.templateId} deleted.\n`);
  return 0;
}

async function cmdTemplatePublic(args) {
  try {
    await api.updateTemplate(args.templateId, { public: args.public === 'true' });
  } catch (e) {
    die(e.message);
  }
  out(`Template ${args.templateId} public=${args.public}.\n`);
  return 0;
}

// ==========================================
// 沙箱生命周期
// ==========================================

async function cmdList(args) {
  let items;
  try {
    items = await api.listSandboxes({ allStates: args.all });
  } catch (e) {
    die(`failed to list sandboxes: ${e.message}`);
  }

  if (args.json) {
    const payload = items.map((s) => ({
      sandbox_id: s.sandboxId,
      template_id: s.templateId,
      alias: s.alias || s.name || '',
      started_at: s.startedAt || null,
      end_at: s.endAt || null,
      launch: (s.metadata && s.metadata.e2b_launch) || null,
      state: s.state ? String(s.state) : '',
    }));
    out(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  if (!items.length) {
    out('No running sandboxes found.\n');
    return 0;
  }
  quoteTable(
    // 纯后端任务（launch 派发）没有人在等结果，标出来避免被顺手 kill
    items.map((s) => [
      s.sandboxId,
      s.templateId,
      s.alias || s.name || '',
      (s.metadata && s.metadata.e2b_launch) ? `launch:${s.metadata.e2b_launch}` : '',
    ]),
    ['SANDBOX ID', 'TEMPLATE ID', 'ALIAS', 'KIND'],
    [24, 22, 22, 24]
  );
  return 0;
}

/**
 * 纯后端任务：拉起沙箱、启动命令、立即返回，之后不再管它。
 *
 * 寿命由调用方声明的**真实需要时长**决定（`--for`），不是某个统一的固定值：
 * 沙箱租期 = 期望时长 + 按比例的小余量，任务跑完之前不会因租期到期被回收，
 * 到期后由控制面整体回收——本进程不续租、不轮询、也不回收。
 */
async function cmdLaunch(args) {
  const seconds = api.parseDuration(args.for);
  if (!seconds) {
    die(
      'launch needs the expected runtime: pass --for <duration>, e.g. --for 45m / --for 6h / --for 2d.\n' +
      'There is no universal default on purpose — the sandbox lives exactly as long as this task needs.'
    );
  }
  const lease = api.leaseForDuration(seconds);
  const name = args.name || `job-${Date.now()}`;
  const cfg = api.loadConfig();
  const mounts = parseMountArgs(args);
  if (mounts.length && args.sandboxId) {
    die('--mount only applies when launch creates the sandbox; drop -s, or mount volumes with create/exec');
  }

  let sbx;
  try {
    sbx = args.sandboxId
      ? await api.connectPreserve(args.sandboxId, { lease, config: cfg })
      : await api.create({
        template: args.template,
        lease,
        network: args.network,
        dnsServers: args.dns,
        metadata: { e2b_launch: String(name), e2b_for: `${seconds}s` },
        mounts,
        lifecycle: parseLifecycle(args),
        config: cfg,
      });
  } catch (e) {
    const capped = /cannot be greater than (\d+) hours/i.exec(e.message || '');
    if (capped) {
      die(
        `requested duration ${seconds}s exceeds the team's max sandbox lifetime (${capped[1]}h). ` +
        'Shorten --for, or split the work into chained launches.'
      );
    }
    die(`failed to prepare sandbox for launch: ${e.message}`);
  }

  let handle;
  try {
    handle = await api.detach(sbx, args.command, {
      cwd: args.cwd,
      user: args.user,
      envs: parseEnvPairs(args.env),
      name: args.name,
    });
  } catch (e) {
    // 沙箱已经拉起但命令没起来：别把空转的沙箱留给用户白计费
    if (!args.sandboxId) {
      try { await sbx.kill(); } catch { /* 尽力而为 */ }
    }
    die(`failed to launch detached command: ${e.message}`);
  }

  let endAt = null;
  try {
    const info = await sbx.getInfo();
    if (info && info.endAt) endAt = new Date(info.endAt).toISOString();
  } catch {
    // 拿不到结束时间是信息缺失，不影响已经派发的任务
  }

  const payload = {
    sandbox_id: sbx.sandboxId,
    template: args.sandboxId ? undefined : (args.template || cfg.template),
    name: handle.name,
    pid: Number(handle.pid),
    expected_seconds: seconds,
    lease_seconds: lease,
    ends_at: endAt,
    log: handle.logPath,
    exit_file: handle.exitPath,
    status: 'launched',
  };
  if (args.json) {
    out(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    out(
      `Launched '${payload.name}' in sandbox ${payload.sandbox_id} (pid ${payload.pid}).\n` +
      `Expected runtime: ${seconds}s; sandbox lease: ${lease}s${endAt ? ` (ends ${endAt})` : ''}.\n` +
      `Log: ${handle.logPath}  Exit file: ${handle.exitPath}\n` +
      'No further action needed — the sandbox is reclaimed by the control plane when the lease expires.\n' +
      `To inspect without touching the lease: info ${sbx.sandboxId}. ` +
      `Reading the log needs a connection, so pass --timeout ${lease} to avoid shortening it.\n`
    );
  }
  return 0;
}

async function cmdCreate(args) {
  const mounts = parseMountArgs(args);
  const envs = parseEnvPairs(args.env);
  let sbx;
  try {
    sbx = await api.create({
      template: args.template,
      lease: args.timeout,
      network: args.network,
      dnsServers: args.dns,
      mounts,
      envs: Object.keys(envs).length ? envs : undefined,
      lifecycle: parseLifecycle(args),
    });
  } catch (e) {
    die(`failed to create sandbox: ${e.message}`);
  }
  const payload = {
    sandbox_id: sbx.sandboxId,
    template: args.template || api.loadConfig().template,
    timeout: args.timeout,
    status: 'created',
  };
  if (args.onTimeout) payload.on_timeout = args.onTimeout;
  if (args.autoResume === true) payload.auto_resume = true;
  if (mounts.length) payload.mounts = mounts;
  if (args.json) {
    out(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    out(`Created sandbox ${payload.sandbox_id} (template: ${payload.template}, timeout: ${payload.timeout}s)\n`);
    for (const m of mounts) out(`  mounted volume ${m.name} at ${m.path}\n`);
  }
  return 0;
}

/** 命令结束（产物已透传）后立即回收临时沙箱，不等 TTL 白白计费。 */
async function cleanupEphemeral(sbx, isEphemeral, args, keepForInspection = false) {
  if (!isEphemeral) return;
  if (keepForInspection || args.keepAlive) {
    if (!args.quiet) process.stderr.write(`[E2B] Sandbox ${sbx.sandboxId} retained for inspection.\n`);
    return;
  }
  try {
    await sbx.kill();
    if (!args.quiet) process.stderr.write(`[E2B] Cleaned up ephemeral sandbox: ${sbx.sandboxId}\n`);
  } catch (e) {
    if (!args.quiet) process.stderr.write(`[E2B] Failed to kill ephemeral sandbox ${sbx.sandboxId}: ${e.message}\n`);
  }
}

/**
 * 在沙箱中执行命令。
 *
 * 三个量互相独立：租期 `--timeout`、硬截止 `--max-timeout`、失败判据。
 * 输出静默不作为失败依据。
 */
async function cmdExec(args) {
  const cfg = api.loadConfig();
  const lease = Number(args.timeout || cfg.lease);
  let deadline;
  if (args.maxTimeout !== undefined && args.maxTimeout !== null) {
    deadline = Number(args.maxTimeout);
  } else if (args.background) {
    deadline = api.DEFAULT_UNATTENDED_DEADLINE;
    if (!args.quiet) {
      process.stderr.write(
        `[E2B] No --max-timeout given; defaulting to ${deadline}s so an unattended task cannot run forever.\n` +
        `[E2B] ${deadline}s is only a runaway guard, not an estimate. ` +
        'For a job that should run to completion and then be forgotten, use: launch <command> --for <duration>.\n'
      );
    }
  } else {
    deadline = api.DEFAULT_COMMAND_DEADLINE;
  }

  const envs = parseEnvPairs(args.env);
  let sbx = null;
  let monitor = null;
  let isEphemeral = false;

  const onStdout = args.stream ? (data) => { process.stdout.write(data); } : undefined;
  const onStderr = args.stream ? (data) => { process.stderr.write(data); } : undefined;

  try {
    if (args.sandboxId) {
      // 连到已有沙箱时只延长不缩短：目标可能是 launch 派发、还要跑很久的沙箱
      sbx = await api.connectPreserve(args.sandboxId, { lease, config: cfg });
    } else {
      isEphemeral = true;
      sbx = await api.create({ template: args.template, lease, network: args.network, dnsServers: args.dns, mounts: parseMountArgs(args), config: cfg });
      if (!args.quiet) {
        process.stderr.write(`[E2B] Launched ephemeral sandbox: ${sbx.sandboxId} (${args.template})\n`);
      }
    }

    monitor = api.startMonitor(sbx, lease);

    const result = await api.run(sbx, args.command, {
      cwd: args.cwd,
      user: args.user,
      envs,
      deadline,
      onStdout,
      onStderr,
      monitor,
    });

    if (!args.stream) {
      if (result.stdout) out(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
      if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    }

    await cleanupEphemeral(sbx, isEphemeral, args, result.exitCode !== 0);
    return result.exitCode;
  } catch (e) {
    if (monitor) monitor.stop();
    if (e instanceof api.LeaseLost) {
      process.stderr.write(`[E2B] ${e.message}\n`);
      if (sbx) await cleanupEphemeral(sbx, isEphemeral, args, true);
      return api.EXIT_LEASE_LOST;
    }
    if (e instanceof api.E2BTimeout) {
      process.stderr.write(`\n[Timeout] Command exceeded its ${deadline}s deadline. Aborting. (${e.message})\n`);
      if (sbx) await cleanupEphemeral(sbx, isEphemeral, args, !args.cleanupOnFailure);
      return api.EXIT_STALLED;
    }
    process.stderr.write(`Execution error: ${e.message}\n`);
    if (sbx) await cleanupEphemeral(sbx, isEphemeral, args, !args.cleanupOnFailure);
    return 1;
  }
}

// ==========================================
// 文件
// ==========================================

async function cmdReadFile(args) {
  try {
    const s = await api.session(args.sandboxId, { lease: args.timeout, preserve: true });
    try {
      out(await api.readFile(s.sandbox, args.path));
    } finally {
      s.stop();
    }
  } catch (e) {
    die(`failed to read file '${args.path}': ${e.message}`);
  }
  return 0;
}

async function cmdWriteFile(args) {
  const content = args.content !== undefined && args.content !== null ? args.content : readStdinSync();
  let written;
  try {
    const s = await api.session(args.sandboxId, { lease: args.timeout, preserve: true });
    try {
      written = await api.writeFile(s.sandbox, args.path, content);
    } finally {
      s.stop();
    }
  } catch (e) {
    die(`failed to write file '${args.path}': ${e.message}`);
  }
  out(`Successfully wrote ${content.length} characters to ${args.path}\n`);
  return 0;
}

async function cmdUpload(args) {
  // 大目录上传可能持续数分钟，期间必须持续续租，否则沙箱会先到期
  let res;
  try {
    const s = await api.session(args.sandboxId, { lease: args.timeout, preserve: true });
    try {
      res = await api.upload(s.sandbox, args.localPath, args.remotePath);
    } finally {
      s.stop();
    }
  } catch (e) {
    die(`failed to upload: ${e.message}`);
  }
  out(`Uploaded ${res.files} file(s) (${res.bytes} bytes): ${args.localPath} -> ${args.remotePath}\n`);
  return 0;
}

async function cmdDownload(args) {
  let res;
  try {
    const s = await api.session(args.sandboxId, { lease: args.timeout, preserve: true });
    try {
      res = await api.download(s.sandbox, args.remotePath, args.localPath);
    } finally {
      s.stop();
    }
  } catch (e) {
    die(`failed to download: ${e.message}`);
  }
  out(`Downloaded ${res.files} file(s) (${res.bytes} bytes): ${args.remotePath} -> ${args.localPath}\n`);
  return 0;
}

// ==========================================
// 持久卷
// ==========================================
//
// 卷不依赖任何沙箱：创建、列目录、读写内容都可以直接走 volume-content API。
// 需要让沙箱看到卷时，在创建沙箱时用 `--mount <name>:<path>` 挂载；
// 挂载只在沙箱生命周期内有效，卷里的内容在沙箱销毁后仍然保留。

function parseMountArgs(args) {
  const specs = args.mount || [];
  return specs.map((s) => api.parseMount(s));
}

async function cmdVolumeCreate(args) {
  const name = args._[0];
  let res;
  try {
    res = await api.volumeCreate(name);
  } catch (e) {
    die(`failed to create volume: ${e.message}`);
  }
  if (args.json) out(`${JSON.stringify(res, null, 2)}\n`);
  else out(`Volume created: ${res.name} (${res.volume_id})\n`);
  return 0;
}

async function cmdVolumeList(args) {
  let items;
  try {
    items = await api.volumeList();
  } catch (e) {
    die(`failed to list volumes: ${e.message}`);
  }
  if (args.json) {
    out(`${JSON.stringify(items, null, 2)}\n`);
    return 0;
  }
  if (!items.length) {
    out('No volumes found.\n');
    return 0;
  }
  quoteTable(items.map((v) => [v.volume_id, v.name]), ['VOLUME ID', 'NAME'], [24, 40]);
  return 0;
}

async function cmdVolumeInfo(args) {
  let res;
  try {
    res = await api.volumeGet(args._[0]);
  } catch (e) {
    die(`failed to get volume: ${e.message}`);
  }
  out(`${JSON.stringify(res, null, 2)}\n`);
  return 0;
}

async function cmdVolumeDestroy(args) {
  let res;
  try {
    res = await api.volumeDestroy(args._[0]);
  } catch (e) {
    die(`failed to destroy volume: ${e.message}`);
  }
  out(res.destroyed
    ? `Volume ${res.volume_id} destroyed.\n`
    : `Volume ${res.volume_id} not found (already destroyed?).\n`);
  return res.destroyed ? 0 : 1;
}

async function cmdVolumeLs(args) {
  const [vol, dirPath] = args._;
  let entries;
  try {
    entries = await api.volumeLs(vol, dirPath, { depth: args.depth === undefined ? 1 : Number(args.depth) });
  } catch (e) {
    die(`failed to list volume: ${e.message}`);
  }
  if (args.json) {
    out(`${JSON.stringify(entries, null, 2)}\n`);
    return 0;
  }
  if (!entries.length) {
    out('(empty)\n');
    return 0;
  }
  quoteTable(
    entries.map((e) => [e.type, String(e.size === undefined || e.size === null ? '' : e.size), e.path]),
    ['TYPE', 'SIZE', 'PATH'],
    [8, 12, 60]
  );
  return 0;
}

async function cmdVolumeStat(args) {
  const [vol, p] = args._;
  let res;
  try {
    res = await api.volumeStat(vol, p);
  } catch (e) {
    die(`failed to stat volume entry: ${e.message}`);
  }
  out(`${JSON.stringify(res, null, 2)}\n`);
  return 0;
}

async function cmdVolumeRead(args) {
  const [vol, p] = args._;
  let content;
  try {
    content = await api.volumeRead(vol, p);
  } catch (e) {
    die(`failed to read volume file: ${e.message}`);
  }
  out(content);
  return 0;
}

async function cmdVolumeWrite(args) {
  const [vol, p, inline] = args._;
  if (!vol || !p) die('usage: volume-write <volume> <path> [content]  (content defaults to stdin, or pass --from-file)');
  const fs = require('fs');
  let content;
  if (args.fromFile) {
    if (inline !== undefined) die('pass either inline content or --from-file, not both');
    try {
      content = fs.readFileSync(args.fromFile);
    } catch (e) {
      die(`failed to read local file ${args.fromFile}: ${e.message}`);
    }
  } else {
    content = inline !== undefined ? inline : readStdinSync();
  }
  let res;
  try {
    res = await api.volumeWrite(vol, p, content);
  } catch (e) {
    die(`failed to write volume file: ${e.message}`);
  }
  out(`Wrote ${res.size} bytes to ${res.path} (volume ${vol})\n`);
  return 0;
}

async function cmdVolumeMkdir(args) {
  const [vol, p] = args._;
  let res;
  try {
    res = await api.volumeMkdir(vol, p);
  } catch (e) {
    die(`failed to create volume directory: ${e.message}`);
  }
  out(`Created ${res.path} (volume ${vol})\n`);
  return 0;
}

async function cmdVolumeRemove(args) {
  const [vol, p] = args._;
  try {
    await api.volumeRemove(vol, p);
  } catch (e) {
    die(`failed to remove volume entry: ${e.message}`);
  }
  out(`Removed ${p} (volume ${vol})\n`);
  return 0;
}

// ==========================================
// 状态与运维
// ==========================================

async function cmdKill(args) {
  try {
    await api.kill(args.sandboxId);
  } catch (e) {
    die(`failed to kill sandbox ${args.sandboxId}: ${e.message}`);
  }
  out(`Sandbox ${args.sandboxId} killed.\n`);
  return 0;
}

async function cmdPause(args) {
  try {
    await api.pause(args.sandboxId, { filesystemOnly: args.fsOnly === true });
  } catch (e) {
    die(`failed to pause sandbox ${args.sandboxId}: ${e.message}`);
  }
  out(`Sandbox ${args.sandboxId} paused${args.fsOnly === true ? ' (filesystem-only)' : ''}.\n`);
  return 0;
}

async function cmdResume(args) {
  try {
    await api.resume(args.sandboxId, { lease: args.timeout });
  } catch (e) {
    die(`failed to resume sandbox ${args.sandboxId}: ${e.message}`);
  }
  out(`Sandbox ${args.sandboxId} resumed and connected.\n`);
  return 0;
}

async function cmdSnapshot(args) {
  let info;
  try {
    info = await api.createSnapshot(args.sandboxId, {
      name: args.name,
      filesystemOnly: args.fsOnly === true,
    });
  } catch (e) {
    die(`failed to snapshot sandbox ${args.sandboxId}: ${e.message}`);
  }
  const payload = {
    sandbox_id: args.sandboxId,
    snapshot_id: info && info.snapshotId,
    names: (info && info.names) || [],
    mode: args.fsOnly === true ? 'filesystem' : 'full',
  };
  if (args.json) {
    out(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    out(`Snapshot created: ${payload.snapshot_id}\n` +
      `Create a sandbox from it with: create -t ${payload.snapshot_id}\n`);
  }
  return 0;
}

async function cmdInfo(args) {
  let info;
  try {
    info = await api.getInfo(args.sandboxId);
  } catch (e) {
    die(`failed to get info for ${args.sandboxId}: ${e.message}`);
  }
  const plain = {};
  for (const [k, v] of Object.entries(info || {})) plain[k] = v instanceof Date ? v.toISOString() : v;
  out(`${JSON.stringify(plain, null, 2)}\n`);
  return 0;
}

async function cmdRenew(args) {
  const cfg = api.loadConfig();
  const lease = args.timeout || cfg.lease;
  let info;
  try {
    const sbx = await api.connect(args.sandboxId, { lease, config: cfg });
    info = await sbx.getInfo();
  } catch (e) {
    die(`failed to renew sandbox ${args.sandboxId}: ${e.message}`);
  }
  const payload = {
    sandbox_id: args.sandboxId,
    timeout: lease,
    end_at: info && info.endAt ? new Date(info.endAt).toISOString() : null,
  };
  if (args.json) {
    out(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    out(`Sandbox ${args.sandboxId} renewed to ${lease}s (ends at ${payload.end_at})\n`);
  }
  return 0;
}

async function cmdLogs(args) {
  let data;
  try {
    data = await api.logs(args.sandboxId, { start: args.start, limit: args.limit });
  } catch (e) {
    die(`failed to fetch logs for ${args.sandboxId}: ${e.message}`);
  }
  if (args.json) {
    out(`${JSON.stringify(data, null, 2)}\n`);
    return 0;
  }
  const entries = (data && (data.logEntries || data.log_entries)) || [];
  if (!entries.length && data && data.logs) {
    const raw = Array.isArray(data.logs) ? data.logs : [data.logs];
    for (const line of raw) out(`${line}\n`);
    return 0;
  }
  for (const e of entries) {
    const ts = e.timestamp ? new Date(e.timestamp).toISOString().replace('T', ' ').slice(0, 19) : '';
    out(`${ts} [${e.level || 'info'}] ${e.message || ''}\n`);
  }
  return 0;
}

async function cmdMetrics(args) {
  let data;
  try {
    data = await api.metrics(args.sandboxId, { lease: args.timeout });
  } catch (e) {
    die(`failed to fetch metrics for ${args.sandboxId}: ${e.message}`);
  }
  // SDK 返回的是大整数纳秒/字节，JSON.stringify 会丢精度，统一转字符串
  const payload = (data || []).map((m) => ({
    timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : String(m.timestamp),
    cpu_used_pct: Number(m.cpuUsedPct) || 0,
    mem_used: Number(m.memUsed) || 0,
    mem_total: Number(m.memTotal) || 0,
    disk_used: Number(m.diskUsed) || 0,
    disk_total: Number(m.diskTotal) || 0,
  }));
  if (args.json) {
    out(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  if (!payload.length) {
    out('No metrics found.\n');
    return 0;
  }
  quoteTable(
    payload.map((m) => [
      m.timestamp,
      m.cpu_used_pct,
      `${m.mem_used}/${m.mem_total}`,
      `${m.disk_used}/${m.disk_total}`,
    ]),
    ['TIMESTAMP', 'CPU%', 'MEM USED/TOTAL', 'DISK USED/TOTAL'],
    [21, 8, 24, 24]
  );
  return 0;
}

// ==========================================
// 参数
// ==========================================

function parseArgs(argv) {
  const args = { _: [] };
  // 支持 --flag=value 与 --flag value 两种写法
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      // 之后的都是位置参数：命令本身可能以 - 开头
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('-')) {
      args._.push(token);
      continue;
    }
    let name = token.replace(/^--?/, '');
    let value;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
      value = argv[i + 1];
      i += 1;
    } else {
      value = true;
    }
    // 同一个 flag 可重复出现（-e、--run-cmd）：存成数组，否则后一次会覆盖前一次
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      args[name] = Array.isArray(args[name]) ? [...args[name], value] : [args[name], value];
    } else {
      args[name] = value;
    }
  }
  return args;
}

const USAGE = `Usage: e2b_ctl.js <command> [options]

配置:
  config-get [--json]
  config-set [--api-key K] [--api-url U] [--sandbox-url S] [-t TPL] [--timeout N]
             [--network JSON | --network-stdin] [--dns IP[,IP...]] [--json]
  setup

出网（--network / --network-stdin，字段与 SDK 的 SandboxNetworkOpts 一致）:
  allowOut, denyOut, dnsServers, rules, egressProxy, allowInternetAccess, httpsPorts
  例:
    --network '{"denyOut":["0.0.0.0/0"]}'                      全关
    --network '{"allowOut":["api.example.com"],"denyOut":["0.0.0.0/0"]}'   只放行一个域名
  注意: 内网私有段由 orchestrator 硬拒绝，沙箱参数无法打开，见 USAGE.md 5.3

模板:
  list-templates [--json]
  build-template <alias> (--dockerfile F | --from-image I | --from-template T) [--run-cmd C]... [--cpu N] [--memory MB] [--disk MB] [--skip-cache] [-q] [--json]
      --disk 只是向服务端请求 minFreeDiskMb；服务端 build-ensure-free-disk-space 开关
      关闭时不生效（本集群即如此），模板磁盘来自基础模板或团队配额。详见 USAGE.md 4.5。
  build-status <template_id> <build_id> [--json]
  build-logs <template_id> <build_id> [--cursor N] [--limit N] [--direction forward|backward] [--level debug|info|warn|error] [--json]
  delete-template <template_id>
  template-public <template_id> true|false

沙箱:
  list [-a|--all] [--json]
  create [-t TPL] [--timeout N] [-e K=V]... [--network JSON | --network-stdin] [--dns IP[,IP]] [--mount NAME:PATH]... [--on-timeout kill|pause|pause:filesystem] [--auto-resume] [--json]
  exec <command> [-s ID] [-t TPL] [--timeout N] [--max-timeout N] [--cwd D] [-u USER] [-e K=V]... [--dns IP[,IP]] [--mount NAME:PATH]... [-k] [--cleanup-on-failure] [-q] [--stream] [--background]
  launch <command> --for DURATION [-s ID] [-t TPL] [--network JSON] [--dns IP[,IP]] [--mount NAME:PATH]... [--on-timeout kill|pause] [--auto-resume] [--cwd D] [-u USER] [-e K=V]... [--name N] [--json]
  read-file -s ID <path> [--timeout N]
  write-file -s ID <path> [content] [--timeout N]
  upload -s ID <local_path> <remote_path> [--timeout N]
  download -s ID <remote_path> <local_path> [--timeout N]
  kill <sandbox_id>
  pause <sandbox_id> [--fs-only]
  resume <sandbox_id> [--timeout N]
  snapshot <sandbox_id> [--name N] [--fs-only] [--json]
  info <sandbox_id>
  renew <sandbox_id> [--timeout N] [--json]
  logs <sandbox_id> [--start N] [--limit N] [--json]
  metrics <sandbox_id> [--timeout N] [--json]

持久卷（内容独立于沙箱，需部署开启 volumes 能力）:
  volume-create <name> [--json]
  volume-list [--json]
  volume-info <volume>
  volume-destroy <volume>
  volume-ls <volume> [path] [--depth N] [--json]
  volume-stat <volume> <path>
  volume-read <volume> <path>
  volume-write <volume> <path> [content]      # content 省略时读 stdin；二进制用 --from-file F
  volume-mkdir <volume> <path>
  volume-rm <volume> <path>
`;

// 短的与长的都认，且带值的不做布尔化
const ALIASES = {
  s: 'sandboxId',
  t: 'template',
  u: 'user',
  e: 'env',
  k: 'keepAlive',
  q: 'quiet',
  a: 'all',
  h: 'help',
};

const FLAGS = new Set([
  'json', 'all', 'quiet', 'stream', 'background', 'keepAlive', 'cleanupOnFailure',
  'skipCache', 'clearTemplate', 'help', 'autoResume', 'fsOnly',
]);

const MULTI = new Set(['env', 'runCmd', 'mount']);

function normalize(raw) {
  const out = { _: raw._ };
  for (const [key, value] of Object.entries(raw)) {
    if (key === '_') continue;
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const name = ALIASES[key] || camel;
    // 同名 flag 重复出现时 parseArgs 给出数组，展开后按出现顺序累积
    const values = Array.isArray(value) ? value : [value];
    if (MULTI.has(name)) {
      out[name] = [...(out[name] || []), ...values];
    } else if (values.length > 1) {
      out[name] = values[values.length - 1];
    } else {
      out[name] = values[0];
    }
  }
  return out;
}

const COMMANDS = {
  'config-get': cmdConfigGet,
  'config-set': cmdConfigSet,
  setup: cmdSetup,
  'list-templates': cmdListTemplates,
  'build-template': cmdBuildTemplate,
  'build-status': cmdBuildStatus,
  'build-logs': cmdBuildLogs,
  'delete-template': cmdDeleteTemplate,
  'template-public': cmdTemplatePublic,
  list: cmdList,
  create: cmdCreate,
  launch: cmdLaunch,
  exec: cmdExec,
  'volume-create': cmdVolumeCreate,
  'volume-list': cmdVolumeList,
  'volume-info': cmdVolumeInfo,
  'volume-destroy': cmdVolumeDestroy,
  'volume-ls': cmdVolumeLs,
  'volume-stat': cmdVolumeStat,
  'volume-read': cmdVolumeRead,
  'volume-write': cmdVolumeWrite,
  'volume-mkdir': cmdVolumeMkdir,
  'volume-rm': cmdVolumeRemove,
  'read-file': cmdReadFile,
  'write-file': cmdWriteFile,
  upload: cmdUpload,
  download: cmdDownload,
  kill: cmdKill,
  pause: cmdPause,
  resume: cmdResume,
  snapshot: cmdSnapshot,
  info: cmdInfo,
  renew: cmdRenew,
  logs: cmdLogs,
  metrics: cmdMetrics,
};

function requirePositional(args, count, names) {
  if (args._.length < count) {
    die(`missing argument(s): ${names.slice(args._.length).join(', ')}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    out(USAGE);
    return argv.length ? 0 : 1;
  }
  const command = argv[0];
  const handler = COMMANDS[command];
  if (!handler) die(`unknown command '${command}'\n\n${USAGE}`);

  const args = normalize(parseArgs(argv.slice(1)));
  if (args.help) {
    out(USAGE);
    return 0;
  }

  // 位置参数按命令各自消费（--flag 形式在上面已剥离）
  const pos = args._;

  switch (command) {
    case 'build-template':
      requirePositional(args, 1, ['alias']);
      args.alias = pos[0];
      args.cpu = args.cpu === undefined ? 2 : Number(args.cpu);
      args.memory = args.memory === undefined ? 1024 : Number(args.memory);
      if (args.disk !== undefined) args.disk = Number(args.disk);
      break;
    case 'build-status':
      requirePositional(args, 2, ['template_id', 'build_id']);
      [args.templateId, args.buildId] = pos;
      break;
    case 'build-logs':
      requirePositional(args, 2, ['template_id', 'build_id']);
      [args.templateId, args.buildId] = pos;
      args.limit = args.limit === undefined ? 100 : Number(args.limit);
      args.cursor = args.cursor === undefined ? undefined : Number(args.cursor);
      break;
    case 'delete-template':
      requirePositional(args, 1, ['template_id']);
      args.templateId = pos[0];
      break;
    case 'template-public':
      requirePositional(args, 2, ['template_id', 'public']);
      [args.templateId, args.public] = pos;
      if (!['true', 'false'].includes(args.public)) die('public must be true or false');
      break;
    case 'create':
      args.timeout = args.timeout === undefined ? api.loadConfig().lease : Number(args.timeout);
      args.template = args.template || api.loadConfig().template;
      if (args.network !== undefined) args.network = parseNetworkJson(args.network);
      if (args.networkStdin) args.network = parseNetworkJson(readStdinSync());
      args.dns = parseDnsArg(args.dns);
      break;
    case 'launch': {
      requirePositional(args, 1, ['command']);
      args.command = pos[0];
      args.template = args.template || api.loadConfig().template;
      if (args.network !== undefined) args.network = parseNetworkJson(args.network);
      if (args.networkStdin) args.network = parseNetworkJson(readStdinSync());
      args.dns = parseDnsArg(args.dns);
      break;
    }
    case 'exec': {
      requirePositional(args, 1, ['command']);
      args.command = pos[0];
      if (args.timeout !== undefined) args.timeout = Number(args.timeout);
      if (args.maxTimeout !== undefined) args.maxTimeout = Number(args.maxTimeout);
      args.template = args.template || api.loadConfig().template;
      args.timeout = args.timeout === undefined ? api.loadConfig().lease : args.timeout;
      args.dns = parseDnsArg(args.dns);
      if (args.mount !== undefined && args.sandboxId) {
        die('--mount only applies when exec creates the sandbox; a running sandbox cannot gain mounts. ' +
          'Drop -s, or mount volumes at creation time (create --mount …).');
      }
      break;
    }
    case 'read-file':
    case 'write-file': {
      requirePositional(args, command === 'read-file' ? 1 : 1, ['path']);
      if (!args.sandboxId) die('missing -s/--sandbox-id');
      args.path = pos[0];
      args.content = pos[1];
      if (args.timeout !== undefined) args.timeout = Number(args.timeout);
      break;
    }
    case 'upload':
    case 'download': {
      requirePositional(args, 2, ['local_path', 'remote_path']);
      if (!args.sandboxId) die('missing -s/--sandbox-id');
      const [a, b] = pos;
      if (command === 'upload') { args.localPath = a; args.remotePath = b; }
      else { args.remotePath = a; args.localPath = b; }
      if (args.timeout !== undefined) args.timeout = Number(args.timeout);
      break;
    }
    case 'volume-create':
    case 'volume-info':
    case 'volume-destroy':
      requirePositional(args, 1, ['volume']);
      break;
    case 'volume-ls':
      requirePositional(args, 1, ['volume']);
      if (args.depth !== undefined) args.depth = Number(args.depth);
      break;
    case 'volume-stat':
    case 'volume-read':
    case 'volume-mkdir':
    case 'volume-rm':
      requirePositional(args, 2, ['volume', 'path']);
      break;
    case 'volume-write':
      requirePositional(args, 2, ['volume', 'path']);
      break;
    case 'kill':
    case 'pause':
    case 'snapshot':
    case 'info':
      requirePositional(args, 1, ['sandbox_id']);
      args.sandboxId = pos[0];
      break;
    case 'resume':
    case 'renew':
    case 'metrics':
      requirePositional(args, 1, ['sandbox_id']);
      args.sandboxId = pos[0];
      if (args.timeout !== undefined) args.timeout = Number(args.timeout);
      break;
    case 'logs':
      requirePositional(args, 1, ['sandbox_id']);
      args.sandboxId = pos[0];
      args.limit = args.limit === undefined ? 1000 : Number(args.limit);
      if (args.start !== undefined) args.start = Number(args.start);
      break;
    case 'config-set':
      if (args.timeout !== undefined) args.timeout = Number(args.timeout);
      break;
    default:
      break;
  }

  return handler(args);
}

// Ctrl-C 交给上层 shell 习惯：退出码 130，不留半个进程
process.on('SIGINT', () => process.exit(130));

main()
  .then((code) => process.exit(typeof code === 'number' ? code : 0))
  .catch((e) => {
    process.stderr.write(`[e2b] ${e && e.message ? e.message : e}\n`);
    if (process.env.E2B_DEBUG) process.stderr.write(`${e && e.stack}\n`);
    process.exit(1);
  });
