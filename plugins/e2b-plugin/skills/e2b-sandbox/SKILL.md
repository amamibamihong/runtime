---
name: e2b-sandbox
description: E2B 微虚机与底层存储管控中心。负责沙箱实例生命周期管理（显式 create/kill/pause/resume/snapshot/list）、出网网络规则配置、独立持久卷管理（Volume CRUD 与旁路文件直接读写）以及沙箱级单次命令/长任务 launch。当需要底层实例生命周期运维、批量管理沙箱或维护持久卷时调用此技能；若仅需日常执行命令请优先调用 e2b-linux。
allowed-tools: bash
---

# E2B Sandbox 操作指南

本技能负责 E2B 微虚机（MicroVM）沙箱实例与持久卷（Volume）的底层资源管理。

> 面向人的完整说明（沙箱能力边界、安装配置、环境变量注入、超时语义、排错）见
> [USAGE.md](USAGE.md)；模板逐个介绍见 [TEMPLATES.md](TEMPLATES.md)。

所有操作均通过以下入口执行：
```bash
node <skill-dir>/e2b_ctl.js <command> [options]
```

---

## 1. 快速使用步骤

```bash
# 1. 临时跑一条命令（自动创建微虚机，执行完自动销毁）
node <skill-dir>/e2b_ctl.js exec "uname -a"

# 2. 创建一个持久沙箱（获取沙箱 ID，推荐在此通过 -e 注入 BASE_URL/API_KEY/MODEL 等环境变量）
node <skill-dir>/e2b_ctl.js create --timeout 600 \
  -e ANTHROPIC_BASE_URL=https://gw.example.com \
  -e ANTHROPIC_AUTH_TOKEN=xxx \
  -e ANTHROPIC_MODEL=my-model \
  --json
# 3. 指定该沙箱执行多条命令
node <skill-dir>/e2b_ctl.js exec -s <SANDBOX_ID> "git clone https://github.com/example/repo.git"
node <skill-dir>/e2b_ctl.js exec -s <SANDBOX_ID> --cwd /home/user/repo "npm test"

# 4. 彻底销毁沙箱（务必执行！）
node <skill-dir>/e2b_ctl.js kill <SANDBOX_ID>
```

### 到期行为（默认不用管）

**默认就是到点回收（`kill`）**，不需要任何参数。绝大多数场景下这是对的：沙箱是
一次性执行环境，任务做完、租期到点，沙箱自然消失，不留任何东西。

只有一种情况例外——**任务的中间状态无法从磁盘重建**（进程要接着跑、连接要保温、
内存里的上下文不能丢），而租期又不够长。这时才用 `--on-timeout pause` 让它在到点
时挂起而不是消失：

```bash
# 仅在这一种场景下才需要
node <skill-dir>/e2b_ctl.js launch --for 2h --on-timeout pause -- "cd /home/user/job && ./run-etl.sh"

# 之后手工唤醒（--auto-resume 则改为被入站流量唤醒）
node <skill-dir>/e2b_ctl.js resume <SANDBOX_ID> --timeout 1800
```

代价是挂起的沙箱会一直占着快照配额，没人 resume 就一直挂着。**能用磁盘重建状态
的任务，别用这个**——直接 `--timeout` 给够，让它到点回收即可。

挂起后默认不会自己醒，要显式 `resume`；加 `--auto-resume` 则改为被入站流量唤醒
（适合长期在线、偶发访问的服务型沙箱）。`--auto-resume` 必须配 `--on-timeout pause`，
且不能和 `pause:filesystem` 同用——磁盘快照没有内存可原地恢复，无法被流量透明唤醒。

`pause` 的快照体积基本等于**客户机常驻内存**，pause 时要把它写到本地缓存，所以
内存占用越大，挂起越慢、占得越多。要控制开销，最直接的是减少沙箱里的常驻：
跑完的进程及时退出，别让大对象一直撑着。`pause:filesystem` 跳过内存导出，只存
磁盘，体积小很多，代价是 resume 时冷启动，进程和未落盘的状态全丢（`/tmp` 下的
内容即使 `sync` 过也不保留，实测如此）。

---

## 2. 常用操作指令

