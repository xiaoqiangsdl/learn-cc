/**
 * agent-state.types.ts
 *
 * 按 docs/zh/data-structures-ts.md 抽出的可复用类型定义。
 * 目标：
 * 1) 提供按“控制层”分组的状态建模；
 * 2) 与现有 s_full.ts 的关键数据形状保持兼容。
 */

/* ============================================================
 * 0) Common
 * ============================================================ */

export type Dict = Record<string, unknown>;

export type Role = "user" | "assistant";

/** Unix 时间戳（秒）。项目里很多事件都使用秒级精度，便于 JSON 持久化。 */
export type UnixSeconds = number;

/* ============================================================
 * 1) Query + Conversation Control
 * ============================================================ */

export interface TextBlock {
  type: "text";
  text: string;
}

/** 模型发起的一次工具调用请求。 */
export interface ToolUseBlock<TInput = Dict> {
  type: "tool_use";
  id: string;
  name: string;
  input: TInput;
}

/** 工具执行结果回写给模型时使用的 block。 */
export interface ToolResultBlock<TResult = string> {
  type: "tool_result";
  tool_use_id: string;
  content: TResult;
  is_error?: boolean;
}

/** 单条消息里可出现的 block 联合。 */
export type MessageBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/** 对话历史中的原始消息：允许 string 或 block 数组。 */
export interface HistoryMessage {
  role: Role;
  content: string | MessageBlock[] | unknown;
}

/** 送给模型 API 前的标准化消息格式。 */
export interface NormalizedMessage {
  role: Role;
  content: MessageBlock[];
}

/** 上下文压缩后的摘要结构，用于替代长历史。 */
export interface CompactSummary {
  task_overview: string;
  current_state: string;
  key_decisions: string[];
  next_steps: string[];
}

/** system prompt 的分块单元，cache_scope 用于缓存策略。 */
export interface SystemPromptBlock {
  text: string;
  cache_scope: string | null;
}

/** 拼装 system prompt 时的中间结构。 */
export interface PromptParts {
  core: string;
  tools: string;
  skills: string;
  memory: string;
  claude_md: string;
  dynamic: string;
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

/** 一次 query 的入口参数（外部输入快照）。 */
export interface QueryParams {
  messages: HistoryMessage[];
  system_prompt: string;
  user_context: Dict;
  system_context: Dict;
  tool_use_context: ToolUseContext;
  fallback_model: string | null;
  max_output_tokens_override: number | null;
  max_turns: number | null;
}

/** query 主循环中的可变控制状态。 */
export interface QueryState {
  messages: HistoryMessage[];
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
 * 2) Tool + Permission + Hook
 * ============================================================ */

export interface ToolSpec<TSchema = Dict> {
  name: string;
  description: string;
  input_schema: TSchema;
}

/** 工具输入在运行时统一收敛为对象。 */
export type ToolInput = Dict;

/** 权限引擎的上下文，包含模式、规则和 cwd 等信息。 */
export interface PermissionContext {
  mode?: "default" | "acceptEdits" | "bypassPermissions" | string;
  cwd?: string;
  rules?: PermissionRule[];
  [key: string]: unknown;
}

/** 已连接 MCP 客户端的最小引用信息。 */
export interface McpClientRef {
  name: string;
  connected?: boolean;
  [key: string]: unknown;
}

/** 工具执行总线：工具处理器 + 权限 + mcp + app 运行态。 */
export interface ToolUseContext {
  tools: Record<string, unknown>;
  permission_context: PermissionContext;
  mcp_clients: McpClientRef[];
  messages: HistoryMessage[];
  app_state: Dict;
  cwd: string;
  read_file_state: Dict;
  notifications: string[];
}

export type PermissionBehavior = "allow" | "deny" | "ask";

/** 静态权限规则。 */
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

/** 单次权限判定结果，可附带建议更新。 */
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

/** 权限确认后写回配置的变更描述。 */
export interface PermissionUpdate {
  type: PermissionUpdateType;
  destination: PermissionUpdateDestination;
  rules?: PermissionRule[];
  mode?: string;
  directories?: string[];
}

export interface HookContext {
  event: string;
  tool_name?: string;
  tool_input?: Dict;
  tool_result?: unknown;
  [key: string]: unknown;
}

/** 出错后恢复链路的尝试次数统计。 */
export interface RecoveryState {
  continuation_attempts: number;
  compact_attempts: number;
  transport_attempts: number;
}

/* ============================================================
 * 3) Durable Work State
 * ============================================================ */

export type TodoStatus = "pending" | "in_progress" | "completed";

/** 会话级 todo 项。activeForm 在部分实现里是必填，这里做可选兼容。 */
export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "private" | "team";

/** 跨会话可持久化的 memory 条目。 */
export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  body: string;
}

