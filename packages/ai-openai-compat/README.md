# @statewalker/ai-openai-compat

## What it is

The OpenAI projection of the session API (statewalker/statewalker-root#138, decided in #71, #83
and #159): an agent's base URL `/v1/projects/<project>/agents/<agent>/` serves `responses`,
`conversations`, `chat/completions` and `models`, so existing OpenAI clients drive harness agents
unchanged. The agent is `<plugin>/<agent>` (two path segments) or `default`, the project's default
agent.

- A Conversation is an agent session, a Response is a turn (their ids are the session's and the
  turn's). `model` is a real model: honoured when the caller may use it, otherwise ignored.
- `previous_response_id` naming the latest response appends; naming an earlier one moves the
  session's head there and sends (an implicit rewind that never reverts files, recorded by the item
  "head moved: chained on an earlier response"); `409` while a turn runs.
- "Ask" is an `mcp_approval_request` (its id is the approval's) and an `mcp_approval_response`
  answers it, once, with `reason` as the deny message. Scope "session" stays native only. The
  harness's own tool calls are `mcp_call` items (server label `harness`).
- Conversations show only the active path; deleting items or responses is refused (`405`).
- Chat Completions is stateless: each request is a fresh unattended session (archived once
  answered), so "ask" is a deny with a reason; earlier messages reach the agent as a transcript.

Part of the AI harness (statewalker/statewalker-root#111): see the
[repository's README](https://github.com/statewalker/statewalker-ai#readme), its
[glossary](https://github.com/statewalker/statewalker-ai/blob/main/GLOSSARY.md) and its
[threat table](https://github.com/statewalker/statewalker-ai/blob/main/docs/security.md).

## How to use it

```sh
npm install @statewalker/ai-openai-compat
```

A deployment's Worker routes REST requests with `handleOpenAiRest(request, open)`. A client that
reaches the session API over RPC runs the same router in its own process:

```ts
import OpenAI from "openai";
import { openAiFetch } from "@statewalker/ai-openai-compat";

const openai = new OpenAI({
  apiKey: token,
  baseURL: "http://harness.invalid/v1/projects/notes/agents/default/",
  fetch: openAiFetch(sessionApi),
});
```