### 沙箱生命周期与多实例运维
```bash
# 列出正在运行的沙箱（-a 显示全部，包括已暂停的）
node <skill-dir>/e2b_ctl.js list -a --json

# 查看特定沙箱的规格、运行时长与状态
node <skill-dir>/e2b_ctl.js info <SANDBOX_ID>

# 查看沙箱控制面事件日志（启动、挂起、回收等事件，非命令 stdout）
node <skill-dir>/e2b_ctl.js logs <SANDBOX_ID>

# 暂停沙箱（保存快照）与恢复沙箱
node <skill-dir>/e2b_ctl.js pause <SANDBOX_ID>
node <skill-dir>/e2b_ctl.js resume <SANDBOX_ID>

# 把运行中的沙箱就地固化成模板（不需要 Dockerfile 或重新构建）
node <skill-dir>/e2b_ctl.js snapshot <SANDBOX_ID> --name my-env --json
# 之后可直接用它当模板：create -t local-dev-team/my-env:default

# 销毁沙箱
node <skill-dir>/e2b_ctl.js kill <SANDBOX_ID>
```

搭建环境时**不要每改一步就重建沙箱或重跑 `build-template`**：在一个沙箱里连续做，
阶段性验证通过就 `snapshot` 留个版本，全部通过后再打最终快照当成品模板。
详见 USAGE.md 4.6。

### 纯离线后台任务派发 (`launch`)
用于启动后完全不关心过程与响应、预计运行一定时间后随沙箱自然回收的离线任务：
```bash
# 派发预计耗时 40 分钟的批处理（命令立即返回，在远端 setsid 脱机运行）
node <skill-dir>/e2b_ctl.js launch --for 40m --name nightly-etl \
  -- "cd /home/user/job && ./run-etl.sh"
```
*`--for` 为必填参数，支持 `30s`、`40m`、`2h` 等。*

### 持久卷管理 (`volume-*`)
持久卷独立于沙箱生命周期，可挂载至不同沙箱或免沙箱直接读写：
```bash
# 1. 卷生命周期管理
node <skill-dir>/e2b_ctl.js volume-create my-data --json
node <skill-dir>/e2b_ctl.js volume-list
node <skill-dir>/e2b_ctl.js volume-destroy my-data

# 2. 旁路直接读写卷内文件（无需拉起沙箱）
node <skill-dir>/e2b_ctl.js volume-mkdir my-data /dataset
node <skill-dir>/e2b_ctl.js volume-write my-data /dataset/train.csv --from-file ./local_train.csv
node <skill-dir>/e2b_ctl.js volume-read my-data /dataset/train.csv
node <skill-dir>/e2b_ctl.js volume-ls my-data /dataset

# 3. 创建沙箱时挂载卷（只能在创建时通过 --mount 挂载）
node <skill-dir>/e2b_ctl.js create --mount my-data:/mnt/data --json
```

### 文件与代码双向同步
```bash
# 上传与下载文件/目录
node <skill-dir>/e2b_ctl.js upload -s <SANDBOX_ID> ./local.py /home/user/run.py
node <skill-dir>/e2b_ctl.js download -s <SANDBOX_ID> /home/user/output.log ./output.log

# 直接读写文件内容
node <skill-dir>/e2b_ctl.js write-file -s <SANDBOX_ID> /home/user/app.json '{"debug":true}'
node <skill-dir>/e2b_ctl.js read-file -s <SANDBOX_ID> /home/user/app.json
```

### 插件配置与出网规则 (`config-set`)
```bash
# 设置 API 凭据与服务端点
node <skill-dir>/e2b_ctl.js config-set --api-key "e2b_xxx"
node <skill-dir>/e2b_ctl.js config-set --api-url "http://192.168.36.222:3000" --sandbox-url "http://192.168.36.222:3002"

# 设置出网网段白名单（如放行内网网段）
node <skill-dir>/e2b_ctl.js config-set --network '{"allowOut":["192.168.36.1/24"]}'

# 设置沙箱内 DNS（写入 /etc/resolv.conf）
node <skill-dir>/e2b_ctl.js config-set --dns 192.168.36.222

# 查看当前生效配置
node <skill-dir>/e2b_ctl.js config-get --json
```

---

## 3. 使用规则与注意事项

1. **生命周期收尾**：任何通过 `create` 创建的沙箱，使用完毕后务必执行 `kill <SANDBOX_ID>`。
2. **租期给够，别依赖 pause**：默认到期是回收，长任务靠 `--timeout` / `--for` 给足时间即可。`--on-timeout pause` 只用于中间状态无法从磁盘重建的场景。
3. **持久卷挂载时机**：持久卷只支持在新建沙箱时传入 `--mount` 挂载，不支持向已运行的沙箱追加挂载。
4. **日常命令优先用 `e2b-linux`**：如果仅是日常跑命令、测试或构建，推荐使用 `e2b-linux`，它会自动管理会话复用、工作目录和环境变量，体验更接近本地 bash。
