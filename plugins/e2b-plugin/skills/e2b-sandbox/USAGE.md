# E2B 沙箱使用手册

面向使用者的完整说明：沙箱是什么、能做什么、怎么装、启动时要给哪些环境变量、常见任务怎么写。
逐个模板装了什么见 [TEMPLATES.md](TEMPLATES.md)，命令速查见 [SKILL.md](SKILL.md)。

---

## 1. 沙箱是什么

每个沙箱是一台 **Firecracker 微虚机**，不是容器。它有独立内核、独立网络栈、独立磁盘，
和宿主机、和别的沙箱相互隔离。因此：

- 可以放心跑不受信任的代码、`apt-get install`、改内核参数、起 systemd 服务；
- 沙箱之间共享不到文件系统，也看不到对方的进程；
- 启动开销在百毫秒级，比整机虚拟机轻得多，但仍然是一台**机器**，不是 shell 子进程。

一个沙箱的生命周期由**租期**（lease）决定：

```
create / launch  →  运行中（每次连上可以续租）  →  租期到点 → kill（默认）或 pause
```

到点默认**直接回收**，磁盘一起消失。需要保留现场才用 `--on-timeout pause`。

### 沙箱里有什么

由**模板**决定。模板是预构建的根文件系统镜像，是集群级公共资源，一次构建所有人可复用。
当前集群可用的模板用 `list-templates` 查，每个模板装了什么见 [TEMPLATES.md](TEMPLATES.md)。

通用模板（`trendy-alpine`、`code-interpreter`、`playwright`、`desktop`、`vscode` 等）提供
各类现成环境；AI 代理模板（`claudecode`、`codex`、`opencode` 等）预装了编码代理 CLI，
但**不含任何凭证**，需要你在创建时注入。

### 沙箱不提供什么

- 没有持久化的本地磁盘——沙箱销毁即丢失。要跨沙箱保留数据用**持久卷**（第 6 节）。
- 不预置你的 API Key、账号、`~/.ssh`、`~/.gitconfig`。全部靠创建时注入，或用 `upload` 传进去。
- 默认不允许任意出网。出网规则要显式声明（第 5 节）。
- 交互式 TUI（vim、htop、`claude` 的交互界面）不能直接用，因为这里没有真 TTY。
  需要交互的 CLI 走非交互参数或 `--run-cmd` 固化进模板。

---

## 2. 安装与首次配置

插件脚本是 Node 写的，依赖 `e2b` npm 包。`bootstrap.js` 负责把运行时装到
`~/.cache/e2b-plugin/node_modules`，并把配置写到 `~/.config/e2b-plugin/config.json`。

```bash
# 一键：装运行时 + 交互式配置 + 连一次控制面验证
node <plugin-dir>/bootstrap.js

# 只装运行时 / 只改配置 / 只检查
node <plugin-dir>/bootstrap.js install
node <plugin-dir>/bootstrap.js config
node <plugin-dir>/bootstrap.js check
```

配置向导会问五项，也可以直接用 `config-set` 非交互写入：

```bash
node <skill-dir>/e2b_ctl.js config-set \
  --api-url "http://192.168.36.222:3000" \
  --sandbox-url "http://192.168.36.222:3002" \
  --api-key "e2b_xxx" \
  --template claudecode \
  --timeout 300
```

**两个地址必须都配对**，这是最常见的配置错误：

| 配置项 | 作用 | 配错的表现 |
|---|---|---|
| `api_url` | 控制面 REST API：建/查/删沙箱、列模板、建模板 | 401 或连不上 |
| `sandbox_url` | 数据面网关：命令执行、文件上传下载（走 envd） | 模板列表正常，但 `exec` 报 `SandboxNotRunningError` |

配置存在 `~/.config/e2b-plugin/config.json`，属于用户数据，不写进插件安装目录。
旧版本留在技能目录的 `config.json` 仍会被读取，但不再写入。

`config-get` 可以查看当前生效值与它们的来源（ENV / 配置文件 / 默认值）：

