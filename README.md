# dsh-project-memory

**项目级有限容量长期记忆**：把跨会话的项目认知（决策、约束、任务、坑、事实）存进工作区的 `.ai/`，可以提交进 git、跟着仓库走，并且**有容量上限**。

> English: dsh-project-memory gives DeepSeek Harness a bounded, git-committable memory layer for a project: five whitelisted Markdown files under `.ai/` hold decisions, constraints, unfinished tasks, known bugs, and durable facts. Entries are human-readable one-line records with stable ids, updated in place, behind hard character and byte ceilings with age-based coarsening that never rewrites a conclusion. A stable, frozen prompt section injects a prioritised summary once per session, and a machine-wide layer under `$DSH_HOME/project-memory/` carries conclusions shared by every project. The package makes no model calls and runs no background jobs: writes come from the `project_memory` tool or the human `/memory` command. Install with `dsh plugin --profile web add github:xingzoudefengye/dsh-project-memory` and verify with `node scripts/check.mjs`.

harness 本来就有两样东西：`AGENTS.md`（规则）和会话史书（session-recall，**会话级**）。缺的是中间那层 —— **跨会话沉淀下来的项目认知**：定过什么决策、哪些任务没做完、踩过哪些坑。没有它，换个会话或换台机器，这些就散了。

## 兼容性

| 平台 | 支持 | 说明 |
| --- | --- | --- |
| Windows 10/11（PowerShell） | ✅ 已实测（Windows 11） | `dsh` 是 `dsh.cmd`/`dsh.ps1` 垫片；`node scripts/check.mjs` 会自动找到垫片旁边的 npm 包并直接执行其 JS 入口（Node 不能直接 spawn `.cmd`）。`scripts/*.sh` 需要 Git Bash 或 WSL，不想装就用 `.mjs`。 |
| macOS（zsh） | ✅ 设计支持 | `DSH_HOME` 默认 `~/.dsh`；`scripts/*.sh` 与 `*.mjs` 都可用。本机未实测，代码只用 Node 标准库的跨平台 API。 |
| Linux（bash/zsh） | ✅ 设计支持 | 同 macOS。 |

- **Node**：`package.json` 的 `engines` 要求 `>=22`（本机用 24.19.0 验证）。
- **DSH**：`peerDependencies` 全是 `*`，**没有锁定版本**。实际需要已安装 `dsh`（0.2.x；本文按 0.2.1-rc.2 验证），且该 profile 能加载第三方 bundle —— 也就是 `dsh plugin --profile <name> add …` 可用。

## 安装

1. 确认前置条件（PowerShell 与 zsh 命令相同）：

   ```bash
   node --version    # 需要 v22 或更高
   dsh --version     # 需要已安装 DeepSeek Harness
   ```

2. 把插件装进 profile（两个系统命令完全一样，`web` 换成你要用的 profile，如 `headless`）：

   ```bash
   dsh plugin --profile web add github:xingzoudefengye/dsh-project-memory
   ```

3. **重启 dsh host**。插件在 host 启动时 import，`dsh plugin add` 只改磁盘上的依赖，不会热加载。完全退出当前进程再启动，例如：

   ```bash
   dsh web
   ```

   刷新 GUI 页面**不够**。

4. 在**你的项目**里初始化记忆。先进入项目目录再启动 dsh，然后在会话里运行：

   ```text
   /memory init
   ```

   `.ai/` 建在**用户项目**里，不是插件目录：workspace 根是当前目录往上最近的 `.git`（没有 `.git` 就用启动目录），所以从子目录启动也会写到仓库根。第一次 `project_memory write` 也会创建缺失的 `.ai/`，`/memory init` 只是把五个模板文件一次建好。

5. 可选：建立跨项目的全局层（放在 `$DSH_HOME/project-memory/`，不进任何项目仓库）：

   ```text
   /memory init --global
   ```

### 两个系统唯一的路径差异

