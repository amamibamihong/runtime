# 沙箱模板说明

本集群模板库里所有可用模板的逐项介绍：装了什么、什么规格、适合什么场景、
创建时怎么用。分两类：

- **通用模板**——命令行、浏览器、多语言、桌面、IDE 等工作环境；
- **AI 代理模板**——预装了各类编码代理 CLI，还需要你自己的账号或 API Key。

> 规格与命令在 2026-11-06 于本集群实测。模板内容会随重建变化，
> 拿不准时用 `exec -t <别名> 'command -v <命令>'` 现场探测。
> 当前集群的实际列表以 `node e2b_ctl.js list-templates` 为准。

---

## 模板总览

### 通用模板

| 模板别名 | 是什么 | 基础镜像 | 规格 (vCPU/内存/磁盘) |
|---|---|---|---|
| `base` | 官方标准极简通用基础镜像（**构建模板的默认基础起点**） | Debian | 2 / 1024 MB / 1 GB |
| `trendy-alpine` | 极简 Alpine，启动最快 | Alpine 3.24 | 2 / 1024 MB / 0.8 GB |
| `trendy-browser` | Chromium + Xvfb 浏览器环境 | Ubuntu 24.04 | 2 / 2048 MB / 3.5 GB |
| `trendy-dev-languages` | 多语言编译环境 | Ubuntu 24.04 | 2 / 2048 MB / 2.5 GB |
| `playwright` | Playwright + Chromium 自动化 | Debian 12 | 2 / 2048 MB / 3.3 GB |
| `chrome` | 精简 Chromium | Debian 13 | 2 / 2048 MB / 2 GB |
| `code-interpreter` | 多版本 Python / Go / Java | Ubuntu 24.04 | 2 / 2048 MB / 9 GB |
| `desktop` | X11 桌面 + VNC | Ubuntu 22.04 | 2 / 1024 MB / 1.6 GB |
| `multica-desktop` | Multica 桌面客户端 + multica/claude/codex/opencode + noVNC | Debian 12 | 2 / 2048 MB / 23 GB |
| `vscode` | code-server 远程 IDE | Debian 12 | 2 / 2048 MB / 1.8 GB |
| `e2b-cli` | 内置 E2B CLI，可在沙箱内反向管理 E2B 资源 | Debian 12 (bookworm-slim) | 2 / 1024 MB / 22 GB |
| `docker` | Docker 全家桶，沙箱内可跑容器 | Debian 12 (bookworm-slim) | 2 / 4096 MB / 22 GB |

### AI 代理模板

| 模板别名 | 是什么 | 主命令 | 规格 (vCPU/内存/磁盘) |
|---|---|---|---|
| `claudecode` | 精简 Claude Code 环境，Node 22 + Python 3（**默认模板**） | `claude` | 2 / 2048 MB / 23.2 GB |
| `trendy-agent-cli` | 旧的 Claude Code 环境（**已废弃**，用 `claudecode` 代替） | `claude` | 2 / 2048 MB / 2.5 GB |
| `codex` | OpenAI Codex CLI，终端编码代理 | `codex` | 2 / 2048 MB / 22 GB |
| `cursor-agents` | Cursor 官方的命令行 agent | `cursor-agent`、`agent` | 2 / 2048 MB / 22 GB |
| `opencode` | 开源的终端 AI 编码代理 | `opencode` | 2 / 2048 MB / 2.5 GB |
| `openclaw` | 多渠道聊天网关 + agent | `openclaw` | 2 / 4096 MB / 2.5 GB |
| `droid` | Factory 的终端编码代理 | `droid` | 2 / 4096 MB / 2.5 GB |
| `pi` | 轻量编码助手，内置读写/执行工具 | `pi` | 2 / 2048 MB / 2.5 GB |
| `grok` | xAI 的 Grok 终端代理 | `grok` | 2 / 2048 MB / 2.5 GB |
| `hermes` | Nous Research 的开源 agent | `hermes` | 2 / 2048 MB / 2.5 GB |
| `langchain` | Python 库环境（不是 CLI） | `python3` | 2 / 4096 MB / 2.5 GB |
| `mcp` | MCP Inspector，调试 MCP server | `mcp-inspector` | 2 / 2048 MB / 2.5 GB |

---

## 通用模板

创建时用 `-t` 指定，例如 `node e2b_ctl.js exec -t trendy-alpine "..."`。

### `trendy-alpine` — 极简启动

Alpine 3.24，Python 3、git、curl、jq。磁盘不到 1 GB，是所有模板里拉起最快的，
适合秒级探测、连通性检查、轻量脚本。没有 glibc，预编译的 x86_64 二进制多半跑不起来。

```bash
node e2b_ctl.js exec -t trendy-alpine "cat /etc/os-release && nslookup baidu.com"
```

### `trendy-dev-languages` — 多语言编译

Ubuntu 24.04，Python 3.12、Node.js/npm、gcc、Java、git。用于跨语言编译和构建。
注意 Go 和 Rust 不在里面。

```bash
node e2b_ctl.js exec -t trendy-dev-languages "gcc --version && java -version"
```

### `trendy-browser` — 浏览器环境

Ubuntu 24.04，Chromium + Xvfb + Node.js/npm + Python 3。可在无显示器环境下跑
浏览器自动化或截图。有头模式需要 Xvfb。

```bash
node e2b_ctl.js exec -t trendy-browser "chromium --version"
```

### `playwright` — Playwright 自动化

Debian 12，Node.js 18.20、Python 3、Xvfb。专职 Playwright 端到端测试。
配套的 `e2b-playwright` 技能直接封装了它，做多步网页交互时优先用那个技能，
不必手写 Playwright 脚本。

### `chrome` — 精简 Chromium

Debian 13，只有 Chromium、git、curl、jq。没有 Python 和 Node——需要脚本驱动浏览器时
用 `trendy-browser` 或 `playwright`，这个模板只适合直接跑 Chromium 本身。