```bash
node <skill-dir>/e2b_ctl.js config-get --json
```

---

## 3. 环境变量：两层，别混

这是最容易搞混的地方。有两组完全不同的环境变量。

### 3.1 插件自己的环境变量（在你本地 shell 里设置）

决定**插件连哪个集群**，优先级高于配置文件。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `E2B_API_URL` | `http://192.168.36.222:3000` | 控制面地址 |
| `E2B_SANDBOX_URL` | `http://192.168.36.222:3002` | 数据面网关地址 |
| `E2B_API_KEY` | 无 | 团队 API Key，`e2b_` 开头 |
| `E2B_DEFAULT_TEMPLATE` | `claudecode` | 默认模板别名 |
| `E2B_DEFAULT_TIMEOUT` | `300` | 默认租期（秒） |
| `E2B_DEBUG` | 无 | 设任意值则出错时打印完整堆栈 |
| `E2B_PLUGIN_CONFIG_DIR` | `~/.config/e2b-plugin` | 配置目录 |
| `E2B_PLUGIN_STATE_DIR` | `~/.local/state/e2b-plugin` | 会话文件、锁、后台任务日志 |
| `E2B_PLUGIN_NODE_MODULES` | `~/.cache/e2b-plugin/node_modules` | `e2b` 包安装位置 |
| `E2B_PLUGIN_E2B_SPEC` | `e2b` | bootstrap 安装的 npm 包版本规格 |

这些变量**不会**进入沙箱。设了 `E2B_API_KEY` 之后就不用每个命令传 `--api-key`。

### 3.2 注入沙箱的环境变量（`-e K=V`）

决定**沙箱里的程序看到什么**，只在 `create` / `launch` 时传：

```bash
node <skill-dir>/e2b_ctl.js create -t claudecode --timeout 1800 \
  -e ANTHROPIC_BASE_URL=https://gw.example.com \
  -e ANTHROPIC_AUTH_TOKEN=xxx \
  -e ANTHROPIC_MODEL=my-model
```

三条规则：

1. **创建时注入，使用时不传。** `create` 传入的变量在整个沙箱生命周期内对后续所有命令生效，
   `exec` / `read-file` / `upload` 都不用再传。
2. **绝不写进模板。** 模板是公共资源，构建进去的 Key 会泄露给所有使用者。
3. **`exec -e` 只影响那一次命令。** 临时变量用 `exec -e`，长期变量在 `create` 时给。

#### 常用注入项

| 场景 | 变量 |
|---|---|
| 官方 Anthropic API | `ANTHROPIC_API_KEY` |
| 自建网关 / 中转 | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` |
| 指定模型 | `ANTHROPIC_MODEL` |
| 沙箱内用 `e2b` CLI 反向管理集群 | `E2B_API_KEY` + `E2B_API_URL` + `E2B_SANDBOX_URL` |
| 语言/构建类的镜像源、代理 | 各工具的常规变量，如 `PIP_INDEX_URL`、`NPM_CONFIG_REGISTRY`、`GOPROXY` |

以 `e2b-cli` 模板在沙箱内反向管理集群为例，三个变量缺一不可：

```bash
node <skill-dir>/e2b_ctl.js create -t e2b-cli --timeout 1800 \
  --network '{"allowOut":["192.168.36.0/24"]}' \
  -e E2B_API_KEY=<你的 Key> \
  -e E2B_API_URL=http://192.168.36.222:3000 \
  -e E2B_SANDBOX_URL=http://192.168.36.222:3002
```

漏掉 `E2B_SANDBOX_URL` 的典型表现：`e2b template list` 正常，`e2b sandbox exec` 报
`SandboxNotRunningError`——模板列表走控制面，命令行执行走数据面。

---

## 4. 常用流程

### 4.1 跑一条命令就完事（自动建、自动销毁）

```bash
node <skill-dir>/e2b_ctl.js exec "uname -a"
node <skill-dir>/e2b_ctl.js exec -t code-interpreter "python3 -c 'print(1+1)'"
```

不传 `-s` 时它建一个临时沙箱，命令跑完立即 kill，不留垃圾。

### 4.2 建一个持久沙箱，反复用

```bash
# 建
node <skill-dir>/e2b_ctl.js create -t claudecode --timeout 3600 -e FOO=bar --json
# → {"sandbox_id": "i...", ...}

