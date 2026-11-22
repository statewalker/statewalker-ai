---
"@statewalker/ai-environment": minor
"@statewalker/ai-sessions": minor
"@statewalker/ai-flue": minor
"@statewalker/ai-host-do": minor
---

Telemetry without content (statewalker/statewalker-root#182): OpenTelemetry traces (one per turn,
with spans for model requests, tool calls, executor runs, memory-tool calls and approval waits;
gate operations sampled), metrics (meter counters, latency histograms, error and denial counts,
queue waits) and structured logs, carrying ids, sizes, timings and outcomes only through an
allowlist schema of attributes. `ai-environment` holds the telemetry and its exporters (OTLP over
`fetch`, a console, or off; a browser deployment gets the console or nothing); `ai-host-do` reads
the deployment's `TELEMETRY` var.
