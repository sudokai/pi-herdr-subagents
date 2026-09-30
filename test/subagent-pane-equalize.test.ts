import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { __test__ } from "../index.ts";
import type { LayoutNode } from "../src/herdr/layout-equalize.ts";

const { collectEqualSplitTargets } = __test__;

const pane = (id: string) => ({ type: "pane" as const, pane_id: id });
const split = (
  direction: "right" | "down",
  ratio: number,
  first: LayoutNode,
  second: LayoutNode,
): LayoutNode => ({ type: "split" as const, direction, ratio, first, second });

describe("layout equalize targets", () => {
  it("equalizes two stacked panes", () => {
    const targets = collectEqualSplitTargets(split("down", 0.5, pane("a"), pane("b")));
    assert.equal(targets.length, 1);
    assert.ok(Math.abs(targets[0]!.ratio - 0.5) < 1e-6);
  });

  it("equalizes three stacked panes", () => {
    const tree = split("down", 0.5, pane("a"), split("down", 0.5, pane("b"), pane("c")));
    const targets = collectEqualSplitTargets(tree);
    const root = targets.find((t) => t.path.length === 0);
    const inner = targets.find((t) => t.path.length === 1 && t.path[0] === true);
    assert.equal(targets.length, 2);
    assert.ok(root && Math.abs(root.ratio - 1 / 3) < 1e-6);
    assert.ok(inner && Math.abs(inner.ratio - 0.5) < 1e-6);
  });

  it("equalizes two columns", () => {
    const targets = collectEqualSplitTargets(split("right", 0.5, pane("main"), pane("sub")));
    assert.equal(targets.length, 1);
    assert.ok(Math.abs(targets[0]!.ratio - 0.5) < 1e-6);
  });
});