### `code-interpreter` — 多版本运行时

Ubuntu 24.04，带一个多语言版本切换器：

```bash
# 可用版本：python 3.10–3.14、go 1.23–1.25、java、node
source /opt/code-interpreter/code-interpreter-env.sh python 3.13
source /opt/code-interpreter/code-interpreter-env.sh go 1.25
```

注意：**numpy / pandas / matplotlib 需要自己装**（`uv` 已预装，比 pip 快），
不要假设开箱就有数据科学栈。磁盘 9 GB，是通用模板里最大的。

```bash
node e2b_ctl.js exec -t code-interpreter \
  "source /opt/code-interpreter/code-interpreter-env.sh python 3.13 && uv pip install --system numpy && python3 -c 'import numpy;print(numpy.__version__)'"
```

### `desktop` — 图形桌面

Ubuntu 22.04，Xvfb + x11vnc + websockify + noVNC。提供可远程连入的 X11 桌面。
需要真实图形界面交互（点按钮、看渲染效果）时用它；纯 DOM 操作不需要。

### `multica-desktop` — Multica 桌面 + 编码代理全家桶

Debian 12，把 Multica 平台的三样东西装进同一个桌面沙箱：

| 组件 | 说明 |
|---|---|
| `multica-desktop` | Multica 官方 Electron 桌面客户端（`/opt/Multica/multica-desktop`），开机自启 |
| `multica` CLI | 0.11.17，管理 agent / issue / daemon |
| `claude` / `codex` / `opencode` | 三个编码代理 CLI |
| noVNC 桌面 | Xvfb + openbox + x11vnc + websockify(6080)，xterm 默认可见 |

桌面由 `/usr/local/bin/start-desktop.sh` 这个 supervisor 拉起（systemd `Type=simple`
+ `Restart=always`，内部每 3 秒巡检各守护进程，崩了自动重拉）。

**Token 登录**。桌面客户端不读进程环境变量，它认启动参数里的深链
`multica://auth/callback?token=<token>`。模板预置了 `multica-login`（不含任何凭据），
它把环境变量里的 token 落到 `/run/e2b-multica/token`，supervisor 随即带深链重启客户端：

```bash
# 创建沙箱时注入 token（-e 注入，别写进模板）
node e2b_ctl.js create -t multica-desktop --timeout 3600 --dns 8.8.8.8 \
  -e MULTICA_TOKEN=mul_xxx

# 在这个沙箱里执行一次，桌面端自动登录
node e2b_ctl.js exec -s <ID> -e MULTICA_TOKEN=mul_xxx 'multica-login'
```

想让沙箱开机即登录，就一次把两件事同时做：在 `create` 时带上 `-e MULTICA_TOKEN=...`，
再 `exec` 一次 `multica-login`。`multica-login` 只读环境变量、不落任何明文到模板。

CLI 侧不需要 `multica-login`：`multica` 二进制原生识别 `MULTICA_TOKEN` 环境变量，
`-e MULTICA_TOKEN=... -e MULTICA_SERVER_URL=https://api.multica.ai` 之后
`multica auth status` 直接显示已登录。

访问桌面：
```bash
http://192.168.36.222:8080/sbx/<sandbox-id>:6080/vnc.html?autoconnect=1&resize=scale
```

### `vscode` — 远程 IDE

Debian 12，预装 code-server。适合需要一个 Web IDE 的工程场景：

```bash
node e2b_ctl.js exec -t vscode "code-server --version"
```

### `e2b-cli` — 沙箱内的 E2B 控制台

Debian 12 slim，Node 22 + `@e2b/cli`（`e2b` 命令，当前 2.23.0）+ git/curl/jq/python3。
用它在沙箱内部**反向管理 E2B 资源**：列模板、建沙箱、跑命令、打快照。
嵌套沙箱和当前沙箱是同级实例，跑在同一个集群里。

**必须同时给两个地址**，少一个就连不通：

| 环境变量 | 值 | 缺失后果 |
|---|---|---|
| `E2B_API_KEY` | 团队 API Key | 控制面 401 |
| `E2B_API_URL` | `http://<集群 API>:3000` | 走官方默认地址，连不上本集群 |
| `E2B_SANDBOX_URL` | `http://<集群数据面>:3002` | 模板列表正常，但 `exec` 报 `SandboxNotRunningError` |

第三个最容易漏：`E2B_API_URL` 只管控制面，`e2b sandbox exec` 走的是数据面（envd），
SDK 从 `E2B_SANDBOX_URL` 取地址，不给就会去解析官方域名。

```bash
# 1. 创建沙箱：注入 Key + 两个地址，并放行内网
node e2b_ctl.js create -t e2b-cli --timeout 1800 \
  --network '{"allowOut":["192.168.36.0/24"]}' \
  -e E2B_API_KEY=<你的 Key> \
  -e E2B_API_URL=http://192.168.36.222:3000 \
  -e E2B_SANDBOX_URL=http://192.168.36.222:3002 \
  --json

# 2. 在沙箱里用 e2b 命令
node e2b_ctl.js exec -s <ID> 'e2b template list'
node e2b_ctl.js exec -s <ID> 'e2b sandbox create trendy-alpine -d --timeout 300'
node e2b_ctl.js exec -s <ID> 'e2b sandbox exec <嵌套ID> "python3 -c \"print(1+1)\""'
node e2b_ctl.js exec -s <ID> 'e2b sandbox kill <嵌套ID>'
```

`e2b sandbox create` 默认会尝试接一个交互终端，非交互场景必须加 `-d`（detach），
否则会卡住。嵌套沙箱是独立计费的实例，用完记得 kill——外层沙箱销毁**不会**连带
回收它。

`e2b template create` 在沙箱内也可用，但构建过程会再起一个构建沙箱，注意别写成
递归构建自己。

### `docker` — 沙箱内再跑容器

