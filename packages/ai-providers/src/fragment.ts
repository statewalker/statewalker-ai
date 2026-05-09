import { newRegistry } from "@statewalker/shared-registry";

export default function init(_ctx: Record<string, unknown>): () => Promise<void> {
  const [_register, cleanup] = newRegistry();
  return cleanup;
}