| | Windows（PowerShell） | macOS / Linux（zsh/bash） |
| --- | --- | --- |
| `DSH_HOME` 默认值 | `%USERPROFILE%\.dsh`（写作 `$env:USERPROFILE\.dsh`） | `~/.dsh` |
| 全局层目录 | `%USERPROFILE%\.dsh\project-memory` | `~/.dsh/project-memory` |
| 项目 `.ai/` | 用户项目根目录下，与操作系统无关 | 同左 |

`dsh plugin add` 本身由 dsh 处理 profile 位置，两边命令一致；`DSH_HOME` 设了就以它为准。

### 从本地路径安装（开发用）

```bash
dsh plugin --profile web add /绝对路径/dsh-project-memory
node scripts/dev-link.mjs
```

`dsh plugin add <本地路径>` 装的是 `link:` 依赖，Node 的 ESM 解析会顺着符号链接走到仓库真实路径，从而找不到 profile 里的 harness 包。`dev-link.mjs` 把这些包链接进本仓库的 `node_modules/@deepseek-ai/`（Windows 用 junction，macOS/Linux 用目录符号链接）。git 安装不需要这一步。

## 验证

```console
$ node scripts/check.mjs
ok:   project-memory is in the composed tree
ok:   project-memory-section is in the composed tree
ok:   tool-project-memory is in the composed tree
ok:   command-project-memory is in the composed tree
ok:   the prompt section row is mounted
note: no global layer yet — create it with /memory init --global (optional, cross-project memory)
```

- 检查其他 profile：`node scripts/check.mjs headless`（默认 `web`）。
- 如果已经建过全局层，最后一行会变成 `ok:   the global layer exists (C:\Users\you\.dsh\project-memory)`（macOS 为 `/Users/you/.dsh/project-memory`）。
- 任何一行 `FAIL:` 都会让退出码为 1。`npm run check` 是同一个脚本。
- shell 版（macOS/Linux，或 Windows 的 Git Bash/WSL）：`bash scripts/check.sh web`。
- 单元测试：`npm test`（`node --test`，全部用假文件系统，不碰真实磁盘、不调模型）。

## 配置

**这个包没有用户级 YAML 配置键。** `cordis.patch.yml` 里的四行只有 `id` 和 `name`，没有 `config:`；行为由代码常量决定。你会编辑的 YAML 就是这四行本身 —— 它们故意分开，是为了只挂其中一部分：

```yaml
- insert:
    - id: project-memory
      name: 'dsh-project-memory/service'
    - id: project-memory-section
      name: 'dsh-project-memory/section'
    - id: tool-project-memory
      name: 'dsh-project-memory/tool'
    - id: command-project-memory
      name: 'dsh-project-memory/command'
```

- 只留前两行 = 纯存储 + 注入，不注册模型工具。
- 去掉 `command` 行 = 没有 `/memory` 命令；去掉 `tool` 行 = 模型不能用 `project_memory` 读写。

不想动包内文件时，用 profile 自己的 patch 层（dsh 会在所有 bundle 层之后应用它）按 `id` 关掉某一行。例如只关模型工具、保留存储/注入/`/memory`，编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`（Windows 是 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`）：

```yaml
# 按 id 关掉 bundle 插入的某一行
- id: tool-project-memory
  disabled: true
```

要彻底不挂载，则编辑上面这份 `cordis.patch.yml` 的 `insert` 列表（升级/重装会覆盖包内文件）。

影响行为的常量（**不是 YAML 键**，改动需要改源码；`ProjectMemory` 构造函数的 `{ fs, globalRoot }` 是给测试/嵌入用的，不是用户配置）：