Debian 12 slim + `docker.io`（dockerd 20.10 / containerd / runc / `docker` CLI），
4 GB 内存、22 GB 磁盘。客户机内核里 overlayfs、loop、iptables nat、cgroup2 都是齐的，
不需要 privileged。

```bash
node e2b_ctl.js exec -t docker 'docker info --format "{{.ServerVersion}} {{.Driver}}"'
node e2b_ctl.js exec -t docker 'docker images'
```

几件必须知道的事：

- **dockerd 随沙箱开机自启**。`docker.io` 包安装时就把 `docker.service` 挂进了
  `multi-user.target`，沙箱里 PID 1 是 systemd，所以第一条 `docker` 命令不用手动起
  守护进程。默认用户 `user` 已在 `docker` 组里，直接 `docker` 即可，不用 `sudo`。
- **镜像装在哪**：`/var/lib/docker`，就在根分区上。磁盘是从基础模板 `e2b-cli`
  继承来的（实测根分区 21 GB、可用 20 GB），不是 `--disk` 给的——本集群的扩容阶段
  被服务端开关关掉了，`--disk` 不生效（见 USAGE.md 4.5）。**镜像层跟模板自身的层
  抢同一块盘**，几个大镜像（每个几个 GB）就能填满。要更大就用更大的基础模板重走
  一遍构建。
- **日志上限**：`daemon.json` 里设了每容器 `max-size=50m`、`max-file=2`，容器狂打
  日志不会把根分区写满。存储驱动是 `overlay2`，不要改成 `vfs`（同样内容占几十倍空间）。
- **出网**：容器默认走 `docker0`（172.17.0.0/16）NAT，最终仍然出沙箱的 `eth0`，所以
  **E2B 的出网白名单对容器同样生效**——容器里访问不到没放行的地址，先在创建沙箱时
  用 `--network` 放行。实测本集群直连 `registry-1.docker.io` 是超时的（DNS 解析正常但
  443 握手不通），拉公共镜像需要在 `/etc/docker/daemon.json` 里配 `registry-mirrors`
  或在沙箱内改用内网 registry，这一步交给使用方按自己的网络环境决定。
- **不加 `--rm` 的容器会留在沙箱里**，连同镜像层一起占用磁盘；沙箱销毁时一并消失。
  镜像和容器都不跨沙箱保留——要复用就自己推到 registry，或者把镜像 tar 存到持久卷。

---

## 通用用法（先看这一节）

### 1. 参数与认证注入规范（创建时注入，使用时不传参）

**核心原则**：
1. **不要把 Key 写进模板**：模板是集群公共资源，构建进去的 Key 会泄露给所有使用该模板的人。
2. **在创建沙箱时通过环境变量统一设置**：包括 `API_KEY`、`BASE_URL` 以及 `MODEL`。E2B 沙箱在创建（`create`）时传入的环境变量在沙箱生命周期内持久生效，沙箱内的所有后续命令均可自动读取。
3. **不在使用时（exec）重复设置**：日常执行命令只负责派发业务指令，避免在每次调用时反复拼凑敏感参数。
4. **模型支持**：既可以使用官方默认模型，也支持指定官方自定义模型或自建网关模型。

标准创建模式：

```bash
# 模式 A：使用官方默认模型（仅需注入官方 Key）
node e2b_ctl.js create -t claudecode \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  --json

# 模式 B：使用官方 API + 自定义官方模型
node e2b_ctl.js create -t claudecode \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  -e ANTHROPIC_MODEL=claude-3-7-sonnet-20250219 \
  --json

# 模式 C：使用自建网关 / 中转站（自定义 base_url、token 与模型）
node e2b_ctl.js create -t claudecode \
  -e ANTHROPIC_BASE_URL=https://gw.example.com \
  -e ANTHROPIC_AUTH_TOKEN=xxx \
  -e ANTHROPIC_MODEL=my-custom-model \
  --json

# 创建完成后，后续使用无需传任何认证或模型参数：
node e2b_ctl.js exec -s <SANDBOX_ID> 'claude -p "你好"'
```

### 2. 交互式 TUI 不能直接用

这些 CLI 默认都是全屏 TUI，而 `exec` 没有 TTY，直接起会卡住或报
"requires an interactive terminal"。三种绕法：

- **用各自的一次性模式**（下文每个模板都给了），最省事；
- 需要多轮对话时用 `create` + 反复 `exec`，靠代理自己的 session 续接
  （`--continue` / `--resume`）；
- 真需要 TUI 就选 `desktop` / `vscode` 模板，用图形或 Web 终端连进去。

### 3. 让代理看到你的代码

代理都在沙箱里跑，必须先有文件：

```bash
# 创建时注入 Key 和模型
node e2b_ctl.js create -t codex -e OPENAI_API_KEY=sk-xxx --timeout 3600
node e2b_ctl.js upload -s <ID> ./my-project /home/user/my-project
# 执行时不再传 -e
node e2b_ctl.js exec -s <ID> \
  --cwd /home/user/my-project \
  'codex exec --skip-git-repo-check "跑一遍测试并修掉失败的用例"'
node e2b_ctl.js download -s <ID> /home/user/my-project/patch.diff ./patch.diff
node e2b_ctl.js kill <ID>
```

### 4. 出网

代理要访问模型 API，沙箱默认走控制面出网策略。要放行内网地址，
只能在 `create` / `launch` 时用 `--network` 指定；`exec -t` 起的临时沙箱
没有这个选项，会走默认网络：

```bash
# 创建时一并注入网络规则与认证环境变量
node e2b_ctl.js create -t codex --timeout 3600 \
  --network '{"allowOut":["192.168.36.0/24"]}' \
  -e OPENAI_API_KEY=sk-xxx
node e2b_ctl.js exec -s <ID> 'codex exec "hi"' '
```

### 5. 走自己的模型网关（base URL + 模型）

用官方账号时给个 API Key 就够了；**接自建网关、中转站、vLLM/Ollama 这类
OpenAI 兼容服务时，只给 Key 不够**，还要同时告诉 CLI 两件事：

