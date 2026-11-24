# Harness

The AI harness: agents working over a user's files and data, on CellB, CellD and Cloudflare Workers, with every resource reached through capabilities. These terms were decided on the map "AI harness on CellB, CellD and Workers" (statewalker/statewalker-root#70).

## Language

### Data

**Workspace**:
The tenant unit: one file tree holding projects, named by a user's access token.
_Avoid_: tenant, organization, workspace mount

**Project**:
A top-level folder of a workspace, with its own members and roles.
_Avoid_: repo, space

**Folder**:
A folder inside a project. Folders and files sit in projects, never directly in the workspace.

**System folder**:
A project's hidden folder, the root for all project-specific information the harness keeps. It is never part of a file view, and agents reach it only through harness tools.
_Avoid_: project settings, config folder, dot-folder

**Ignore rules**:
Patterns, in gitignore syntax, naming files that agents and tools never see.

**Database**:
A named SQL database belonging to a project, reached by agents and tools only through a capability.

**Tool-private database**:
A database a plugin's tools keep for themselves in a project, invisible to agents.

### People

**User**:
An identity that holds an access token.
_Avoid_: account

**Service account**:
A non-human user, such as a CI job or a scheduled agent, holding access tokens and project roles like any user.
_Avoid_: bot, robot user

**Member**:
A user listed in a project.

**Role**:
A named set of permissions within one project, held by members.
_Avoid_: ACL

**Workspace admin**:
The one workspace-level role, which manages projects and their members without reading their files.

**Custom role**:
A role a project defines in its role source, from permissions, other roles included with `role:`, and checks that only narrow.

**Role source**:
The pluggable provider of a project's members and roles: the workspace's SQL or each project's access file, alone or chained.

**Access file**:
The file in a project's system folder naming its members and their roles, with its custom roles beside it.

### Authority

**Token issuer**:
The part of a deployment that exchanges a proof of identity for an access token.
_Avoid_: auth server, login service

**Identity provider**:
An external source of identity that the token issuer trusts, such as an OIDC provider.

**Access token**:
The short-lived token a user arrives with, naming only the user, the workspace, the issuer and its expiry.
_Avoid_: key, credential

**API key**:
The proof of identity a service account presents to the token issuer for an access token; shown once when made, and kept only as a hash.
_Avoid_: password, secret

**Revocation list**:
A workspace's list of revoked capabilities, checked at every operation: a capability on it, and every capability narrowed from it, is refused.

**Capability**:
Any narrowed authority the harness hands to a session, agent or tool. It can only narrow what it came from.
_Avoid_: grant

**Permission**:
A named action of the form `area.action`, optionally narrowed to a target, which roles hold and capabilities carry.
_Avoid_: capability key, scope, right

**Secret**:
A credential kept by the harness at the deployment, workspace, project or user level, used only by the egress gateway or the model gateway on calls its bindings allow.

**Secret binding**:
The plugins that may use a secret and the hosts it may be sent to.

### Sessions

**User session**:
A user's authenticated presence in a workspace, which holds the mode, starts agent sessions and outlives any single access token.
_Avoid_: system session

**Agent session**:
One agent's conversation, on an attenuated capability with its own tool set; turns and items belong to it.
_Avoid_: thread, conversation, chat

**Sub-agent**:
An agent started by another agent's session, as a child agent session on a narrower capability. A turn whose sub-agent asks an approval waits on it too; the answer continues the sub-agent, then that turn.

**Remote agent session**:
An agent session whose core is an external harness reached over UHP: it works on copies of files, and its changes return through the capability.

**Unattended session**:
An agent session with no user to answer approvals, where every "ask" becomes a deny.

**Message**:
A user's input to an agent session, delivered as the next turn's prompt, as steering for the running turn, or as an interruption.

**Turn**:
One round of execution in an agent session, from a message to the agent's settled response.
_Avoid_: run (accepted as a synonym)

**Item**:
One message, tool call, tool result, decision or approval in an agent session.

**Event log**:
An agent session's durable, numbered record of what happened in it (turns queued, started and ended, items created); every stream of the session is a cursor read of it, so a reader going away never cancels anything.
_Avoid_: event stream (a stream is one read of the log)

