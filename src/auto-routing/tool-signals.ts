// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from NVIDIA-NeMo/Switchyard commit 48b3b71d3cc629aa9eb011852f5a7da90957ba22.

export const DEFAULT_RECENT_WINDOW = 3;
export const SOFT_SEVERITY = 0.3;
export const HARD_SEVERITY = 0.7;
export const CRITICAL_SEVERITY = 1;

const ERROR_PATTERNS: Array<[string, number, string[]]> = [
  ["oom", CRITICAL_SEVERITY, ["out of memory", "memoryerror", "cannot allocate memory"]],
  ["connection_refused", CRITICAL_SEVERITY, ["connection refused", "connectionrefusederror", "econnrefused"]],
  ["traceback", HARD_SEVERITY, ["traceback (most recent call last)"]],
  ["import_error", HARD_SEVERITY, ["modulenotfounderror:", "importerror:", "no module named "]],
  ["cmd_not_found", HARD_SEVERITY, ["command not found", "not found\n", "/usr/bin/env: "]],
  ["assertion", HARD_SEVERITY, ["assertionerror"]],
  ["value_error", HARD_SEVERITY, ["valueerror:"]],
  ["syntax_error", HARD_SEVERITY, ["syntaxerror:"]],
  ["timeout", HARD_SEVERITY, ["timed out", "timeouterror", "timeout expired", "deadline exceeded"]],
  ["no_such_file", HARD_SEVERITY, ["filenotfounderror:", "no such file or directory", "file does not exist"]],
  ["exit_nonzero", SOFT_SEVERITY, ["exit code 1", "exit code 2", "exit status 1", "returned non-zero", "exited with code"]],
];

const EDIT_TOOLS = new Set(["edit", "multiedit", "notebookedit", "str_replace", "str_replace_based_edit_tool", "text_editor", "patch"]);
const WRITE_TOOLS = new Set(["write", "create_file", "new_file", "write_file"]);
const READ_TOOLS = new Set(["read", "view", "read_file", "search_files"]);
const PLAN_TOOLS = new Set(["todowrite", "todo_write", "todo", "update_plan"]);
const SHELL_TOOLS = new Set(["bash", "shell_command", "shell", "local_shell_call", "terminal"]);
const SHELL_WRITES = ["cat >", "cat >>", "echo >", "echo >>", "tee ", "printf >", "printf >>", "> /", ">> /", "<< 'eof'", "<<eof", "<<'eof'", "<< eof"];
const SHELL_EDITS = ["sed -i", "sed --in-place", "awk -i inplace", "awk 'inplace=1'", "patch ", "patch -p", "perl -i", "perl -p -i", "perl -pi"];
const SHELL_READS = ["cat /", "cat ./", "cat ../", "grep ", "ls ", "ls -", "find ", "head ", "tail ", "wc ", "diff ", "which ", "ps ", "df ", "du ", "stat ", "file ", "less ", "more "];
const TEST_PASS_PHRASES = [" passed", "passed in", "tests passed", "all tests passed", "test ok", "test result: ok", "passed.\n", "tests pass", "\nok ", "✓ "];
const TEST_FAILURE_LITERAL = ["✗ ", "fatal:", "assertionerror", "error:"];
const NUMERIC_FAILURE_KEYWORDS = ["failed", "failure", "failures", "errors", "error"];

export interface ToolSignals {
  severity: number;
  noErrorStreak: number;
  editCount: number;
  writeCount: number;
  readCount: number;
  planCount: number;
  recentEditCount: number;
  recentWriteCount: number;
  recentReadCount: number;
  recentPlanCount: number;
  pureShellStreak: number;
  testsPassed: boolean;
  turnDepth: number;
  compacted: boolean;
  toolResultTexts: string[];
}

interface ObservedToolCall {
  name: string;
  command?: string;
}

export function classifyText(text: string): { severity: number; patterns: string[] } {
  const lower = text.toLowerCase();
  const patterns: string[] = [];
  let severity = 0;
  for (const [name, level, substrings] of ERROR_PATTERNS) {
    if (substrings.some((substring) => lower.includes(substring))) {
      patterns.push(name);
      severity = Math.max(severity, level);
    }
  }
  return { severity, patterns };
}