1. **base URL**——请求发到哪；
2. **模型 ID**——网关上模型的真实名字，通常和官方名字不一样。

各 CLI 的配置方式差别很大：有的认通用环境变量，有的只认自己的配置文件，
还有的会静默忽略你以为会生效的变量。下表在沙箱里逐个实测过：

| 模板 | base URL 怎么设 | 模型怎么选 | 是否实测生效 |
|---|---|---|---|
| `codex` | `-c` 覆盖或 `~/.codex/config.toml` 定义 `model_providers.<id>`；**不认** `OPENAI_BASE_URL` | `-m <model>`，或 `-c model=<model>` | 是 |
| `cursor-agents` | `--endpoint <url>` 或 `CURSOR_API_ENDPOINT` | `--model <id>` | 是（但端点需是 Cursor 私有协议） |
| `opencode` | `~/.config/opencode/opencode.json` 里的 `provider.<id>.options.baseURL` | `-m <provider>/<model>` | 是 |
| `openclaw` | `openclaw onboard ... --custom-base-url <url>`，落到 `~/.openclaw/openclaw.json` | `--custom-model-id <id>` | 是 |
| `droid` | `FACTORY_API_BASE_URL` 或 `FACTORY_API_BASE_URL_EU` | `-m <id>` | 是 |
| `pi` | `~/.pi/agent/models.json`（或 `PI_CODING_AGENT_DIR` 指向的目录）里的 `providers.<id>.baseUrl` | `--provider <id> --model <model>` | 是 |
| `grok` | `~/.grok/config.toml` 的 `[model_providers.<id>] base_url`；**不认** `XAI_API_BASE_URL` | `[model.<id>]` 条目 + `-m <id>` | 是 |
| `hermes` | `hermes config set model.base_url <url>` | `hermes config set model.model <id>`，或 `-m` | 是 |
| `langchain` | 代码里 `ChatOpenAI(base_url=..., model=...)`，或 `OPENAI_BASE_URL` | 代码里传 `model=` | 是 |
| `mcp` | 不涉及（它连的是 MCP server，不是模型） | — | — |

两条通用规律：

- **先只改 base URL、模型仍用官方名字，多半会 404**。自建网关的模型名
  一般不同（`gpt-4o` → `my-gpt` 之类），两个参数要一起改。
- **验证是否真的生效**：把 base URL 指向一个不存在的地址（如
  `https://gw.invalid/v1`），再跑一次。如果立刻报连接错误而不是正常出结果，
  说明这台 CLI 确实在用你给的值；如果照常跑通，说明这个参数被忽略了。

下面每个模板的 "环境" 表格里都有对应的 base URL / 模型两行，配好即用。

---

## AI 代理模板逐个说明

### `claudecode` — Claude Code（默认模板）

**是什么**：本集群的默认模板，基于 `node:22-bookworm`，`npm install -g`
装最新版 Claude Code（当前 2.1.318）。带 Python 3.11、git、curl、jq、ripgrep
和常规系统工具（`vi` 可用，`vim` 没有），既是 Claude Code 的运行环境，
也是通用命令行环境。没有编译器和浏览器。

配套技能 `e2b-claudecode` 的 `start` / `run-claude` 用的就是它，如果需要多轮
Claude Code 会话，建议直接在创建沙箱时通过环境变量传入认证与网关信息，
这样在该沙箱内调用 `claude` 时自动生效，不必每次执行都拼 `-e` 参数。

```bash
# 推荐做法：创建时注入环境变量，后续在沙箱内直接运行 claude
node e2b_ctl.js create -t claudecode \
  -e ANTHROPIC_BASE_URL=https://gw.example.com \
  -e ANTHROPIC_AUTH_TOKEN=xxx \
  -e ANTHROPIC_MODEL=my-model \
  --json

# 此后该沙箱内 claude 命令直接走网关
node e2b_ctl.js exec -s <SANDBOX_ID> 'claude -p "hi"'
```

| 项 | 值 |
|---|---|
| 入口 | `claude`（TUI）、`claude -p "<prompt>"`（一次性） |
| 认证 | `ANTHROPIC_API_KEY`（官方），或 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`（网关） |
| 检查版本 | `claude --version` |
| 一次性执行 | `claude -p "<prompt>"` |
| 续接会话 | `claude --continue` / `claude --resume` |
| 模型 | 环境变量 `ANTHROPIC_MODEL` |
| base URL | 环境变量 `ANTHROPIC_BASE_URL` |

```bash
# 1. 官方 API + 默认模型（官方默认）
node e2b_ctl.js create -t claudecode \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  --json

# 2. 官方 API + 自定义模型
node e2b_ctl.js create -t claudecode \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  -e ANTHROPIC_MODEL=claude-3-7-sonnet-20250219 \
  --json

# 3. 自建网关（自定义 base_url、token 与模型）
node e2b_ctl.js create -t claudecode \
  -e ANTHROPIC_BASE_URL=https://gw.example.com \
  -e ANTHROPIC_AUTH_TOKEN=xxx \
  -e ANTHROPIC_MODEL=my-custom-model \
  --json

