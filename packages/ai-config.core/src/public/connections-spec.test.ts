import { validateSpec } from "@json-render/core";
import { describe, expect, it } from "vitest";
import { CONNECTIONS_ACTIONS, CONNECTIONS_COMPONENTS } from "./connections-catalog.js";
import { makeConnectionsInitialState, makeConnectionsSpec } from "./connections-spec.js";

interface SpecElement {
  type: string;
  on?: Record<string, Array<{ action: string }>>;
}
interface SpecShape {
  root: string;
  elements: Record<string, SpecElement>;
}

describe("makeConnectionsSpec", () => {
  const rawSpec = makeConnectionsSpec();
  const spec = rawSpec as unknown as SpecShape;

  it("passes json-render structural validation", () => {
    const result = validateSpec(rawSpec, { checkOrphans: true });
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("references only component types in the catalog vocabulary", () => {
    const allowed = new Set<string>(CONNECTIONS_COMPONENTS);
    const used = new Set(Object.values(spec.elements).map((e) => e.type));
    const unknown = [...used].filter((t) => !allowed.has(t));
    expect(unknown).toEqual([]);
  });

  it("dispatches only actions defined for the connections panel", () => {
    const allowed = new Set<string>(CONNECTIONS_ACTIONS);
    const used = new Set<string>();
    for (const el of Object.values(spec.elements)) {
      for (const handlers of Object.values(el.on ?? {})) {
        for (const h of handlers) used.add(h.action);
      }
    }
    const unknown = [...used].filter((a) => !allowed.has(a));
    expect(unknown).toEqual([]);
    // Sanity: the spec actually wires the lifecycle verbs (not a no-op set).
    expect(used.has("addConnection")).toBe(true);
    expect(used.has("connectConnection")).toBe(true);
    expect(used.has("removeConnection")).toBe(true);
  });
});

describe("makeConnectionsInitialState", () => {
  const state = makeConnectionsInitialState() as {
    persistent: { hasConnections: boolean; tabs: unknown[]; active: unknown };
    ui: { activeConnectionId: string; form: Record<string, unknown> };
  };

  it("seeds an empty, key-free persistent projection", () => {
    expect(state.persistent.hasConnections).toBe(false);
    expect(state.persistent.tabs).toEqual([]);
    expect(state.persistent.active).toBeNull();
    // The API key must never live under /persistent — it is /ui-only.
    expect(JSON.stringify(state.persistent)).not.toMatch(/apiKey/);
  });

  it("keeps the transient API key under /ui/form only", () => {
    expect(state.ui.form.apiKey).toBe("");
    expect(state.ui.form.settingsOpen).toBe(true);
    expect(state.ui.form.error).toBeNull();
  });
});
