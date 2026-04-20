# statewalker-ai

AI agent + providers: ai-agent, ai-agent-fsm, ai-agent-state, ai-agent-tests, ai-mcp, ai-provider, ai-provider-core, ai-provider-llamacpp, ai-provider-local, ai-provider-webllm

## Packages

<!-- List every package under `packages/` here with a one-line description and a link. Kept in sync by `scripts/new-monorepo.ts` and audited by `scripts/validate-migration.ts`. -->

| Package | Description |
| --- | --- |
| _(none yet)_ | |

## Development

```sh
pnpm install
pnpm run build
pnpm run test
```

## Release

Releases are managed via [changesets](https://github.com/changesets/changesets):

```sh
pnpm changeset           # describe the change
pnpm version-packages    # roll versions + regenerate CHANGELOGs
pnpm release-packages    # publish to npm
```
