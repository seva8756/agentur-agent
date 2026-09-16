# Skills Guide

[English](skill-packages.md) | [Русский](ru/skill-packages.md)

This document describes the current contract for chat-local skills, so the details are recorded outside of prompt descriptions and personal notes.

## Overview

A skill belongs to a particular Telegram chat. It is stored as a directory with `skill.json`, `SKILL.md`, and `plugin.js`, but in the interface and user-facing replies we simply call it a skill.

For privileged integrations such as MCP, use trusted skills from `skills/catalog/`. Server connections and access permissions are described in the [integration guide](integrations.md#mcp).

Trusted skills run as native code outside the QuickJS sandbox. They are enabled by the application, not created by the agent from a chat. The first such skill is `skills/catalog/mcp`.

Structure:

```text
data/chats/<chat>/skills/custom/<skill_id>/
  skill.json
  SKILL.md
  plugin.js
  revisions/
    v1/
      snapshot.json
      SKILL.md
      plugin.js
```

The `enabled` flag in `skill.json` alone determines whether the runtime runs a skill. `revisions/v<version>/` holds only one saved revision of the skill.

New skills are created disabled. To enable one:

```text
/agentur skill enable <skill_id>
```

Enabling a skill validates it, runs a dry run, and sets `enabled` to `true`.

## skill.json

Minimal manifest:

```json
{
  "id": "shopping_list",
  "title": "Shopping List",
  "description": "Use when the user asks to add, remove, or view shopping-list items; do not use for unrelated tasks.",
  "enabled": false,
  "runtime": "quickjs",
  "source": "chat_generated",
  "version": 1,
  "triggers": [
    {
      "type": "command",
      "command": "/add_product",
      "tool": "add_item"
    }
  ],
  "tools": {
    "add_item": {
      "description": "Add item to shopping list",
      "schema": {
        "type": "object",
        "properties": {
          "item": { "type": "string" }
        }
      }
    },
    "list_items": {
      "description": "Show shopping list",
      "schema": {
        "type": "object",
        "properties": {}
      }
    }
  },
  "permissions": {
    "httpOrigins": [],
    "storage": true,
    "secrets": []
  },
  "createdAt": "2026-06-03T00:00:00.000Z"
}
```

Rules:

- `runtime` is currently always `"quickjs"`;
- `tools` must contain at least one tool;
- `triggers` should be `[]` by default: the agent selects the skill based on its meaning, without requiring a Telegram command;
- direct triggers support only explicit slash commands, such as `/balance`;
- create a command trigger only when the user explicitly asks to bind a slash command to a particular tool;
- each trigger must refer to an existing tool;
- natural-language activation uses `description` and semantic selection, not phrase or keyword triggers;
- `httpOrigins` must contain exact origins, such as `https://openrouter.ai`;
- secrets must be declared explicitly.

Examples:

- a good command trigger: the user explicitly requested `/denis_tasks`, and the command always produces a particular report;
- a good skill selected by meaning alone: a GitLab helper with `triggers: []` and a precise `description`;
- a poor command trigger: `/gitlab`, if the skill itself tries to guess what the user wants to do.

## SKILL.md

`SKILL.md` describes when and how to use the skill. For enabled skills, it is included in the model's context.

Keep it short:

```md
Use `add_item` when the user asks to add a shopping item.
Use `list_items` when the user asks for the current shopping list.
Do not use this skill for tasks unrelated to the shopping list.
```

## plugin.js

Contract:

```js
export default {
  tools: {
    async tool_name(ctx, args) {
      return { ok: true, reply: "Done." };
    }
  }
};
```

The SDK is available only through `ctx.api`. Do not use a third `api` argument.

Example:

```js
export default {
  tools: {
    async add_item(ctx, args) {
      const item = String(args.item || ctx.item || "").trim();
      if (!item) return { ok: true, reply: "What should I add?" };

      await ctx.api.lists.append("shopping", item);
      return { ok: true, reply: "Added: " + item };
    },

    async list_items(ctx, args) {
      const items = await ctx.api.lists.list("shopping");
      if (!items.length) return { ok: true, reply: "The list is empty." };
      return {
        ok: true,
        reply: items.map((item, index) => (index + 1) + ". " + item.text).join("\n")
      };
    }
  }
};
```

## ctx

`ctx` contains the message and its environment:

```js
ctx.text          // full message text
ctx.item          // text after the slash command
ctx.now           // ISO timestamp
ctx.user.id
ctx.user.username
ctx.user.displayName
ctx.chat.id
ctx.chat.type
ctx.message.id
ctx.message.date
ctx.api           // SDK
```

`ctx.item` is useful for command triggers:

- message: `/todo buy milk`;
- `ctx.item`: `buy milk`.

For calls selected by the model through `run_skill_tool`, use `args`. `ctx.item` may be empty; it contains the command arguments only for a direct slash trigger.

## args

`args` comes from the LLM tool call through `run_skill_tool`.

If a tool is called by a direct trigger without the LLM, `args` is usually `{}`.

Pattern:

```js
const value = args.value || ctx.item || ctx.text;
```

## SDK

### Storage

Storage is scoped to each skill, in `skills/state/<skill_id>.json`.

```js
const value = ctx.api.storage.get("key");
ctx.api.storage.set("key", value);
ctx.api.storage.delete("key");
```

`storage` is synchronous.

### Lists

Chat-level lists are stored in `chat/lists/*.json`.

```js
const items = await ctx.api.lists.list("shopping");
await ctx.api.lists.append("shopping", "milk");
await ctx.api.lists.clear("shopping");
```

### Memory

```js
await ctx.api.memory.rememberFact("The user prefers short replies.");
await ctx.api.memory.saveDecision("We agreed to review reports on Fridays.");
```

### Artifacts

Artifacts are chat-local files that a skill can create and send through the shared `send` contract. Skills do not have direct file system access: they create files through the SDK and then pass only the `artifactId`.

```js
const artifact = await ctx.api.artifacts.createText({
  filename: "index.html",
  mimeType: "text/html",
  text: "<h1>Hello</h1>"
});

return {
  ok: true,
  send: {
    kind: "file",
    source: { type: "artifact", artifactId: artifact.id },
    caption: "HTML is ready"
  }
};
```

For binary files:

```js
const image = await ctx.api.artifacts.createBase64({
  filename: "square.png",
  mimeType: "image/png",
  base64: "..."
});
```

`ctx.api.artifacts.get(artifactId)` reads metadata. `ctx.api.artifacts.readText(artifactId)` reads text-like artifacts with a size limit. The older media payload with `url: "https://..."` remains valid only for public HTTP(S) URLs.

### Secrets

A skill can access only the secrets declared in `skill.json`.

```js
const token = ctx.api.secrets.get("OPENROUTER_API_KEY");
if (!token) return { ok: true, reply: "The OPENROUTER_API_KEY secret is required." };
```

`secrets` is synchronous.

### HTTP

```js
const res = await ctx.api.http.get("https://example.com/api", {
  headers: { Authorization: "Bearer " + token }
});

const created = await ctx.api.http.post("https://example.com/items", {
  title: "Item"
});

const patched = await ctx.api.http.patch("https://example.com/items/1", {
  title: "Updated"
});

const removed = await ctx.api.http.delete("https://example.com/items/1");

const custom = await ctx.api.http.request({
  method: "PUT",
  url: "https://example.com/items/1",
  headers: { "content-type": "application/json" },
  body: { title: "Updated" }
});
```

HTTP response:

```js
res.ok
res.status
res.statusText
res.headers
res.text
res.body
res.json
res.url
```

HTTP requests pass through the safety layer:

- only `http/https`;
- the origin must be listed in `skill.json.permissions.httpOrigins`;
- the origin must also be allowed globally in `SKILL_HTTP_ALLOWED_ORIGINS`;
- localhost and private IP addresses are blocked by default; explicit exceptions are set through `HTTP_ALLOWED_PRIVATE_HOSTS`, see [HTTP setup](integrations.md#http);
- redirects are checked;
- timeouts and request/response body size limits apply.

### MCP

Regular chat skills can use only MCP servers already connected to that chat:

```js
const servers = await ctx.api.mcp.listServers();
const tools = await ctx.api.mcp.listTools("my_gitlab");
const result = await ctx.api.mcp.callTool("my_gitlab", "list_merge_requests", {
  assignee: "me"
});
```

Available methods:

- `ctx.api.mcp.listServers()`;
- `ctx.api.mcp.listTools(serverId?)`;
- `ctx.api.mcp.callTool(serverId, toolName, args)`;
- `ctx.api.mcp.readResource(serverId, uri)`.

You cannot connect servers from `plugin.js`: there is no `connect`, `spawn`, `setHeader`, or `setSecret`. Connections are configured with `/agentur mcp ...` commands, and execution always goes through the trusted `McpManager`.

### Log

```js
ctx.api.log("step=loaded");
```

Logs are written to `skills/audit/<skill_id>.jsonl`.

### Sleep

```js
await ctx.api.sleep(500);
```

Sleep duration is limited. Do not use it for long-running processes.

## Result Contract

A tool must return an object:

```js
return {
  ok: true,
  reply: "text",
  data: { any: "json" },
  send: undefined,
  error: undefined
};
```

Fields:

- `ok?: boolean`;
- `reply?: string | null`;
- `data?: any`;
- `send?: media payload`;
- `error?: { code: string, message: string }`.

Examples:

```js
return { ok: true, reply: "Done." };
return { ok: true, reply: null };
return { ok: true, data: { count: 3 }, reply: "Found 3 items." };
return { ok: false, error: { code: "missing_secret", message: "OPENROUTER_API_KEY is not set" } };
```

`reply: null` means the tool completed successfully but has nothing to send to the chat.

Media:

```js
return {
  ok: true,
  reply: "The document is ready.",
  send: {
    kind: "file",
    url: "https://cdn.example.com/report.pdf",
    caption: "Report",
    filename: "report.pdf"
  }
};
```

Supported kinds are `message`, `file`, `photo`, and `video`. The URL must use public `http/https`, not localhost or a private IP address. For locally created files, use `source: { type: "artifact", artifactId }`; do not use `kind: "artifact"`.

## Forbidden

The following are not allowed in `plugin.js`:

- `require`;
- `import`;
- `process`;
- `fs`;
- `child_process`;
- direct `fetch`;
- `XMLHttpRequest`;
- `WebSocket`;
- `Worker`;
- `eval`;
- `Function`;
- infinite loops such as `while(true)` and `for(;;)`;
- Node.js APIs.

## HTTP Skill Example

```js
export default {
  tools: {
    async openrouter_balance(ctx, args) {
      const key = ctx.api.secrets.get("OPENROUTER_API_KEY");
      if (!key) return { ok: true, reply: "The OpenRouter API key is not set." };

      const res = await ctx.api.http.get("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: "Bearer " + key }
      });

      if (!res.ok) {
        return { ok: false, error: { code: "http_error", message: "OpenRouter status " + res.status } };
      }

      const account = res.json && res.json.data ? res.json.data : {};
      const limit = account.limit !== undefined ? account.limit : "?";
      const usage = account.usage !== undefined ? account.usage : "?";

      return {
        ok: true,
        reply: "OpenRouter balance\nLimit: " + limit + "\nUsed: " + usage,
        data: account
      };
    }
  }
};
```

Manifest permissions:

```json
{
  "permissions": {
    "httpOrigins": ["https://openrouter.ai"],
    "storage": true,
    "secrets": ["OPENROUTER_API_KEY"]
  }
}
```

Global `.env` must allow the origin:

```env
SKILL_HTTP_ALLOWED_ORIGINS=https://openrouter.ai
```

## Lifecycle

1. Agent creates or updates a skill via `create_skill_package`.
2. On update, the current `plugin.js`, `SKILL.md`, and runtime manifest fields are saved to `skills/custom/<id>/revisions/v<version>/`. The existing `enabled` flag is preserved: updates to an enabled skill take effect without enabling it again.
3. User sets required secrets.
4. For a new or disabled skill, the user runs `/agentur skill enable <id>`.
5. Enable validates and dry-runs the skill, then sets `enabled: true`.
6. Runtime executes the package when `enabled` is true.
7. If a recent update is broken, the agent can manually use `rollback_skill` to restore the one saved revision. The enabled flag, secrets, scoped state, and audit log are kept unchanged.

## Common Mistakes

- Using `api.http` instead of `ctx.api.http`.
- Using a third `api` argument: `async tool(ctx,args,api)`.
- Reading HTTP JSON from `res.data`; use `res.json`.
- Forgetting to declare `httpOrigins`.
- Forgetting to allow origin in `SKILL_HTTP_ALLOWED_ORIGINS`.
- Forgetting to declare secrets in `skill.json`.
- Updating a skill expecting more than one revision to be retained.
- Returning a string instead of `{ reply: "..." }`.
- Using `module.exports`; prefer `export default`.
- Creating command triggers for broad/agentic skills instead of using `triggers: []` and `description`.
- Returning raw JSON dumps or low-level integration errors as `reply`; prefer structured `data`/`error` and let the LLM compose semantic answers.
