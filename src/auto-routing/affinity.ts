// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Adapted from NVIDIA-NeMo/Switchyard commit 48b3b71d3cc629aa9eb011852f5a7da90957ba22.

import { createHash } from "node:crypto";

export interface AffinityEntry {
  model: string;
  expiresAt: number;
  fallback?: boolean;
}

/** Process-local, TTL-bounded model affinity. */
export class SessionAffinity {
  private readonly assignments = new Map<string, AffinityEntry>();
  private readonly responseSessions = new Map<string, { key: string; expiresAt: number }>();

  constructor(
    private readonly ttlMs = 6 * 60 * 60 * 1000,
    private readonly maxEntries = 4096,
  ) {}

  keyFor(input: { sessionId?: string | null; previousResponseId?: string | null }): string | undefined {
    if (input.sessionId?.trim()) return `session:${input.sessionId.trim()}`;
    if (input.previousResponseId?.trim()) {
      const responseId = input.previousResponseId.trim();
      const linked = this.responseSessions.get(responseId);
      if (linked && linked.expiresAt > Date.now()) return linked.key;
      if (linked) this.responseSessions.delete(responseId);
      return `response:${responseId}`;
    }
    return undefined;
  }

  lookup(key: string, now = Date.now()): AffinityEntry | undefined {
    const entry = this.assignments.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.assignments.delete(key);
      return undefined;
    }
    return { ...entry };
  }

  remember(key: string, model: string, fallback = false, now = Date.now()): void {
    if (this.assignments.size >= this.maxEntries && !this.assignments.has(key)) {
      const oldest = this.assignments.keys().next().value;
      if (oldest) this.assignments.delete(oldest);
    }
    this.assignments.set(key, { model, fallback, expiresAt: now + this.ttlMs });
  }

  linkResponse(responseId: string, key: string, now = Date.now()): void {
    if (!responseId) return;
    if (this.responseSessions.size >= this.maxEntries && !this.responseSessions.has(responseId)) {
      const oldest = this.responseSessions.keys().next().value;
      if (oldest) this.responseSessions.delete(oldest);
    }
    this.responseSessions.set(responseId, { key, expiresAt: now + this.ttlMs });
  }

  forget(key: string, model?: string): void {
    const current = this.assignments.get(key);
    if (current && (!model || current.model === model)) this.assignments.delete(key);
  }

  static messageHash(messages: readonly Record<string, unknown>[]): string | undefined {
    const firstUser = messages.find((message) => message.role === "user");
    if (!firstUser) return undefined;
    const content = typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content ?? "");
    if (!content) return undefined;
    return `message:${createHash("sha256").update(content).digest("hex").slice(0, 32)}`;
  }

  clear(): void {
    this.assignments.clear();
    this.responseSessions.clear();
  }
}
