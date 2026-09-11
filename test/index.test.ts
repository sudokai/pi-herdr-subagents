import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import herdrSubagents, { __test__, createHerdrSubagentsExtension } from "../index.ts";
import { HERDR_PLUGIN_ID } from "../src/herdr/client.ts";
import type { SubagentOutcome } from "../src/watcher.ts";

const INDEX_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");

// ── env management ─────────────────────────────────────────────────────────
// These tests may themselves run inside herdr / a subagent — always set or
// delete every relevant key explicitly, and restore afterwards.

const ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_TAB_ID",
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_ID",
  "PI_HERDR_PI_BIN",
  "PI_CODING_AGENT_DIR",
] as const;

const savedEnv = new Map<string, string | undefined>();
const cleanups: Array<() => void> = [];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  __test__.reset();
  while (cleanups.length > 0) cleanups.pop()!();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

function envInsideHerdr(): void {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.HERDR_SOCKET_PATH = "/tmp/fake-herdr-test.sock";
}

// ── fakes ──────────────────────────────────────────────────────────────────

interface FakeToolInfo {
  name: string;
  sourceInfo?: { path: string };
}

function createFakePi(opts?: { allTools?: FakeToolInfo[] }) {
  const registeredTools: any[] = [];
  const commands: Array<{ name: string; handler: Function }> = [];
  const renderers = new Map<string, unknown>();
  const handlers = new Map<string, Function[]>();
  const sent: Array<{ message: any; options: any }> = [];
  const sentUser: string[] = [];
  let allTools: FakeToolInfo[] | null = opts?.allTools ?? null;

  const api: any = {
    registerTool(tool: any) {
      registeredTools.push(tool);
    },
    registerCommand(name: string, options: any) {
      commands.push({ name, ...options });
    },
    registerMessageRenderer(type: string, renderer: unknown) {
      renderers.set(type, renderer);
    },
    registerShortcut() {},
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
    sendUserMessage(text: string) {
      sentUser.push(text);
    },
    getAllTools(): FakeToolInfo[] {
      if (allTools) return allTools;
      return registeredTools.map((t) => ({ name: t.name, sourceInfo: { path: INDEX_PATH } }));
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0 };
    },
  };

  return {
    api,
    registeredTools,
    commands,
    renderers,
    sent,
    sentUser,
    setAllTools(tools: FakeToolInfo[]) {
      allTools = tools;
    },
    toolNames(): string[] {
      return registeredTools.map((t) => t.name);
    },
    findTool(name: string) {
      return registeredTools.find((t) => t.name === name);
    },
    fire(event: string, eventObj: unknown, ctx: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(eventObj, ctx);
    },
  };
}

function makeFakeCtx(overrides?: {
  cwd?: string;
  sessionFile?: string | null;
  sessionDir?: string;
  sessionId?: string;
  mode?: "tui" | "rpc" | "json" | "print";
}) {
  const notifications: Array<{ message: string; type: string }> = [];
  const ctx = {
    mode: overrides?.mode ?? "tui",
    hasUI: false,
    cwd: overrides?.cwd ?? "/tmp",
    ui: {
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
      setWidget() {},
    },
    sessionManager: {
      getSessionFile: () =>
        overrides?.sessionFile !== undefined ? overrides.sessionFile : "/tmp/orch.jsonl",
      getSessionId: () => overrides?.sessionId ?? "orch-session-id",
      getSessionDir: () => overrides?.sessionDir ?? "/tmp/orch-sessions",
    },
  };
  return { ctx, notifications };
}

function makeFakeClient(overrides?: Partial<Record<string, Function>>) {
  return {
    async paneStart() {
      return { paneId: "w1:p9", terminalId: "term1", workspaceId: "w1", tabId: "t1" };
    },
    async paneRename() {},
    async paneGet() {
      return null;
    },
    async paneList() {
      return [];
    },
    async paneClose() {},
    async paneSendKeys() {},
    async ping() {
      return { ok: true, version: "0.8.2", protocol: 14 };
    },
    async pluginGet() {
      return { plugin_id: "pi-herdr-subagents", enabled: true };
    },
    async pluginLink() {},
    ...overrides,
  } as any;
}

