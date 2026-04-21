#!/usr/bin/env node
// 总控：整合所有机制的完整控制台。
/**
 * s_full.ts - 终章教学 Agent
 *
 * `s_full.py` 的 TypeScript 移植版。
 */

import { randomUUID } from "node:crypto";
import { exec, spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import {
  isRecord,
  isTextBlock,
  isToolUseBlock,
  toToolInput,
} from "./s_full.types";
import type {
  BackgroundTask,
  BusMessage,
  HistoryMessage,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  PersistentTask,
  PersistentTaskStatus,
  PlanRequest,
  TeamConfig,
  TeamMember,
  TeamMemberStatus,
  TextPayload,
  TodoItem,
  TodoStatus,
  Tool,
  ToolInput,
  ToolResultPayload,
} from "./s_full.types";

dotenv.config({ override: true });
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const MODEL = process.env.MODEL_ID ?? "";
if (!MODEL) {
  throw new Error("MODEL_ID 是必填项");
}

const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const SKILLS_DIR = path.join(WORKDIR, "skills");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const TOKEN_THRESHOLD = 100000;
const POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

const TASK_OUTPUT_DIR = path.join(WORKDIR, ".task_outputs");
const TOOL_RESULTS_DIR = path.join(TASK_OUTPUT_DIR, "tool-results");
const PERSIST_OUTPUT_TRIGGER_CHARS_DEFAULT = 50000;
const PERSIST_OUTPUT_TRIGGER_CHARS_BASH = 30000;
const CONTEXT_TRUNCATE_CHARS = 50000;
const PERSISTED_OPEN = "<persisted-output>";
const PERSISTED_CLOSE = "</persisted-output>";
const PERSISTED_PREVIEW_CHARS = 2000;
const KEEP_RECENT = 3;
const PRESERVE_RESULT_TOOLS = new Set(["read_file"]);

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 生成短任务/请求 ID，用于后台任务、审批请求和消息追踪。
function shortId(): string {
  return randomUUID().slice(0, 8);
}

// === 模块：大输出持久化（s06） ===
// 将超大工具输出落盘，返回相对路径以便在上下文中引用。
async function _persist_tool_result(tool_use_id: string, content: string): Promise<string> {
  await fsp.mkdir(TOOL_RESULTS_DIR, { recursive: true });
  const safe_id = (tool_use_id || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const filePath = path.join(TOOL_RESULTS_DIR, `${safe_id}.txt`);
  try {
    await fsp.access(filePath, fs.constants.F_OK);
  } catch {
    await fsp.writeFile(filePath, content, "utf8");
  }
  return path.relative(WORKDIR, filePath);
}

function _format_size(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

function _preview_slice(text: string, limit: number): [string, boolean] {
  if (text.length <= limit) return [text, false];
  const idx = text.slice(0, limit).lastIndexOf("\n");
  const cut = idx > limit * 0.5 ? idx : limit;
  return [text.slice(0, cut), true];
}

function _build_persisted_marker(stored_path: string, content: string): string {
  const [preview, has_more] = _preview_slice(content, PERSISTED_PREVIEW_CHARS);
  let marker =
    `${PERSISTED_OPEN}\n` +
    `输出过大（${_format_size(content.length)}）。` +
    `完整输出已保存到：${stored_path}\n\n` +
    `预览（前 ${_format_size(PERSISTED_PREVIEW_CHARS)}）：\n` +
    `${preview}`;
  if (has_more) marker += "\n...";
  marker += `\n${PERSISTED_CLOSE}`;
  return marker;
}

// 统一大输出处理策略：超过阈值则写入文件并返回可回读的 marker。
async function maybe_persist_output(
  tool_use_id: string,
  output: unknown,
  trigger_chars?: number,
): Promise<string> {
  const asString = typeof output === "string" ? output : String(output);
  const trigger =
    trigger_chars === undefined ? PERSIST_OUTPUT_TRIGGER_CHARS_DEFAULT : Number(trigger_chars);
  if (asString.length <= trigger) return asString;
  const stored_path = await _persist_tool_result(tool_use_id, asString);
  return _build_persisted_marker(stored_path, asString);
}

// === 模块：基础工具 ===
// 约束所有文件访问在当前 WORKDIR 内，防止路径越界。
function safe_path(p: string): string {
  const full = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`路径越界，超出 workspace：${p}`);
  }
  return full;
}

// 执行 shell 命令并做最小安全拦截与大输出截断。
async function run_bash(command: string, tool_use_id = ""): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "错误：已拦截危险命令";
  }
  try {
    const r = spawnSync(command, {
      shell: true,
      cwd: WORKDIR,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return "错误：执行超时（120s）";
    }
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    if (!out) return "（无输出）";
    const persisted = await maybe_persist_output(
      tool_use_id,
      out,
      PERSIST_OUTPUT_TRIGGER_CHARS_BASH,
    );
    return persisted.slice(0, CONTEXT_TRUNCATE_CHARS);
  } catch {
    return "错误：执行超时（120s）";
  }
}

