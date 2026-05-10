import { defineSlot } from "@statewalker/shared-slots";
import type { ProviderDescriptor } from "./types.js";

/**
 * `providers:remote` — `ProviderDescriptor` contributions. The
 * providers fragment contributes built-ins (OpenAI / Anthropic /
 * Google) and one descriptor per custom OpenAI-compatible endpoint
 * loaded from `providers.json`. Plug-in fragments contribute
 * additional descriptors here to expose new providers without
 * editing chat-mini core.
 *
 * Consumers (the agent-runtime resolver, the model picker, the
 * provider-config UI) read the slot via the `Slots` bus's
 * `observe` / `getSnapshot` against `remoteProvidersSlot`.
 */
export const remoteProvidersSlot = defineSlot<ProviderDescriptor>("providers:remote");
