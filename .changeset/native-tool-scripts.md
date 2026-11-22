---
"@statewalker/ai-definitions": minor
"@statewalker/ai-host-do": minor
---

Native tool scripts in isolates (statewalker/statewalker-root#130): the plugin builder bundles a
plugin's tool scripts with webrun-bundler (one ESM bundle per tool, named by sha-256), generates the
OpenAPI document of OpenCode-style tools and holds workspace and project plugins to the acceptance
check; the deployment runs each call in a Worker Loader isolate of its own (`LOADER`), with the
network off, files and databases only through the tool's capability, isolate time metered as
`executor_cpu_ms:isolate`, catalog bundles only once approved by hash (`APPROVED_BUNDLES`).
