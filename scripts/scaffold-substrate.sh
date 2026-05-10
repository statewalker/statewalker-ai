#!/usr/bin/env bash
# Scaffold the new AI substrate packages from
# openspec/changes/fragmentize-workbench-and-collapse-explorer/tasks.md
# (group 3.x). Idempotent: existing files are NOT overwritten.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$ROOT/packages"

mk_logic_pkg() {
  local name="$1"
  local desc="$2"
  local dir="$PKG_DIR/$name"
  mkdir -p "$dir/src"
  if [ ! -f "$dir/package.json" ]; then
    cat > "$dir/package.json" <<JSON
{
  "name": "@statewalker/$name",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "description": "$desc",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+ssh://git@github.com/statewalker/statewalker-ai.git"
  },
  "exports": {
    ".": "./src/index.ts",
    "./fragment": "./src/fragment.ts"
  },
  "files": ["src"],
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest --passWithNoTests",
    "typecheck": "tsc --noEmit",
    "lint": "biome check --write .",
    "format": "biome format --write ."
  },
  "dependencies": {
    "@statewalker/ai-agent": "workspace:*",
    "@statewalker/shared-baseclass": "catalog:",
    "@statewalker/shared-intents": "catalog:",
    "@statewalker/shared-registry": "catalog:",
    "@statewalker/shared-slots": "catalog:",
    "@statewalker/workspace": "catalog:"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
  "sideEffects": false,
  "publishConfig": {"access": "public"}
}
JSON
  fi
  if [ ! -f "$dir/tsconfig.json" ]; then
    cat > "$dir/tsconfig.json" <<'JSON'
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "lib": ["ESNext", "DOM"],
    "strict": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noEmit": true
  },
  "include": ["./src", "./tests"],
  "exclude": ["node_modules", "dist"]
}
JSON
  fi
  if [ ! -f "$dir/vitest.config.ts" ]; then
    cat > "$dir/vitest.config.ts" <<'TS'
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
TS
  fi
  if [ ! -f "$dir/src/index.ts" ]; then
    cat > "$dir/src/index.ts" <<'TS'
export {};
TS
  fi
  if [ ! -f "$dir/src/fragment.ts" ]; then
    cat > "$dir/src/fragment.ts" <<'TS'
import { newRegistry } from "@statewalker/shared-registry";

export default function init(_ctx: Record<string, unknown>): () => Promise<void> {
  const [_register, cleanup] = newRegistry();
  return cleanup;
}
TS
  fi
}

mk_react_pkg() {
  local name="$1"
  local desc="$2"
  local dir="$PKG_DIR/$name"
  mkdir -p "$dir/src"
  if [ ! -f "$dir/package.json" ]; then
    cat > "$dir/package.json" <<JSON
{
  "name": "@statewalker/$name",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "description": "$desc",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+ssh://git@github.com/statewalker/statewalker-ai.git"
  },
  "exports": {
    ".": "./src/index.ts",
    "./fragment": "./src/fragment.ts",
    "./styles": "./src/styles.css"
  },
  "files": ["src"],
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest --passWithNoTests",
    "typecheck": "tsc --noEmit",
    "lint": "biome check --write .",
    "format": "biome format --write ."
  },
  "dependencies": {
    "@statewalker/ai-agent": "workspace:*",
    "@statewalker/ai-providers": "workspace:*",
    "@statewalker/shared-baseclass": "catalog:",
    "@statewalker/shared-intents": "catalog:",
    "@statewalker/shared-registry": "catalog:",
    "@statewalker/shared-slots": "catalog:",
    "@statewalker/workspace": "catalog:"
  },
  "peerDependencies": {
    "react": ">=18",
    "react-dom": ">=18"
  },
  "devDependencies": {
    "@types/react": "catalog:",
    "@types/react-dom": "catalog:",
    "react": "catalog:",
    "react-dom": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
  "sideEffects": ["**/*.css"],
  "publishConfig": {"access": "public"}
}
JSON
  fi
  if [ ! -f "$dir/tsconfig.json" ]; then
    cat > "$dir/tsconfig.json" <<'JSON'
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noEmit": true
  },
  "include": ["./src", "./tests"],
  "exclude": ["node_modules", "dist"]
}
JSON
  fi
  if [ ! -f "$dir/vitest.config.ts" ]; then
    cat > "$dir/vitest.config.ts" <<'TS'
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
TS
  fi
  if [ ! -f "$dir/src/index.ts" ]; then
    cat > "$dir/src/index.ts" <<'TS'
export {};
TS
  fi
  if [ ! -f "$dir/src/fragment.ts" ]; then
    cat > "$dir/src/fragment.ts" <<'TS'
import { newRegistry } from "@statewalker/shared-registry";

export default function init(_ctx: Record<string, unknown>): () => Promise<void> {
  const [_register, cleanup] = newRegistry();
  return cleanup;
}
TS
  fi
  if [ ! -f "$dir/src/styles.css" ]; then
    cat > "$dir/src/styles.css" <<'CSS'
@source "./**/*.{ts,tsx}";
CSS
  fi
}

mk_logic_pkg ai-agent-runtime  "AI agent-runtime fragment: AgentRuntimeAdapter, agent:tools slot, agent intents."
mk_logic_pkg ai-providers      "AI providers fragment: provider config storage, ActiveModel adapter, provider:* intents."
mk_react_pkg ai-providers-react "AI providers renderer fragment: provider config dialog, model picker UI."

echo "Scaffold complete."
