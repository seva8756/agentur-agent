# HTTP, secrets, and MCP

[English](integrations.md) | [Русский](ru/integrations.md)

[← README](../README.md)

Integrations have two levels of configuration: the application owner controls shared capabilities through `.env`, while server settings and secrets are stored separately for each chat.

## HTTP

HTTP requests from skills and the agent's built-in `execute_http_query` tool use a shared network layer. In `.env`, list the allowed origins: scheme, host, and optional port, without a path:

```dotenv
SKILL_HTTP_ALLOWED_ORIGINS=https://api.example.com,https://another.example.com
SKILL_HTTP_TIMEOUT_MS=10000
SKILL_HTTP_MAX_REQUEST_BYTES=131072
SKILL_HTTP_MAX_RESPONSE_BYTES=1048576
HTTP_BLOCKED_HOSTS=
HTTP_ALLOWED_PRIVATE_HOSTS=
```

Replace the example addresses with those of your APIs. An empty `SKILL_HTTP_ALLOWED_ORIGINS` disables these HTTP requests. The value `*` allows any public origin while keeping the other checks in place.

A skill must also declare its required origins in `skill.json`:

```json
{
  "permissions": {
    "httpOrigins": ["https://api.example.com"],
    "storage": true,
    "secrets": ["SERVICE_TOKEN"]
  }
}
```

This is a manifest fragment, not a complete file. See the [full skill contract](skill-packages.md).

In `plugin.js`, make requests through `ctx.api.http`, for example:

```js
const token = ctx.api.secrets.get("SERVICE_TOKEN");
const response = await ctx.api.http.get("https://api.example.com/items", {
  headers: { Authorization: "Bearer " + token }
});
```

The network layer enforces:

- `http` and `https` protocols only;
- checks on allowed origins, destination addresses, and redirects;
- blocking of localhost and private IP addresses by default;
- timeouts and request/response size limits.

`HTTP_BLOCKED_HOSTS` adds a blocklist by hostname, without a port. `HTTP_ALLOWED_PRIVATE_HOSTS` explicitly allows a particular internal host, which must still pass the origin check. `HTTP_BLOCKED_HOSTS` takes priority. These settings apply to the HTTP layer used by skills and the agent, not to LLM, Telegram, or MCP connections.

Direct `fetch` is not available in skill code. See the [skills guide](skill-packages.md#http) for the full HTTP SDK.

## Secrets

Integration keys for a chat are stored in `chat/secrets.json` inside its data directory. This is an ordinary JSON file without encryption. The application's LLM key and Telegram token are set separately in `.env`.

```text
/agentur secrets
/agentur secret set SERVICE_TOKEN <value>
/agentur secret delete SERVICE_TOKEN
```

`/agentur secrets` shows key names and whether values are set, but not the values themselves. A skill can use `ctx.api.secrets.get()` only for keys listed in its manifest's `permissions.secrets`.

**Current behavior:** a command that sets a secret is saved in the message buffer before the command is handled, and may enter later LLM context. In a group, the bot tries to delete the original Telegram message if it has permission, but this does not clear local history. Removing a key with `secret delete` also does not remove it from previously saved messages, summaries, or backups.

To avoid sending a key through a chat command, the server owner can stop the application and add the string value directly to that chat's `chat/secrets.json`, keeping the other keys. The file has this format:

```json
{
  "SERVICE_TOKEN": "key-value"
}
```

Start the application after making the change. A key set in a private chat with the bot does not carry over to a group: those chats have separate storage.

## MCP

MCP (Model Context Protocol) lets you connect tools and resources from external services. This project provides it through the trusted [`skills/catalog/mcp`](../skills/catalog/mcp/SKILL.md) skill, which runs in the Node.js process.

### Enabling MCP

In `.env`:

```dotenv
MCP_ENABLED=true
MCP_TIMEOUT_MS=20000
MCP_MAX_RESPONSE_BYTES=262144
```

After making the change, run `docker compose up -d`. Remote servers using the `streamable_http` transport are supported. The configuration is intended for public HTTP(S) addresses; URL validation rejects localhost and a number of private address ranges. Local processes and stdio are not supported.

### Connecting a server

Run these commands in the target chat, replacing the address and names with those for your server:

```text
/agentur mcp add-remote my_service https://mcp.example.com/mcp
/agentur mcp servers
```

If authentication is required, save `SERVICE_MCP_TOKEN` in that chat's secret store as described [above](#secrets), then link it:

```text
/agentur mcp set-token my_service SERVICE_MCP_TOKEN
```

The key's value is sent to the server as `Authorization: Bearer <token>`. Then list the tools:

```text
/agentur mcp tools my_service
```

### Restricting tools and resources

A new server has empty `allowedTools` and `allowedResources` lists. **An empty list allows all of the server's tools or resources**, rather than denying access.

To restrict tools, add the allowed names:

```text
/agentur mcp allow-tool my_service list_items
/agentur mcp allow-resource my_service service://reports/*
```

After the first `allow-tool`, only the listed tools are allowed. Resources are restricted separately through `allow-resource`. Resources support an exact URI or a prefix ending in `*`. Tool names and URIs depend on the server.

To remove the connection:

```text
/agentur mcp delete my_service
```

Settings are stored in `integrations/mcp/servers.json` inside the chat directory; the token value remains in `chat/secrets.json`. Removing a connection does not remove its key from the secret store.

### Use by the agent and skills

The agent receives the tools `mcp_list_servers`, `mcp_list_tools`, `mcp_call_tool`, and `mcp_read_resource`. A regular skill can also call a connected server:

```js
const result = await ctx.api.mcp.callTool("my_service", "list_items", {});
```

Servers are connected through management commands, not skill code. Calls go through the MCP manager and follow the restrictions set for that server in the chat. See the [MCP SDK for skills](skill-packages.md#mcp).