export function extractToolSignals(
  messages: readonly Record<string, unknown>[],
  recentWindow = DEFAULT_RECENT_WINDOW,
): ToolSignals {
  const window = Math.max(1, Math.floor(recentWindow));
  const texts: string[] = [];
  const calls: ObservedToolCall[] = [];
  let compacted = false;
  for (const message of messages) {
    const text = messageText(message.content);
    if (text.toLowerCase().includes("session is being continued")) compacted = true;
    if (message.role === "tool" || message.role === "function") {
      if (text) texts.push(text);
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!isRecord(call)) continue;
        const fn = isRecord(call.function) ? call.function : call;
        calls.push({ name: typeof fn.name === "string" ? fn.name : "", command: commandFrom(fn.arguments) });
      }
    }
    if (message.role === "assistant" && isRecord(message.tool_call)) {
      const call = message.tool_call;
      calls.push({ name: typeof call.name === "string" ? call.name : "", command: commandFrom(call.arguments) });
    }
  }

  const severity = texts.slice(-window).reduce((max, text) => Math.max(max, classifyText(text).severity), 0);
  let noErrorStreak = 0;
  for (const text of [...texts].reverse()) {
    if (classifyText(text).severity > 0) break;
    noErrorStreak++;
  }
  const recentStart = Math.max(0, calls.length - window);
  let writeCount = 0;
  let editCount = 0;
  let readCount = 0;
  let planCount = 0;
  let recentWriteCount = 0;
  let recentEditCount = 0;
  let recentReadCount = 0;
  let recentPlanCount = 0;
  let pureShellStreak = 0;
  let streakOpen = true;
  calls.forEach((call, index) => {
    const category = classifyToolCall(call.name, call.command);
    if (category === "write") { writeCount++; if (index >= recentStart) recentWriteCount++; }
    if (category === "edit") { editCount++; if (index >= recentStart) recentEditCount++; }
    if (category === "read") { readCount++; if (index >= recentStart) recentReadCount++; }
    if (category === "plan") { planCount++; if (index >= recentStart) recentPlanCount++; }
  });
  for (const call of [...calls].reverse()) {
    if (!streakOpen) break;
    if (classifyToolCall(call.name, call.command) === "other") pureShellStreak++;
    else streakOpen = false;
  }
  return {
    severity,
    noErrorStreak,
    editCount,
    writeCount,
    readCount,
    planCount,
    recentEditCount,
    recentWriteCount,
    recentReadCount,
    recentPlanCount,
    pureShellStreak,
    testsPassed: detectTestsPassed(texts, window),
    turnDepth: messages.length,
    compacted,
    toolResultTexts: texts,
  };
}

type ToolCategory = "write" | "edit" | "read" | "plan" | "other";

function classifyToolCall(name: string, command?: string): ToolCategory {
  const lower = name.toLowerCase();
  if (WRITE_TOOLS.has(lower)) return "write";
  if (EDIT_TOOLS.has(lower)) return "edit";
  if (READ_TOOLS.has(lower)) return "read";
  if (PLAN_TOOLS.has(lower)) return "plan";
  if (SHELL_TOOLS.has(lower) && command) {
    if (SHELL_WRITES.some((pattern) => command.includes(pattern))) return "write";
    if (SHELL_EDITS.some((pattern) => command.includes(pattern))) return "edit";
    if (SHELL_READS.some((pattern) => command.includes(pattern))) return "read";
  }
  return "other";
}

function detectTestsPassed(texts: readonly string[], window: number): boolean {
  return texts.slice(-window).some((text) => {
    const lower = text.toLowerCase();
    return TEST_PASS_PHRASES.some((phrase) => lower.includes(phrase)) &&
      !TEST_FAILURE_LITERAL.some((phrase) => lower.includes(phrase)) &&
      !hasNonzeroFailureCount(lower);
  });
}

function hasNonzeroFailureCount(lower: string): boolean {
  for (const keyword of NUMERIC_FAILURE_KEYWORDS) {
    let cursor = 0;
    while (cursor < lower.length) {
      const relative = lower.slice(cursor).indexOf(keyword);
      if (relative < 0) break;
      const start = cursor + relative;
      const end = start + keyword.length;
      const next = lower[end];
      if (next === undefined || !/[a-z0-9]/.test(next)) {
        const prefix = lower.slice(0, start).trimEnd();
        const match = prefix.match(/(\d+)$/);
        if (match && [...match[1]].some((digit) => digit !== "0")) return true;
      }
      cursor = end;
    }
  }
  return false;
}

function commandFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed) && typeof parsed.command === "string") return parsed.command.toLowerCase();
    } catch { /* arguments may be a plain command string */ }
    return value.toLowerCase();
  }
  return isRecord(value) && typeof value.command === "string" ? value.command.toLowerCase() : undefined;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
