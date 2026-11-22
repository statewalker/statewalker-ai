// A browser deployment's configuration (statewalker/statewalker-root#132): everything a page loads
// can be read by whoever holds the page, so the configuration it is built with holds no key of
// the deployment's. The conformance suite proves the deployment ignores such keys when given them
// anyway (ai-conformance tests/browser.test.ts); this proves they are never given.
import { describe, expect, it } from "vitest";
import { browserDeploymentConfig, browserDeploymentVars } from "../src/browser.js";

describe("a browser deployment's configuration", () => {
  const server = {
    MODELS: "{}",
    SECRETS_KEY: "server-secrets-key",
    DEPLOYMENT_SECRETS: JSON.stringify({
      OPENAI_KEY: { plugins: ["model-gateway"], hosts: ["x"] },
    }),
    OPENAI_KEY: "sk-deployment",
  };

  it("keeps SECRETS_KEY, DEPLOYMENT_SECRETS and the values it names off a browser page", () => {
    const vars = browserDeploymentVars(server);
    expect(vars).toEqual({ MODELS: "{}", HOSTING: "browser" });
    expect(JSON.stringify(vars)).not.toMatch(/server-secrets-key|sk-deployment/);
  });

  it("applies to a whole Worker configuration, its own vars and the run's", () => {
    const config = browserDeploymentConfig(
      { name: "ai-host-do", vars: { WORKSPACES: "default", SECRETS_KEY: "in-wrangler" } },
      server,
    );
    expect(config).toEqual({
      name: "ai-host-do",
      vars: { WORKSPACES: "default", MODELS: "{}", HOSTING: "browser" },
    });
  });

  it("drops DEPLOYMENT_SECRETS even when it cannot be read", () => {
    expect(browserDeploymentVars({ DEPLOYMENT_SECRETS: "{not json" })).toEqual({
      HOSTING: "browser",
    });
  });
});
