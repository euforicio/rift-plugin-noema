// bb-plugin-noema — federated agentic memory for BB.
//
// Registers six native agent tools that mirror Hermes's Noema access:
// noema_search, noema_remember, noema_recall, noema_list, noema_update, noema_lineage.
//
// Tools call Noema's Streamable HTTP MCP endpoint (≥0.20.0) with full session
// lifecycle management (initialize, re-initialize on 404 expiry).
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ─── Noema MCP HTTP client ───────────────────────────────────────────

class NoemaClient {
  private sessionId: string | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private baseUrl: string,
    private accessKey?: string,
  ) {}

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.accessKey) h["Authorization"] = `Bearer ${this.accessKey}`;
    return h;
  }

  private async initialize(): Promise<void> {
    // Serialize init calls so concurrent tool invocations don't race
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async _doInit(): Promise<void> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
      id: 1,
    });

    const resp = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: this.authHeaders(),
      body,
    });

    if (!resp.ok) throw new Error(`Noema init failed: HTTP ${resp.status}`);

    const sid = resp.headers.get("mcp-session-id");
    const text = await resp.text();

    // Streamable HTTP: response is SSE-framed. Parse data: lines for the
    // initialize result (message id 1).
    let gotInit = false;
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const msg = JSON.parse(line.slice(6));
        if (msg.id === 1) {
          gotInit = true;
          if (msg.error) throw new Error(`Noema init error: ${msg.error.message}`);
        }
      }
    }
    if (!gotInit) throw new Error("Noema init: no initialize response in SSE stream");
    if (!sid) throw new Error("Noema init: no Mcp-Session-Id header");
    this.sessionId = sid;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.sessionId) await this.initialize();

    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: args },
      id: 2,
    });

    const resp = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Mcp-Session-Id": this.sessionId!,
      },
      body,
    });

    // Session expired — reinitialize once and retry
    if (resp.status === 404) {
      this.sessionId = null;
      await this.initialize();
      return this.callTool(name, args);
    }

    if (!resp.ok) throw new Error(`Noema HTTP ${resp.status}`);

    const text = await resp.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const msg = JSON.parse(line.slice(6));
        if (msg.id === 2) {
          if (msg.error) {
            // Surface the MCP error text to the agent
            throw new Error(`Noema: ${msg.error.message}`);
          }
          return msg.result;
        }
      }
    }
    throw new Error("Noema: no tool result in SSE response");
  }
}

// ─── Agent tool schemas ──────────────────────────────────────────────

const searchSchema = z.object({ query: z.string().min(1).describe("Search query — keywords or natural phrases.") });

const rememberSchema = z.object({
  title: z.string().min(1).max(100).describe("Short descriptive title (no date — ID prepends date automatically)."),
  type: z.enum(["fact", "decision", "preference", "context", "skill", "intent", "observation", "note"]).describe("Memory type."),
  body: z.string().min(1).describe("Full content of the memory (markdown)."),
  tags: z.string().optional().describe("Comma-separated keyword tags."),
  derived_from: z.string().optional().describe("Comma-separated trace IDs this memory was derived from."),
});

const recallSchema = z.object({ id: z.string().min(1).describe("Trace ID (e.g. 20260412-my-trace).") });

const listSchema = z.object({
  type: z.string().optional().describe("Filter by trace type."),
  author: z.string().optional().describe("Filter by author."),
  tag: z.string().optional().describe("Filter by tag."),
  origin: z.string().optional().describe("Filter by origin cortex."),
});

const updateSchema = z.object({
  id: z.string().min(1).describe("Trace ID to update."),
  title: z.string().max(100).optional().describe("New title."),
  type: z.enum(["fact", "decision", "preference", "context", "skill", "intent", "observation", "note"]).optional().describe("New type."),
  body: z.string().optional().describe("New body content."),
  tags: z.string().optional().describe("New tags (comma-separated, replaces existing)."),
});

const lineageSchema = z.object({ id: z.string().min(1).describe("Trace ID to query the derivation graph for.") });

// ─── Plugin entry ────────────────────────────────────────────────────

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("bb-plugin-noema loaded");

  const settings = bb.settings.define({
    noemaHttpUrl: {
      type: "string",
      label: "Noema HTTP URL",
      default: process.env.NOEMA_HTTP_URL ?? "http://127.0.0.1:3004",
      description: "Streamable HTTP MCP endpoint (noema serve --transport http)",
    },
    noemaCortex: {
      type: "string",
      label: "Cortex name",
      default: process.env.NOEMA_CORTEX ?? "coding-agents",
    },
    noemaAccessKey: {
      type: "string",
      label: "MCP access key",
      default: process.env.NOEMA_MCP_KEY ?? "",
      secret: true,
    },
  });

  const { noemaHttpUrl, noemaCortex, noemaAccessKey } = await settings.get();
  const client = new NoemaClient(noemaHttpUrl, noemaAccessKey || undefined);

  bb.log.info(`Noema client → ${noemaHttpUrl} (cortex: ${noemaCortex})`);

  // ── Register agent tools ─────────────────────────────────────────

  bb.agents.registerTool({
    name: "noema_search",
    description: `Search your Noema memory for relevant traces. Returns matching memories ranked by relevance (FTS5 full-text search). Cortex: ${noemaCortex}.`,
    parameters: searchSchema,
    async execute({ query }, { threadId }) {
      bb.log.info(`[noema] thread ${threadId}: noema_search '${query}'`);
      const result = await client.callTool("noema_search", { query });
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    },
  });

  bb.agents.registerTool({
    name: "noema_remember",
    description: `Create a new memory trace in Noema. Choose a type that reflects the intent: fact, decision, preference, context, skill, intent, observation, or note. Cortex: ${noemaCortex}.`,
    parameters: rememberSchema,
    async execute(args) {
      // Strip undefined optional fields so Noema doesn't receive them
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined) clean[k] = v;
      }
      const result = await client.callTool("noema_remember", clean);
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    },
  });

  bb.agents.registerTool({
    name: "noema_recall",
    description: `Read a specific Noema memory trace by ID, including its full body. Cortex: ${noemaCortex}.`,
    parameters: recallSchema,
    async execute({ id }) {
      const result = await client.callTool("noema_recall", { id });
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    },
  });

  bb.agents.registerTool({
    name: "noema_list",
    description: `List Noema memory traces, optionally filtered by type, author, tag, or origin. Cortex: ${noemaCortex}.`,
    parameters: listSchema,
    async execute(args) {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined) clean[k] = v;
      }
      const result = await client.callTool("noema_list", clean);
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    },
  });

  bb.agents.registerTool({
    name: "noema_update",
    description: `Update fields of an existing Noema memory trace. Only provided fields are changed. Cortex: ${noemaCortex}.`,
    parameters: updateSchema,
    async execute(args) {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined) clean[k] = v;
      }
      const result = await client.callTool("noema_update", clean);
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    },
  });

  bb.agents.registerTool({
    name: "noema_lineage",
    description: `Show the derivation graph for a Noema trace: what it was derived from and what derives from it. Cortex: ${noemaCortex}.`,
    parameters: lineageSchema,
    async execute({ id }) {
      const result = await client.callTool("noema_lineage", { id });
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    },
  });

  // ── Cleanup ──────────────────────────────────────────────────────

  bb.onDispose(() => {
    bb.log.info("bb-plugin-noema disposed");
  });
}
