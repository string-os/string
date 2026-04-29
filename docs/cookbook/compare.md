---
title: 02 — Why markdown + /command
---

# 02 — Why markdown + /command

**Goal:** see the same weather capability built three ways, side by side. This chapter is the answer to *"why not just use what already exists?"*

The comparison is not "how few lines of code." It is: **what does the agent have to learn, per app, to use this protocol?** That is the axis that matters when the user installs their third, tenth, and hundredth app.

Three options compared:

1. **SFMD + `string`** — a markdown file, the shared runtime, and one verb the LLM learns: "call string with a topic and a /command."
2. **MCP server** — one long-lived process per app, each exposing its own tool list, each registered in the host config.
3. **OpenAI-style function calling** — a JSON schema passed in the prompt, a server endpoint handling invocations, orchestration glue in the agent loop.

All three let an AI get a weather lookup. The cost to the author, the cost to the operator, and the cost the agent pays in its context window all differ.

---

## Approach 1: SFMD + `string`

The whole thing:

````markdown
---
title: Weather
name: weather
type: app
---

```act.now
GET https://wttr.in/{city}?format=%l:+%C+%t+%w&m
  city: string (required) "City name"
```
````

**Line count:** ~11 lines of markdown.

**Runtime processes:** one `stringd` daemon, shared across *every* SFMD app the user has installed. The weather app itself does not start any processes.

**Install path:** `string '/install --app ./weather/string.md'`. One command, no host restart.

**Per-app verb in the agent's tool list:** none. The agent already has one tool — `string(topic, cmd)` — that dispatches to every installed app.

**Per-app prompt token cost:** none. The agent discovers the app at `/open` time by reading the rendered page. The weather file's contents are not in the prompt on turns where weather isn't involved.

**The agent's tool call:**

```typescript
string({ topic: "app:weather", cmd: "/act.now --city Seoul" })
```

---

## Approach 2: MCP server

A roughly equivalent MCP server in TypeScript, kept honest — no features beyond what MCP requires:

```typescript
// weather-mcp/src/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "weather", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "now",
    description: "Current weather for a city",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "now") {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }
  const city = encodeURIComponent(
    (req.params.arguments as { city: string }).city,
  );
  const url = `https://wttr.in/${city}?format=%l:+%C+%t+%w&m`;
  const text = await (await fetch(url)).text();
  return { content: [{ type: "text", text }] };
});

await server.connect(new StdioServerTransport());
```

Plus a `package.json`, a `tsconfig.json`, a build step, and a host config entry:

```json
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": ["/absolute/path/to/weather-mcp/dist/index.js"]
    }
  }
}
```

**Line count:** ~50 lines of TypeScript + ~25 lines of config + `tsconfig.json` + `package.json` + `node_modules/` on the order of tens of MB.

**Runtime processes:** one long-lived Node process per MCP server. Install five weather-like apps and you have five Node processes started at host launch and killed at host exit.

**Install path:** `git clone`, `npm install`, `npm run build`, edit the host config JSON, **restart the host**. Four steps, one of which interrupts the user.

**Per-app verb in the agent's tool list:** one (`weather`). Install ten MCP servers and the tool list has ten top-level entries. The LLM learns a separate verb for each.

**Per-app prompt token cost:** the tool schema is loaded into the agent's context at session start and stays there. One server is fine. Fifty servers is a measurable input-token line item every turn.

**The agent's tool call:**

```typescript
weather({ city: "Seoul" })
```

Same shape as Approach 1 from the LLM's point of view. Different cost structure under the hood.

---

## Approach 3: Function calling

The tool schema rides in the prompt. A server endpoint handles the invocation. The agent framework wires the two together.

```json
{
  "type": "function",
  "function": {
    "name": "weather_now",
    "description": "Current weather for a city",
    "parameters": {
      "type": "object",
      "properties": {
        "city": { "type": "string", "description": "City name" }
      },
      "required": ["city"]
    }
  }
}
```

```typescript
// server.ts
import express from "express";
const app = express();
app.use(express.json());

app.post("/tools/weather_now", async (req, res) => {
  const city = encodeURIComponent(req.body.city);
  const r = await fetch(`https://wttr.in/${city}?format=%l:+%C+%t+%w&m`);
  res.json({ result: await r.text() });
});

