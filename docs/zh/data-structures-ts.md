# Core Data Structures (TypeScript 版)

> 这份文档是 [`data-structures.md`](./data-structures.md) 的 TypeScript 落地版。目标不是穷举所有实现细节，而是把“状态放在哪一层、最小结构长什么样”直接写成可复用的类型定义。

## 推荐联读

- 不懂术语，先看 [`glossary.md`](./glossary.md)。
- 不懂边界，先看 [`entity-map.md`](./entity-map.md)。
- `TaskRecord` / `RuntimeTaskState` 容易混，配合 [`s13a-runtime-task-model.md`](./s13a-runtime-task-model.md)。
- MCP 的 resource / prompt / elicitation 边界，配合 [`s19a-mcp-capability-layers.md`](./s19a-mcp-capability-layers.md)。

## 使用方式

可以把下面代码块直接拷贝到一个类型文件，例如 `src/types/agent-state.ts`，再按你项目里的真实字段增减。

```ts
/* ============================================================
 * 0) Common Helpers
 * ============================================================ */

export type Dict = Record<string, unknown>;

export type Role = "user" | "assistant";

export type Status =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "idle"
  | "blocked"
  | "approved"
  | "rejected"
  | "expired";

/* ============================================================
 * 1) Query + Conversation Control
 * ============================================================ */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock<TInput = Dict> {
  type: "tool_use";
  name: string;
  input: TInput;
  id?: string;
}

export interface ToolResultBlock<TResult = unknown> {
  type: "tool_result";
  content: TResult;
  tool_use_id?: string;
  is_error?: boolean;
}

export type MessageBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: Role;
  content: string | MessageBlock[];
}

export interface NormalizedMessage {
  role: Role;
  content: MessageBlock[];
}

export interface CompactSummary {
  task_overview: string;
  current_state: string;
  key_decisions: string[];
  next_steps: string[];
}

export interface SystemPromptBlock {
  text: string;
  cache_scope: string | null;
}

export interface PromptParts {
  core: string;
  tools: string;
  skills: string;
  memory: string;
  claude_md: string;
  dynamic: string;
}

export interface QueryParams {
  messages: Message[];
  system_prompt: string;
  user_context: Dict;
  system_context: Dict;
  tool_use_context: ToolUseContext;
  fallback_model: string | null;
  max_output_tokens_override: number | null;
  max_turns: number | null;
}

export type TransitionReasonCode =
  | "next_turn"
  | "reactive_compact_retry"
  | "token_budget_continuation"
  | "max_output_tokens_recovery"
  | "stop_hook_continuation";

export interface TransitionReason {
  reason: TransitionReasonCode;
}

export interface QueryState {
  messages: Message[];
  tool_use_context: ToolUseContext;
  turn_count: number;
  max_output_tokens_recovery_count: number;
  has_attempted_reactive_compact: boolean;
  max_output_tokens_override: number | null;
  pending_tool_use_summary: CompactSummary | null;
  stop_hook_active: boolean;
  transition: TransitionReason | null;
}

/* ============================================================
 * 2) Tools + Permissions + Hooks
 * ============================================================ */

export interface ToolSpec<TSchema = Dict> {
  name: string;
  description: string;
  input_schema: TSchema;
}

export type ToolHandler<TInput = Dict, TResult = unknown> = (
  input: TInput,
  ctx: ToolUseContext
) => Promise<TResult> | TResult;

export type ToolDispatchMap = Record<string, ToolHandler>;

export interface PermissionContext {
  mode?: "default" | "acceptEdits" | "bypassPermissions" | string;
  cwd?: string;
  rules?: PermissionRule[];
  [key: string]: unknown;
}

export interface McpClientRef {
  name: string;
  connected?: boolean;
  [key: string]: unknown;
}

export interface ToolUseContext {
  tools: ToolDispatchMap;
  permission_context: PermissionContext;
  mcp_clients: McpClientRef[];
  messages: Message[];
  app_state: Dict;
  cwd: string;
  read_file_state: Dict;
  notifications: string[];
}

export type PermissionBehavior = "allow" | "deny" | "ask";

export interface PermissionRule {
  tool_name: string;
  rule_content: string;
  behavior: PermissionBehavior;
}

export type PermissionRuleSource =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "flagSettings"
  | "policySettings"
  | "cliArg"
  | "command"
  | "session";

export interface PermissionDecision {
  behavior: PermissionBehavior;
  reason: string;
  updated_input?: Dict;
  pending_classifier_check?: boolean;
  suggested_updates?: PermissionUpdate[];
}

export type PermissionUpdateType =
  | "addRules"
  | "removeRules"
  | "setMode"
  | "addDirectories";

export type PermissionUpdateDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session";

export interface PermissionUpdate {
  type: PermissionUpdateType;
  destination: PermissionUpdateDestination;
  rules?: PermissionRule[];
  mode?: string;
  directories?: string[];
}

export interface HookContext {
  event: string; // e.g. "PreToolUse"
  tool_name?: string;
  tool_input?: Dict;
  tool_result?: unknown;
  [key: string]: unknown;
}

export interface RecoveryState {
  continuation_attempts: number;
  compact_attempts: number;
  transport_attempts: number;
}

/* ============================================================
 * 3) Durable Work State
 * ============================================================ */

export interface TodoItem {
  content: string;
  status: "pending" | "completed";
}

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "private" | "team";

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  body: string;
}

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed"
  | "canceled";

export interface TaskRecord {
  id: number;
  subject: string;
  description: string;
  status: TaskStatus;
  blockedBy: number[];
  blocks: number[];
  owner: string;
  worktree: string;
}

export interface ScheduleRecord {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  created_at: number;
  last_fired_at: number | null;
}

/* ============================================================
 * 4) Runtime Execution State
 * ============================================================ */

export type RuntimeTaskType = "local_bash" | "tool_call" | "subagent" | string;
export type RuntimeTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export interface RuntimeTaskState {
  id: string;
  type: RuntimeTaskType;
  status: RuntimeTaskStatus;
  description: string;
  start_time: number;
  end_time: number | null;
  output_file: string;
  notified: boolean;
}

export type TeamMemberStatus = "idle" | "busy" | "offline";

export interface TeamMember {
  name: string;
  role: string;
  status: TeamMemberStatus;
}

export type MessageEnvelopeType =
  | "message"
  | "shutdown_request"
  | "plan_approval";

export interface MessageEnvelope<TPayload = Dict> {
  type: MessageEnvelopeType;
  from: string;
  to: string;
  request_id: string;
  content: string;
  payload: TPayload;
  timestamp: number;
}

export type RequestKind = "shutdown" | "plan_review";
export type RequestStatus = "pending" | "approved" | "rejected" | "expired";

export interface RequestRecord {
  request_id: string;
  kind: RequestKind;
  status: RequestStatus;
  from: string;
  to: string;
}

export type WorktreeStatus = "active" | "archived" | "deleted";

export interface WorktreeRecord {
  name: string;
  path: string;
  branch: string;
  task_id: number;
  status: WorktreeStatus;
}

export interface WorktreeEvent {
  event: string; // e.g. "worktree.create.after"
  task_id: number;
  worktree: string;
  ts: number;
}

/* ============================================================
 * 5) External Platform + MCP
 * ============================================================ */

export type McpScope = "local" | "user" | "project" | "dynamic" | "plugin";
export type McpTransportType = "stdio" | "sse" | "http";

export interface ScopedMcpServerConfig {
  name: string;
  type: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  scope: McpScope;
}

export type MCPConnectionType =
  | "connected"
  | "pending"
  | "failed"
  | "needs-auth"
  | "disabled";

export interface MCPServerConnectionState {
  name: string;
  type: MCPConnectionType;
  config: ScopedMcpServerConfig;
}

export interface MCPToolSpec<TSchema = Dict> {
  name: `mcp__${string}`;
  description: string;
  input_schema: TSchema;
}

export interface ElicitationRequest {
  server_name: string;
  message: string;
  requested_schema: Dict;
}

/* ============================================================
 * 6) Optional Aggregated View
 * ============================================================ */

export interface AgentStateSnapshot {
  query: QueryState;
  recovery: RecoveryState;
  runtime_tasks: RuntimeTaskState[];
  todos: TodoItem[];
  memories: MemoryEntry[];
  tasks: TaskRecord[];
  schedules: ScheduleRecord[];
  team: TeamMember[];
  worktrees: WorktreeRecord[];
  mcp_servers: MCPServerConnectionState[];
}
```

## 先记住两条建模边界

### 1) 内容状态 vs 流程状态

- 内容状态：`messages`、`tool_result`、`MemoryEntry.body`
- 流程状态：`turn_count`、`transition`、`pending_classifier_check`

### 2) 持久状态 vs 运行时状态

- 持久状态：`TaskRecord`、`MemoryEntry`、`ScheduleRecord`
- 运行时状态：`RuntimeTaskState`、`PermissionDecision`、`MCPServerConnectionState`

## 最后一句话

先把类型层级分对，再去补字段细节。  
这比一开始就追“全字段 1:1 复刻”更稳，也更符合真实工程迭代节奏。