# 创建后，直接在沙箱内执行，无需再传入环境变量
node e2b_ctl.js exec -s <SANDBOX_ID> 'claude -p "列出 /tmp 下最大的 3 个文件"'
```

不需要 Claude Code、只跑普通命令时，也用这个模板（它是默认值，`-t` 可省略）。

### `trendy-agent-cli` — 已废弃

旧的 Claude Code 模板（Debian 12 + Claude Code 2.1.312）。保留在模板库里只为
兼容旧脚本，新的用法一律换 `claudecode`。

### `codex` — OpenAI Codex CLI

**是什么**：OpenAI 官方的终端编码代理。能读写文件、执行命令、按提示
完成多步骤的编码任务；`codex exec` 是非交互入口，`codex` 裸跑是 TUI。

**环境**：codex-cli 0.166.0，Node 22 + Python 3.10 + git + ripgrep，磁盘 21 GB。

| 项 | 值 |
|---|---|
| 认证 | `OPENAI_API_KEY` 环境变量；或 `printenv OPENAI_API_KEY \| codex login --with-api-key` |
| 检查登录 | `codex login status` |
| 一次性执行 | `codex exec --skip-git-repo-check "<prompt>"` |
| 续接会话 | `codex exec resume --last "<prompt>"` |
| 模型 | `-m <model>` |
| base URL | 只能走 `model_providers`（不认 `OPENAI_BASE_URL`） |

```bash
# 1. 官方 API + 默认模型
node e2b_ctl.js create -t codex -e OPENAI_API_KEY=sk-xxx --json
node e2b_ctl.js exec -s <SANDBOX_ID> --cwd /home/user/proj 'codex exec "总结这个仓库的架构"'

# 2. 官方 API + 自定义模型（如 o3-mini、gpt-5）
node e2b_ctl.js create -t codex -e OPENAI_API_KEY=sk-xxx -e CODEX_MODEL=o3-mini --json
```

`--skip-git-repo-check` 只在工作目录不是 git 仓库时需要，在项目里可省。
运行时会提示 `could not find bubblewrap`，会自动回退到内置的，不影响使用。

**接自建网关**：在 `-c` 里临时定义 provider（也可写进 `~/.codex/config.toml`）：

```bash
# 3. 自建网关（在创建时注入网关配置与 Key）
node e2b_ctl.js create -t codex \
  -e MYGW_KEY=sk-xxx \
  -e OPENAI_BASE_URL=https://my-gw.example.com/v1 \
  --json

# 执行命令
node e2b_ctl.js exec -s <SANDBOX_ID> \
  'codex exec --skip-git-repo-check -m my-gpt \
     -c model_provider=gw \
     -c "model_providers.gw.name=gw" \
     -c "model_providers.gw.base_url=https://my-gw.example.com/v1" \
     -c "model_providers.gw.env_key=MYGW_KEY" \
     -c "model_providers.gw.wire_api=responses" \
     "列一下当前目录的文件"'
```

`wire_api` 取 `responses` 或 `chat`，取决于网关照的是哪个接口。

---

### `cursor-agents` — Cursor Agent CLI

**是什么**：Cursor 官方的命令行 agent，把 Cursor 的编码能力搬到终端。
支持 plan/ask 只读模式、JSON 输出、模型切换，适合脚本化调用。

**环境**：2026.11.05-86047df，自带 Node 与运行时依赖，磁盘 21 GB。

| 项 | 值 |
|---|---|
| 可执行文件 | `cursor-agent`，另有别名 `agent` |
| 认证 | `CURSOR_API_KEY` 环境变量；或 `agent login`（浏览器/设备码） |
| 列模型 | `agent --list-models`（需要已认证） |
| 一次性执行 | `agent -p "<prompt>"`，可加 `--output-format json` |
| 只读模式 | `--mode plan` / `--mode ask` |
| 指定模型 | `--model <id>`，例如 `--model gpt-5` |
| base URL | `--endpoint <url>` 或 `CURSOR_API_ENDPOINT`（默认 `https://api2.cursor.sh`） |

```bash
# 创建沙箱注入 Key，可直接指定模型或自定义端点
node e2b_ctl.js create -t cursor-agents \
  -e CURSOR_API_KEY=cur_xxx \
  -e CURSOR_API_ENDPOINT=https://api2.cursor.sh \
  --json

# 执行时直接跑
node e2b_ctl.js exec -s <SANDBOX_ID> \
  --cwd /home/user/proj \
  'agent -p --output-format json "找出所有未处理的 TODO 并生成清单"'
```

未提供 Key 时直接报 `Authentication required`。

`--endpoint` 用于把请求发到自建/代理的 Cursor 后端（端点需实现
Cursor 的 `/auth/exchange_user_api_key` 等私有接口，不是 OpenAI 兼容网关）。
想走 OpenAI 兼容网关请用 `opencode` 或 `codex`。

---

### `opencode` — OpenCode

**是什么**：开源的终端 AI 编码代理。支持多家模型 provider，自带 TUI，
也能起无头 server（`opencode serve`）或 Web UI（`opencode web`），适合
接自有网关。

**环境**：1.19.5。

| 项 | 值 |
|---|---|
| 认证 | `opencode auth login`（交互），凭据落在 `~/.local/share/opencode`；也认 `ANTHROPIC_API_KEY` 等标准环境变量 |
| 列凭据/模型 | `opencode auth list`、`opencode models` |
| 一次性执行 | `opencode run "<prompt>"` |
| 无头服务 | `opencode serve` / `opencode web` |
| 会话管理 | `opencode session`、`opencode stats` |
| base URL + 模型 | `~/.config/opencode/opencode.json` 里定义自定义 provider |

```bash
# 1. 官方 API + 默认/自定义模型
node e2b_ctl.js create -t opencode -e ANTHROPIC_API_KEY=sk-ant-xxx --json
node e2b_ctl.js exec -s <SANDBOX_ID> \
  --cwd /home/user/proj \
  'opencode run "给 utils.py 补单元测试"'
```

**接自建网关**（OpenAI 兼容）：在创建沙箱时注入网关 Key，沙箱内先写配置，再用 `provider/model` 调用。

```bash
# 2. 自建网关（创建时注入 Key）
node e2b_ctl.js create -t opencode -e MYGW_KEY=sk-xxx --json

# 写入自定义 provider 配置并执行
node e2b_ctl.js exec -s <SANDBOX_ID> 'mkdir -p ~/.config/opencode && cat > ~/.config/opencode/opencode.json <<JSON
{"$schema":"https://opencode.ai/config.json",
 "provider":{"mygw":{
   "npm":"@ai-sdk/openai-compatible",
   "name":"My Gateway",
   "options":{"baseURL":"https://my-gw.example.com/v1","apiKey":"{env:MYGW_KEY}"},
   "models":{"my-gpt":{"name":"My GPT"}}}}}
JSON'
node e2b_ctl.js exec -s <SANDBOX_ID> 'opencode run -m mygw/my-gpt "hi"'
```

