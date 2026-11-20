import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { initializeDeploymentSecrets } from "../src/deployment-secrets.js";

const applicationId = "11111111-1111-4111-8111-111111111111";
const passwordId = "22222222-2222-4222-8222-222222222222";
const c = { ...config, LocalSecretsPath: "", KeyVaultUri: "https://test.vault.azure.net",
  WebClientId: "33333333-3333-4333-8333-333333333333",
  RuntimeManagedIdentityClientId: "44444444-4444-4444-8444-444444444444",
  ProvisioningManagedIdentityClientId: "55555555-5555-4555-8555-555555555555",
  WebClientSecretName: "web", SessionSecretName: "session" };
const secretValue = "test-only-private-credential";
const notFound = () => Object.assign(new Error("Missing test credential"), { code: "SecretNotFound", statusCode: 404 });

function fixture(context: TestContext) {
  const secrets = new Map<string, { value?: string; properties?: { enabled?: boolean; expiresOn?: Date } }>();
  const writes: string[] = [];
  const graphCalls: string[] = [];
  let fault: "none" | "before-write" | "after-write" | "forbidden" | "unknown-write" = "none";
  context.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://graph.microsoft.com");
    graphCalls.push(`${options?.method} ${url.pathname}`);
    if (url.pathname.endsWith("/addPassword")) return Response.json({ keyId: passwordId, secretText: secretValue });
    if (url.pathname.endsWith("/removePassword")) return new Response(null, { status: 204 });
    return Response.json({ id: applicationId, appId: c.WebClientId });
  });
  const services = {
    provisioner: { getToken: async () => ({ token: "test-only-token", expiresOnTimestamp: Date.now() + 60_000 }) },
    secretWriter: {
      async getSecret(name: string) {
        if (fault === "forbidden" || (fault === "unknown-write" && writes.length))
          throw Object.assign(new Error(secretValue), { statusCode: 403 });
        const value = secrets.get(name);
        if (!value) throw notFound();
        return value;
      },
      async setSecret(name: string, value: string, options?: { expiresOn?: Date }) {
        writes.push(name);
        if (fault === "before-write" || fault === "unknown-write") throw new Error(secretValue);
        secrets.set(name, { value, properties: options });
        if (fault === "after-write" && name === "web") throw new Error(secretValue);
        return {};
      },
    },
    wait: async () => {},
  };
  return { services, secrets, writes, graphCalls, setFault(value: typeof fault) { fault = value; } };
}

it("initializes missing credentials inside Azure and preserves them on subsequent startups", async context => {
  const f = fixture(context);
  await initializeDeploymentSecrets(c, applicationId, f.services);
  assert.deepEqual(f.writes, ["web", "session"]);
  assert.equal(f.secrets.get("web")?.value, secretValue);
  assert.equal(Buffer.from(f.secrets.get("session")!.value!, "base64").length, 32);
  assert.ok(f.secrets.get("web")!.properties!.expiresOn! > new Date());
  const sessionKey = f.secrets.get("session")!.value;
  await initializeDeploymentSecrets(c, applicationId, f.services);
  assert.deepEqual(f.writes, ["web", "session"]);
  assert.equal(f.secrets.get("session")!.value, sessionKey);
  assert.equal(f.graphCalls.filter(call => call.includes("/addPassword")).length, 1);
  assert.equal(f.graphCalls.length, 2);
});

it("fails closed on vault denials, invalid existing credentials, and mismatched application/configuration", async context => {
  const f = fixture(context);
  f.setFault("forbidden");
  await assert.rejects(initializeDeploymentSecrets(c, applicationId, f.services),
    (error: Error) => !error.message.includes(secretValue));
  assert.equal(f.writes.length, 0);
  assert.ok(!f.graphCalls.some(call => call.includes("/addPassword")));
  f.setFault("none");
  for (const existing of [
    { value: "" }, { value: secretValue, properties: { enabled: false } },
    { value: secretValue, properties: { expiresOn: new Date(0) } },
  ]) {
    f.secrets.set("web", existing);
    await assert.rejects(initializeDeploymentSecrets(c, applicationId, f.services));
  }
  f.secrets.clear();
  await assert.rejects(initializeDeploymentSecrets({ ...c, WebClientId: passwordId }, applicationId, f.services));
  for (const invalid of [
    { LocalSecretsPath: "C:\\private\\secrets.json" },
    { ProvisioningManagedIdentityClientId: "" },
    { ProvisioningManagedIdentityClientId: c.RuntimeManagedIdentityClientId },
    { SessionSecretName: c.WebClientSecretName },
    { KeyVaultUri: "https://untrusted.example" },
  ]) await assert.rejects(initializeDeploymentSecrets({ ...c, ...invalid }, applicationId, f.services));
  assert.equal(f.writes.length, 0);
  assert.ok(!f.graphCalls.some(call => call.includes("/addPassword")));
});

it("retries read-only propagation failures and recovers a partial initialization without rotating the web credential", async context => {
  const f = fixture(context);
  let reads = 0;
  const getSecret = f.services.secretWriter.getSecret;
  context.mock.method(f.services.secretWriter, "getSecret", async (name: string) => {
    if (++reads === 1) throw Object.assign(new Error("RBAC propagation"), { statusCode: 403 });
    return getSecret(name);
  });
  const write = f.services.secretWriter.setSecret;
  const mock = context.mock.method(f.services.secretWriter, "setSecret", async (...args: Parameters<typeof write>) => {
    if (args[0] === "session") throw new Error(secretValue);
    return write(...args);
  });
  await assert.rejects(initializeDeploymentSecrets(c, applicationId, f.services));
  assert.equal(f.secrets.get("web")?.value, secretValue);
  mock.mock.restore();
  await initializeDeploymentSecrets(c, applicationId, f.services);
  assert.equal(f.graphCalls.filter(call => call.includes("/addPassword")).length, 1);
  assert.deepEqual(f.writes, ["web", "session"]);
});

it("revokes a generated credential when storage definitively failed, but not after a committed or indeterminate write", async context => {
  const f = fixture(context);
  f.setFault("before-write");
  await assert.rejects(initializeDeploymentSecrets(c, applicationId, f.services),
    (error: Error) => !error.message.includes(secretValue));
  assert.equal(f.graphCalls.filter(call => call.includes("/removePassword")).length, 1);
  f.graphCalls.length = 0;
  f.writes.length = 0;
  f.setFault("unknown-write");
  await assert.rejects(initializeDeploymentSecrets(c, applicationId, f.services));
  assert.ok(!f.graphCalls.some(call => call.includes("/removePassword")));
  f.setFault("after-write");
  await initializeDeploymentSecrets(c, applicationId, f.services);
  assert.equal(f.secrets.get("web")?.value, secretValue);
  assert.ok(!f.graphCalls.some(call => call.includes("/removePassword")));
});