function makeFakeStream() {
  return {
    watch() {
      return () => {};
    },
    onReconcile() {
      return () => {};
    },
    close() {},
    connected: false,
  };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── fixture for real-launch-plan spawns ────────────────────────────────────

function makeSpawnFixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-index-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const agentDir = join(root, "agent-config");
  mkdirSync(agentDir, { recursive: true });
  const sessionDir = join(root, "orch-sessions");
  mkdirSync(sessionDir, { recursive: true });
  const parentSessionFile = join(sessionDir, "parent.jsonl");
  writeFileSync(parentSessionFile, JSON.stringify({ type: "session", version: 3, id: "p1" }) + "\n");

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_HERDR_PI_BIN = "/usr/local/bin/pi-fake";

  const { ctx, notifications } = makeFakeCtx({
    cwd,
    sessionFile: parentSessionFile,
    sessionDir,
    sessionId: "orch-session-id",
  });
  return { root, cwd, agentDir, sessionDir, parentSessionFile, ctx, notifications };
}

// ── activation guard ───────────────────────────────────────────────────────

describe("index: activation guard", () => {
  it("not inside herdr → no tools registered at load", () => {
    const fake = createFakePi();
    herdrSubagents(fake.api);
    assert.deepEqual(fake.toolNames(), []);
  });

  it("inside herdr → subagent tool registered at load", () => {
    envInsideHerdr();
    const fake = createFakePi();
    herdrSubagents(fake.api);
    assert.ok(fake.toolNames().includes("subagent"));
  });

  it("outside herdr: session_start registers setup-hint stubs when no subagent tool exists", async () => {
    const fake = createFakePi({ allTools: [] });
    herdrSubagents(fake.api);
    assert.deepEqual(fake.toolNames(), []);

    const { ctx } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    const stub = fake.findTool("subagent");
    assert.ok(stub, "expected a subagent setup-hint stub");
    const result = await stub.execute("t1", { name: "X", task: "y" }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /herdr/i);
    assert.equal(result.details.error, "not in herdr");
  });

  it("outside herdr: stays silent when another extension already provides subagent", () => {
    const fake = createFakePi({
      allTools: [{ name: "subagent", sourceInfo: { path: "/other/pi-interactive-subagents/index.ts" } }],
    });
    herdrSubagents(fake.api);
    const { ctx, notifications } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    assert.deepEqual(fake.toolNames(), []);
    assert.deepEqual(notifications, []);
  });

  it("PI_DENY_TOOLS=subagent suppresses registration inside herdr", () => {
    envInsideHerdr();
    process.env.PI_DENY_TOOLS = "subagent";
    const fake = createFakePi();
    herdrSubagents(fake.api);
    assert.ok(!fake.toolNames().includes("subagent"));
    // other spawning tools are gated individually, not as a block
    assert.ok(fake.toolNames().includes("subagent_interrupt"));
    assert.ok(fake.toolNames().includes("subagents_list"));
  });

  it("inside herdr but lost the registry race → visible session_start warning", () => {
    envInsideHerdr();
    __test__.setDeps({ client: makeFakeClient() });
    const fake = createFakePi();
    herdrSubagents(fake.api);

    fake.setAllTools([
      { name: "subagent", sourceInfo: { path: "/other/pi-interactive-subagents/index.ts" } },
    ]);
    const { ctx, notifications } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    const warning = notifications.find((n) => n.type === "warning");
    assert.ok(warning, "expected a visible warning notify");
    assert.match(warning.message, /pi-herdr-subagents/);
    assert.match(warning.message, /before/i);
  });

  it("inside herdr and won the race → no warning", () => {
    envInsideHerdr();
    __test__.setDeps({ client: makeFakeClient() });
    const fake = createFakePi();
    herdrSubagents(fake.api);

    fake.setAllTools([{ name: "subagent", sourceInfo: { path: INDEX_PATH } }]);
    const { ctx, notifications } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    assert.deepEqual(
      notifications.filter((n) => n.type === "warning"),
      [],
    );
  });

  it("wrapper providerEntryPaths accept file:// URLs and filesystem paths", () => {
    envInsideHerdr();
    __test__.setDeps({ client: makeFakeClient() });
    const wrapperPath = resolve(dirname(INDEX_PATH), "extensions", "subagent.ts");
    const wrapper = createHerdrSubagentsExtension({
      providerEntryPaths: [pathToFileURL(wrapperPath).href],
    });
    const fake = createFakePi();
    wrapper(fake.api);

    fake.setAllTools([{ name: "subagent", sourceInfo: { path: wrapperPath } }]);
    const { ctx, notifications } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    assert.deepEqual(
      notifications.filter((n) => n.type === "warning"),
      [],
    );
  });

  it("inside herdr with unreachable socket → visible notify from session_start check", async () => {
    envInsideHerdr();
    __test__.setDeps({
      client: makeFakeClient({
        ping: async () => ({ ok: false, version: null, protocol: null }),
      }),
    });
    const fake = createFakePi();
    herdrSubagents(fake.api);
    const { ctx, notifications } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    await waitFor(() => notifications.length > 0);
    assert.match(notifications[0].message, /not reachable/i);
  });

  it("inside herdr with an old version → actionable upgrade warning", async () => {
    envInsideHerdr();
    __test__.setDeps({
      client: makeFakeClient({
        ping: async () => ({ ok: true, version: "0.8.1", protocol: 14 }),
      }),
    });
    const fake = createFakePi();
    herdrSubagents(fake.api);
    const { ctx, notifications } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    await waitFor(() => notifications.length > 0);
    assert.match(notifications[0].message, /herdr >= 0\.8\.2/);
    assert.match(notifications[0].message, /update herdr/i);
  });

  it("inside herdr with a disabled plugin → actionable enable warning", async () => {
    envInsideHerdr();
    __test__.setDeps({
      client: makeFakeClient({
        pluginGet: async () => ({ plugin_id: "pi-herdr-subagents", enabled: false }),
      }),
    });
    const fake = createFakePi();
    herdrSubagents(fake.api);
    const { ctx, notifications } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    await waitFor(() => notifications.length > 0);
    assert.match(notifications[0].message, /plugin enable pi-herdr-subagents/);
  });
});

