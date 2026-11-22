# @statewalker/ai-uhp

## What it is

The UHP projection of the session API (statewalker/statewalker-root#139, decided in #108, amended
by #157 and #159): UHP clients drive harness agents through the
[Unified Harness Protocol](https://github.com/HarnessRouter/harnessrouter/tree/main/protocol) at
class **Core** plus `input_requests`, pinned to UHP `2026-10-19` at spec commit
`300dc9da9baa8f1f6eb98090075e5c4482ca44d0` (`UHP_SPEC_COMMIT`). A request naming another
`UHP-Version` is refused; each new date version is a deliberate change.

- Each agent the user may start is a **harness** named `<project>/<plugin>/<agent>`; its id is that
  name behind UHP's `chrn_` prefix, slashes spelled `~` (`chrn_notes~team~lead`), and a task's
  `metadata.harness_id` takes the bare name too. The workspace is the token's.
- A UHP **session** is an agent session and a **response** is a turn (`resp_<turn id>`).
- A task sent while a turn runs is `409 session_busy`: UHP has no queue and no steering (both stay
  native).
- An approval is the response's last item, an `input_request` (`confirm`, options `allow`/`deny`;
  a remote harness's question keeps its kind), asked **one at a time**: the response ends
  `incomplete` with reason `input_required`. An `input_response` answers it with scope "once"
  (scope "session" stays native); any other input passes it over (`metadata.voided_input_requests`).
  A sub-agent's approval is asked as the root response's `input_request`: the turn that started it
  waits on it, and the answer's response is the root's turn continuing with the sub-agent's outcome
  (statewalker/statewalker-ai#88).
- `previous_response_id` naming an earlier response moves the session's head there and continues
  in the same session (an implicit rewind that reverts no file). `branch: true` is a fork carrying
  the task as its first message, reporting `metadata.branched_from`; `GET /v1/sessions/{id}` names
  the origin with `turn`, the response's depth on its path. Files are not restored into the fork,
  so `session_branching` is not declared.
- Fields the projection does not act on (`tools`, `include`, budgets, `instructions`, …) are named
  in `metadata.ignored_fields`; a model the caller may not use is substituted and reported
  (`requested_model`, `model_fallback`). `memories`, files, session listing and harness management
  are not declared.

Part of the AI harness (statewalker/statewalker-root#111): see the
[repository's README](https://github.com/statewalker/statewalker-ai#readme), its
[glossary](https://github.com/statewalker/statewalker-ai/blob/main/GLOSSARY.md) and its
[threat table](https://github.com/statewalker/statewalker-ai/blob/main/docs/security.md).

## How to use it

```sh
npm install @statewalker/ai-uhp
```

A deployment's Worker routes REST requests under `/uhp` with `handleUhpRest(request, open)`; a UHP
client's base URL is then `https://<deployment>/uhp`. A client that reaches the session API over
RPC runs the same router in its own process:

```ts
import { uhpFetch } from "@statewalker/ai-uhp";

const fetchUhp = uhpFetch(sessionApi);
const res = await fetchUhp("http://harness.invalid/uhp/v1/responses", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ input: "hello", metadata: { harness_id: "notes/team/lead" } }),
});
```

UHP's own conformance suite (`uhp-conformance --class core`) runs against a deployment every night
(`ai-conformance`'s `tests/nightly/uhp-conformance.test.ts`).
