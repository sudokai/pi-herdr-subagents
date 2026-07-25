import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { __test__ } from "../index.ts";

const { shouldAutoCloseSubagentPane } = __test__;

describe("subagent pane auto-close", () => {
  const completed = { kind: "completed" as const, summary: "done", exitCode: 0 as const };
  const ping = { kind: "ping" as const, name: "worker", message: "help" };
  const completedUserExit = {
    kind: "completed-user-exit" as const,
    summary: "bye",
    exitCode: 0 as const,
  };
  const crashed = { kind: "crashed" as const, exitCode: 1, summary: null };
  const launchFailed = { kind: "launch-failed" as const, exitCode: 1, heldOpen: true };
  const cancelled = { kind: "cancelled" as const };

  it("closes pane on intentional completion and ping", () => {
    assert.equal(shouldAutoCloseSubagentPane(completed, false), true);
    assert.equal(shouldAutoCloseSubagentPane(ping, false), true);
    assert.equal(shouldAutoCloseSubagentPane(completed, true), true);
    assert.equal(shouldAutoCloseSubagentPane(ping, true), true);
  });

  it("keeps pane for other outcomes", () => {
    assert.equal(shouldAutoCloseSubagentPane(completedUserExit, false), false);
    assert.equal(shouldAutoCloseSubagentPane(crashed, false), false);
    assert.equal(shouldAutoCloseSubagentPane(launchFailed, false), false);
    assert.equal(shouldAutoCloseSubagentPane(cancelled, false), false);
  });
});
