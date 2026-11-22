---
"@statewalker/ai-definitions": minor
"@statewalker/ai-host-do": minor
---

Remote MCP servers (statewalker/statewalker-root#135): a plugin's `mcp.json` Streamable HTTP
servers are listed by the Workspace DO's MCP gateway (stateless MCP 2026-07-28, through the
secrets gateway) and their tools join the session's tool set as `<plugin>__<tool>`, re-checked at
every call. stdio and SSE servers answer ENOSYS; credentials come only from bound secrets
(`${NAME}` or `{{secret:NAME}}`), and a server whose files hold one is refused. A tool reads only
where the plugin says so (`x-dev.cellb.harness: {actions}`). ai-definitions adds
`catalogMcpServers`, `mcpServersOf`, `mcpTools`, `mcpRequest`, `mcpAnswer`, `mcpCallOutput` and
`MCP_REVISION`; the MCP tool route gains `server` and `headers`; `NarrowedAgent.mcpTools` keeps an
agent's tool patterns for tools listed later.
