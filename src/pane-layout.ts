import { equalizeTabLayout } from "./herdr/layout-equalize.ts";
import type { RunningSubagent } from "./watcher.ts";

export interface SubagentPaneSplit {
  direction: "right" | "down";
  targetPaneId?: string;
}

/** Most recent subagent pane id, including launches not yet in `running`. */
let latestSubagentPaneId: string | undefined;
let paneLaunchChain: Promise<unknown> = Promise.resolve();
let paneLaunchesInFlight = 0;

/**
 * Resolve herdr pane split topology for a new subagent launch.
 *
 * - First subagent: `right` split from the orchestrator (50/50 columns).
 * - Later subagents: `down` split from the most recently launched subagent pane.
 *
 * Pass `latestPaneId` when a pane was just created but is not in `running` yet.
 */
export function resolveSubagentPaneSplit(
  running: Iterable<RunningSubagent>,
  latestPaneId?: string,
): SubagentPaneSplit {
  const runningList = [...running];
  if (runningList.length === 0 && !latestPaneId) {
    return { direction: "right" };
  }

  const anchor = runningList.reduce<RunningSubagent | undefined>(
    (latest, agent) => (!latest || agent.startTime >= latest.startTime ? agent : latest),
    undefined,
  );
  const targetPaneId = anchor?.paneId ?? latestPaneId;
  if (!targetPaneId) {
    return { direction: "right" };
  }
  return { direction: "down", targetPaneId };
}

/** Serialize pane splits so concurrent launches get distinct layout slots. */
export async function withSerializedPaneLaunch<T>(fn: () => Promise<T>): Promise<T> {
  const run = paneLaunchChain.then(async () => {
    paneLaunchesInFlight++;
    try {
      return await fn();
    } finally {
      paneLaunchesInFlight--;
    }
  });
  paneLaunchChain = run.catch(() => {});
  return run;
}

/** Resolve layout, start the pane, and record the new anchor pane id. */
export async function startSubagentPaneWithLayout<
  T extends { direction?: "right" | "down"; targetPaneId?: string },
>(
  paneStart: T,
  running: Iterable<RunningSubagent>,
  paneStartFn: (payload: T) => Promise<{ paneId: string; tabId?: string }>,
): Promise<{ paneId: string; tabId?: string }> {
  return withSerializedPaneLaunch(async () => {
    const { direction, targetPaneId } = resolveSubagentPaneSplit(
      running,
      latestSubagentPaneId,
    );
    const started = await paneStartFn({ ...paneStart, direction, targetPaneId });
    latestSubagentPaneId = started.paneId;

    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (socketPath) {
      try {
        await equalizeTabLayout(socketPath, { tabId: started.tabId });
      } catch {
        // Best-effort; spawn proceeds if equalize fails.
      }
    }

    return started;
  });
}

/** Clear layout anchor when no subagents are running or launching. */
export function maybeResetSubagentPaneLayout(runningCount: number): void {
  if (runningCount === 0 && paneLaunchesInFlight === 0) {
    latestSubagentPaneId = undefined;
  }
}

/** @internal test helpers */
export const __paneLayoutTest__ = {
  resetSubagentPaneLayoutState: () => {
    latestSubagentPaneId = undefined;
    paneLaunchChain = Promise.resolve();
    paneLaunchesInFlight = 0;
  },
};
