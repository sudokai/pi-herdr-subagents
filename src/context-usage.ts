import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

export const CONTEXT_USAGE_VERSION = 1 as const;
export const contextUsagePath = (sessionFile: string): string => `${sessionFile}.context-usage`;

export interface TokenBreakdown {
  input: number;
  cacheRead: number;
  output: number;
}

export interface ContextUsageSnapshot {
  version: typeof CONTEXT_USAGE_VERSION;
  subagentId: string;
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  input?: number;
  cacheRead?: number;
  output?: number;
}

type ContextUsage = Pick<
  ContextUsageSnapshot,
  "tokens" | "contextWindow" | "percent" | "input" | "cacheRead" | "output"
>;

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function isOptionalNonNegativeNumber(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function addUsageToBreakdown(totals: TokenBreakdown, usage: Usage): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
}

/** Aggregate billed input, cached input, and output tokens across the session. */
export function aggregateSessionTokenBreakdown(entries: readonly SessionEntry[]): TokenBreakdown {
  const totals: TokenBreakdown = { input: 0, cacheRead: 0, output: 0 };
  for (const entry of entries) {
    if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      addUsageToBreakdown(totals, entry.usage);
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (message.role === "toolResult" && message.usage) {
      addUsageToBreakdown(totals, message.usage);
    } else if (message.role === "assistant") {
      addUsageToBreakdown(totals, message.usage);
    }
  }
  return totals;
}

function formatTokenCount(value: number): string {
  if (value < 1_000) return value.toString();
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

export function formatContextUsageLine(usage: ContextUsageSnapshot | null | undefined): string {
  if (usage?.tokens == null || usage.percent == null || usage.contextWindow <= 0) return "";

  const remaining = Math.max(0, usage.contextWindow - usage.tokens);
  const percent = usage.percent.toFixed(2);
  let line =
    `\n\nContext: ${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)} tokens ` +
    `(${percent}% used, ${formatTokenCount(remaining)} remaining`;

  const breakdownParts: string[] = [];
  if (usage.input != null) breakdownParts.push(`input ${formatTokenCount(usage.input)}`);
  if (usage.cacheRead != null) {
    breakdownParts.push(`cached input ${formatTokenCount(usage.cacheRead)}`);
  }
  if (usage.output != null) breakdownParts.push(`output ${formatTokenCount(usage.output)}`);
  if (breakdownParts.length > 0) line += `; ${breakdownParts.join(", ")}`;

  return `${line}).`;
}

export function isContextUsageSnapshot(value: unknown): value is ContextUsageSnapshot {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === CONTEXT_USAGE_VERSION &&
    typeof candidate.subagentId === "string" &&
    candidate.subagentId.length > 0 &&
    isNullableNonNegativeNumber(candidate.tokens) &&
    typeof candidate.contextWindow === "number" &&
    Number.isFinite(candidate.contextWindow) &&
    candidate.contextWindow >= 0 &&
    isNullableNonNegativeNumber(candidate.percent) &&
    isOptionalNonNegativeNumber(candidate.input) &&
    isOptionalNonNegativeNumber(candidate.cacheRead) &&
    isOptionalNonNegativeNumber(candidate.output)
  );
}

/** Write a complete snapshot before atomically publishing it at the sidecar path. */
export function writeContextUsageSidecar(
  sessionFile: string,
  id: string,
  usage: ContextUsage,
  options?: { overwrite?: boolean },
): boolean {
  if (
    !id ||
    !isContextUsageSnapshot({ version: CONTEXT_USAGE_VERSION, subagentId: id, ...usage })
  ) {
    return false;
  }

  const target = contextUsagePath(sessionFile);
  if (options?.overwrite === false && existsSync(target)) return false;

  const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(
      temp,
      JSON.stringify({ version: CONTEXT_USAGE_VERSION, subagentId: id, ...usage }),
    );
    if (options?.overwrite === false && existsSync(target)) return false;
    renameSync(temp, target);
    return true;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Read once, validate ownership, and consume even malformed or stale telemetry. */
export function consumeContextUsageSidecar(
  sessionFile: string,
  expectedId: string,
): ContextUsageSnapshot | null {
  const path = contextUsagePath(sessionFile);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isContextUsageSnapshot(parsed) && parsed.subagentId === expectedId ? parsed : null;
  } catch {
    return null;
  } finally {
    rmSync(path, { force: true });
  }
}