export type PersistentTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

/** 磁盘任务图中的节点结构。 */
export interface TaskRecord {
  id: number;
  subject: string;
  description: string;
  status: PersistentTaskStatus;
  blockedBy: number[];
  blocks: number[];
  owner: string | null;
  worktree?: string;
}

/** cron 调度记录。 */
export interface ScheduleRecord {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  created_at: UnixSeconds;
  last_fired_at: UnixSeconds | null;
}

/* ============================================================
 * 4) Runtime Execution State
 * ============================================================ */

export type RuntimeTaskType = "local_bash" | "tool_call" | "subagent" | string;
export type RuntimeTaskStatus = "pending" | "running" | "completed" | "failed" | "canceled";

/** 当前进程内执行槽位（运行态任务），与 TaskRecord 不同。 */
export interface RuntimeTaskState {
  id: string;
  type: RuntimeTaskType;
  status: RuntimeTaskStatus;
  description: string;
  start_time: UnixSeconds;
  end_time: UnixSeconds | null;
  output_file: string;
  notified: boolean;
}

export type TeamMemberStatus = "idle" | "working" | "shutdown" | "offline";

/** 持久队友信息。 */
export interface TeamMember {
  name: string;
  role: string;
  status: TeamMemberStatus;
}

/** 团队配置文件结构。 */
export interface TeamConfig {
  team_name: string;
  members: TeamMember[];
}

export type MessageEnvelopeType =
  | "message"
  | "broadcast"
  | "shutdown_request"
  | "shutdown_response"
  | "plan_approval"
  | "plan_approval_response";

/** 队友间结构化消息信封。 */
export interface MessageEnvelope<TPayload = Dict> {
  type: MessageEnvelopeType;
  from: string;
  to?: string;
  request_id?: string;
  content: string;
  payload?: TPayload;
  timestamp: UnixSeconds;
}

export type RequestKind = "shutdown" | "plan_review";
export type RequestStatus = "pending" | "approved" | "rejected" | "expired";

/** 协议请求状态（例如 plan review / shutdown）。 */
export interface RequestRecord {
  request_id: string;
  kind: RequestKind;
  status: RequestStatus;
  from: string;
  to: string;
}

export type WorktreeStatus = "active" | "archived" | "deleted";

/** 任务绑定的 worktree 元数据。 */
export interface WorktreeRecord {
  name: string;
  path: string;
  branch: string;
  task_id: number;
  status: WorktreeStatus;
}

/** worktree 生命周期事件日志。 */
export interface WorktreeEvent {
  event: string;
  task_id: number;
  worktree: string;
  ts: UnixSeconds;
}

/* ============================================================
 * 5) MCP
 * ============================================================ */

export type McpScope = "local" | "user" | "project" | "dynamic" | "plugin";
export type McpTransportType = "stdio" | "sse" | "http";

/** 带作用域信息的 MCP Server 配置。 */
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

/** MCP 连接状态机快照。 */
export interface MCPServerConnectionState {
  name: string;
  type: MCPConnectionType;
  config: ScopedMcpServerConfig;
}

/** 统一后的 MCP 工具定义（映射到 agent 工具体系）。 */
export interface MCPToolSpec<TSchema = Dict> {
  name: `mcp__${string}`;
  description: string;
  input_schema: TSchema;
}

/** MCP 反向向用户索取参数时的请求结构。 */
export interface ElicitationRequest {
  server_name: string;
  message: string;
  requested_schema: Dict;
}

/* ============================================================
 * 6) Aggregated Snapshot
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

/* ============================================================
 * 7) s_full.ts Compatibility Aliases
 * ============================================================ */

export type PersistentTask = TaskRecord;
/** 这里保留更强约束的信封模型；s_full.types.ts 里会放宽为 string type。 */
export type BusMessage = MessageEnvelope;
export type PlanRequest = {
  from: string;
  status: "pending" | "approved" | "rejected";
};
export type BackgroundTask = {
  status: "running" | "completed" | "error";
  command: string;
  result: string | null;
};