// ── bundled plugin auto-link ────────────────────────────────────────────────

/**
 * Fake client with a mutable plugin registry: `pluginGet` reads it and
 * `pluginLink` writes it (or throws), recording every link call.
 */
function makeLinkStateClient(opts: {
  initial: Record<string, unknown> | null;
  linkFails?: Error;
}) {
  let plugin = opts.initial;
  const linkCalls: string[] = [];
  const client = makeFakeClient({
    pluginGet: async () => plugin,
    pluginLink: async (path: string) => {
      linkCalls.push(path);
      if (opts.linkFails) throw opts.linkFails;
      plugin = { plugin_id: HERDR_PLUGIN_ID, enabled: true, plugin_root: path };
    },
  });
  return { client, linkCalls };
}

describe("index: bundled plugin auto-link", () => {
  function fireSessionStart(client: unknown, mode: "tui" | "rpc" | "json" | "print" = "tui") {
    __test__.setDeps({ client: client as any });
    const fake = createFakePi();
    herdrSubagents(fake.api);
    const { ctx, notifications } = makeFakeCtx({ mode });
    fake.fire("session_start", {}, ctx);
    return { fake, ctx, notifications };
  }

  it("tui parent: a missing plugin is linked once, reported, and the check cache is cleared", async () => {
    envInsideHerdr();
    const { client, linkCalls } = makeLinkStateClient({ initial: null });
    const { notifications } = fireSessionStart(client);

    await waitFor(() => notifications.some((n) => n.type === "info"));
    assert.deepEqual(linkCalls, [__test__.herdrPluginDir]);
    const info = notifications.find((n) => n.type === "info")!;
    assert.match(info.message, /linked the bundled Herdr plugin/);
    assert.ok(info.message.includes(__test__.herdrPluginDir));
    assert.match(info.message, /herdr plugin unlink pi-herdr-subagents/);
    // The post-link readiness check must not report the stale missing plugin.
    assert.deepEqual(
      notifications.filter((n) => n.type === "warning"),
      [],
    );
  });

  it("tui parent: an existing correct link is a no-op", async () => {
    envInsideHerdr();
    const { client, linkCalls } = makeLinkStateClient({
      initial: { plugin_id: HERDR_PLUGIN_ID, enabled: true, plugin_root: __test__.herdrPluginDir },
    });
    const { notifications } = fireSessionStart(client);

    // Give the asynchronous readiness check time to finish; a correct link
    // produces neither a link call nor a notification.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(linkCalls, []);
    assert.deepEqual(notifications, []);
  });

  it("tui parent: a correct link reached through a symlink is still a no-op", async (t) => {
    envInsideHerdr();
    const root = mkdtempSync(join(tmpdir(), "herdr-autolink-symlink-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const linkPath = join(root, "herdr-plugin");
    try {
      symlinkSync(__test__.herdrPluginDir, linkPath);
    } catch {
      t.skip("symlinks unavailable on this platform");
      return;
    }
    const { client, linkCalls } = makeLinkStateClient({
      initial: { plugin_id: HERDR_PLUGIN_ID, enabled: true, plugin_root: linkPath },
    });
    const { notifications } = fireSessionStart(client);

    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(linkCalls, []);
    assert.deepEqual(notifications, []);
  });

  it("tui parent: a disabled plugin is never enabled automatically", async () => {
    envInsideHerdr();
    const { client, linkCalls } = makeLinkStateClient({
      initial: { plugin_id: HERDR_PLUGIN_ID, enabled: false, plugin_root: __test__.herdrPluginDir },
    });
    const { notifications } = fireSessionStart(client);

    await waitFor(() => notifications.some((n) => n.type === "warning"));
    assert.deepEqual(linkCalls, []);
    assert.match(notifications[0].message, /plugin enable pi-herdr-subagents/);
  });

  it("tui parent: a different linked path is reported, never overwritten", async () => {
    envInsideHerdr();
    const otherRoot = "/some/other/checkout/pi-herdr-subagents/herdr-plugin";
    const { client, linkCalls } = makeLinkStateClient({
      initial: { plugin_id: HERDR_PLUGIN_ID, enabled: true, plugin_root: otherRoot },
    });
    const { notifications } = fireSessionStart(client);

    await waitFor(() => notifications.some((n) => n.type === "warning"));
    assert.deepEqual(linkCalls, []);
    const warning = notifications.find((n) => n.type === "warning")!;
    assert.match(warning.message, /linked from a different path/);
    assert.match(warning.message, /Refusing to replace it/);
    assert.ok(warning.message.includes(otherRoot));
    assert.ok(warning.message.includes(__test__.herdrPluginDir));
  });

  it("tui parent: a failed link warns with the error and the manual command", async () => {
    envInsideHerdr();
    const { client, linkCalls } = makeLinkStateClient({
      initial: null,
      linkFails: new Error("plugin manifest is invalid"),
    });
    const { notifications } = fireSessionStart(client);

    await waitFor(() => notifications.some((n) => n.type === "warning"));
    assert.deepEqual(linkCalls, [__test__.herdrPluginDir]);
    const warning = notifications.find((n) => n.type === "warning")!;
    assert.match(warning.message, /failed to link the bundled Herdr plugin/);
    assert.match(warning.message, /plugin manifest is invalid/);
    assert.match(warning.message, /herdr plugin link/);
    assert.deepEqual(
      notifications.filter((n) => n.type === "info"),
      [],
    );
  });

  it("retries a failed link on the next session start", async () => {
    envInsideHerdr();
    const options = { initial: null, linkFails: new Error("temporary link failure") as Error | undefined };
    const { client, linkCalls } = makeLinkStateClient(options);
    const { fake, notifications } = fireSessionStart(client);
    await waitFor(() => notifications.some((n) => n.type === "warning"));

    options.linkFails = undefined;
    const second = makeFakeCtx();
    fake.fire("session_start", {}, second.ctx);
    await waitFor(() => second.notifications.some((n) => n.type === "info"));
    assert.equal(linkCalls.length, 2);
    assert.deepEqual(second.notifications.filter((n) => n.type === "warning"), []);
  });

  it("reports a failed registry read and recovers on the next session start", async () => {
    envInsideHerdr();
    const { client, linkCalls } = makeLinkStateClient({ initial: null });
    const readPlugin = client.pluginGet;
    client.pluginGet = async () => { throw new Error("registry read failed"); };
    const { fake, notifications } = fireSessionStart(client);
    await waitFor(() => notifications.some((n) => n.type === "warning"));
    assert.match(notifications[0].message, /capability check failed: registry read failed/);
    assert.equal(linkCalls.length, 0);

    client.pluginGet = readPlugin;
    const second = makeFakeCtx();
    fake.fire("session_start", {}, second.ctx);
    await waitFor(() => second.notifications.some((n) => n.type === "info"));
    assert.equal(linkCalls.length, 1);
  });

  for (const state of ["disabled", "conflict", "missing"] as const) {
    it(`checks ${state} registration again after a successful link`, async () => {
      envInsideHerdr();
      const { client, linkCalls } = makeLinkStateClient({ initial: null });
      const { fake, notifications } = fireSessionStart(client);
      await waitFor(() => notifications.some((n) => n.type === "info"));

      client.pluginGet = async () => state === "missing" ? null : {
        plugin_id: HERDR_PLUGIN_ID,
        enabled: state !== "disabled",
        plugin_root: state === "conflict" ? "/other/herdr-plugin" : __test__.herdrPluginDir,
      };
      const second = makeFakeCtx();
      fake.fire("session_start", {}, second.ctx);
      await waitFor(() => second.notifications.some((n) => n.type === "warning"));
      assert.equal(linkCalls.length, state === "missing" ? 2 : 1);
      assert.match(second.notifications[0].message,
        state === "disabled" ? /plugin is disabled/ :
        state === "conflict" ? /different path/ : /setup is still incomplete/);
    });
  }

  it("a spawn after a successful auto-link passes the capability gate", async () => {
    envInsideHerdr();
    const { client, linkCalls } = makeLinkStateClient({ initial: null });
    const paneStartCalls: any[] = [];
    __test__.setDeps({
      client: {
        ...client,
        paneStart: async (p: any) => {
          paneStartCalls.push(p);
          return { paneId: "w1:p9", terminalId: "", workspaceId: "", tabId: "" };
        },
      } as any,
      watch: async () => ({ kind: "completed", summary: "done", exitCode: 0 }),
      createStream: () => makeFakeStream() as any,
    });
    const fake = createFakePi();
    herdrSubagents(fake.api);
    const tool = fake.findTool("subagent");
    const fx = makeSpawnFixture();

    fake.fire("session_start", {}, fx.ctx);
    await waitFor(() => fx.notifications.some((n) => n.type === "info"));

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.status, "started", JSON.stringify(result.details));
    assert.deepEqual(linkCalls, [__test__.herdrPluginDir]);
    assert.equal(paneStartCalls.length, 1);
  });

  it("tui parent: concurrent session starts share one link attempt", async () => {
    envInsideHerdr();
    const { client, linkCalls } = makeLinkStateClient({ initial: null });
    __test__.setDeps({ client: client as any });
    const fake = createFakePi();
    herdrSubagents(fake.api);
    const first = makeFakeCtx();
    const second = makeFakeCtx();

    fake.fire("session_start", {}, first.ctx);
    fake.fire("session_start", {}, second.ctx);

    await waitFor(() =>
      first.notifications.some((n) => n.type === "info") ||
      second.notifications.some((n) => n.type === "info"),
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(linkCalls, [__test__.herdrPluginDir]);
    assert.equal(
      first.notifications.filter((n) => n.type === "info").length +
        second.notifications.filter((n) => n.type === "info").length,
      1,
    );
  });

  it("tui parent: a later session leaves a correct registration untouched", async () => {
    envInsideHerdr();
    const { client, linkCalls } = makeLinkStateClient({ initial: null });
    __test__.setDeps({ client: client as any });
    const fake = createFakePi();
    herdrSubagents(fake.api);
    const first = makeFakeCtx();
    fake.fire("session_start", {}, first.ctx);
    await waitFor(() => first.notifications.some((n) => n.type === "info"));

    const second = makeFakeCtx();
    fake.fire("session_start", {}, second.ctx);
    await new Promise((r) => setTimeout(r, 30));

    assert.deepEqual(linkCalls, [__test__.herdrPluginDir]);
    assert.deepEqual(second.notifications, []);
  });

  for (const mode of ["rpc", "json", "print"] as const) {
    it(`mode ${mode}: never links implicitly, only warns`, async () => {
      envInsideHerdr();
      const { client, linkCalls } = makeLinkStateClient({ initial: null });
      const { notifications } = fireSessionStart(client, mode);

      await waitFor(() => notifications.some((n) => n.type === "warning"));
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(linkCalls, []);
      assert.match(notifications[0].message, /plugin link/);
    });
  }

  it("a subagent process never links the plugin", async () => {
    envInsideHerdr();
    process.env.PI_SUBAGENT_ID = "child-1";
    const { client, linkCalls } = makeLinkStateClient({ initial: null });
    const { notifications } = fireSessionStart(client);

    await waitFor(() => notifications.some((n) => n.type === "warning"));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(linkCalls, []);
    assert.match(notifications[0].message, /plugin link/);
  });

  it("a session that lost the registry race does not link the plugin", async () => {
    envInsideHerdr();
    const { client, linkCalls } = makeLinkStateClient({ initial: null });
    __test__.setDeps({ client: client as any });
    const fake = createFakePi();
    herdrSubagents(fake.api);
    fake.setAllTools([
      { name: "subagent", sourceInfo: { path: "/other/pi-interactive-subagents/index.ts" } },
    ]);
    const { ctx, notifications } = makeFakeCtx();
    fake.fire("session_start", {}, ctx);

    await waitFor(() => notifications.some((n) => /registry race/.test(n.message)));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(linkCalls, []);
  });

  it("an unreachable server does not trigger a link attempt", async () => {
    envInsideHerdr();
    const { client, linkCalls } = makeLinkStateClient({ initial: null });
    (client as any).ping = async () => ({ ok: false, version: null, protocol: null });
    const { notifications } = fireSessionStart(client);

    await waitFor(() => notifications.some((n) => /not reachable/i.test(n.message)));
    assert.deepEqual(linkCalls, []);
  });
});

// ── subagent tool execute ──────────────────────────────────────────────────

describe("index: subagent tool", () => {
  function registerAndGetTool() {
    envInsideHerdr();
    const fake = createFakePi();
    herdrSubagents(fake.api);
    const tool = fake.findTool("subagent");
    assert.ok(tool, "subagent tool must be registered");
    return { fake, tool };
  }

  it("self-spawn is blocked", async () => {
    const { tool } = registerAndGetTool();
    process.env.PI_SUBAGENT_AGENT = "worker";
    const { ctx } = makeFakeCtx();

    const result = await tool.execute(
      "t1",
      { name: "Worker 2", task: "do it", agent: "worker" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.error, "self-spawn blocked");
    assert.match(result.content[0].text, /worker/);
  });

  it("recursive spawn is blocked (subagents cannot create subagents)", async () => {
    const { tool } = registerAndGetTool();
    process.env.PI_SUBAGENT_ID = "abc123";
    const { ctx } = makeFakeCtx();

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it", agent: "worker" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.error, "recursive spawn blocked");
    assert.match(result.content[0].text, /cannot create subagents/);
    assert.equal(result.details.id, undefined); // nothing was launched
  });

  it("PI_SUBAGENT_AGENT alone does not trigger the recursion guard", async () => {
    // The guard keys on PI_SUBAGENT_ID only — PI_SUBAGENT_AGENT is exported
    // just for named-agent launches, so it cannot identify subagents launched
    // without one. A session carrying only PI_SUBAGENT_AGENT must still spawn.
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async () => ({ kind: "completed", summary: "done", exitCode: 0 }),
      createStream: () => makeFakeStream() as any,
    });
    process.env.PI_SUBAGENT_AGENT = "worker";

    const result = await tool.execute(
      "t1",
      { name: "Scout", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.status, "started");
  });

  it("requires a persistent session file", async () => {
    const { tool } = registerAndGetTool();
    const { ctx } = makeFakeCtx({ sessionFile: null });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      ctx,
    );

    assert.equal(result.details.error, "no session file");
  });

  it("capability failure stops before pane launch", async () => {
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    let paneStarted = false;
    __test__.setDeps({
      client: makeFakeClient({
        ping: async () => ({ ok: true, version: "0.8.1", protocol: 14 }),
        paneStart: async () => {
          paneStarted = true;
          return { paneId: "w1:p9", terminalId: "", workspaceId: "", tabId: "" };
        },
      }),
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.error, "herdr setup incomplete");
    assert.match(result.content[0].text, /herdr >= 0\.8\.2/);
    assert.equal(paneStarted, false);
  });

  it("spawn: writes plan files, starts a plugin pane, returns fire-and-forget ack", async () => {
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    const paneStartCalls: any[] = [];
    let watchedStream: unknown = null;
    const fakeStream = makeFakeStream();
    __test__.setDeps({
      client: makeFakeClient({
        paneStart: async (p: any) => {
          paneStartCalls.push(p);
          return { paneId: "w1:p9", terminalId: "", workspaceId: "", tabId: "" };
        },
      }),
      watch: async (_running: any, deps: any): Promise<SubagentOutcome> => {
        watchedStream = deps.stream;
        return { kind: "completed", summary: "did the thing", exitCode: 0 };
      },
      createStream: () => fakeStream as any,
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.equal(result.details.status, "started");
    assert.equal(result.details.paneId, "w1:p9");
    assert.equal(result.details.name, "Worker");
    assert.ok(result.details.sessionFile.endsWith(".jsonl"));
    assert.ok(existsSync(result.details.launchScriptFile), "launch script written to disk");
    assert.match(result.content[0].text, /launched and is now running/);

    // argv launch through the client
    assert.equal(paneStartCalls.length, 1);
    assert.equal(paneStartCalls[0].launchScriptFile, result.details.launchScriptFile);

    // watcher armed against the shared event stream
    await waitFor(() => watchedStream !== null);
    assert.equal(watchedStream, fakeStream);
  });

  it("outcome wiring: completed outcome → subagent_result steer wakes the orchestrator", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (running): Promise<SubagentOutcome> => {
        writeFileSync(
          `${running.sessionFile}.context-usage`,
          JSON.stringify({
            version: 1,
            subagentId: running.id,
            tokens: 75_000,
            contextWindow: 200_000,
            percent: 37.5,
          }),
        );
        return {
          kind: "completed",
          summary: "did the thing",
          exitCode: 0,
        };
      },
      createStream: () => makeFakeStream() as any,
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );
    await waitFor(() => fake.sent.length === 1);

    const { message, options } = fake.sent[0];
    assert.equal(message.customType, "subagent_result");
    assert.match(message.content, /completed/);
    assert.match(message.content, /did the thing/);
    assert.match(message.content, /Context: 75k\/200k tokens/);
    assert.deepEqual(message.details.contextUsage, {
      version: 1,
      subagentId: result.details.id,
      tokens: 75_000,
      contextWindow: 200_000,
      percent: 37.5,
    });
    assert.equal(
      existsSync(`${result.details.sessionFile}.context-usage`),
      false,
      "telemetry is consumed after the terminal outcome",
    );
    assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
    assert.equal(__test__.runningSubagents.size, 0);
  });

  it("rejects and removes stale context usage from another resume id", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    let telemetryPath = "";
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (running): Promise<SubagentOutcome> => {
        telemetryPath = `${running.sessionFile}.context-usage`;
        writeFileSync(
          telemetryPath,
          JSON.stringify({
            version: 1,
            subagentId: "previous-launch-id",
            tokens: 90_000,
            contextWindow: 100_000,
            percent: 90,
          }),
        );
        return { kind: "completed", summary: "done", exitCode: 0 };
      },
      createStream: () => makeFakeStream() as any,
    });

    await tool.execute("t1", { name: "Worker", task: "do it" }, undefined, undefined, fx.ctx);
    await waitFor(() => fake.sent.length === 1);

    assert.doesNotMatch(fake.sent[0].message.content, /Context:/);
    assert.equal("contextUsage" in fake.sent[0].message.details, false);
    assert.equal(existsSync(telemetryPath), false, "stale telemetry is consumed");
  });

  it("cancelled outcome sends no steer message", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    let watched = false;
    __test__.setDeps({
      client: makeFakeClient(),
      watch: async (): Promise<SubagentOutcome> => {
        watched = true;
        return { kind: "cancelled" };
      },
      createStream: () => makeFakeStream() as any,
    });

    await tool.execute("t1", { name: "Worker", task: "do it" }, undefined, undefined, fx.ctx);
    await waitFor(() => watched && __test__.runningSubagents.size === 0);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fake.sent.length, 0);
  });

  it("paneStart failure returns an error result and registers nothing", async () => {
    const { fake, tool } = registerAndGetTool();
    const fx = makeSpawnFixture();

    __test__.setDeps({
      client: makeFakeClient({
        paneStart: async () => {
          throw new Error("connection refused");
        },
      }),
      createStream: () => makeFakeStream() as any,
    });

    const result = await tool.execute(
      "t1",
      { name: "Worker", task: "do it" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.match(result.content[0].text, /connection refused/);
    assert.ok(result.details.error);
    assert.equal(__test__.runningSubagents.size, 0);
    assert.equal(fake.sent.length, 0);
  });

  it("unsupported cli agent def returns a clear error", async () => {
    const { tool } = registerAndGetTool();
    const fx = makeSpawnFixture();
    mkdirSync(join(fx.agentDir, "agents"), { recursive: true });
    writeFileSync(
      join(fx.agentDir, "agents", "claudey.md"),
      "---\nname: claudey\ncli: claude\n---\nBody\n",
    );

    __test__.setDeps({ client: makeFakeClient(), createStream: () => makeFakeStream() as any });

    const result = await tool.execute(
      "t1",
      { name: "C", task: "x", agent: "claudey" },
      undefined,
      undefined,
      fx.ctx,
    );

    assert.match(result.content[0].text, /not supported/);
  });
});

// ── steer message renderers ────────────────────────────────────────────────

describe("index: renderers", () => {
  it("registers subagent_result and subagent_ping renderers", () => {
    const fake = createFakePi();
    herdrSubagents(fake.api);
    assert.ok(fake.renderers.has("subagent_result"));
    assert.ok(fake.renderers.has("subagent_ping"));
  });
});
