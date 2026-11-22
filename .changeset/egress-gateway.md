---
"@statewalker/ai-access": minor
"@statewalker/ai-environment": minor
"@statewalker/ai-definitions": minor
"@statewalker/ai-sessions": minor
"@statewalker/ai-flue": minor
"@statewalker/ai-host-do": minor
---

The egress gateway (statewalker/statewalker-root#208): executed code's only network. A node
script's `fetch`, Pyodide's `pyfetch` (scripts may use top-level `await`), the shell's `curl` and
`wget`, and a native tool's `ctx.fetch` go through one host-side gateway in the Workspace DO, which
sends a request only where the deployment allowlist (`EGRESS_ALLOW`, empty by default), the user's
`net.read`/`net.write` roles, the agent's or tool's `requires.network` and the mode all allow it
(`acceptEdits` allows reads, `plan` denies the network, `default` asks on first use). HTTPS on the
default port only; internal and metadata addresses refused (the gateway resolves names itself),
every redirect re-checked, bound secrets put in only for their hosts, caps on request bodies, query
strings and answers, each request counted toward `outbound_requests` and recorded as a
`network_request` item. REST tools and remote MCP servers get the same address rule. Pyodide's raw
sockets stay closed.

`ai-environment`: `egressFetch`, `parseEgress`, `internalAddress`, `networkNeeds`, transports
(`nodeTransport`, `fetchTransport`, `dohResolver`); `gatewayFetch` takes an optional address guard;
`EngineRun.fetch`; `PoolMount.egress`. `ai-access`: the built-in modes decide `net.*`. `ai-sessions`:
the `network_request` item kind. `ai-flue`: `CodePort.fetch`. `ai-definitions`: a native tool's route
carries its operation's `requires`.