# 用（每次连上都会续租，所以长任务期间不会到期）
node <skill-dir>/e2b_ctl.js exec -s <ID> "git clone https://github.com/x/y.git"
node <skill-dir>/e2b_ctl.js exec -s <ID> --cwd /home/user/y "npm test"

# 用完必须销毁
node <skill-dir>/e2b_ctl.js kill <ID>
```

### 4.3 传文件

```bash
node <skill-dir>/e2b_ctl.js upload -s <ID> ./src /home/user/app
node <skill-dir>/e2b_ctl.js download -s <ID> /home/user/app/dist ./dist
node <skill-dir>/e2b_ctl.js write-file -s <ID> /home/user/conf.json '{"debug":true}'
node <skill-dir>/e2b_ctl.js read-file -s <ID> /home/user/out.log
```

### 4.4 派发一个跑很久、之后不关心的任务

`launch` 是"启动完就不管"：命令在沙箱里 `setsid` 脱机运行，本地立刻返回，沙箱到点自然回收。

```bash
node <skill-dir>/e2b_ctl.js launch --for 40m --name nightly-etl \
  -- "cd /home/user/job && ./run-etl.sh"
```

`--for` 必填，是**你预计任务要跑多久**。沙箱租期自动取 `预计时长 + 20% 余量`（夹在 1~10 分钟），
所以不用手工算租期。`--for` 支持 `30s` / `40m` / `2h` / `2d`。

返回里有 `log`、`exit_file`、`ends_at`。事后想看结果得另开连接（会续租，注意加 `--timeout`）。

### 4.5 管理模板

```bash
node <skill-dir>/e2b_ctl.js list-templates
node <skill-dir>/e2b_ctl.js build-template my-env --from-template base --run-cmd "pip install pandas numpy"
node <skill-dir>/e2b_ctl.js build-status <TEMPLATE_ID> <BUILD_ID>
node <skill-dir>/e2b_ctl.js build-logs <TEMPLATE_ID> <BUILD_ID>
```

在已有模板上增量构建能复用层缓存，最快。构建过程会再起一个构建沙箱。

**`--run-cmd` 以模板的默认用户身份执行，不是 root**；要装系统包得自己加 `sudo -n`：

```bash
# 注意先 apt-get update，否则 docker.io 这类包会报 "Unable to locate package"
node <skill-dir>/e2b_ctl.js build-template my-env --from-template e2b-cli \
  --run-cmd 'sudo -n sh -c "apt-get update && apt-get install -y docker.io"'
```

**关于磁盘大小，本集群的实际情况：**

`--disk MB` 对应服务端的 `minFreeDiskMb`（构建结束后要求根分区至少还剩这么多可用空间，
服务端上限 25600），但这个扩容阶段由编排器的特性开关 `build-ensure-free-disk-space`
控制，**本集群没有开**。实测 `--disk 6000` 从 813 MB 的模板构建，结果仍是 813 MB；
`--disk 24000` 和 `--disk 2000` 建出来的模板也都是同一个磁盘大小。**所以 `--disk`
目前不改变生成模板的磁盘，别指望它。**

模板磁盘实际来自基础：

- `--from-template X`：**完全继承 X 的磁盘**，构建步骤只往里写。写满就构建失败。
- `--from-image Y`：构建时工作空间由团队配额 `disk_mb` 决定。

要更大的盘，选一个本身就大的基础模板（`e2b-cli` 22 GB、`codex` 22 GB、`claudecode`
23 GB），或者在自己的部署里打开上面那个服务端开关。磁盘只会长不会缩。

### 4.6 装环境：在一个沙箱里迭代，别反复重建

`build-template --run-cmd` 适合**已经写死的一串命令**。但探索阶段（装哪个包、路径对不对、
服务起不起来）没人能一次写对，这时候反复 `build-template` 或反复 `create` 都是浪费：
每次都要等一轮构建/启动，还得重新回到刚才那一步。

正确做法是**一个沙箱走到底**：

```bash
# 1. 建一个工作沙箱，租期给够（续租靠每次连上自动延长）
node <skill-dir>/e2b_ctl.js create -t base --timeout 3600 --dns 8.8.8.8