| 行为 | 默认值 | 位置 |
| --- | --- | --- |
| 五个文件软配额 | `project.md` 4000、`decisions.md` 6000、`tasks.md` 5000、`bugs.md` 5000、`memory.md` 4000 字符 | `lib/entries.js` `MEMORY_FILES` |
| 硬上限（五件合计） | 24000 字符 / 65536 字节 | `lib/entries.js` |
| 整理目标 | 19000 字符 | `lib/entries.js` |
| 项目层注入预算 | 12000 字符 / 4000 估算 token | `lib/entries.js` |
| 全局层注入预算 | 4000 字符 / 1000 估算 token | `lib/service.js` |
| 详情粗化档位 | ≤7 天全留；7–30 天留最后 2 条；>30 天只留结论 | `lib/entries.js` |
| 全局层目录 | `$DSH_HOME/project-memory`，`DSH_HOME` 默认 `~/.dsh`（Windows `%USERPROFILE%\.dsh`） | `lib/service.js` |
| 工作区根 | 从 cwd 往上最近的 `.git`（文件或目录都算） | `lib/store.js` |
| `project_memory` 的 `read` 单次上限 | 8000 字符 | `lib/tool.js` |
| prompt section 顺序 | 9500 | `lib/section.js` |

唯一相关的环境变量是 `DSH_HOME`：它只影响全局层位置，不影响项目里的 `.ai/`。

## 卸载

```bash
dsh plugin --profile web remove dsh-project-memory
```

然后**重启 dsh host**（同上，插件在启动时加载）。

插件不会带走这些磁盘内容：

- 用户项目里的 `.ai/`：五个 Markdown 文件、`.gitignore`、`.local/` 内部状态、每次写入保留的一份 `*.bak` 恢复副本。它们是你的项目文件，插件被卸载也不会删。
- 全局层 `$DSH_HOME/project-memory/`（默认 `~/.dsh/project-memory/` 或 `%USERPROFILE%\.dsh\project-memory\`）。
- 已经提交进 git 的 `.ai/` 历史。

确认不再需要时手工删除：

```powershell
# Windows PowerShell
Remove-Item -Recurse -Force .ai
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\project-memory"
```

```bash
# macOS / Linux
rm -rf .ai
rm -rf ~/.dsh/project-memory
```

如果 `.ai/` 已经提交，用 `git rm -r .ai` 删除并正常提交；若设置了 `DSH_HOME`，全局层在 `$DSH_HOME/project-memory`。

## 排错

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `dsh plugin add` 成功，但会话里没有 `project_memory` 工具、也没有 `/memory` 命令 | 插件在 **host 启动时** import；`plugin add` 只改依赖，不会热加载 | 完全退出 dsh 进程再启动（如 `dsh web`）。刷新 GUI 页面无效。 |
| 改了插件代码（或 `git pull` 了插件）行为没变 | host 进程里是 ESM 模块缓存，旧模块不会因文件变化重新加载 | 重启整个 host 进程。本地 `link:` 安装同样要重启，单测不受影响。 |
| `dsh plugin add` 在私有网络 / 公司代理后失败（拉 GitHub 超时、证书错误） | pnpm 需要能访问 GitHub（或配置的 registry/代理） | 设置 `HTTPS_PROXY`/`HTTP_PROXY` 后重试；或 `git clone` 到本地，用 `dsh plugin --profile web add <本地路径>` 再跑 `node scripts/dev-link.mjs`。 |
| 记忆看起来是空的：注入没有内容、`/memory status` 全是 0 | 项目根还没有 `.ai/`；读取不会创建模板 | 在项目里运行 `/memory init`（或让模型第一次 `project_memory write`）。注意 workspace 根是最近的 `.git`，从子目录启动也会写到仓库根。 |
| 写入报权限错误（EACCES/EPERM），或提示文件在准备期间变了 | `.ai/` 所在目录只读（只读 checkout、容器只读挂载、ACL），或读与写之间文件被外部改动 | 修权限或换可写工作区；外部改动先 `git diff` 看一眼再重试。插件不会静默覆盖别人的改动。 |
| `node scripts/check.mjs` 报 `FAIL: no such profile: …` | `DSH_HOME` 指向别处、profile 名拼错，或装插件与检查用了不同 profile | 检查 `$env:DSH_HOME`（Windows）/`echo $DSH_HOME`（macOS），默认 profile 是 `web`。 |
| 容量满了，写入被拒绝 | 五件合计达到 24000 字符 / 65536 字节；结论永不自动删 | `/memory check` 看整理计划，`/memory compact --apply` 粗化旧详情，或 `/memory forget --id <id> --apply`。注意 `forget` 默认只预览，忘加 `--apply` 会“看起来没生效”。 |

## 设计

### 五个文件，都在 `.ai/`

| 文件 | 装什么 | 软配额 |
| --- | --- | --- |
| `project.md` | 项目概况、当前阶段 | 4000 字符 |
| `decisions.md` | 已定的决策 | 6000 |
| `tasks.md` | 未完成的任务 | 5000 |
| `bugs.md` | 已知的坑与缺陷 | 5000 |
| `memory.md` | 其他长期事实 | 4000 |

硬上限 **24000 字符 / 65536 字节**（五件合计），整理目标 19000。软配额是**可互借**的：它决定容量紧张时先粗化哪个文件，不决定写入是否合法。

`.ai/.local/` 放程序内部状态，初始化时自动写进 `.ai/.gitignore`。

### 条目格式

人可读、可手改、`git diff` 看得懂：

```text
- YYYY-MM-DD [id=稳定标识] [status=active|done|resolved|superseded] [kind=constraint|decision|task|bug|fact|history]: 当前完整结论
  - 可选嵌套详情
