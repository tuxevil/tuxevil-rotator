// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from NVIDIA-NeMo/Switchyard commit 48b3b71d3cc629aa9eb011852f5a7da90957ba22.

export interface TrajectoryMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
}

export interface TrajectorySummaryOptions {
  recentTurnWindow?: number;
  windowMessageChars?: number;
  maxRequestChars?: number;
}

/** Keeps anchors, a bounded recent tail, and never emits an unpaired tool result. */
export function summarizeTrajectory(
  messages: readonly TrajectoryMessage[],
  options: TrajectorySummaryOptions = {},
): string {
  const recentWindow = options.recentTurnWindow ?? 28;
  const perMessage = options.windowMessageChars ?? 500;
  const maxChars = options.maxRequestChars ?? 16_000;
  const opening = messages.find((message) => message.role === "user");
  const tail = messages.slice(Math.max(0, messages.length - recentWindow));
  const selected = opening && !tail.includes(opening) ? [opening, ...tail] : tail;
  const lines = selected.map((message) => {
    const text = messageText(message.content);
    const toolCalls = Array.isArray(message.tool_calls) ? ` tool_calls=${message.tool_calls.length}` : "";
    return `${message.role ?? "unknown"}: ${text.slice(0, perMessage)}${toolCalls}`;
  });
  return truncateWithAnchors(lines.join("\n"), maxChars);
}

export function truncateWithAnchors(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n…[trajectory truncated]…\n";
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((part) => typeof part === "string" ? part : isRecord(part) && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
