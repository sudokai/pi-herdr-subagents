import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseAgentDefinition,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
} from "../src/agents.ts";

describe("subagent session mode", () => {
  it("defaults to lineage-only", () => {
    assert.equal(resolveEffectiveSessionMode({ name: "x", task: "y" }, null), "lineage-only");
  });

  it("fork param wins", () => {
    assert.equal(
      resolveEffectiveSessionMode({ name: "x", task: "y", fork: true }, null),
      "fork",
    );
  });

  it("respects agent session-mode", () => {
    assert.equal(
      resolveEffectiveSessionMode({ name: "x", task: "y" }, { sessionMode: "fork" }),
      "fork",
    );
  });

  it("lineage-only uses artifact delivery without inherited context", () => {
    const behavior = resolveLaunchBehavior({ name: "x", task: "y" }, null);
    assert.equal(behavior.sessionMode, "lineage-only");
    assert.equal(behavior.taskDelivery, "artifact");
    assert.equal(behavior.inheritsConversationContext, false);
  });

  it("fork uses direct delivery with inherited context", () => {
    const behavior = resolveLaunchBehavior({ name: "x", task: "y", fork: true }, null);
    assert.equal(behavior.sessionMode, "fork");
    assert.equal(behavior.taskDelivery, "direct");
    assert.equal(behavior.inheritsConversationContext, true);
  });

  it("maps legacy standalone session-mode to lineage-only", () => {
    const legacy = parseAgentDefinition(
      "---\nname: legacy\nsession-mode: standalone\n---\nbody",
      "legacy",
    );
    assert.equal(legacy?.sessionMode, "lineage-only");
  });
});