```

- 同一个 `id` 再次写入是**原地更新**，不是追加重复条目。
- 围栏代码块里的示例**永远不会**被当成条目 —— 所以文件里可以写格式说明。
- 条目之外的文字（标题、说明、段落）原样保留，任何重写都不动它们。

### 容量与分层保留

| 年龄 | 详情 |
| --- | --- |
| ≤ 7 天 | 全部保留 |
| 7–30 天 | 只留最后 2 条 |
| > 30 天 | 只留结论 |

**结论永不改写。** 容量紧张时提前一档粗化，先动**最超配额**的那个文件。

**受保护条目**（`status=active` 的 `constraint` / `task` / `bug`）**完全不参与年龄粗化** —— 变老不会让一条约束失效或让一个任务变成已完成。

真的到硬上限时：写入**被拒绝**并返回明确原因，原文件**逐字节不变**。

### 注入：择优、有界、会话内冻结

每次请求注入的是**择优摘要**，不是全部：

- 预算 12000 字符 / 4000 估算 token，两个都卡 —— 这是**项目层**的预算。
- 全局层在项目节之后另起一节，独立预算 4000 字符 / 1000 token：本项目永远优先，全局再多也不能把本项目的知识挤出去。
- 优先级：`constraint` → 未完成的 `task`/`bug` → `decision` → `fact` → 其他；同类按日期新到旧，再按 id。
- 放不下的条目**跳过继续填**，不会被一条超长结论饿死后面全部。
- 省略了多少条会**明写出来**，并告诉模型用 `project_memory` 工具读完整条目。
- `superseded` 条目不注入（但留在文件里作审计）。

**会话内冻结**：一个会话的注入文本只构建一次，会话中途写记忆**不会**改变它。原因是缓存 —— 每次请求都重读文件会让这段文本在服务商缓存前缀里反复进出，模型看到同样的知识却每次都是 cache miss。需要新内容就显式读；下个会话自然用最新的。

**第一个 step 也能看到**：系统提示的 section 是**同步**函数，而组装发生在 `agent/pre-step` 之前。为了不让每个会话的第一句话在**没有**约束的情况下答出来，快照缺失时会走一次**同步读**（五个小文件，每会话至多一次）并缓存。文件系统端口要是没有同步读能力（`readSync`），就退化成「从第二个 step 开始有」而不是报错。

### 全局层（跨项目记忆）

项目层跟着仓库走，换项目就换一套；全局层跟着机器走：`$DSH_HOME/project-memory/`（默认 `~/.dsh/project-memory/`，Windows 为 `%USERPROFILE%\.dsh\project-memory\`），同样五个文件、同样格式、同样容量规则，**不进任何项目的 git**。

- 每个会话自动注入，分两节、标清来源：项目节在前（全预算），全局节在后（小预算）。
- 写入默认进项目；进全局必须显式：工具 `scope=global`，或 `/memory promote --id <id> --apply` 把某条项目记忆复制过去（先预览）。
- 换电脑带走全局层就是拷一个目录：

  ```bash
  rsync -a ~/.dsh/project-memory/ <新机>:~/.dsh/project-memory/
  ```

插件本身换机靠 `dsh plugin --profile web add github:xingzoudefengye/dsh-project-memory` 重装。

### 界面

**工具** `project_memory`（一个工具，不是三个 —— 每个工具 schema 每次请求都要付费）：

| action | 用途 |
| --- | --- |
| `write` | 记一条（同 id 即更新） |
| `read` | 读完整条目，含注入时被省略的详情 |
| `list` | 容量与计数 |

`scope` 参数（三种 action 通用，默认 `project`）：

- `project`：写进本项目的 `.ai/`，跟着仓库走；
- `global`：写进全局层 `$DSH_HOME/project-memory/`，所有项目可见。**只给放之四海皆准的结论**（个人偏好、工具习惯、到处验证过的网关坑），不记聊天原文、不记密钥、不记行为轨迹。

**命令** `/memory`：

```text
/memory status                      # 容量、各文件条目数（默认）
/memory check                       # 再加整理计划
/memory init                        # 建缺失的模板文件
/memory compact [--apply]           # 粗化旧详情；默认只预览
/memory forget --id <id> [--apply]  # 删除条目；默认只预览
/memory forget --query <文本> --apply
/memory forget --date 2026-10-04 --apply
/memory status --global             # 看全局层（compact/forget/init 同理加 --global）
/memory promote --id <id> [--apply] # 把一条项目记忆复制到全局层；默认只预览
```

**遗忘默认只预览**，`--apply` 才写。唯一的破坏性操作不该离一次模型调用那么近。

### 写入路径与安全

- **唯一写入门**：工具、命令、其他插件都走同一个函数。
- 写入前先校验容量；**原子写**（临时文件 + rename），崩溃不会留下半截文件。
- 外部改动优先：读与写之间文件被改过（内容哈希不符）就**失败**，不静默覆盖别人写的东西。
- 每次写入保留**一份**恢复副本（`.bak`）。

### 边界

- **不做自动提取。** 这个包自己不发起任何模型调用、不跑后台任务。写入由模型主动调工具或人敲命令触发。后台语义提取（scheduler/cursor/退避）是有价值的下一步，但那是另一个东西，不该混进存储层。
- 注入预算是**本地估算 token**，不是服务商 usage。
- 不迁移旧格式；`.ai/` 跟着 git 走就是项目层的同步方式，全局层拷 `~/.dsh/project-memory/` 一个目录（见上）。
- 单测覆盖：`node --test`（不调模型；存储规则用内存里的假文件系统，工作区查找用 `os.tmpdir()` 下的临时目录）。

## 相关插件

同作者维护的其他 DSH 插件：

- [dsh-browser](https://github.com/xingzoudefengye/dsh-browser)
- [dsh-web-search-failover](https://github.com/xingzoudefengye/dsh-web-search-failover)
- [dsh-compaction-local-handoff](https://github.com/xingzoudefengye/dsh-compaction-local-handoff)
- [dsh-resume-budget](https://github.com/xingzoudefengye/dsh-resume-budget)
- [dsh-session-recall](https://github.com/xingzoudefengye/dsh-session-recall)

## 许可

MIT，见 [LICENSE](LICENSE)。