// 读取文件（可限行），并复用大输出持久化逻辑。
async function run_read(pathArg: string, tool_use_id = "", limit?: number): Promise<string> {
  try {
    const content = await fsp.readFile(safe_path(pathArg), "utf8");
    let lines = content.split(/\r?\n/);
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat(`...（还有 ${lines.length - limit} 行）`);
    }
    const out = lines.join("\n");
    const persisted = await maybe_persist_output(tool_use_id, out);
    return persisted.slice(0, CONTEXT_TRUNCATE_CHARS);
  } catch (e) {
    return `错误：${String(e)}`;
  }
}

// 覆盖写文件，自动创建父目录。
async function run_write(pathArg: string, content: string): Promise<string> {
  try {
    const fp = safe_path(pathArg);
    await fsp.mkdir(path.dirname(fp), { recursive: true });
    await fsp.writeFile(fp, content, "utf8");
    return `已写入 ${content.length} 字节到 ${pathArg}`;
  } catch (e) {
    return `错误：${String(e)}`;
  }
}

// 基于精确 old_text -> new_text 的最小编辑接口。
async function run_edit(pathArg: string, old_text: string, new_text: string): Promise<string> {
  try {
    const fp = safe_path(pathArg);
    const c = await fsp.readFile(fp, "utf8");
    if (!c.includes(old_text)) {
      return `错误：在 ${pathArg} 中未找到目标文本`;
    }
    await fsp.writeFile(fp, c.replace(old_text, new_text), "utf8");
    return `已编辑 ${pathArg}`;
  } catch (e) {
    return `错误：${String(e)}`;
  }
}

// === 模块：待办（s03） ===
// 维护会话级 todo 列表，约束状态并输出人类可读视图。
class TodoManager {
  items: TodoItem[] = [];

