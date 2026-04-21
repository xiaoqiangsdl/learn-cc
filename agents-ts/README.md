# agents-ts

独立的 TypeScript 运行与构建目录，当前入口是 `src/s_full.ts`。
改写 agents/s_full.py 的 ts 版本。

## 1) 安装依赖

```bash
cd agents-ts
bun install
```

## 2) 开发运行

```bash
bun run dev
```

启动后会进入交互式 REPL，提示符如下：

```text
s_full >>
```

### 启动后怎么用

1. 直接输入自然语言任务，Agent 会自动调用内置工具执行（读写文件、跑命令、拆任务等）。
2. 输入内置命令可查看当前状态：
   - `/tasks`：查看 `.tasks` 里的任务面板
   - `/team`：查看队友状态
   - `/inbox`：查看并清空 lead 收件箱消息
   - `/compact`：手动压缩上下文
3. 输入 `q` / `exit` / 空行可退出 REPL。

### 快速示例

```text
s_full >> 帮我检查 src/s_full.ts 里有哪些 console.log 调试输出，并给出最小清理方案
s_full >> /tasks
s_full >> /team
s_full >> exit
```

### 运行产物目录（按需关注）

- `.tasks/`：持久化任务文件（`task_*.json`）
- `.team/`：团队配置和消息收件箱（`inbox/*.jsonl`）
- `.task_outputs/tool-results/`：超大工具输出的落盘文件
- `.transcripts/`：上下文压缩前的会话快照

## 3) 类型检查

```bash
bun run typecheck
```

## 4) 构建并运行

```bash
bun run build
bun run start
```

## 环境变量

沿用项目根目录 `.env.local` / `.env`（`dotenv` 会从进程 `cwd` 开始向上查找）：

- `MODEL_ID`
- `ANTHROPIC_BASE_URL`（可选）
- `ANTHROPIC_API_KEY`（或你当前 Anthropic SDK 使用的鉴权变量）
