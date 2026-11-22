---
"@statewalker/ai-openai-compat": patch
---

A Chat Completions stream no longer loses the answer of a turn that ends between the stream's up-to-date read of the session log and its check of the turn's status: it reads the events the turn logged meanwhile before it finishes (statewalker/statewalker-ai#95).