  update(items: unknown[]): string {
    const validated: TodoItem[] = [];
    let ip = 0;
    items.forEach((raw, idx) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      const content = String(item.content ?? "").trim();
      const status = String(item.status ?? "pending").toLowerCase() as TodoStatus;
      const activeForm = String(item.activeForm ?? "").trim();
      if (!content) throw new Error(`条目 ${idx}：content 必填`);
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`条目 ${idx}：status 无效 '${status}'`);
      }
      if (!activeForm) throw new Error(`条目 ${idx}：activeForm 必填`);
      if (status === "in_progress") ip += 1;
      validated.push({ content, status, activeForm });
    });
    if (validated.length > 20) throw new Error("最多 20 个 todo");
    if (ip > 1) throw new Error("只允许一个 in_progress");
    this.items = validated;
    return this.render();
  }

  render(): string {
    if (!this.items.length) return "暂无 todo。";
    const lines: string[] = [];
    this.items.forEach((item) => {
      const m = { completed: "[x]", in_progress: "[>]", pending: "[ ]" }[item.status] ?? "[?]";
      const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      lines.push(`${m} ${item.content}${suffix}`);
    });
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n（已完成 ${done}/${this.items.length}）`);
    return lines.join("\n");
  }

  has_open_items(): boolean {
    return this.items.some((item) => item.status !== "completed");
  }
}

// === 模块：子代理（s04） ===
// 启动一次“受限工具集”的子代理回合，返回其最终文本摘要。
async function run_subagent(prompt: string, agent_type = "Explore"): Promise<string> {
  const sub_tools: Tool[] = [
    {
      name: "bash",
      description: "执行命令。",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "读取文件。",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ];
  if (agent_type !== "Explore") {
    sub_tools.push(
      {
        name: "write_file",
        description: "写入文件。",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "编辑文件。",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
          },
          required: ["path", "old_text", "new_text"],
        },
      },
    );
  }

  const sub_handlers: Record<string, (kw: ToolInput) => Promise<string>> = {
    bash: async (kw) => run_bash(String(kw.command ?? "")),
    read_file: async (kw) => run_read(String(kw.path ?? "")),
    write_file: async (kw) => run_write(String(kw.path ?? ""), String(kw.content ?? "")),
    edit_file: async (kw) =>
      run_edit(String(kw.path ?? ""), String(kw.old_text ?? ""), String(kw.new_text ?? "")),
  };

  const sub_msgs: HistoryMessage[] = [{ role: "user", content: prompt }];
  let resp: Message | null = null;
  for (let i = 0; i < 30; i += 1) {
    const request: MessageCreateParamsNonStreaming = {
      model: MODEL,
      messages: sub_msgs as unknown as MessageParam[],
      tools: sub_tools,
      max_tokens: 8000,
    };
    resp = await client.messages.create(request);

    sub_msgs.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") break;
    const results: ToolResultPayload[] = [];
    for (const b of resp.content) {
      if (isToolUseBlock(b)) {
        const handler = sub_handlers[b.name] ?? (async () => "未知工具");
        const result = await handler(toToolInput(b.input));
        results.push({
          type: "tool_result",
          tool_use_id: b.id,
          content: String(result).slice(0, 50000),
        });
      }
    }
    sub_msgs.push({ role: "user", content: results });
  }
  if (resp) {
    const text = resp.content
      .filter(isTextBlock)
      .map((b) => b.text)
      .join("");
    return text || "（无摘要）";
  }
  return "（subagent 执行失败）";
}

// === 模块：技能（s05） ===
// 加载本地 skills 目录并按名称提供注入内容。
class SkillLoader {
  skills = new Map<string, { meta: Record<string, string>; body: string }>();

  constructor(private skills_dir: string) {
    if (!fs.existsSync(skills_dir)) return;
    const files = this.walkSkillFiles(skills_dir);
    files.sort().forEach((file) => {
      const text = fs.readFileSync(file, "utf8");
      const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      let meta: Record<string, string> = {};
      let body = text;
      if (match) {
        match[1]
          .trim()
          .split("\n")
          .forEach((line) => {
            const idx = line.indexOf(":");
            if (idx >= 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          });
        body = match[2].trim();
      }
      const name = meta.name || path.basename(path.dirname(file));
      this.skills.set(name, { meta, body });
    });
  }

  private walkSkillFiles(root: string): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name === "SKILL.md") out.push(full);
      }
    }
    return out;
  }

  descriptions(): string {
    if (!this.skills.size) return "（无 skills）";
    return [...this.skills.entries()]
      .map(([n, s]) => `  - ${n}: ${s.meta.description ?? "-"}`)
      .join("\n");
  }

  load(name: string): string {
      const s = this.skills.get(name);
    if (!s) {
      return `错误：未知 skill '${name}'。可用项：${[...this.skills.keys()].join(", ")}`;
    }
    return `<skill name="${name}">\n${s.body}\n</skill>`;
  }
}

// === 模块：压缩（s06） ===
// 估算上下文 token 量，用于触发自动压缩。
function estimate_tokens(messages: HistoryMessage[]): number {
  return Math.floor(JSON.stringify(messages).length / 4);
}

// 微压缩历史 tool_result，保留最近若干条与关键工具输出。
function microcompact(messages: HistoryMessage[]): void {
  const tool_results: ToolResultPayload[] = [];
  messages.forEach((msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      msg.content.forEach((part) => {
        if (
          isRecord(part) &&
          part.type === "tool_result" &&
          typeof part.tool_use_id === "string" &&
          typeof part.content === "string"
        ) {
          tool_results.push(part as ToolResultPayload);
        }
      });
    }
  });
  if (tool_results.length <= KEEP_RECENT) return;

  const tool_name_map = new Map<string, string>();
  messages.forEach((msg) => {
    if (msg.role !== "assistant") return;
    if (!Array.isArray(msg.content)) return;
    msg.content.forEach((block) => {
      if (
        isRecord(block) &&
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        tool_name_map.set(block.id, block.name);
      }
    });
  });

  tool_results.slice(0, -KEEP_RECENT).forEach((part) => {
    if (typeof part.content !== "string" || part.content.length <= 100) return;
    const tool_id = String(part.tool_use_id ?? "");
    const tool_name = tool_name_map.get(tool_id) ?? "unknown";
    if (PRESERVE_RESULT_TOOLS.has(tool_name)) return;
    part.content = `【历史记录：已调用 ${tool_name}】`;
  });
}

// 将长对话压缩为可续写摘要，并保存压缩前 transcript。
async function auto_compact(messages: HistoryMessage[], focus?: string): Promise<HistoryMessage[]> {
  await fsp.mkdir(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Math.floor(Date.now() / 1000)}.jsonl`);
  const lines = messages.map((msg) => `${JSON.stringify(msg)}\n`).join("");
  await fsp.writeFile(transcriptPath, lines, "utf8");

  const conv_text = JSON.stringify(messages).slice(0, 80000);
  let prompt =
    "请为后续连续性总结这段对话，并按以下结构输出：\n" +
    "1) 任务概览：核心诉求、成功标准、约束\n" +
    "2) 当前状态：已完成工作、修改文件、产出物\n" +
    "3) 关键决策与发现：约束、报错、失败尝试\n" +
    "4) 下一步：剩余动作、阻塞项、优先级\n" +
    "5) 需保留上下文：用户偏好、领域细节、承诺事项\n" +
    "请保持简洁，但保留关键细节。\n";
  if (focus) prompt += `\n请重点关注：${focus}\n`;

  const resp = await client.messages.create({
    model: MODEL,
    messages: [{ role: "user", content: `${prompt}\n${conv_text}` }] as MessageParam[],
    max_tokens: 4000,
  } satisfies MessageCreateParamsNonStreaming);

  const summary = resp.content.find(isTextBlock)?.text ?? "";
  const continuation =
    "当前会话从一次上下文已耗尽的历史对话续接。以下摘要覆盖了此前对话内容。\n\n" +
    `${summary}\n\n` +
    "请从中断处继续，不要再向用户追加提问。";

  return [{ role: "user", content: continuation }];
}

