// The tracer (statewalker/statewalker-root#121): a user with an access token opens their user
// session, starts an agent session in a project they belong to, and one Flue turn reads a file of
// that project through the gated file view. Run against the harness's own deployment
// (ai-host-do) on CellB Node in-process, with the scripted model.
import { Biscuit, generateKeypair } from "@statewalker/webrun-biscuit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Deployment,
  type FakeModel,
  fakeModel,
  login,
  restClient,
  type SessionClient,
  seed,
  startDeployment,
} from "../src/index.js";

const HOST = new URL("../../ai-host-do/", import.meta.url);
const ADMIN_KEY = "conformance-admin-key";

const FILES = {
  "/alpha/readme.md": "# alpha\nThe tracer reads this.\n",
  "/alpha/.system/access": JSON.stringify({ ann: "reader" }),
  "/beta/notes.md": "beta only\n",
  "/beta/.system/access": JSON.stringify({ bob: "owner" }),
};

type Connect = (deployment: Deployment, token: string) => Promise<SessionClient>;
const transports: [string, Connect][] = [["REST", async (d, token) => restClient(d, token)]];

let model: FakeModel;
let deployment: Deployment;

beforeAll(async () => {
  model = await fakeModel();
  deployment = await startDeployment(HOST, {
    LLM_BASE_URL: model.url,
    DEV_LOGIN: "true",
    ADMIN_KEY,
  });
  await seed(deployment, ADMIN_KEY, FILES);
}, 120_000);
afterAll(async () => {
  await deployment?.close();
  await model?.close();
});

describe.each(transports)("tracer over %s", (_name, connect) => {
  const as = async (user: string) => connect(deployment, await login(deployment, user));

  it("opens the user session with an access token, and a second token resumes the same one", async () => {
    const first = await (await as("ann")).me();
    expect(first).toMatchObject({ user: "ann", workspace: expect.any(String) });
    const second = await (await as("ann")).me();
    expect(second.id).toBe(first.id);
    const other = await (await as("bob")).me();
    expect(other.id).not.toBe(first.id);
  });

  it("refuses a request whose access token the issuer did not sign", async () => {
    const forged = Biscuit.build(
      generateKeypair().secretKey,
      'user("ann");\nworkspace("default");\nissuer("default");\nexpires(9999999999999);',
    ).toBase64();
    await expect((await connect(deployment, forged)).me()).rejects.toMatchObject({ status: 401 });
    await expect((await connect(deployment, "")).me()).rejects.toMatchObject({ status: 401 });
  });

  it("refuses an expired access token", async () => {
    const expired = await login(deployment, "ann", { ttlMs: -1000 });
    await expect((await connect(deployment, expired)).me()).rejects.toMatchObject({ status: 401 });
  });
});