# 2. 阶段验证：每一步都在同一个沙箱里做
node <skill-dir>/e2b_ctl.js exec -s <ID> -- 'sudo apt-get update && sudo apt-get install -y x11vnc'
node <skill-dir>/e2b_ctl.js exec -s <ID> -- 'pgrep -x x11vnc || (x11vnc --version >/dev/null)'
```

某一段验证通过了，而你要离开一会儿或做别的实验，先**打快照**保存现场：

```bash
node <skill-dir>/e2b_ctl.js snapshot <ID> --name my-env-step2
# → Snapshot created: local-dev-team/my-env-step2:default
```

快照是一个**独立的模板**，直接能当模板名用：

```bash
node <skill-dir>/e2b_ctl.js create -t local-dev-team/my-env-step2
```

全部步骤都通过后，对最终那个沙箱再打一次快照，就是成品模板：

```bash
node <skill-dir>/e2b_ctl.js snapshot <ID> --name my-env --json
```

几点说明：

- 快照**期间源沙箱会被暂停**，打完自动恢复，不用手动 resume。
- 不给 `--name` 时由服务端命名，返回里看 `snapshot_id`。
- 同名快照再次打，会给**同一个模板**追加新版本，不新建模板。
- **`--fs-only` 在本集群用不了**：服务端报 `Snapshots without memory (memory: false)
  are not enabled for this team`。全量快照（带内存）才通。
- 全量快照的体积约等于客户机常驻内存，尽量在装的包稳定后再打，别每改一行就打一次。
- 快照和 `build-template` 产物在同一个模板命名空间里，用 `list-templates` 都能看到，
  用 `delete-template` 都能删。

**对比 `build-template --run-cmd`**：那条路可复现、可重放，适合已经稳定的步骤；
这条路适合探索和搭环境。搭好了再把最终命令序列整理成 `--run-cmd` 固化，两件事不冲突。

---

## 5. 出网

出网规则直接用 SDK 的 `network` 对象，CLI 不额外包装，原样透传给服务端：

```bash
node <skill-dir>/e2b_ctl.js create -t <tpl> --network '{"denyOut":["0.0.0.0/0"]}'
node <skill-dir>/e2b_ctl.js create -t <tpl> --network-stdin < net.json
```

字段与 `Sandbox.create({ network })` 完全一致（`node_modules/e2b/dist/index.d.ts`
的 `SandboxNetworkOpts`）：

| 字段 | 作用 |
|---|---|
| `allowOut` | 放行列表：CIDR / IP / 域名 / `*.domain` |
| `denyOut` | 拒绝列表；放行项优先于拒绝项 |
| `dnsServers` | 放行到这些 DNS 的流量（不改 `resolv.conf`，见 5.4） |
| `rules` | 按域名改写请求（`{ domain, transform }`） |
| `egressProxy` | 出网代理 |
| `allowInternetAccess` | 布尔；`false` 等价于 `denyOut:["0.0.0.0/0"]` |
| `httpsPorts` | 额外按 HTTPS 处理的端口 |

**没有 `allowIn`**，也没有任何内网方向的字段——E2B 的 network 是单向的出网模型。
内网段由 orchestrator 硬拒绝，见 5.3。

不传 `--network` 时服务端默认**全部放行**。

### 5.1 七种常见需求怎么写

**1) 不开放网络** —— 完全离线，只剩沙箱内的 envd 控制面

```bash
--network '{"denyOut":["0.0.0.0/0"]}'
```

**2) 开放外网，不开放内网** —— 最常用的默认形态

```bash
# 不传 --network 就是外网全开；内网默认就被拒
--dns 8.8.8.8
```

**3) 开放外网 + 开放内网** —— 内网是集群级开关，见 5.3

```bash
# 宿主机上给 orchestrator 设 ALLOW_SANDBOX_INTERNAL_CIDRS=192.168.36.0/24 并重启
--dns 8.8.8.8
# 若还要解析内网域名，DNS 要指向内网 DNS：--dns 192.168.36.x
```

**4) 不开放外网，只开放内网** —— 同样依赖 5.3 的集群开关

```bash
# 宿主机上设 ALLOW_SANDBOX_INTERNAL_CIDRS=192.168.36.0/24
--network '{"denyOut":["0.0.0.0/0"]}' --dns 192.168.36.x
```

`denyOut:["0.0.0.0/0"]` 这条规则**排在**集群级内网放行之后，所以内网仍然可达，
外网被关掉——这正是想要的组合。DNS 也必须用内网 DNS，用 `8.8.8.8` 解析不了
内网域名（且它的流量已被 deny）。

**5) 只开放外网某个网站 + 开放内网**

```bash
# 宿主机上设 ALLOW_SANDBOX_INTERNAL_CIDRS=192.168.36.0/24
--network '{"allowOut":["api.example.com"],"denyOut":["0.0.0.0/0"]}' --dns 8.8.8.8
```

沙箱参数里没有任何一项能打开内网，真正生效的只有宿主机那个变量。
在 `allowOut` 里写内网网段不会报错，但也不会生效。

**6) 开放外网所有权限，只限制内网部分地址**

内网白名单/黑名单无法按沙箱做（见 5.3）。若必须细粒度控制内网，
只能在 `ALLOW_SANDBOX_INTERNAL_CIDRS` 里列出允许的网段——这是节点级、
对全部沙箱生效的。

```bash
--dns 8.8.8.8
# 内网范围由宿主机 ALLOW_SANDBOX_INTERNAL_CIDRS 决定
```

**7) 只开放部分外网地址**

```bash
--network '{"allowOut":["api.example.com","*.npmjs.org","1.1.1.0/24"],"denyOut":["0.0.0.0/0"]}'
# 有域名时 denyOut 必须含 0.0.0.0/0，否则服务端 400
```

### 5.1.1 七种需求速查

| # | 需求 | network 写法 | 内网是否可达 |
|---|---|---|---|
| 1 | 不开网络 | `{"denyOut":["0.0.0.0/0"]}` | 否 |
| 2 | 外网开、内网关 | 不传 | 否 |
| 3 | 外网开、内网开 | 不传 + 宿主机 `ALLOW_SANDBOX_INTERNAL_CIDRS` | 是 |
| 4 | 外网关、内网开 | `{"denyOut":["0.0.0.0/0"]}` + 宿主机变量 | 是 |
| 5 | 外网单站点 + 内网 | `{"allowOut":["<站点>"],"denyOut":["0.0.0.0/0"]}` + 宿主机变量 | 是 |
| 6 | 外网全开、内网部分 | 不传 + 宿主机变量列网段 | 部分 |
| 7 | 外网部分地址 | `{"allowOut":[...],"denyOut":["0.0.0.0/0"]}` | 否 |

所有需求都必须考虑 DNS：只要涉及域名访问，就带上 `--dns`，详见 5.4。

### 5.2 白名单的匹配规则（实测）

| `allowOut` 写法 | 效果 |
|---|---|
| `example.com` | 只匹配 `example.com` 本身，`www.example.com` **不通** |
| `*.example.com` | 匹配任意子域，裸域 `example.com` **不通** |
| `1.1.1.0/24` | 整个网段：`1.1.1.1` 通、`1.0.0.1` 不通 |
| `1.1.1.1` | 单主机（等价 `/32`） |

裸域和通配符都要时两个都写：`["example.com","*.example.com"]`。

服务端还有一条硬约束：`allowOut` 里出现**域名**时，`denyOut` 必须含
`0.0.0.0/0`，否则创建 400：

```
When specifying allowed domains in allow out, you must include 'ALL_TRAFFIC' in deny out
```

纯 IP/CIDR 的白名单不受这条约束，但建议也写 `denyOut`——没有它时
`allowOut` 只是「额外放行」，其余流量照样通。

### 5.3 内网：沙箱参数管不了

**`allowOut` 写内网网段不会生效。** 私有地址段
（`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`100.64/10`）
被硬编码在 orchestrator 的 `predefinedDenySet` 里，且那条 DROP 规则排在用户放行
规则**之前**（`packages/orchestrator/pkg/sandbox/network/firewall.go`，Rule 3 早于 Rule 4）。

