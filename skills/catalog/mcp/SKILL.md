Use MCP tools when the user asks for data or actions from configured MCP servers.

Use `mcp_list_servers` when server names are unclear.
Use `mcp_list_tools` before calling a server tool if available capabilities are unclear.
Use `mcp_call_tool` only for allowlisted tools on allowlisted servers.
Use `mcp_read_resource` only for allowlisted resource URIs.

If an MCP tool can modify external state, ask the user for confirmation before calling it.