// === 模块：文件任务（s07） ===
// 持久化任务板：创建、更新、依赖关系与认领。
class TaskManager {
  constructor() {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
  }

  private _next_id(): number {
    const ids = fs
      .readdirSync(TASKS_DIR)
      .filter((f) => /^task_\d+\.json$/.test(f))
      .map((f) => Number(path.basename(f, ".json").split("_")[1]));
    return (ids.length ? Math.max(...ids) : 0) + 1;
  }

  private _taskPath(tid: number): string {
    return path.join(TASKS_DIR, `task_${tid}.json`);
  }

  private _load(tid: number): PersistentTask {
    const p = this._taskPath(tid);
    if (!fs.existsSync(p)) throw new Error(`任务 ${tid} 不存在`);
    return JSON.parse(fs.readFileSync(p, "utf8")) as PersistentTask;
  }

  private _save(task: PersistentTask): void {
    fs.writeFileSync(this._taskPath(task.id), JSON.stringify(task, null, 2), "utf8");
  }

  // 创建任务并落盘，返回完整任务 JSON。
  create(subject: string, description = ""): string {
    const task: PersistentTask = {
      id: this._next_id(),
      subject,
      description,
      status: "pending",
      owner: null,
      blockedBy: [],
      blocks: [],
    };
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  get(tid: number): string {
    return JSON.stringify(this._load(tid), null, 2);
  }

  // 更新任务状态与依赖；完成时会自动清理阻塞关系。
  update(tid: number, status?: PersistentTaskStatus, add_blocked_by?: number[], add_blocks?: number[]): string {
    const task = this._load(tid);
    if (status) {
      task.status = status;
      if (status === "completed") {
        fs.readdirSync(TASKS_DIR)
          .filter((f) => /^task_\d+\.json$/.test(f))
          .forEach((f) => {
            const taskPath = path.join(TASKS_DIR, f);
            const t = JSON.parse(fs.readFileSync(taskPath, "utf8")) as PersistentTask;
            if (t.blockedBy.includes(tid)) {
              t.blockedBy = t.blockedBy.filter((id) => id !== tid);
              this._save(t);
            }
          });
      }
      if (status === "deleted") {
        fs.rmSync(this._taskPath(tid), { force: true });
        return `任务 ${tid} 已删除`;
      }
    }
    if (add_blocked_by?.length) {
      task.blockedBy = [...new Set(task.blockedBy.concat(add_blocked_by))];
    }
    if (add_blocks?.length) {
      task.blocks = [...new Set(task.blocks.concat(add_blocks))];
    }
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  // 面向控制台输出的任务总览。
  list_all(): string {
    const tasks = fs
      .readdirSync(TASKS_DIR)
      .filter((f) => /^task_\d+\.json$/.test(f))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8")) as PersistentTask);
    if (!tasks.length) return "暂无任务。";
    return tasks
      .map((t) => {
        const m = { pending: "[ ]", in_progress: "[>]", completed: "[x]", deleted: "[?]" }[t.status] ?? "[?]";
        const owner = t.owner ? ` @${t.owner}` : "";
        const blocked = t.blockedBy.length ? `（被阻塞于：${JSON.stringify(t.blockedBy)}）` : "";
        return `${m} #${t.id}: ${t.subject}${owner}${blocked}`;
      })
      .join("\n");
  }

  // 将任务标记为被 owner 认领并进入 in_progress。
  claim(tid: number, owner: string): string {
    const task = this._load(tid);
    task.owner = owner;
    task.status = "in_progress";
    this._save(task);
    return `${owner} 已认领任务 #${tid}`;
  }
}

// === 模块：后台任务（s08） ===
// 管理后台命令生命周期，并在主循环中异步回收结果。
class BackgroundManager {
  tasks = new Map<string, BackgroundTask>();
  notifications: { task_id: string; status: string; result: string }[] = [];

  // 异步执行命令，返回任务 ID，结果通过 notifications 回传。
  run(command: string, timeout = 120): string {
    const tid = shortId();
    this.tasks.set(tid, { status: "running", command, result: null });
    exec(
      command,
      { cwd: WORKDIR, timeout: timeout * 1000, maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const current = this.tasks.get(tid);
        if (!current) return;
        if (err) {
          current.status = "error";
          current.result = String(err.message ?? err);
        } else {
          const out = `${stdout ?? ""}${stderr ?? ""}`.trim().slice(0, 50000);
          current.status = "completed";
          current.result = out || "（无输出）";
        }
        this.notifications.push({
          task_id: tid,
          status: current.status,
          result: (current.result ?? "").slice(0, 500),
        });
      },
    );
    return `后台任务 ${tid} 已启动：${command.slice(0, 80)}`;
  }

  // 查询单个或全部后台任务状态。
  check(tid?: string): string {
    if (tid) {
      const t = this.tasks.get(tid);
      if (!t) return `未知任务：${tid}`;
      return `[${t.status}] ${t.result ?? "（运行中）"}`;
    }
    const lines = [...this.tasks.entries()].map(
      ([k, v]) => `${k}: [${v.status}] ${v.command.slice(0, 60)}`,
    );
    return lines.join("\n") || "暂无后台任务。";
  }

  // 取走并清空待通知结果，避免重复消费。
  drain(): { task_id: string; status: string; result: string }[] {
    const out = [...this.notifications];
    this.notifications = [];
    return out;
  }
}

// === 模块：消息总线（s09） ===
// 基于本地 jsonl 文件的轻量消息总线。
class MessageBus {
  constructor() {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
  }

  // 向指定成员投递消息。
  send(sender: string, to: string, content: string, msg_type = "message", extra?: Record<string, unknown>): string {
    const msg: BusMessage = { type: msg_type, from: sender, content, timestamp: Date.now() / 1000 };
    if (extra) Object.assign(msg, extra);
    fs.appendFileSync(path.join(INBOX_DIR, `${to}.jsonl`), `${JSON.stringify(msg)}\n`, "utf8");
    return `已发送 ${msg_type} 给 ${to}`;
  }

  // 读取并清空成员收件箱（一次性消费语义）。
  read_inbox(name: string): BusMessage[] {
    const inboxPath = path.join(INBOX_DIR, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];
    const raw = fs.readFileSync(inboxPath, "utf8");
    const msgs = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BusMessage);
    fs.writeFileSync(inboxPath, "", "utf8");
    return msgs;
  }

  // 向当前团队所有成员广播消息。
  broadcast(sender: string, content: string, names: string[]): string {
    let count = 0;
    names.forEach((n) => {
      if (n !== sender) {
        this.send(sender, n, content, "broadcast");
        count += 1;
      }
    });
    return `已广播给 ${count} 名队友`;
  }
}

const shutdown_requests: Record<string, { target: string; status: string }> = {};
const plan_requests: Record<string, PlanRequest> = {};

// === 模块：团队协作（s09/s11） ===
// 管理持久化“队友代理”的生命周期和任务拉取逻辑。
class TeammateManager {
  config_path: string;
  config: TeamConfig;
  threads = new Map<string, Promise<void>>();

