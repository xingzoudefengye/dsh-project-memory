# dsh-project-memory

**项目级有限容量长期记忆**：把跨会话的项目认知（决策、约束、任务、坑、事实）存进工作区的 `.ai/`，可以提交进 git、跟着仓库走，并且**有容量上限**。

## 它解决什么

harness 本来就有两样东西：`AGENTS.md`（规则）和会话史书（session-recall，**会话级**）。缺的是中间那层 —— **跨会话沉淀下来的项目认知**：定过什么决策、哪些任务没做完、踩过哪些坑。没有它，换个会话或换台机器，这些就散了。

## 五个文件，都在 `.ai/`

| 文件 | 装什么 | 软配额 |
|---|---|---|
| `project.md` | 项目概况、当前阶段 | 4000 字符 |
| `decisions.md` | 已定的决策 | 6000 |
| `tasks.md` | 未完成的任务 | 5000 |
| `bugs.md` | 已知的坑与缺陷 | 5000 |
| `memory.md` | 其他长期事实 | 4000 |

硬上限 **24000 字符 / 65536 字节**（五件合计），整理目标 19000。软配额是**可互借**的：它决定容量紧张时先粗化哪个文件，不决定写入是否合法。

`.ai/.local/` 放程序内部状态，初始化时自动写进 `.ai/.gitignore`。

## 条目格式

人可读、可手改、`git diff` 看得懂：

```text
- YYYY-MM-DD [id=稳定标识] [status=active|done|resolved|superseded] [kind=constraint|decision|task|bug|fact|history]: 当前完整结论
  - 可选嵌套详情
```

- 同一个 `id` 再次写入是**原地更新**，不是追加重复条目。
- 围栏代码块里的示例**永远不会**被当成条目 —— 所以文件里可以写格式说明。
- 条目之外的文字（标题、说明、段落）原样保留，任何重写都不动它们。

## 容量与分层保留

| 年龄 | 详情 |
|---|---|
| ≤ 7 天 | 全部保留 |
| 7–30 天 | 只留最后 2 条 |
| > 30 天 | 只留结论 |

**结论永不改写。** 容量紧张时提前一档粗化，先动**最超配额**的那个文件。

**受保护条目**（`status=active` 的 `constraint` / `task` / `bug`）**完全不参与年龄粗化** —— 变老不会让一条约束失效或让一个任务变成已完成。

真的到硬上限时：写入**被拒绝**并返回明确原因，原文件**逐字节不变**。

## 注入：择优、有界、会话内冻结

每次请求注入的是**择优摘要**，不是全部：

- 预算 12000 字符 / 4000 估算 token，两个都卡 —— 这是**项目层**的预算。
- 全局层在项目节之后另起一节，独立预算 4000 字符 / 1000 token：本项目永远优先，全局再多也不能把本项目的知识挤出去（业内项目记忆压用户记忆的同一优先级）。
- 优先级：`constraint` → 未完成的 `task`/`bug` → `decision` → `fact` → 其他；同类按日期新到旧，再按 id。
- 放不下的条目**跳过继续填**，不会被一条超长结论饿死后面全部。
- 省略了多少条会**明写出来**，并告诉模型用 `project_memory` 工具读完整条目。
- `superseded` 条目不注入（但留在文件里作审计）。

**会话内冻结**：一个会话的注入文本只构建一次，会话中途写记忆**不会**改变它。原因是缓存 —— 每次请求都重读文件会让这段文本在服务商缓存前缀里反复进出，模型看到同样的知识却每次都是 cache miss。需要新内容就显式读；下个会话自然用最新的。

**第一个 step 也能看到**：系统提示的 section 是**同步**函数，而组装发生在 `agent/pre-step` 之前，所以「等文件读完再组装」这条路走不通。为了不让每个会话的第一句话在**没有**约束的情况下答出来，快照缺失时会走一次**同步读**（五个小文件，每会话至多一次）并缓存。文件系统端口要是没有同步读能力（`readSync`），就退化成「从第二个 step 开始有」而不是报错。

## 写入路径与安全

- **唯一写入门**：工具、命令、其他插件都走同一个函数。
- 写入前先校验容量；**原子写**（临时文件 + rename），崩溃不会留下半截文件。
- 外部改动优先：读与写之间文件被改过（内容哈希不符）就**失败**，不静默覆盖别人写的东西。
- 每次写入保留**一份**恢复副本（`.bak`）。

## 全局层（跨项目记忆）

项目层跟着仓库走，换项目就换一套；全局层跟着机器走：`$DSH_HOME/project-memory/`（默认 `~/.dsh/project-memory/`），同样五个文件、同样格式、同样容量规则，**不进任何项目的 git**。

- 每个会话自动注入，分两节、标清来源：项目节在前（全预算），全局节在后（小预算）。
- 写入默认进项目；进全局必须显式：工具 `scope=global`，或 `/memory promote --id <id> --apply` 把某条项目记忆复制过去（先预览）。
- 换电脑带走全局层就是拷一个目录：

```bash
rsync -a ~/.dsh/project-memory/ <新机>:~/.dsh/project-memory/
```

插件本身换机靠 `dsh plugin add github:xingzoudefengye/dsh-project-memory` 重装（dsh-env 的 bootstrap 已覆盖）。

## 界面

**工具** `project_memory`（一个工具，不是三个 —— 每个工具 schema 每次请求都要付费）：

| action | 用途 |
|---|---|
| `write` | 记一条（同 id 即更新） |
| `read` | 读完整条目，含注入时被省略的详情 |
| `list` | 容量与计数 |

`scope` 参数（三种 action 通用，默认 `project`）：

- `project`：写进本项目的 `.ai/`，跟着仓库走；
- `global`：写进全局层 `$DSH_HOME/project-memory/`，所有项目可见。**只给放之四海皆准的结论**（个人偏好、工具习惯、到处验证过的网关坑），不记聊天原文、不记密钥、不记行为轨迹。

**命令** `/memory`：

```bash
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

## 挂载

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

四行分开，是为了能只装存储+注入、不装模型工具，或只装命令。验证：

```bash
scripts/check.sh web
```

## 边界

- **不做自动提取。** 这个包自己不发起任何模型调用、不跑后台任务。写入由模型主动调工具或人敲命令触发。后台语义提取（ComeCode 那套 scheduler/cursor/退避）是有价值的下一步，但那是另一个东西，不该混进存储层。
- 注入预算是**本地估算 token**，不是服务商 usage。
- 不迁移旧格式；`.ai/` 跟着 git 走就是项目层的同步方式，全局层拷 `~/.dsh/project-memory/` 一个目录（见上）。
- 单测覆盖：`node --test`（全部用假文件系统，不碰真实磁盘、不调模型）。

## 许可

MIT。
