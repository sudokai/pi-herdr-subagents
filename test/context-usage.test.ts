import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateSessionTokenBreakdown,
  formatContextUsageLine,
} from "../src/context-usage.ts";

describe("context usage", () => {
  const usage = {
    version: 1 as const,
    subagentId: "sub-1",
    tokens: 28228,
    contextWindow: 1_000_000,
    percent: 2.8228,
    input: 15000,
    cacheRead: 5000,
    output: 8228,
  };

  it("formats context usage with breakdown", () => {
    assert.equal(
      formatContextUsageLine(usage),
      "\n\nContext: 28k/1.0M tokens (2.82% used, 972k remaining; input 15k, cached input 5.0k, output 8.2k).",
    );
  });

  it("omits breakdown when absent", () => {
    assert.equal(
      formatContextUsageLine({
        ...usage,
        input: undefined,
        cacheRead: undefined,
        output: undefined,
      }),
      "\n\nContext: 28k/1.0M tokens (2.82% used, 972k remaining).",
    );
  });

  it("aggregates assistant, tool, and compaction usage", () => {
    const breakdown = aggregateSessionTokenBreakdown([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, cost: { total: 0 } },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0 } },
        },
      },
      {
        type: "compaction",
        usage: { input: 10, output: 3, cacheRead: 4, cacheWrite: 0, cost: { total: 0 } },
      },
    ] as any);
    assert.equal(breakdown.input, 115);
    assert.equal(breakdown.cacheRead, 35);
    assert.equal(breakdown.output, 25);
  });
});
