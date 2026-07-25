import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { __test__ } from "../index.ts";

const { resolveSubagentPaneSplit, startSubagentPaneWithLayout, __paneLayoutTest__ } = __test__;

describe("subagent pane layout", () => {
  it("first subagent splits right from orchestrator", () => {
    __paneLayoutTest__.resetSubagentPaneLayoutState();
    const split = resolveSubagentPaneSplit([]);
    assert.equal(split.split, "right");
    assert.equal(split.splitFromPaneId, undefined);
  });

  it("later subagents split down from the most recent pane", () => {
    const first = {
      id: "a",
      name: "first",
      task: "t",
      paneId: "pane-1",
      startTime: 100,
      sessionFile: "/tmp/a.jsonl",
      launchScriptFile: "/tmp/a.sh",
      interactive: false,
    };
    const oneRunning = resolveSubagentPaneSplit([first]);
    assert.equal(oneRunning.split, "down");
    assert.equal(oneRunning.splitFromPaneId, "pane-1");

    const second = { ...first, id: "b", name: "second", paneId: "pane-2", startTime: 200 };
    const twoRunning = resolveSubagentPaneSplit([first, second]);
    assert.equal(twoRunning.split, "down");
    assert.equal(twoRunning.splitFromPaneId, "pane-2");
  });

  it("uses latest pane id when no subagents are running yet", () => {
    const pendingOnly = resolveSubagentPaneSplit([], "pane-pending");
    assert.equal(pendingOnly.split, "down");
    assert.equal(pendingOnly.splitFromPaneId, "pane-pending");
  });

  it("serializes concurrent launches as right then down", async () => {
    __paneLayoutTest__.resetSubagentPaneLayoutState();
    const launchOrder: Array<"right" | "down" | undefined> = [];
    await Promise.all([
      startSubagentPaneWithLayout({ cwd: "/tmp" }, [], async (payload) => {
        launchOrder.push(payload.split);
        await new Promise((r) => setTimeout(r, 20));
        return { paneId: "pane-a" };
      }),
      startSubagentPaneWithLayout({ cwd: "/tmp" }, [], async (payload) => {
        launchOrder.push(payload.split);
        return { paneId: "pane-b" };
      }),
    ]);
    assert.deepEqual(launchOrder, ["right", "down"]);
  });
});