实测表现：

- `allowOut:["192.168.36.0/24"]` → 内网目标仍 000 超时，外网反而通
- `allowOut:["192.168.36.0/24"], denyOut:["0.0.0.0/0"]` → 创建直接 **500**
- 沙箱内 `ip route` 只有 `default via 169.254.0.22`，网关 TCP 不通

真正的开关是 **orchestrator 的环境变量**，它进 `predefinedAllowSet`
（Rule 2，排在拒绝规则之前），所以能放行：

```bash
# 宿主机上，写进 compose 的 orchestrator environment 或 .env
ALLOW_SANDBOX_INTERNAL_CIDRS=192.168.36.0/24,10.0.0.0/8
```

改完必须重启 orchestrator 才生效：

```bash
docker compose -f /home/e2b-data/e2b-embed/compose.yaml up -d orchestrator
```

**这个开关是集群级的，对该节点上所有沙箱生效**，不能按沙箱单独设置。
开放内网意味着该节点上运行的所有沙箱（包括不可信代码）都能访问该网段，
属于安全放宽，改动前应确认影响面。

### 5.4 DNS

DNS 有**两个完全独立**的层面，混淆是最常见的踩坑点：

| 层面 | 参数 | 作用 |
|---|---|---|
| 防火墙 | `network.dnsServers` | 只决定放不放行**到该 DNS 的流量**，不改解析配置 |
| 解析 | `--dns` | 真正写进沙箱 `/etc/resolv.conf` 的 nameserver（CLI 自己执行，非 SDK 字段） |

