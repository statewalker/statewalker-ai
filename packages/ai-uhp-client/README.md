# @statewalker/ai-uhp-client

## What it is

Remote agent sessions (statewalker/statewalker-root#144, decided in #109): agent sessions whose
core is an external harness (Claude Code, Codex, …) behind a server of the Unified Harness
Protocol, version `2026-10-19`. A remote session works on copies of files: at its start, the files
its capability can read under the agent's `inputs` are copied in; the artifacts its harness returns
are written back through the capability as one change set, a `write` under the mode. No tool, MCP
server or secret of the harness's crosses but the server's own token. Its items are mirrored into
the session marked `external`, which the risk classifier never sees; a question
(`input_request`) becomes an approval (a question for free text); cancelling, archiving or revoking
the session sends UHP cancel. Each task continues the remote session from the response of the last
task on the turn's path (`previous_response_id`): after a rewind, a branch switch or an edit, the
remote session follows the active path; with no task on the path (rewound before the first one, or
a fork) the task starts a fresh remote session, with the files copied in again.

It holds `RemoteCore` (the turn of a remote session, its tasks, polls, questions and write-back in
the DO's SQLite), the parts of the protocol it uses, the server registration format and the
inputs. The deployment's DOs (`ai-host-do`) run it: the Workspace DO holds the servers' tokens,
decides starting a task and meters every call; each agent session DO runs `RemoteCore`.

Part of the AI harness (statewalker/statewalker-root#111): see the
[repository's README](https://github.com/statewalker/statewalker-ai#readme), its
[glossary](https://github.com/statewalker/statewalker-ai/blob/main/GLOSSARY.md) and its
[threat table](https://github.com/statewalker/statewalker-ai/blob/main/docs/security.md).

## How to use it

```sh
npm install @statewalker/ai-uhp-client
```

A deployment registers UHP servers in `UHP_SERVERS` (or a workspace in `/.system/uhp-servers`):

```json
[{ "id": "hr", "baseUrl": "https://uhp.example.com", "secret": "HR_TOKEN",
   "harnesses": { "coder": "chrn_08dae611630d467ab3e67ed792570ae5" } }]
```

`HR_TOKEN` is a secret bound to plugin `uhp` and host `uhp.example.com`. The listed harness is the
remote agent `remote:hr/coder`, started like any agent (`POST /v1/sessions {agent}`, or
`agent.start`) by users whose role grants `agents.use:remote:hr/coder`; a plugin agent may also name
one in its front matter (`remote: {server: hr, harness: coder}`, `inputs: ['docs/**']`).

## Why it is the way it is

- **A child session, not a tool.** A remote harness runs every tool in its own sandbox, a separate
  trust domain: it gets copies, and nothing it does reaches the project but through the change set.
- **The stored response is the truth.** Tasks run in the background; the DO keeps the response id
  and the `Idempotency-Key` before sending and polls from its alarm, so a restart neither loses nor
  duplicates a task.
- **Pinned to `2026-10-19`.** The protocol moves quickly; unknown fields and items are ignored.
