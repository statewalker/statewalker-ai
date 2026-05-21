import { validateSpec } from "@json-render/core";
import { describe, expect, it } from "vitest";
import { makeConnectionsTabSpec } from "./connections-tab-spec.js";
import { makeLocalModelsTabSpec } from "./local-models-tab-spec.js";

describe("makeConnectionsTabSpec", () => {
  const spec = makeConnectionsTabSpec();
  const result = validateSpec(spec);

  it("is structurally valid", () => {
    expect(result.valid).toBe(true);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("contains no Dialog elements (Settings dialog provides wrapping)", () => {
    const dialogs = Object.values(spec.elements).filter((el) => el.type === "Dialog");
    expect(dialogs).toHaveLength(0);
  });

  it("has a Tabs element with all four ConnectionType sub-tabs", () => {
    const tabs = spec.elements.typeTabs as unknown as {
      type: string;
      props: { tabs: { value: string }[] };
    };
    expect(tabs.type).toBe("Tabs");
    expect(tabs.props.tabs.map((t) => t.value).sort()).toEqual([
      "anthropic",
      "google",
      "openai",
      "openai-compatible",
    ]);
  });

  it("has a per-tab connections list and form for every type", () => {
    for (const t of ["google", "openai", "anthropic", "openai-compatible"]) {
      expect(spec.elements).toHaveProperty(`${t}_body`);
      expect(spec.elements).toHaveProperty(`${t}_connectionsList`);
      expect(spec.elements).toHaveProperty(`${t}_formCard`);
      expect(spec.elements).toHaveProperty(`${t}_formConnect`);
    }
  });

  it("renders different URL placeholders for required vs optional URL tabs", () => {
    const anthropicUrl = spec.elements.anthropic_formUrl as unknown as { props: { label: string } };
    const openaiUrl = spec.elements.openai_formUrl as unknown as { props: { label: string } };
    expect(anthropicUrl.props.label).toMatch(/required/i);
    expect(openaiUrl.props.label).toMatch(/optional/i);
  });

  it("wires lifecycle buttons per row (Connect / Check Connection / Disconnect)", () => {
    const connectBtn = spec.elements.google_connectionRowConnectBtn as unknown as {
      props: { label: string };
    };
    const checkBtn = spec.elements.google_connectionRowCheckBtn as unknown as {
      props: { label: string };
    };
    const disconnectBtn = spec.elements.google_connectionRowDisconnectBtn as unknown as {
      props: { label: string };
    };
    expect(connectBtn.props.label).toBe("Connect");
    expect(checkBtn.props.label).toBe("Check Connection");
    expect(disconnectBtn.props.label).toBe("Disconnect");
  });
});

describe("makeLocalModelsTabSpec", () => {
  const spec = makeLocalModelsTabSpec();
  const result = validateSpec(spec);

  it("is structurally valid", () => {
    expect(result.valid).toBe(true);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("contains no Dialog elements", () => {
    const dialogs = Object.values(spec.elements).filter((el) => el.type === "Dialog");
    expect(dialogs).toHaveLength(0);
  });
});
