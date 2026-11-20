import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalSecretStore } from "../src/local-secrets.js";
import { AzureServices } from "../src/azure.js";
import { config, configured } from "../src/config.js";

it("reads external development credentials, persists tenant credentials, and handles missing/expired values", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pbi-local-secret-test-"));
  const file = path.join(directory, "secrets.json");
  try {
    writeFileSync(file, JSON.stringify({ version: 1, secrets: {
      "web-client": { value: "unit-test-only-not-a-real-credential" },
      expired: { value: "unit-test-expired", expiresOn: "2000-01-01T00:00:00Z" },
    } }), { mode: 0o600 });
    const store = new LocalSecretStore(file, false);
    assert.equal((await store.getSecret("web-client")).value, "unit-test-only-not-a-real-credential");
    await assert.rejects(store.getSecret("missing"), (error: unknown) =>
      (error as { statusCode?: number }).statusCode === 404);
    await assert.rejects(store.getSecret("expired"), /expired/);
    await store.setSecret("tenant-credential", "unit-test-tenant-value", { expiresOn: new Date("2099-01-01T00:00:00Z") });
    assert.equal((await new LocalSecretStore(file, false).getSecret("tenant-credential")).value, "unit-test-tenant-value");
    assert.equal((await store.getSecret("web-client")).value, "unit-test-only-not-a-real-credential");
    assert.deepEqual(readdirSync(directory), ["secrets.json"]);
    assert.ok(readFileSync(file, "utf8").includes("2099-01-01T00:00:00.000Z"));
    const localConfig = { ...config, LocalSecretsPath: file, KeyVaultUri: "", DirectoryTenantId: "directory",
      WebClientId: "client", BootstrapObjectId: "operator", SqlServer: "server", SqlDatabase: "database" };
    assert.equal(configured(localConfig), true);
    assert.equal(await new AzureServices(localConfig).secret("web-client"), "unit-test-only-not-a-real-credential");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("rejects production/repository paths and suppresses malformed secret contents", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pbi-local-secret-test-"));
  const file = path.join(directory, "secrets.json");
  try {
    assert.throws(() => new LocalSecretStore(file, true), /not allowed in production/);
    assert.throws(() => new LocalSecretStore(path.resolve("secrets.json"), false), /outside the repository/);
    assert.throws(() => new LocalSecretStore("relative-secrets.json", false), /outside the repository/);
    const link = path.join(directory, "checkout-link");
    symlinkSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."), link,
      process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => new LocalSecretStore(path.join(link, "secrets.json"), false), /outside the repository/);
    writeFileSync(file, "unit-test-sensitive-malformed-content", { mode: 0o600 });
    await assert.rejects(new LocalSecretStore(file, false).getSecret("web-client"), (error: unknown) => {
      assert.doesNotMatch(String(error), /unit-test-sensitive-malformed-content/);
      return /invalid/.test(String(error));
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
