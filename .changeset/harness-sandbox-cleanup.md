---
"@statewalker/ai-environment": minor
"@statewalker/ai-flue": patch
"@statewalker/ai-sessions": minor
---

Appends are one change at the gate (statewalker/statewalker-root#146): the gated view and the
mode gate take `append`, one at a time per file, decided as a write and asked about as an
`append` approval (a new `StoredAction` method) that adds exactly its bytes when approved. The
agent's shell appends through it, so parallel sessions appending to one file lose nothing; it
stores redirected binary output byte for byte (just-bash's `binary`/`latin1` content is no
longer encoded as UTF-8), and `cp`/`mv` onto an existing file or into a folder work (the file
view tells just-bash each entry's identity).