  constructor(private bus: MessageBus, private task_mgr: TaskManager) {
    fs.mkdirSync(TEAM_DIR, { recursive: true });
    this.config_path = path.join(TEAM_DIR, "config.json");
    this.config = this._load();
  }

  private _load(): TeamConfig {
    if (fs.existsSync(this.config_path)) {
      return JSON.parse(fs.readFileSync(this.config_path, "utf8")) as TeamConfig;
    }
    return { team_name: "default", members: [] };
  }

  private _save(): void {
    fs.writeFileSync(this.config_path, JSON.stringify(this.config, null, 2), "utf8");
  }

  private _find(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  // 启动或恢复一个队友线程并分配初始职责。
  spawn(name: string, role: string, prompt: string): string {
    const member = this._find(name);
    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") {
        return `错误：'${name}' 当前状态为 ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    this._save();
    const p = this._loop(name, role, prompt).catch(() => this._set_status(name, "shutdown"));
    this.threads.set(name, p);
    return `已启动 '${name}'（角色：${role}）`;
  }

  private _set_status(name: string, status: TeamMemberStatus): void {
    const member = this._find(name);
    if (!member) return;
    member.status = status;
    this._save();
  }

  // 队友主循环：处理消息、执行工具、idle 轮询与自动认领任务。
  private async _loop(name: string, role: string, prompt: string): Promise<void> {
    const team_name = this.config.team_name;
    const sys_prompt = `你是 '${name}'，角色：${role}，团队：${team_name}，工作目录：${WORKDIR}。` +
      "当前工作完成后请调用 idle。你可以自动认领任务。";
    const messages: HistoryMessage[] = [{ role: "user", content: prompt }];

    const tools: Tool[] = [
      { name: "bash", description: "执行命令。", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "read_file", description: "读取文件。", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write_file", description: "写入文件。", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      { name: "edit_file", description: "编辑文件。", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
      { name: "send_message", description: "发送消息。", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
      { name: "idle", description: "表示当前没有更多工作。", input_schema: { type: "object", properties: {} } },
      { name: "claim_task", description: "按 ID 认领任务。", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
    ];

    while (true) {
      for (let i = 0; i < 50; i += 1) {
        const inbox = this.bus.read_inbox(name);
        inbox.forEach((msg) => {
          if (msg.type === "shutdown_request") {
            this._set_status(name, "shutdown");
            throw new Error("shutdown");
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        });

        const request: MessageCreateParamsNonStreaming = {
          model: MODEL,
          system: sys_prompt,
          messages: messages as unknown as MessageParam[],
          tools,
          max_tokens: 8000,
        };
        const response = await client.messages.create(request);

        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason !== "tool_use") break;

        const results: ToolResultPayload[] = [];
        let idle_requested = false;
        for (const block of response.content) {
          if (!isToolUseBlock(block)) continue;
          const blockInput = toToolInput(block.input);
          let outputText = "未知";
          if (block.name === "idle") {
            idle_requested = true;
            outputText = "进入 idle 阶段。";
          } else if (block.name === "claim_task") {
            outputText = this.task_mgr.claim(Number(blockInput.task_id), name);
          } else if (block.name === "send_message") {
            outputText = this.bus.send(name, String(blockInput.to), String(blockInput.content));
          } else if (block.name === "bash") {
            outputText = await run_bash(String(blockInput.command ?? ""));
          } else if (block.name === "read_file") {
            outputText = await run_read(String(blockInput.path ?? ""));
          } else if (block.name === "write_file") {
            outputText = await run_write(String(blockInput.path ?? ""), String(blockInput.content ?? ""));
          } else if (block.name === "edit_file") {
            outputText = await run_edit(
              String(blockInput.path ?? ""),
              String(blockInput.old_text ?? ""),
              String(blockInput.new_text ?? ""),
            );
          }
          console.log(`  [${name}] ${block.name}: ${String(outputText).slice(0, 120)}`);
          results.push({ type: "tool_result", tool_use_id: block.id, content: String(outputText) });
        }
        messages.push({ role: "user", content: results });
        if (idle_requested) break;
      }

      this._set_status(name, "idle");
      let resume = false;
      for (let i = 0; i < Math.floor(IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1)); i += 1) {
        await sleep(POLL_INTERVAL * 1000);
        const inbox = this.bus.read_inbox(name);
        if (inbox.length) {
          inbox.forEach((msg) => {
            if (msg.type === "shutdown_request") {
              this._set_status(name, "shutdown");
              throw new Error("shutdown");
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          });
          resume = true;
          break;
        }

        const unclaimed: PersistentTask[] = fs
          .readdirSync(TASKS_DIR)
          .filter((f) => /^task_\d+\.json$/.test(f))
          .sort()
          .map((f) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf8")) as PersistentTask)
          .filter((t) => t.status === "pending" && !t.owner && !t.blockedBy.length);

        if (unclaimed.length) {
          const task = unclaimed[0];
          this.task_mgr.claim(task.id, name);
          if (messages.length <= 3) {
            messages.unshift({
              role: "user",
              content: `<identity>你是 '${name}'，角色：${role}，团队：${team_name}。</identity>`,
            });
            messages.splice(1, 0, { role: "assistant", content: `我是 ${name}。继续执行。` });
          }
          messages.push({
            role: "user",
            content: `<auto-claimed>任务 #${task.id}：${task.subject}\n${task.description}</auto-claimed>`,
          });
          messages.push({ role: "assistant", content: `已认领任务 #${task.id}，开始处理。` });
          resume = true;
          break;
        }
      }

      if (!resume) {
        this._set_status(name, "shutdown");
        return;
      }
      this._set_status(name, "working");
    }
  }

  // 返回当前团队状态快照。
  list_all(): string {
    if (!this.config.members.length) return "暂无队友。";
    return [`团队：${this.config.team_name}`]
      .concat(this.config.members.map((m) => `  ${m.name} (${m.role}): ${m.status}`))
      .join("\n");
  }

  // 返回所有成员名称，用于 broadcast。
  member_names(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

const TODO = new TodoManager();
const SKILLS = new SkillLoader(SKILLS_DIR);
const TASK_MGR = new TaskManager();
const BG = new BackgroundManager();
const BUS = new MessageBus();
const TEAM = new TeammateManager(BUS, TASK_MGR);

const SYSTEM =
  `你是位于 ${WORKDIR} 的 coding agent，请使用工具完成任务。\n` +
  "多步骤工作优先使用 task_create/task_update/task_list。短清单使用 TodoWrite。\n" +
  "需要子代理委派时使用 task。需要专业知识时使用 load_skill。\n" +
  `Skills：${SKILLS.descriptions()}`;

// 向队友发送 shutdown 请求并记录 request_id。
function handle_shutdown_request(teammate: string): string {
  const req_id = shortId();
  shutdown_requests[req_id] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "请执行 shutdown。", "shutdown_request", { request_id: req_id });
  return `已向 '${teammate}' 发送 shutdown 请求 ${req_id}`;
}