app.listen(3000);
```

Plus agent-side orchestration to catch the function call, POST to the endpoint, feed the result back. Most frameworks handle this shape.

**Line count:** ~15 lines of schema + ~15 lines of server + orchestration glue.

**Runtime processes:** one HTTP server, authored and deployed by you. If the agent runs somewhere else, the server has to be reachable — a real operational concern.

**Install path:** add the schema to the agent's prompt config, deploy the endpoint, update agent framework config. Not end-user installable at all — this is developer plumbing.

**Per-app verb in the agent's tool list:** one (`weather_now`), same as MCP.

**Per-app prompt token cost:** highest of the three. The schema rides in the prompt on **every turn**, not just when the tool is used.

**The agent's tool call:**

```typescript
weather_now({ city: "Seoul" })
```

---

## Side by side

| | SFMD + `string` | MCP server | Function calling |
|---|---|---|---|
| Author writes | 11 lines of markdown | ~90 lines TS + 2 config files | 30 lines JSON/TS + framework glue |
| Languages the author needs | CommonMark | TypeScript + MCP SDK | JSON Schema + any server language |
| New processes per app | 0 | 1 | 1 (operator-deployed) |
| Install on end-user machine | `/install` + one path | `git clone`, `npm install`, `build`, edit JSON, restart host | Not end-user installable |
| Host restart required to install | No | Yes | N/A |
| Prompt tokens per app, per turn | 0 | ~schema size (once) | ~schema size (every turn) |
| Verbs the agent learns for N apps | **1** | N | N |
| How the agent discovers what the app can do | Reads the rendered page with `/open` | Host-managed tool listing at session start | Tool schema in the prompt |
| Shared runtime services (shell-safe args, session state, history, HTML fallback, app→app navigation) | Yes — in `stringd`, reused by every app | Each server re-implements | Each server re-implements |
| Revoke / uninstall | Remove one file | Edit JSON, restart host | Redeploy |
| Auditability | One markdown file per app, read as prose | N source repos, each its own project | Source lives in the server |

**The row that matters most is "verbs the agent learns for N apps."** In SFMD, that number is always 1. Every new app the user installs extends the agent's *capability*, not the agent's *vocabulary*. The LLM already knows how to `string(topic, cmd)`. It learns the new app the way a human learns a new website: by visiting it.

In both MCP and function calling, every new app is a new top-level verb the LLM has to carry. The cost is linear in the number of installed tools, paid in prompt tokens, in attention space, and in the LLM's ability to pick the right verb when the task is ambiguous.

The SFMD column is not shorter because the runtime is hiding complexity. It is shorter because **the shared runtime does the work exactly once, for every app**. Shell quoting, HTTP, error shapes, session state, history, navigation, discovery — all implemented in `string`, all reused by every SFMD app ever written.

---

## When to prefer each

**Prefer SFMD + `string` when:**

- The capability fits the pattern "open a thing, call an action, read the result." Most agent tools fit.
- You want end users to install the app themselves, without a host restart.
- You want the agent's prompt size to stay flat as more apps get installed.
- You want the agent to discover new apps by *visiting them* instead of loading schemas at startup.

**Prefer an MCP server when:**

- The capability needs a long-lived background process — a database connection pool, a persistent websocket, a stateful LLM pipeline.
- You want MCP features outside of tools: resources, prompts, sampling.
- You are targeting a third-party host (Claude Desktop, Cursor) whose users already speak MCP. In that case use `@string-os/string-mcp` as a bridge — it turns your SFMD apps into MCP tools on the other side.

**Prefer function calling when:**

- You are building both the agent and the tool, in the same codebase, for one model provider.
- You want the lowest-latency path from the model's decision to the tool's output and are willing to pay the prompt-token cost.

SFMD does not replace MCP or function calling. The three protocols compose — `string` can run as an MCP bridge to make SFMD apps usable in an MCP host, and a function-calling agent can embed `@string-os/client` to dispatch to SFMD apps via one function. The choice is about **where the complexity lives**, not about which protocol "wins."

---

## The ask

Read the weather app. Install it. Write your own app with the same shape — one thing your agent should be able to do, as a markdown file. Watch your agent use it with no further wiring. Then decide whether the protocol you were about to build is still the one you want.

That is the pitch.
