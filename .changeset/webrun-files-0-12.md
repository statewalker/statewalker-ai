---
"@statewalker/ai-agent-runtime.core": minor
"@statewalker/ai-agent.core": minor
"@statewalker/ai-config.core": minor
"@statewalker/ai-local-models.browser": minor
"@statewalker/ai-local-models.core": minor
---

**Move to `@statewalker/webrun-files` 0.12 and the kernel 0.8 line built on it** (statewalker/statewalker-ai#28). The dependency ranges move to these breaking lines:
- webrun-files, -composite and -mem go to ^0.12.0;
- workspace.core and settings.core go to ^0.8.0.

webrun-files 0.12 resolves `..` segments before any filter, guard or mount sees a path, and throws `Path climbs above the root` for a path above the root. The agent's tools view therefore cannot reach the system folder through a path such as `/work/../.settings/x`.