`opencode models mygw` 可以确认 provider 里的模型已被识别。

---

### `openclaw` — OpenClaw

**是什么**：把 Telegram / Slack / Discord 等聊天渠道接到同一个 agent
网关的工具，也能用 `--local` 跑嵌入式 agent 做单轮执行。适合"一个 agent
多个入口"的场景。

**环境**：OpenClaw 2026.9.2，内存 4 GB。

| 项 | 值 |
|---|---|
| 配置文件 | `~/.openclaw/openclaw.json`（用 `openclaw config file` 查路径） |
| 初始化 | `openclaw onboard --non-interactive --accept-risk --auth-choice <provider> ...`（provider 列表见 `openclaw onboard --help`） |
| 改配置 | `openclaw config get <dot.path>` / `openclaw config patch '<json5>'` |
| 一次性执行 | `openclaw agent --local -m "<prompt>"`（`--json` 输出结构化结果） |
| 健康检查 | `openclaw doctor` |
| 网页控制台 | `openclaw dashboard` |
| base URL + 模型 | `onboard` 的 `--custom-base-url` / `--custom-model-id` |

```bash
node e2b_ctl.js exec -t openclaw 'openclaw config file'
node e2b_ctl.js exec -t openclaw --cwd /home/user/proj \
  'openclaw agent --local -m "review 一下 main.py"'
```

`onboard` 会联网装插件，首次执行通常要一两分钟。没跑过 `onboard` 时
`openclaw agent --local` 会用内置默认模型（如 `openai/gpt-5.6-sol`）并报
`Unknown model`，所以要先 `onboard`（或 `config patch` 设好 provider 与
模型）再调用。

**接自建网关**：用 custom provider 完成初始化，模型与 base URL 一起指定。

```bash
node e2b_ctl.js exec -t openclaw \
  'openclaw onboard --non-interactive --skip-health --accept-risk \
     --auth-choice custom-api-key \
     --custom-base-url https://my-gw.example.com/v1 \
     --custom-api-key sk-xxx \
     --custom-model-id my-gpt \
     --custom-compatibility openai'
```

`--skip-health` 用来跳过本地 gateway 的健康探测（容器里没有常驻 gateway
时会报 `Gateway did not become reachable`，不影响配置写入）。
`--custom-compatibility` 取 `openai` / `openai-responses` / `anthropic`。
生成结果在 `~/.openclaw/openclaw.json` 的 `models.providers.<id>`，并自动
设为该 agent 的默认模型。

---

### `droid` — Factory Droid

**是什么**：Factory 的终端编码代理。有交互 TUI、`droid exec` 非交互模式，
以及 `resume` / `fork` 会话管理，支持自定义 autonomy 级别。

**环境**：1.3.0，内存 4 GB。

| 项 | 值 |
|---|---|
| 认证 | `FACTORY_API_KEY` 环境变量；或交互式 `/login` |
| 一次性执行 | `droid exec "<prompt>"`，可加 `--output-format json` |
| 自主级别 | `--auto low\|medium\|high` |
| 指定模型 | `-m <model-id>`（默认 `gpt-6.1-sol`） |
| base URL | `FACTORY_API_BASE_URL`，欧洲区用 `FACTORY_API_BASE_URL_EU` |
| 诊断 | `droid doctor`（检查网络、证书、代理、认证） |

```bash
# 1. 官方 API + 默认/自定义模型
node e2b_ctl.js create -t droid -e FACTORY_API_KEY=fk-xxx --json
node e2b_ctl.js exec -s <SANDBOX_ID> \
  --cwd /home/user/proj \
  'droid exec --auto medium "修掉 mypy 报出的类型错误"'

# 2. 自建网关（创建时注入 BASE_URL 与 Key）
node e2b_ctl.js create -t droid \
  -e FACTORY_API_KEY=fk-xxx \
  -e FACTORY_API_BASE_URL=https://my-gw.example.com \
  --json
node e2b_ctl.js exec -s <SANDBOX_ID> \
  --cwd /home/user/proj \
  'droid exec --auto medium -m my-gpt "修掉 mypy 报出的类型错误"'
```

`FACTORY_API_BASE_URL` 只改请求地址，不改认证方式；网关需要接受
Factory 的 API Key 格式，否则会报 `Invalid api key format`。

---

### `pi` — Pi coding agent

**是什么**：轻量终端编码助手，内置 read / bash / edit / write 四个工具，
支持多 provider、模型目录、会话续接与扩展安装。

**环境**：1.5.0。

| 项 | 值 |
|---|---|
| 认证 | 标准环境变量 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 等；或 `pi auth` 系列子命令 |
| 检查就绪 | `pi auth check --provider anthropic` → `ready` / `not_ready` |
| 一次性执行 | `pi -p "<prompt>"`，`--mode json` 输出结构化结果 |
| 指定模型 | `--provider <name> --model <pattern>` |
| 续接会话 | `-c` 继续当前目录最近会话，`-r` 选择会话 |
| 扩展 | `pi install <source>`、`pi list`、`pi mcp` |
| base URL + 模型 | `~/.pi/agent/models.json` 定义自定义 provider |

```bash
# 1. 官方 API + 默认/自定义模型
node e2b_ctl.js create -t pi -e ANTHROPIC_API_KEY=sk-ant-xxx --json
node e2b_ctl.js exec -s <SANDBOX_ID> \
  --cwd /home/user/proj \
  'pi -p --mode json "把 README 里的安装步骤补全"'
```

**接自建网关**：`pi` 的自定义 provider 写在 `models.json`（同目录下的
`auth.json` 存凭据，`PI_CODING_AGENT_DIR` 可以把整个目录挪走）。

