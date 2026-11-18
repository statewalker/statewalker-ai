# Memory as theater

> **An illustration, not a specification.** This page is a mental model for where memory belongs.
> The terms that count are in `GLOSSARY.md`, and the decisions are on the root tickets. Where this
> page and either of those disagree, they win. Don't use the theater words in code, APIs or specs.

The harness can be pictured as a theater.

| Theater | Harness |
|---|---|
| A **role**: a part written once and played many times | an **agent** (`agents/<name>.md`) |
| An **actor** who plays roles | a **user** |
| A **virtual actor**: no person behind it, but it remembers the parts it has played | the identity behind **agent memory**: one agent in one project |
| A **scene**: the place where the action happens | a **project** |
| A **performance**: one time, one place, actors playing roles | an **agent session** |

A scene can hold several roles at once: an agent session can start sub-agents. Each role is
played by an actor, either a real one (a user) or a virtual one (a sub-agent, played on behalf of
whoever started the performance).

## Where memories live

Memories belong to **places** and to **actors**:

- **The place remembers.** Whatever happened in a scene is remembered by the scene, and every actor
  who comes there shares it. This is **project memory**.
- **The virtual actor remembers.** The `reviewer` in project X remembers every performance of the
  `reviewer` in project X, whichever user started it. It doesn't follow the part into other
  projects, and it holds no authority: in each performance it acts under the capability of the
  session that started it. This is **agent memory**.
- **The real actor remembers.** A user's own memories are individual and are not shared with the
  other actors. This is still being decided (statewalker/statewalker-root#157).

## Where the picture stops

- An actor in the theater chooses what to do. In the harness, what an agent may do comes only from
  the capability of the session it runs in. Memory never grants access.
- One virtual actor per role and place is the first model. Later there may be one per user as
  well ("Alice's reviewer"), which would make agent memory individual too.
- In the glossary, "role" already means a set of permissions in a project (owner, editor, reader).
  That is one more reason the theater words stay on this page.
