# @statewalker/ai-config.core

## 0.7.0

### Minor Changes

- 607236d: **Move to `@statewalker/webrun-files` 0.12 and the kernel 0.8 line built on it** (statewalker/statewalker-ai#28). The dependency ranges move to these breaking lines:
  - webrun-files, -composite and -mem go to ^0.12.0;
  - workspace.core and settings.core go to ^0.8.0.
  
  webrun-files 0.12 resolves `..` segments before any filter, guard or mount sees a path, and throws `Path climbs above the root` for a path above the root. The agent's tools view therefore cannot reach the system folder through a path such as `/work/../.settings/x`.

## 0.6.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/workspace.core ^0.5.0 -> ^0.7.0
  - files changed: dist/public/model-reference.d.ts, dist/public/model-reference.d.ts.map, dist/public/model-reference.js.map, dist/public/provider-registry.d.ts, dist/public/provider-registry.d.ts.map, 3 more

## 0.5.2

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md, src/internal/store.test.ts

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/workspace.core@0.1.1
