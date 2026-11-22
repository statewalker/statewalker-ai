---
"@statewalker/ai-environment": minor
---

The Pyodide code engine (statewalker/statewalker-root#142): `@statewalker/ai-environment/pyodide`
(`pyodideEngine`, `pyodideNodeHost`, `pyodideWorkerHost`) and its engine script
`engines/pyodide-engine.mjs`. A runtime's host installs it to run `python` from the agent's `bash`
tool: on Node in a child process under Node's permission model, in a browser in a module Worker;
the session's project is copied in and each change written back through the session's file view,
authorized again; no network.

The Wasmer code engine on Node (statewalker/statewalker-root#142): `@statewalker/ai-environment/wasmer`
(`wasmerEngine`) and its engine scripts `engines/wasmer-*.mjs`: WASIX programs the deployment lists
run in a Wasmer sandbox whose `/workspace` is the session's file view, every file operation
forwarded live to the gate; no network.
