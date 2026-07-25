/**
 * Equalize herdr tab splits so each pane gets an even share along each axis.
 *
 * herdr models a tab as a binary BSP tree (`right` columns, `down` rows).
 * Rebalance dividers via layout.export and layout.set_split_ratio (divider moves
 * only — panes keep running).
 */
import net from "node:net";

export type LayoutNode =
  | { type: "pane"; [key: string]: unknown }
  | {
      type: "split";
      direction: "right" | "down";
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };

export interface EqualSplitTarget {
  path: boolean[];
  ratio: number;
}

/** How many slots a node occupies along a split axis (see herdr BSP layout). */
export function axisSpan(node: LayoutNode, axis: "right" | "down"): number {
  if (node.type === "pane") return 1;
  if (node.direction === axis) {
    return axisSpan(node.first, axis) + axisSpan(node.second, axis);
  }
  return 1;
}

/** Target ratio + tree path for every split in a layout tree. */
export function collectEqualSplitTargets(
  node: LayoutNode,
  path: boolean[] = [],
  out: EqualSplitTarget[] = [],
): EqualSplitTarget[] {
  if (node.type !== "split") return out;

  const first = axisSpan(node.first, node.direction);
  const second = axisSpan(node.second, node.direction);
  out.push({ path: [...path], ratio: first / (first + second) });
  collectEqualSplitTargets(node.first, [...path, false], out);
  collectEqualSplitTargets(node.second, [...path, true], out);
  return out;
}

type HerdrSocketResult = { layout?: { root?: LayoutNode } };

function callHerdrSocket<T>(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `layout-equalize-${Date.now()}`;
    const conn = net.connect(socketPath, () => {
      conn.write(`${JSON.stringify({ id, method, params })}\n`);
    });

    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(new Error(`timed out calling ${method}`));
    }, 5000);

    conn.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0 || settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();

      let msg: { error?: { message?: string }; result?: T };
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch {
        reject(new Error(`bad response for ${method}`));
        return;
      }
      if (msg.error) {
        reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        return;
      }
      resolve(msg.result as T);
    });

    conn.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Rebalance every split in a tab. Best-effort; no-op when the tab has one pane. */
export async function equalizeTabLayout(
  socketPath: string,
  scope: { tabId?: string; paneId?: string } = {},
): Promise<number> {
  const exportParams: Record<string, string> = {};
  if (scope.tabId) exportParams.tab_id = scope.tabId;
  else if (scope.paneId) exportParams.pane_id = scope.paneId;

  const exported = await callHerdrSocket<HerdrSocketResult>(
    socketPath,
    "layout.export",
    exportParams,
  );
  const root = exported?.layout?.root;
  if (!root || root.type !== "split") return 0;

  const targets = collectEqualSplitTargets(root);
  const base: Record<string, unknown> = { ...exportParams };
  for (const target of targets) {
    await callHerdrSocket(socketPath, "layout.set_split_ratio", {
      ...base,
      path: target.path,
      ratio: target.ratio,
    });
  }
  return targets.length;
}