```bash
# 2. 自建网关（创建时注入 Key）
node e2b_ctl.js create -t pi -e MYGW_KEY=sk-xxx --json
node e2b_ctl.js exec -s <SANDBOX_ID> 'mkdir -p ~/.pi/agent && cat > ~/.pi/agent/models.json <<JSON
{"providers":{"mygw":{
  "name":"My Gateway",
  "baseUrl":"https://my-gw.example.com/v1",
  "apiKey":"$MYGW_KEY",
  "api":"openai-completions",
  "models":[{"id":"my-gpt","name":"My GPT"}]}}}
JSON'
node e2b_ctl.js exec -s <SANDBOX_ID> 'pi -p --provider mygw --model my-gpt "hi"'
```

`apiKey` 写成 `$MYGW_KEY` 表示从环境变量插值（也支持 `!命令` 取输出）。
`api` 取 `openai-completions` / `openai-responses` / `anthropic-messages` /
`google-generative-ai`，要和网关的接口对上。`pi --list-models` 能确认
provider 与模型已注册。

---

### `grok` — Grok CLI

**是什么**：xAI 的 Grok 终端代理。支持单轮 `-p`、多轮 TUI、权限模式与
结构化输出，也能在无浏览器环境用设备码登录。

**环境**：grok 1.0.70。

| 项 | 值 |
|---|---|
| 认证 | `XAI_API_KEY` 环境变量；或 `grok login --device-auth`（无浏览器环境用设备码） |
| 一次性执行 | `grok -p "<prompt>"`，`--output-format plain\|json` |
| 权限模式 | `--permission-mode default\|acceptEdits\|auto\|plan` |
| 指定模型 | `-m <MODEL>` |
| 会话 | `-c` 续接最近会话、`--fork-session` 分叉 |
| base URL | 只能走 `~/.grok/config.toml`（不认 `XAI_API_BASE_URL`） |

```bash
# 1. 官方 API + 默认/自定义模型
node e2b_ctl.js create -t grok -e XAI_API_KEY=xai-xxx --json
node e2b_ctl.js exec -s <SANDBOX_ID> \
  --cwd /home/user/proj \
  'grok -p --output-format json "解释这个脚本做了什么"'
```

**接自建网关**：`grok` 的 `XAI_API_BASE_URL` 环境变量**不生效**（会被忽略，
仍然请求 `api.x.ai`），必须写 `~/.grok/config.toml`：

```bash
# 2. 自建网关（创建时注入 Key）
node e2b_ctl.js create -t grok -e MYGW_KEY=sk-xxx --json
node e2b_ctl.js exec -s <SANDBOX_ID> 'mkdir -p ~/.grok && cat > ~/.grok/config.toml <<TOML
[model.my-gpt]
model_provider = "gw"

[model_providers.gw]
name = "gw"
base_url = "https://my-gw.example.com/v1"
env_key = "MYGW_KEY"

[features]
remote_fetch = false
TOML'
node e2b_ctl.js exec -s <SANDBOX_ID> 'grok -m my-gpt -p "hi"'
```

要点：provider 段里的键是 `base_url`（不是 `api_base_url`，后者定义会被
忽略并静默回退到 `https://cli-chat-proxy.grok.com/v1`）；模型必须用
`[model.<id>]` 表声明，否则 `-m` 找不到它。`remote_fetch = false` 关掉
远端模型目录拉取，避免启动时卡在拉 `api.x.ai/v1/models` 的超时重试上。

---

### `hermes` — Hermes Agent（Nous Research）

**是什么**：Nous Research 的开源 agent，功能面较宽：多 provider 凭据池、
工具集选择、MCP、会话、网关、cron 等，既能在终端交互，也能当服务跑。

**环境**：v0.19.0，装在 `~/.local/bin/hermes`，并在 `/usr/local/bin/hermes`
有软链。

| 项 | 值 |
|---|---|
| 认证 | `hermes auth add/list/status`（凭据池）；或直接给 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 等 |
| 选模型 | `hermes model`（**必须交互终端**），或运行时用 `--provider`/`-m`，或 `HERMES_INFERENCE_MODEL=anthropic/claude-sonnet-4.6` |
| 一次性执行 | `hermes -z "<prompt>"`（oneshot） |
| 配置向导 | `hermes setup --non-interactive` |
| 状态 | `hermes status` |
| 其他 | `hermes mcp`、`hermes skills`、`hermes gateway`、`hermes cron` |
| base URL + 模型 | `hermes config set model.base_url` / `model.model` |

默认 provider 从配置或环境推导；不指定时可能落到 `gmi` 之类的默认项并报
`no usable credentials`。**稳妥写法是显式给 provider 和 model**：

```bash
# 1. 官方 API + 默认/自定义模型
node e2b_ctl.js create -t hermes -e ANTHROPIC_API_KEY=sk-ant-xxx --json
node e2b_ctl.js exec -s <SANDBOX_ID> \
  --cwd /home/user/proj \
  'hermes --provider anthropic -m claude-sonnet-4.6 -z "总结这个项目的入口"'
```

**接自建网关**：`hermes config set` 写进 `~/.hermes/config.yaml`，
四个键要一起设（`base_url` 直接连 OpenAI 兼容端点时优先级高于 provider）：

```bash
node e2b_ctl.js exec -t hermes \
  'hermes config set model.provider custom && \
   hermes config set model.base_url https://my-gw.example.com/v1 && \
   hermes config set model.api_key sk-xxx && \
   hermes config set model.model my-gpt'
node e2b_ctl.js exec -t hermes 'hermes -z "hi"'
```

`hermes config get model` 可以回读结果（`api_key` 显示为 `***`）。
写进 `config.yaml` 的 Key 留在沙箱内，别写进模板。

---

### `langchain` — Python 库环境

**是什么**：这不是一个 CLI，而是一个装好 LangChain 全家桶的 Python 环境，
用来写自己的 agent 脚本。

