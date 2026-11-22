// The secret store (statewalker/statewalker-root#133): workspace, project and user secrets are
// rows of the Workspace DO's SQLite, each value sealed under a key derived from the deployment's
// SECRETS_KEY. The session API never shows a value, so what the table holds is checked here.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SecretStore, type SqlLike } from "../src/index.js";

const sqlite = (): SqlLike & { db: DatabaseSync } => {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...(bindings as never[]));
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
};
const binding = { plugins: ["github"], hosts: ["api.github.com"] };

describe("secret store", () => {
  it("keeps values sealed under SECRETS_KEY, never in the clear", async () => {
    const sql = sqlite();
    const store = new SecretStore({ sql, secretsKey: "deployment-key", workspace: "default" });
    await store.set("user", "ann", "GITHUB_TOKEN", "ghp_plaintext_value", binding);
    const dump = JSON.stringify(sql.db.prepare("SELECT * FROM secrets").all());
    expect(dump).toContain("GITHUB_TOKEN");
    expect(dump).not.toContain("ghp_plaintext_value");
    expect(await store.open("user", "ann", "GITHUB_TOKEN")).toMatchObject({
      value: "ghp_plaintext_value",
    });
    // Another deployment key, or another workspace's derived key, cannot open it.
    const wrongKey = new SecretStore({ sql, secretsKey: "another-key", workspace: "default" });
    await expect(wrongKey.open("user", "ann", "GITHUB_TOKEN")).rejects.toThrow(/EIO/);
    const otherWs = new SecretStore({ sql, secretsKey: "deployment-key", workspace: "other" });
    await expect(otherWs.open("user", "ann", "GITHUB_TOKEN")).rejects.toThrow(/EIO/);
  });

  it("a sealed value moved to another row does not open", async () => {
    const sql = sqlite();
    const store = new SecretStore({ sql, secretsKey: "deployment-key", workspace: "default" });
    await store.set("user", "ann", "TOKEN", "ann-value", binding);
    await store.set("user", "bob", "TOKEN", "bob-value", binding);
    sql.db.exec(
      "UPDATE secrets SET sealed = (SELECT sealed FROM secrets WHERE scope = 'ann') WHERE scope = 'bob'",
    );
    await expect(store.open("user", "bob", "TOKEN")).rejects.toThrow(/EIO/);
  });

  it("opens the values of one scope for the memory scan, and only that scope's", async () => {
    const sql = sqlite();
    const store = new SecretStore({ sql, secretsKey: "deployment-key", workspace: "default" });
    await store.set("user", "ann", "A", "ann-value-1", binding);
    await store.set("user", "ann", "B", "ann-value-2", binding);
    await store.set("user", "bob", "A", "bob-value", binding);
    expect((await store.values("user", "ann")).sort()).toEqual(["ann-value-1", "ann-value-2"]);
    expect(await store.values("project", "alpha")).toEqual([]);
    // Without SECRETS_KEY nothing is stored, so there is nothing to match.
    const none = new SecretStore({ sql: sqlite(), secretsKey: undefined, workspace: "default" });
    expect(await none.values("user", "ann")).toEqual([]);
  });

  it("keeps no secrets without SECRETS_KEY", async () => {
    const store = new SecretStore({ sql: sqlite(), secretsKey: undefined, workspace: "default" });
    await expect(store.set("user", "ann", "TOKEN", "v", binding)).rejects.toThrow(/ENOSYS/);
  });
});
