---
"@statewalker/ai-openai-compat": patch
---

A streamed Chat Completion now shows the turn's last events when the turn ends between an up-to-date read of its events and the status check after it. Before, the stream could end with an empty answer (statewalker/statewalker-root#141).
