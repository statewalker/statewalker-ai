---
"@statewalker/ai-host-do": patch
---

The harness runs on CellD and workerd as on CellB (statewalker/statewalker-root#141):
- **File writes on CellD:** a file write streamed over several files-RPC calls keeps the call that opened it alive until the stream ends, in the Workspace and Profiles DOs. CellD refuses a storage transaction to code continuing an event that has ended.
- **Native tools on CellD:** a native tool's isolate reaches the host by plain values, one step per round of host calls, where the Worker Loader carries no stub into it (CellD). Elsewhere it still gets the host as a stub.
- **Remote agent turns on CellD:** a remote agent session's turn keeps its event alive while it runs (`ctx.waitUntil`), as Flue's turns do. CellD drops the timers and continuations of an event that has ended, which left the turn's polls waiting forever.
- **`local` workspace backend:** documented as CellB Node only, since CellD's `node:fs` has no host file system.
- **Native tool transport choice:** the transport is probed once per isolate, with a loaded worker that holds no tool code, and never inferred from a tool's own run.