`--dns` **只写 `resolv.conf`，不放行任何防火墙流量**。只给 `--dns` 而没放行
该 DNS 的流量，解析请求会被丢弃。两个层面都要给到：

```bash
node <skill-dir>/e2b_ctl.js create -t <tpl> \
  --network '{"allowOut":["example.com"],"denyOut":["0.0.0.0/0"]}' \
  --dns 1.1.1.1
# 这样 1.1.1.1 的解析仍然会失败——dnsServers 没写进去
```

正确写法是把 DNS 也放进 `network.dnsServers`：

```bash
node <skill-dir>/e2b_ctl.js create -t <tpl> \
  --network '{"allowOut":["example.com"],"denyOut":["0.0.0.0/0"],"dnsServers":["1.1.1.1"]}' \
  --dns 1.1.1.1
```

**SDK 的默认值**：`allowOut` 里出现域名时，`dnsServers` 不写就默认放行 `8.8.8.8`
（见 `SandboxNetworkOpts.dnsServers` 的类型注释）。所以白名单模式下用
`--dns 8.8.8.8` 恰好能通，换任何别的 DNS 都必须显式写 `dnsServers`。
这是最容易误判的一点：`--dns 8.8.8.8` 能通不代表 `--dns` 会放行流量。

**本集群的重要默认坑**：模板里 `resolv.conf` 写死 `nameserver 192.168.36.222`，
而该地址从沙箱内**不可达**（属于被拒的内网段）。所以**不显式传 `--dns` 时，
所有域名解析都会失败**，表现为 `curl` 全部 000——即使外网权限是全开的。
装包、拉依赖、访问任何域名之前，先确认带了 `--dns 8.8.8.8`。

