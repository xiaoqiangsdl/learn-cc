import type {
  ContentBlock,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  TextBlock,
  Tool,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";

export type {
  ContentBlock,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  TextBlock,
  Tool,
  ToolUseBlock,
};

export type Role = "user" | "assistant";

export type ToolResultPayload = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

export type TextPayload = {
  type: "text";
  text: string;
};

export type HistoryMessage = {
  role: Role;
  content: unknown;
};

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  content: string;
  status: TodoStatus;
  activeForm: string;
};

export type PersistentTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type PersistentTask = {
  id: number;
  subject: string;
  description: string;
  status: PersistentTaskStatus;
  owner: string | null;
  blockedBy: number[];
  blocks: number[];
};

export type TeamMemberStatus = "idle" | "working" | "shutdown";

export type TeamMember = {
  name: string;
  role: string;
  status: TeamMemberStatus;
};

export type TeamConfig = {
  team_name: string;
  members: TeamMember[];
};

export type BusMessage = {
  type: string;
  from: string;
  content: string;
  timestamp: number;
  [k: string]: unknown;
};

export type BackgroundTask = {
  status: "running" | "completed" | "error";
  command: string;
  result: string | null;
};

export type PlanRequest = {
  from: string;
  status: "pending" | "approved" | "rejected";
};

export type ToolInput = Record<string, unknown>;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text";
}

export function toToolInput(input: unknown): ToolInput {
  return isRecord(input) ? input : {};
}