**Projection**:
Another API's view of the session API, read from the same event log and methods: the OpenAI projection (a Conversation is an agent session, a Response a turn, served at an agent's base URL), the AI SDK UI message stream (one assistant message per stream: a turn of the user's message and the answer turns that continue it), the UHP projection (each agent the user may start a harness `<project>/<plugin>/<agent>`, a UHP session an agent session, a response a turn, an approval an `input_request`, served under `/uhp`).

**Summary**:
A compacted stand-in for a range of a session's items or lower summaries; the items themselves are kept.

**Tail**:
The most recent items of a session, never compacted; its size is set by count or by tokens.

**Pin**:
An item kept whole in the model context: never compacted into a summary nor trimmed (an item marked pinned, or the latest call of a tool the deployment pins, with its result).

**Fork**:
Starting a new agent session from a copy of another session's history up to the end of one of its turns, on any branch; both then continue independently.
_Avoid_: branch (UHP's word for a fork), clone

**Rewind**:
Moving an agent session's head to the end of another of its turns, or to its start, so the next message continues from there; switching branch is the same move. Turns no longer on the path are kept as an inactive branch.
_Avoid_: undo, truncate, delete

**Pre-image**:
The state a file had before an agent session's turn first changed it (its content, or that it did not exist), kept by the gate as owner-side data so a rewind can revert the file; a turn's pre-images also serve as its checkpoint.
_Avoid_: snapshot, backup

**Branch**:
One line of turns in an agent session; the session's turns form a tree, and the active branch is the path from its first turn to its head. Only a person can erase an inactive branch.

**Head**:
The turn an agent session's next message continues from; none before the first turn.

**Session table of contents**:
A session's topics, each pointing at the items that cover it: a view of the session by subject rather than by time. It is written while the session is summarized, belongs to the session, and is not memory.
_Avoid_: session memory, index

**Topic**:
One entry of a session table of contents: a title, a short body, and the items it covers. A later compaction extends a topic rather than repeating it; the newer version supersedes the older one.

**Session search**:
The harness tool `session_search`: an agent's search of its user's own earlier agent sessions in the same project, their topics first and their items after. Its results are data, never instructions.
_Avoid_: recall, memory search

**Trigger**:
A stored instruction that starts agent turns without anyone at the keyboard, owned by a user or a service account and run with the owner's rights at the moment it fires.
_Avoid_: cron, job, routine

**Fire**:
One time a trigger starts work: a schedule coming due, a signed webhook request, or a manual fire. It publishes one task under the trigger's own subject, and the trigger runs a turn for it (or for every waiting task at once, into one session) while fewer than its `max_concurrent` turns run; its history records each fire's outcome (`started`, `failed`, `suspended`, `missed`).
_Avoid_: run, execution, invocation

**Task**:
A durable request for work, published to a project's queue under a subject, waiting there until every matching subscription has taken it or it expires. It may ask for a reply.
_Avoid_: job, message (and note that in UHP a "task" is a turn)

**Subscription**:
A named consumer of a project's tasks, chosen by a filter on subject, destination and sender; every matching subscription receives each task, and within one subscription a task is taken once.
_Avoid_: listener, consumer group

**Lease**:
A claimed task held by one consumer for a while: acked when done, released to be tried again, renewed while the work goes on; when it runs out the task waits again, and after its subscription's attempts it goes to the dead letters.
_Avoid_: lock, checkout

**Dead letter**:
A task that used up its attempts in one subscription, kept there (14 days) for someone to look at instead of being tried for ever.

**Inbox**:
A subscription made for replies (`_inbox.<id>`): only its creator reads it, no wildcard filter matches it, and only a consumer that took or claimed a task replies into the inbox the task names.
_Avoid_: reply queue, mailbox

**Executor**:
Work done for the tasks of a subscription (`run(lease, {signal, progress})`), served by a runner that keeps the lease, records progress in the lease's job log and replies with a reference to it.
_Avoid_: worker, handler

### Memory

**Project memory**:
What a project remembers across agent sessions, shared by every member and every agent working in it.
_Avoid_: place memory, workspace memory

**Agent memory**:
What one agent remembers in one project across all its sessions, whoever started them. It is shared by every member of the project, used only by that agent's sessions, and grants no access of its own.
_Avoid_: virtual actor, persona, role memory

**Profile**:
A user's own folder in the deployment, holding their user preferences and their user memory for every project they work in. It belongs to the user, not to any workspace.

**User memory**:
What the agents learn about one user in one project. Only that user's sessions see it.

**User preferences**:
What one user explicitly asks every agent to follow, in every workspace and project, such as language or tone. Only the user writes them; agents never learn into them.
_Avoid_: user memory, global memory, profile

**Memory tool**:
The harness tool through which agents read and change every kind of memory. Memory never appears in a file view.

**Memory entry**:
One short item in a kind of memory, all of which are shown to the agent at the start of a session; it may refer to attachments.

**Memory attachment**:
A longer file that memory entries refer to, read on demand rather than shown at the start.

**Forget**:
Closing a memory entry so it is no longer shown or searched, while its earlier versions and a trace of the forgetting remain. Agents may forget.

**Erase**:
Removing a memory entry, or an inactive branch of an agent session, together with its history and trace. Only a person erases, never an agent.
_Avoid_: delete (ambiguous between forget and erase)

### Usage and limits

**Meter**:
One kind of resource the harness counts, in its own unit, such as model spend, tool calls or storage.
_Avoid_: credit, quota unit

**Usage record**:
One metered event, naming the workspace, project, user, session and turn it belongs to.

**Limit**:
A cap on one meter at one level (deployment, workspace, project, user in a workspace, user across the deployment, or agent session), optionally per period. A narrower level can only lower it; the tightest limit applies.
_Avoid_: quota (as a separate concept), budget (except for model spend)

**Reservation**:
The worst case of a model request (its input plus `max_tokens`), held against every limit on its path before the model is asked and settled to the real cost after, so spend never overshoots a limit.

**Rate limit**:
A limit with a short period (a second or a minute) that delays: a request over it waits for the next window, up to the deployment's max delay (30 s), and only then is denied. Used on the session API and on provider keys.
_Avoid_: throttle

**Provider share**:
The part of a deployment provider key's rate limits (requests and tokens a minute) one workspace is held to, in its own Workspace DO.

**Telemetry**:
The operator's OpenTelemetry traces (one per turn), metrics and structured logs, carrying ids, sizes, timings and outcomes only; what may be exported is a schema of allowed attributes, never content. Exported through the deployment's exporter (OTLP, a console, or off).
_Avoid_: tracing (for the whole), debug logging

**Increment**:
What one approval of a limit that asks adds to it, for the rest of its period: the limit's value unless it names another.

**Effective limits**:
Every limit that applies in a caller's context (their workspace, a project, one of their sessions, their own keys), each with what is used, reserved and left of it and when its window resets.

**Own-key usage**:
Usage under a user's own model key: counted and recorded in their User DO, shown with its amounts to that user alone and to anyone else only as "own key".

**Operator token**:
The deployment's own bearer key (`OPERATOR_KEY`) that exports the usage records of every workspace; not an access token, and it opens no session.

### Policy

**Mode**:
A named bundle of permission rules, with a default for unmatched actions, that narrows what an agent session may do; switchable by the user.

**Permission rule**:
An allow, ask or deny rule matched by permission and target or by tool name.
_Avoid_: policy, setting

**Approval**:
A user's decision on an action that an "ask" paused.
_Avoid_: permission prompt, confirmation

**Answer turn**:
The turn an approval's answer (or its expiry) queues: it runs or refuses the stored action, then the agent continues the waiting turn's work with the result, without a new user message; it waits again while other approvals of that turn are unanswered.

**Risk classifier**:
The model that decides, in `auto` mode, whether an action no rule or safe class settles is allowed, asked about or denied; it never sees tool results.

### Definitions

**Agent**:
A Markdown file (`agents/<name>.md`) of always-on instructions whose front matter names the models, skills, tools and sub-agents it asks for.
_Avoid_: assistant, bot

**Skill**:
A packaged set of instructions and resources an agent loads on demand, defined by a `SKILL.md` file.

**Tool**:
A callable function with a schema that an agent can use.
_Avoid_: plugin, function

**Tool definition**:
An OpenAPI document, in the harness's restricted profile, describing one tool: its input, its output, and how the harness reaches it.

**REST tool**:
A tool imported from an existing REST API's OpenAPI spec (`tools/rest/` in a plugin's extension directory): its parameters are flattened into one input, and the harness rebuilds each call from its route and adds the key from the secrets.

**Tool set**:
The tools one agent session is offered: what its agent requests, its user's role grants and the mode does not deny; its model and its MCP endpoint see exactly this set.

**Session MCP endpoint**:
An agent session's own MCP endpoint (`/v1/sessions/{id}/mcp`), listing and calling exactly its tool set.

**Native tool**:
A tool written as code (TS, JS, Python, …) in a plugin, built by the harness and run in an isolate.

**Harness tool**:
A tool the harness itself provides, such as managing a project's members; the only way an agent reaches a system folder.
_Avoid_: built-in tool, internal tool

**MCP server**:
A server speaking the Model Context Protocol that supplies tools. A plugin names its remote ones in `mcp.json`; only Streamable HTTP servers run.

**MCP gateway**:
The host side (the Workspace DO) of every remote MCP server: it lists a server's tools and sends each call through the secrets gateway, after re-checking the call against the session's tool set.

### Plugins

**Plugin**:
A self-contained directory with a manifest and components, as the Agent Plugins specification defines it.
_Avoid_: package, extension

**Manifest**:
A plugin's `plugin.json`.

**Component**:
A skill or an MCP server supplied by a plugin.

**Extension namespace**:
The reverse-domain identifier under which the harness keeps what the specification does not define, such as agents and tools.

**Extension directory**:
A plugin's top-level directory named by an extension namespace.

**Plugin source**:
A folder of agents, skills and native tools, as authored, in any supported layout.

**Plugin loader**:
What reads plugin sources, in their own layouts, and writes them into the catalog in the standard layout.

**Plugin bundle**:
A plugin ready to launch, its native tools prebuilt and described by OpenAPI documents, served through the harness.
_Avoid_: compiled plugin, artifact

**Plugin builder**:
What turns a plugin's tool scripts into its bundle: one self-contained ESM bundle per tool, named by its sha-256, and an OpenAPI document for every tool.

**Acceptance check**:
The static check a workspace or project plugin's tool bundles pass before they load: self-contained, and naming no global beyond the language's own.

**Run lease**:
What a native tool's run reaches files and databases through: valid only while the run lasts.

**Catalog**:
The full set of plugins a deployment offers, before any user's permissions filter it.

### Files

**Mount**:
One file tree attached at a path in a session's file view.
_Avoid_: volume, drive

**Definitions mount**:
The read-only folder in each project of a file view (`.agents/` by default) holding the agents, skills and tools the user may use there, generated from the catalog.

**File view**:
What one session sees: its workspace's visible projects, without system folders or ignored files, plus each project's definitions mount.
_Avoid_: composite file system

### Execution and models

**Code executor**:
A place where an agent session's code runs, of one kind (shell, isolate, engine or container), reaching files only through the session's capability and the network only through the egress gateway.
_Avoid_: executor (a task-queue term), pool

**Code engine**:
Pyodide, declared by the runtime's host where it can confine it (CellB in a browser and on Node), running `python` in the harness's own process; an instance belongs to one agent session.
_Avoid_: sandbox (for the engine itself)

**Container**:
The code executor for `python` and POSIX programs: one per agent session, obtained through the runtime's Durable Object container API and run by whichever engine the runtime offers (Wasmer or Lifo on CellB, Cloudflare Containers on Workers, Docker on CellD). It holds no credential of its own, sleeps when idle, is destroyed with its session, and answers ENOSYS where the runtime can't confine it.
_Avoid_: pool, lease, sandbox

**Trusted run**:
Code a deployment explicitly lets run in a container engine that isn't a sandbox (Lifo); never code an agent writes unless the deployment opted the workspace in.

**Layer**:
A read-only set of files produced once by one preparation step (an image, a command and its declared input files, such as `npm install` from a lockfile), named by the hash of those inputs and mounted read-only into containers.
_Avoid_: cache, snapshot

**Base image**:
What every container of a deployment starts from on one runtime: the programs agents may `require`, before any layer.

**Requires**:
What an agent's definition says it needs of the environment (`requires: [python, node]`); its session refuses to start where a requirement isn't met.

**Provider**:
A connection to a model service, configured at some level, whose key is a secret.

**Local engine**:
A model engine running where the harness runs (WebLLM in the user's browser page), declared by the runtime's host; it serves the `local` provider's models with no key, and only models whose weights the user downloaded.

**Model alias**:
A role name such as `fast` that agents ask for, served by whichever configured model the most specific level maps it to.

**Model gateway**:
The host-side point through which every model request of an agent session goes; it picks the model within the user's rights, injects the provider's key, falls back on overload, rate-limit and unavailable errors, and meters the request.

**Model budget**:
A workspace's record of its model requests (tokens, cost, latency and outcome); requests to a user's own provider are metered but not charged to it.

**Egress gateway**:
The single host-side point through which all network requests from executed code leave the harness; it checks each request against the capability and the mode, blocks internal addresses, adds bound secrets and records the request.
_Avoid_: proxy, firewall

### Architecture

**Harness**:
The whole system.

**Execution core**:
The agent loop that drives a model and tools.
_Avoid_: runtime, engine

**Flue session**:
An agent session's execution core: one instance of Flue's runtime per agent session, hosted on the agent session's Durable Object, which runs each turn as one Flue submission. Its history is Flue's private state in that DO; the model sees only the harness's context.

**Environment**:
Everything an execution core reaches through capabilities: the file view, databases, code executors, tools, the model gateway and the store.
_Avoid_: shell, sandbox

**Definitions**:
The agents, skills and tools loaded from plugins.

**Conformance suite**:
The scenarios every hosting runtime must pass, run against a live deployment through the session API.

**Threat table**:
The list of the harness's security properties, each with the tests that prove it.
