---
"@statewalker/ai-uhp-client": minor
"@statewalker/ai-access": minor
"@statewalker/ai-environment": minor
"@statewalker/ai-definitions": minor
"@statewalker/ai-sessions": minor
"@statewalker/ai-host-do": minor
---

Remote agent sessions over UHP (statewalker/statewalker-root#144): the new `ai-uhp-client` package
runs an agent session whose core is an external harness behind a UHP server (2026-10-19), started
as `remote:<server>/<harness>` (or from an agent with `remote: {server, harness}`) with
`agents.use:remote:<server>/<harness>`, which no built-in role holds. Files under the agent's
`inputs` are copied in; artifacts are written back as one change set under the mode;
`input_request` becomes an approval or a question (a `question` item); remote items are
`external`; cancel, archive and revoke send UHP cancel. Servers are registered in `UHP_SERVERS` or a
workspace's `/.system/uhp-servers`.
