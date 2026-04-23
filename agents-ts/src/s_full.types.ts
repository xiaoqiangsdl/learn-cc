import type {
  ContentBlock,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  TextBlock,
  Tool,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";

import type {
  TodoItem as AgentTodoItem,
  ToolInput,
} from "./agent-state.types";

export type {
  BackgroundTask,
  HistoryMessage,
  PersistentTask,
  PersistentTaskStatus,
  PlanRequest,
  Role,
  TeamConfig,
  TeamMember,
  TeamMemberStatus,
  TodoStatus,
  ToolInput,
} from "./agent-state.types";

export type {
  ContentBlock,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  TextBlock,
  Tool,
  ToolUseBlock,
};

// s_full.ts 当前的消息总线允许更宽松的字符串 type，这里保留兼容定义。
export type BusMessage = {
  type: string;
  from: string;
  content: string;
  timestamp: number;
  [k: string]: unknown;
};

// 为 s_full.ts 保留“必填 activeForm”的兼容约束。
export type TodoItem = AgentTodoItem & {
  activeForm: string;
};

export type TextPayload = {
  type: "text";
  text: string;
};

export type ToolResultPayload = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text";
}

// 工具入参统一收敛为对象，避免运行时对 null/primitive 做属性访问。
export function toToolInput(input: unknown): ToolInput {
  return isRecord(input) ? input : {};
}
