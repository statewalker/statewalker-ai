# workbench

## What it is

The harness's workbench: a terminal in a browser page whose commands talk to the harness through
the session API. By default the harness runs in the page itself, on CellB: the deployment
(`ai-host-do`) is built for browsers and loaded in a Dedicated Worker, its cells in the page's OPFS.
With `?deployment=<url>&token=<access token>` it talks to a deployment elsewhere instead.

It replaces `statewalker-sandbox/apps/flue-workbench`, which ran Flue in the page against a Gemini
key (statewalker/statewalker-root#84, #132): agents, files, models and secrets are now the
harness's, reached only through the session API.

## Why it exists

- **The harness's first usable client in a browser.** It proves the release on CellB in a page:
  sessions, turns streamed as they run, approvals, files, the user's own models and secrets.
- **A browser page holds only the user's own secrets.** The page's harness is a browser deployment
  (`HOSTING` "browser", built by `@statewalker/ai-host-do/browser`): it is built without
  `SECRETS_KEY`, `DEPLOYMENT_SECRETS` or any value they name, keeps no project or workspace secret,
  and asks for a secret's value without showing it.
- **The session API is the boundary.** The page imports nothing of the harness: `src/client.ts`
  is a plain REST and server-sent-events client, the same one its tests drive against a live
  deployment.

## How to run it

```sh
pnpm install                                     # at the repository root
pnpm --filter @statewalker/ai-workbench dev      # builds the harness, starts Vite
pnpm --filter @statewalker/ai-workbench test     # the shell against a deployment on CellB Node
pnpm --filter @statewalker/ai-workbench build && pnpm --filter @statewalker/ai-workbench test:page
                                                 # the built page in Chromium
```

`scripts/build-harness.mjs` builds the harness into `public/harness/` with `cellb build` (Vite
does not bundle the Worker project; the Flue runtime is hand-written for that reason), with a
browser deployment's configuration and the development login on, since the page is its user's own.

## How to use it

Type `help` in the terminal. Plain text is a message to the current agent session; the agent's
answer, its tool calls and their results stream in as the turn runs, and Ctrl-C cancels it.

```text
› provider openai-completions https://api.openai.com/v1 gpt-5-mini OPENAI_KEY
› secret set OPENAI_KEY model-gateway api.openai.com
value of OPENAI_KEY:                       (typed unseen)
› write /home/todo.md "- try the workbench"
› summarise todo.md
› approvals
› approve ap-…
```

The page's harness has one project, `home`, owned by its user, and no model until the user
configures their own provider (a page holds no deployment key). The page makes its own admin key at
each load, used only to give its user that project.

## Internals

- `src/client.ts`: the session API over a `fetch` (REST, the event stream of a turn).
- `src/commands.ts`: the shell: each command one or a few session-API calls.
- `src/harness-worker.ts`, `src/in-page.ts`: the harness in a Dedicated Worker, and a streamed
  `fetch` onto it.
- `src/main.ts`: xterm, the line editor, the boot.
- `tests/shell.test.ts`: the shell against ai-host-do on CellB Node (ai-conformance's runner) with
  the scripted model. `tests/page/`: the built page in Chromium.