```bash
# 设为默认，之后每次创建都自动带上
node <skill-dir>/e2b_ctl.js config-set --dns 8.8.8.8

# 查看当前生效值
node <skill-dir>/e2b_ctl.js config-get
```

常见 DNS 选择：

| 场景 | 建议 |
|---|---|
| 一般外网访问、默认放行 | `--dns 8.8.8.8`（SDK 默认放行的就是它） |
| 用别的公共 DNS | 必须同时写 `network.dnsServers:["1.1.1.1"]` |
| 内网域名解析 | `--dns <内网 DNS IP>`，且该 IP 必须在 `dnsServers` 或 `ALLOW_SANDBOX_INTERNAL_CIDRS` 里 |
| 完全离线（`denyOut 0.0.0.0/0`） | DNS 无意义，解析必然失败；IP 直连也不行（外网全关） |

多个 DNS 用逗号分隔：`--dns 8.8.8.8,1.1.1.1`。

外网全关时若要访问内网（见 5.3），内网 DNS 需出现在
`ALLOW_SANDBOX_INTERNAL_CIDRS` 里，否则解析该内网域名同样不通。

### 5.5 把开关存成默认值

```bash
# 之后所有 create/exec/launch 都用这套规则
node <skill-dir>/e2b_ctl.js config-set \
  --network '{"allowOut":["api.example.com"],"denyOut":["0.0.0.0/0"]}' --dns 8.8.8.8
```

---

## 6. 持久卷

卷独立于沙箱存在，可以挂到不同沙箱，也能免沙箱直接读写（需集群部署开启 volumes 能力）。

```bash
node <skill-dir>/e2b_ctl.js volume-create my-data --json
node <skill-dir>/e2b_ctl.js volume-list
node <skill-dir>/e2b_ctl.js volume-destroy my-data

# 旁路读写：不拉沙箱
node <skill-dir>/e2b_ctl.js volume-mkdir my-data /dataset
node <skill-dir>/e2b_ctl.js volume-write my-data /dataset/train.csv --from-file ./train.csv
node <skill-dir>/e2b_ctl.js volume-read my-data /dataset/train.csv
node <skill-dir>/e2b_ctl.js volume-ls my-data /dataset

# 只能在创建时挂载，不能给运行中的沙箱追加
node <skill-dir>/e2b_ctl.js create --mount my-data:/mnt/data --json
```

已知限制（当前集群实测，挂载在沙箱内表现为一个 NFSv3 网络盘）：

- **模板里必须有 `mount` 命令**。`claudecode` 可以；`trendy-alpine` 这类极简镜像没有，
  挂载会 500。
- 硬链接（`ln`）失败、`flock`/`fcntl` 文件锁挂起、稀疏文件空洞丢失、`df` 显示的空间不可信。
  需要这些行为的程序不要放在卷上跑。
- 挂载是 `hard` 模式：后端抖动时表现为**卡住**而不是报错。
- 卷没有配额。

---

## 7. 生命周期与超时

三个量互相独立，别混为一谈：

| 参数 | 管什么 | 默认 |
|---|---|---|
| `--timeout` | **租期**。沙箱最长活多久，到点按 `--on-timeout` 处理 | 配置里的 `default_timeout_seconds`（300s） |
| `--max-timeout` | **单次命令的硬截止**。到点中止命令，返回 124 | 前台 0（不设）；`--background` 时 3600s |
| `--for`（`launch`） | 你**预计任务跑多久**，用于自动算租期 | 必填，无默认 |

要点：

- 每次连上沙箱执行操作都会**续租**，所以租期不是"总时长"，而是"多久不活动就回收"。
- 连已有沙箱（`-s`）时只延长不缩短——防止把 `launch` 派发的长任务沙箱缩短掉。
- `exec` 有输出不等于有进展，静默也不判失败；失败只看退出码。

