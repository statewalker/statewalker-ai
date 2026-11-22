---
"@statewalker/ai-environment": patch
---

The gate's files-RPC server answers every chunk of a stream cut by a revocation with the refusal (`EACCES`), also chunks already waiting at the server or whose check passed only after another chunk's refusal; before, such a chunk failed as `UNKNOWN_STREAM: the stream was closed` (statewalker/statewalker-ai#75).