// 处理队友 plan 审批结果并通过消息总线回传。
function handle_plan_review(request_id: string, approve: boolean, feedback = ""): string {
  const req = plan_requests[request_id];
  if (!req) return `错误：未知的 plan request_id '${request_id}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", {
    request_id,
    approve,
    feedback,
  });
  return `已对 '${req.from}' 的计划执行：${req.status}`;
}

type ToolHandler = (kw: ToolInput) => Promise<string>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: async (kw) => run_bash(String(kw.command ?? ""), String(kw.tool_use_id ?? "")),
  read_file: async (kw) =>
    run_read(String(kw.path ?? ""), String(kw.tool_use_id ?? ""), kw.limit === undefined ? undefined : Number(kw.limit)),
  write_file: async (kw) => run_write(String(kw.path ?? ""), String(kw.content ?? "")),
  edit_file: async (kw) =>
    run_edit(String(kw.path ?? ""), String(kw.old_text ?? ""), String(kw.new_text ?? "")),
  TodoWrite: async (kw) => TODO.update(Array.isArray(kw.items) ? kw.items : []),
  task: async (kw) => run_subagent(String(kw.prompt ?? ""), String(kw.agent_type ?? "Explore")),
  load_skill: async (kw) => SKILLS.load(String(kw.name ?? "")),
  compress: async () => "正在压缩上下文...",
  background_run: async (kw) => BG.run(String(kw.command ?? ""), kw.timeout ? Number(kw.timeout) : 120),
  check_background: async (kw) => BG.check(kw.task_id ? String(kw.task_id) : undefined),
  task_create: async (kw) => TASK_MGR.create(String(kw.subject ?? ""), String(kw.description ?? "")),
  task_get: async (kw) => TASK_MGR.get(Number(kw.task_id)),
  task_update: async (kw) =>
    TASK_MGR.update(
      Number(kw.task_id),
      kw.status as PersistentTaskStatus | undefined,
      Array.isArray(kw.add_blocked_by) ? kw.add_blocked_by.map(Number) : undefined,
      Array.isArray(kw.add_blocks) ? kw.add_blocks.map(Number) : undefined,
    ),
  task_list: async () => TASK_MGR.list_all(),
  spawn_teammate: async (kw) => TEAM.spawn(String(kw.name ?? ""), String(kw.role ?? ""), String(kw.prompt ?? "")),
  list_teammates: async () => TEAM.list_all(),
  send_message: async (kw) =>
    BUS.send("lead", String(kw.to ?? ""), String(kw.content ?? ""), String(kw.msg_type ?? "message")),
  read_inbox: async () => JSON.stringify(BUS.read_inbox("lead"), null, 2),
  broadcast: async (kw) => BUS.broadcast("lead", String(kw.content ?? ""), TEAM.member_names()),
  shutdown_request: async (kw) => handle_shutdown_request(String(kw.teammate ?? "")),
  plan_approval: async (kw) =>
    handle_plan_review(String(kw.request_id ?? ""), Boolean(kw.approve), String(kw.feedback ?? "")),
  idle: async () => "Lead 不进入 idle。",
  claim_task: async (kw) => TASK_MGR.claim(Number(kw.task_id), "lead"),
};

const TOOLS: Tool[] = [
  { name: "bash", description: "执行 shell 命令。", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "读取文件内容。", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "将内容写入文件。", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "在文件中替换精确文本。", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "TodoWrite", description: "更新任务跟踪清单。", input_schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, activeForm: { type: "string" } }, required: ["content", "status", "activeForm"] } } }, required: ["items"] } },
  { name: "task", description: "启动 subagent 做隔离探索或执行。", input_schema: { type: "object", properties: { prompt: { type: "string" }, agent_type: { type: "string", enum: ["Explore", "general-purpose"] } }, required: ["prompt"] } },
  { name: "load_skill", description: "按名称加载专业技能。", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "compress", description: "手动压缩会话上下文。", input_schema: { type: "object", properties: {} } },
  { name: "background_run", description: "在后台线程执行命令。", input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] } },
  { name: "check_background", description: "检查后台任务状态。", input_schema: { type: "object", properties: { task_id: { type: "string" } } } },
  { name: "task_create", description: "创建持久化文件任务。", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_get", description: "按 ID 获取任务详情。", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "更新任务状态或依赖关系。", input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] }, add_blocked_by: { type: "array", items: { type: "integer" } }, add_blocks: { type: "array", items: { type: "integer" } } }, required: ["task_id"] } },
  { name: "task_list", description: "列出所有任务。", input_schema: { type: "object", properties: {} } },
  { name: "spawn_teammate", description: "启动持久化自治队友。", input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "列出所有队友。", input_schema: { type: "object", properties: {} } },
  { name: "send_message", description: "向队友发送消息。", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "读取并清空 lead 的收件箱。", input_schema: { type: "object", properties: {} } },
  { name: "broadcast", description: "向所有队友广播消息。", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "shutdown_request", description: "请求队友执行 shutdown。", input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "plan_approval", description: "批准或拒绝队友计划。", input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
  { name: "idle", description: "进入 idle 状态。", input_schema: { type: "object", properties: {} } },
  { name: "claim_task", description: "从任务板认领任务。", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
];

// Lead 主循环：拉取消息、调用模型、执行工具、处理压缩与提醒。
async function agent_loop(messages: HistoryMessage[]): Promise<void> {
  let rounds_without_todo = 0;
  while (true) {
    microcompact(messages);
    if (estimate_tokens(messages) > TOKEN_THRESHOLD) {
      console.log("[已触发自动压缩]");
      const compacted = await auto_compact(messages);
      messages.splice(0, messages.length, ...compacted);
    }

    const notifs = BG.drain();
    if (notifs.length) {
      const txt = notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${txt}\n</background-results>` });
      messages.push({ role: "assistant", content: "已记录后台结果。" });
    }

    const inbox = BUS.read_inbox("lead");
    if (inbox.length) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      messages.push({ role: "assistant", content: "已记录收件箱消息。" });
    }

    const request: MessageCreateParamsNonStreaming = {
      model: MODEL,
      system: SYSTEM,
      messages: messages as unknown as MessageParam[],
      tools: TOOLS,
      max_tokens: 8000,
    };
    const response = await client.messages.create(request);

    // 调试用
    const assistantText = response.content
      .filter(isTextBlock)
      .map((block) => block.text)
      .join("")
      .trim();
    if (assistantText) {
      console.log(assistantText);
      console.log('*-*');
    }

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") return;

    const results: (ToolResultPayload | TextPayload)[] = [];
    let used_todo = false;
    let manual_compress = false;
    let compact_focus: string | undefined = undefined;

    for (const block of response.content) {
      if (!isToolUseBlock(block)) continue;
      const blockInput = toToolInput(block.input);
      if (block.name === "compress") {
        manual_compress = true;
        compact_focus = blockInput.focus ? String(blockInput.focus) : undefined;
      }
      const handler = TOOL_HANDLERS[block.name];
      let outputText = `未知工具：${block.name}`;
      try {
        const tool_input: ToolInput = { ...blockInput, tool_use_id: block.id };
        outputText = handler ? await handler(tool_input) : outputText;
      } catch (e) {
        outputText = `错误：${String(e)}`;
      }
      console.log(`> ${block.name}: ${String(outputText).slice(0, 200)}`);
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: String(outputText),
      });
      if (block.name === "TodoWrite") used_todo = true;
    }

    rounds_without_todo = used_todo ? 0 : rounds_without_todo + 1;
    if (TODO.has_open_items() && rounds_without_todo >= 3) {
      results.unshift({ type: "text", text: "<reminder>请更新你的 todos。</reminder>" });
    }
    messages.push({ role: "user", content: results });

    if (manual_compress) {
      console.log("[手动压缩]");
      const compacted = await auto_compact(messages, compact_focus);
      messages.splice(0, messages.length, ...compacted);
    }
  }
}

// REPL 入口：接收用户输入并驱动 agent_loop。
async function repl(): Promise<void> {
  const history: HistoryMessage[] = [];
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const query = await rl.question("\u001b[36ms_full >> \u001b[0m");
      const trimmed = query.trim().toLowerCase();
      if (["q", "exit", ""].includes(trimmed)) break;
      if (query.trim() === "/compact") {
        if (history.length) {
          console.log("[通过 /compact 执行手动压缩]");
          const compacted = await auto_compact(history);
          history.splice(0, history.length, ...compacted);
        }
        continue;
      }
      if (query.trim() === "/tasks") {
        console.log(TASK_MGR.list_all());
        continue;
      }
      if (query.trim() === "/team") {
        console.log(TEAM.list_all());
        continue;
      }
      if (query.trim() === "/inbox") {
        console.log(JSON.stringify(BUS.read_inbox("lead"), null, 2));
        continue;
      }
      history.push({ role: "user", content: query });
      await agent_loop(history);
      console.log();
    }
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  repl().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
