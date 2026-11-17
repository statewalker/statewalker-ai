// The conformance runner itself: a deployment on CellB Node, in-process, with the scripted model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Deployment, type FakeModel, fakeModel, startDeployment } from "../src/index.js";

const SMOKE_HOST = new URL("../fixtures/smoke-host/", import.meta.url);

describe("conformance runner", () => {
  let model: FakeModel;
  let deployment: Deployment;

  beforeAll(async () => {
    model = await fakeModel();
    deployment = await startDeployment(SMOKE_HOST, { LLM_BASE_URL: model.url });
  }, 60_000);
  afterAll(async () => {
    await deployment?.close();
    await model?.close();
  });

  it("starts a deployment on CellB Node and calls it over HTTP", async () => {
    const res = await deployment.fetch("/v1/runtime");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ harness: "statewalker-ai" });
  });

  it("gives the deployment the scripted model, which answers as the script says", async () => {
    const res = await deployment.fetch("/v1/runtime/model", { method: "POST", body: "ping" });
    expect(await res.json()).toEqual({ text: "OK" });
    expect(model.requests.at(-1)?.lastUserText).toBe("ping");
  });
});