### 到期行为

默认 `kill`，直接回收。绝大多数场景就该这样：沙箱是一次性环境，任务做完自然消失。

只有**中间状态无法从磁盘重建**（进程要接着跑、内存上下文不能丢）且租期不够长时，才用挂起：

```bash
node <skill-dir>/e2b_ctl.js launch --for 2h --on-timeout pause -- "cd /home/user/job && ./run-etl.sh"
node <skill-dir>/e2b_ctl.js resume <ID> --timeout 1800
```

三种取值：

| 值 | 快照内容 | resume 表现 |
|---|---|---|
| `kill`（默认） | 无 | 无法恢复 |
| `pause` | 内存 + 磁盘 | 原地恢复，进程和连接都在 |
| `pause:filesystem` | 只有磁盘 | 冷启动，进程与内存状态全丢 |

`--auto-resume` 让挂起的沙箱被入站流量唤醒，不用人工 `resume`；必须配 `pause`，
不能和 `pause:filesystem` 同用（磁盘快照没有内存可原地恢复）。

挂起的沙箱会一直占团队快照配额，没人 resume 就一直占着。快照体积约等于客户机常驻内存。
**能用磁盘重建状态的任务，别用 pause**——直接 `--timeout` 给够。

---

## 8. 退出码

| 退出码 | 含义 | 处理 |
|---|---|---|
| `0` | 成功 | — |
| 其他 `1~255` | 沙箱内命令的原生退出码 | 按命令语义处理 |
| `124` | 命中 `--max-timeout` 硬截止 | 拆分任务或加长截止 |
| `125` | 连接断开 / 租约丢失 | 重新建沙箱；确认 `--timeout` 够长 |

`126` 预留给"沙箱因空闲被回收"，当前版本尚未在 `e2b_ctl.js` 中返回。

---

## 9. 排错

**`Invalid authorization header` / 401**：API Key 没配或过期。`config-get --json` 看
`api_key` 的 `sources` 是哪来的。

**模板列表正常但 `exec` 报 `SandboxNotRunningError`**：`sandbox_url` 配错或缺失，
数据面连不上。

**`Failed to place sandbox`**：集群资源不足（内存池、磁盘）。先 `list` 看看有没有闲置沙箱可以 kill。

**沙箱一建就消失**：`--timeout` 太短，或者 `create` 后没有在租期内连上。`info <ID>` 看
`endAt`。

**`--mount` 报 500 `failed to unmount stale NFS mount`**：模板里缺 `findmnt`/`mount`
之类的基础工具，换一个完整点的模板。

**大目录 `upload` 中途失败**：上传期间会持续续租，但如果本地网络断了，沙箱可能在传完前到期。
给 `--timeout` 留足余量。

**想看详细堆栈**：`E2B_DEBUG=1 node ...`。

---

## 10. 从浏览器访问沙箱内的服务

集群在 `192.168.36.222:8080` 上有一个反向代理，按 **path 前缀** 分发，
不需要配 Host 头、也不需要在本地自己搭代理：

```
http://192.168.36.222:8080/sbx/<sandbox-id>:<port>/<path>
```

例如沙箱 `abc123` 里跑了 6080 端口的 noVNC：

```
http://192.168.36.222:8080/sbx/abc123:6080/vnc.html
```

代理会把 `/sbx/` 后面解析成沙箱 ID 和端口，去掉前缀后转发到对应沙箱。
端口省略时用默认端口。

另外，访问根路径 `http://192.168.36.222:8080/` 会弹出一个输入框，
填一次沙箱 ID 后写进 cookie，之后的请求都按 cookie 里的 ID 分发——
适合那些不认路径前缀的站点。

noVNC 有个额外细节：它的 JS 会把 WebSocket 地址拼成绝对路径，路径前缀模式下
会丢掉 `/sbx/<id>:<port>` 前缀。代理已经自动补 `?path=` 参数处理这件事，
直接用上面的 URL 即可。