**环境**：`langchain` 1.4.9、`langgraph` 1.2.20、`deepagents` 0.7.32，
以及 `langchain-openai` / `langchain-anthropic` / `langchain-google-genai`；
另带 Claude Code 2.1.312 和 Node.js。内存 4 GB。

| 项 | 值 |
|---|---|
| 入口 | 自己写脚本，`python3` 跑 |
| 认证 | 各 provider 的标准环境变量（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY`） |

```bash
node e2b_ctl.js write-file -s <ID> /home/user/run_agent.py '
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI

agent = create_agent(ChatOpenAI(model="gpt-5"), tools=[])
print(agent.invoke({"messages": [{"role": "user", "content": "hi"}]}))
'
node e2b_ctl.js exec -s <ID> -e OPENAI_API_KEY=sk-xxx \
  'python3 /home/user/run_agent.py'
```

接自建网关时，`langchain-openai` 直接支持 `base_url` 参数（底层 openai SDK
也认 `OPENAI_BASE_URL`），模型名换成网关上的 ID：

```python
llm = ChatOpenAI(model="my-gpt", base_url="https://my-gw.example.com/v1",
                 api_key="sk-xxx")
```

Anthropic / Google 的对应写法是 `ChatAnthropic(base_url=...)` 和
`ChatGoogleGenerativeAI(...)`（后者走 `GOOGLE_API_USE_CLIENT_CERTIFICATE`
一类的 Vertex 配置，接第三方兼容网关时建议统一用 `ChatOpenAI`）。

---

### `mcp` — MCP Inspector

**是什么**：调试和验证 MCP server 的工具。三种模式：Web UI、CLI、TUI。
用它列工具、调工具、读资源，确认一个 MCP server 能不能正常握手。

**环境**：mcp-inspector 2.14.0。

| 项 | 值 |
|---|---|
| 模式 | `--web`（默认）、`--cli`、`--tui` |
| 列工具 | `mcp-inspector --cli <server 命令> --method tools/list` |
| 调工具 | `mcp-inspector --cli <server 命令> --method tools/call --tool-name <name> --tool-arg 键=值` |
| 读资源 | `mcp-inspector --cli <server 命令> --method resources/read --uri <uri>` |

```bash
node e2b_ctl.js exec -t mcp \
  'mcp-inspector --cli npx -y @modelcontextprotocol/server-filesystem /tmp --method tools/list --connect-timeout 0'
```

`--cli` 必须带 `--method`，只给 target 会报 `Method is required`。
用 `npx -y` 拉取 server 时，首次安装可能要一两分钟，会超过默认的 15 秒连接超时
并报 `unreachable`；加 `--connect-timeout 0`（不限时）或给一个足够大的毫秒值即可。
`--web` 在沙箱内监听端口，要从本机访问需要走沙箱地址；只做连通性验证时
用 `--cli` 更简单。

---

## 选哪个

**通用场景**

- 不知道选什么、跑命令跑脚本：`claudecode`（默认）
- 要最快启动、做连通性探测：`trendy-alpine`
- 要编译 C/Java、多语言构建：`trendy-dev-languages`
- 要 C/Python/Go/Java 多版本切换：`code-interpreter`
- 要浏览器自动化（多步网页交互）：`playwright` 模板 + `e2b-playwright` 技能
- 只要有头 Chromium 跑一跑：`trendy-browser`
- 只是驱动 Chromium 本身、不需要脚本运行时：`chrome`
- 要真实图形桌面、点按钮看渲染：`desktop`
- 要 Web IDE 写代码：`vscode`
- 要在沙箱里反向管理 E2B（建嵌套沙箱、列模板）：`e2b-cli`

**AI 代理场景**

- 用 Claude Code、或不知道选哪个：`claudecode`（默认，已预装 Claude Code）
- 想要最成熟的编码代理、已有 OpenAI 账号：`codex`
- 已有 Cursor 订阅：`cursor-agents`
- 想接自己的模型网关、要开源：`opencode` 或 `pi`
- 要把 agent 接到聊天渠道：`openclaw`
- 已有 Factory 账号：`droid`
- 已有 xAI 账号：`grok`
- 偏好 Nous Research 生态、需要 cron / gateway：`hermes`
- 要自己拼 agent 逻辑：`langchain`
- 验证 MCP server：`mcp`

## 常见问题

**`command not found`**：模板名写错，或该模板没装这个 CLI。先用
`node e2b_ctl.js exec -t <别名> 'command -v <命令>'` 探测。

**`Authentication required` / `no usable credentials`**：没传 `-e KEY=...`，
或传的变量名不是该 CLI 认的那个（见每个模板的"认证"行）。

**执行卡住无输出**：大概率是 CLI 进了 TUI 等 TTY。换一次性模式
（`-p` / `exec` / `run` / `-z`）。

**改了 base URL 但请求还发到官方域名**：多数 CLI 不认通用环境变量。
`grok` 忽略 `XAI_API_BASE_URL`，`codex` 忽略 `OPENAI_BASE_URL`，都必须写
各自的配置文件；详见"走自己的模型网关"一节的对照表。用
`https://gw.invalid/v1` 这类必然失败的地址验证一遍最可靠。

**网关连通但报 404 / model not found**：base URL 生效了，但模型名还是
官方名字。把 `-m` / `--model` 换成网关上注册的真实模型 ID。

**报 `Connection error` 或长时间无响应**：确认沙箱能出网到该地址；
内网网关需要在 `create` / `exec` 时用 `--network` 放行。

**长任务中途断开**：`exec` 默认跟随沙箱租期（默认 300 秒）。用
`create --timeout 7200` 或 `exec --timeout 7200`，任务长于 10 分钟时
改用 `--background` 配合 `jobs` / `logs`。

**想让配置在沙箱里长期有效**：写进该沙箱的 `~/.bashrc` 或对应工具的
配置目录（如 `~/.codex`、`~/.openclaw`、`~/.local/share/opencode`），
再用 `pause` / `resume` 保留；模板里不放任何个人凭据。
