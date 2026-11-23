import { randomUUID } from "node:crypto";
import { it } from "node:test";
import assert from "node:assert/strict";
import type { AzureServices } from "../src/azure.js";
import { CapacityPolicy, capacityPolicyName } from "../src/capacity-policy.js";
import { config } from "../src/config.js";

function fixture(deploymentDefault = false) {
  const values = new Map<string, string>([["web-client-secret", "test-only-existing-credential"]]);
  let fault: "none" | "denied" | "before-write" | "after-write" = "none";
  let writes = 0;
  const read = async (name: string) => {
    if (fault === "denied") throw Object.assign(new Error("Private diagnostic"), { statusCode: 403 });
    if (!values.has(name)) throw Object.assign(new Error("Missing"), { statusCode: 404, code: "SecretNotFound" });
    return { value: values.get(name) };
  };
  const azure = { config: { ...config, AutoResumeCapacities: deploymentDefault, KeyVaultUri: "https://fixture.vault.azure.net", LocalSecretsPath: "" },
    secrets: { getSecret: read },
    secretWriter: { getSecret: read, setSecret: async (name: string, value: string) => {
      writes++;
      if (fault === "before-write") throw new Error("Private diagnostic");
      values.set(name, value);
      if (fault === "after-write") throw new Error("Private diagnostic");
      return {};
    } },
  } as unknown as AzureServices;
  return { azure, values, policy: new CapacityPolicy(azure), setFault(value: typeof fault) { fault = value; }, writes: () => writes };
}

it("persists enable and disable outside SQL and applies saved policy over deployment defaults after restart", async () => {
  const f = fixture();
  const initial = await f.policy.refresh(true);
  assert.equal(initial.enabled, false);
  assert.equal(initial.source, "deployment");
  const enabled = await f.policy.set(true, initial.revision);
  assert.equal(f.azure.config.AutoResumeCapacities, true);
  assert.equal((await new CapacityPolicy({ ...f.azure, config: { ...f.azure.config, AutoResumeCapacities: false } } as AzureServices).refresh(true)).enabled, true);
  const disabled = await f.policy.set(false, enabled.revision);
  assert.equal(disabled.enabled, false);
  const restarted = new CapacityPolicy({ ...f.azure, config: { ...f.azure.config, AutoResumeCapacities: true } } as AzureServices);
  assert.equal((await restarted.refresh(true)).enabled, false);
  assert.equal(f.values.get("web-client-secret"), "test-only-existing-credential");
});

it("fails closed on denied, malformed or disabled policy records without silently using an enabled deployment default", async () => {
  const f = fixture(true);
  f.setFault("denied");
  assert.equal((await f.policy.refresh(true)).available, false);
  assert.equal(f.azure.config.AutoResumeCapacities, false);
  await assert.rejects(f.policy.set(true, null), { code: "CapacityPolicyUnavailable" });
  assert.equal(f.writes(), 0);
  f.setFault("none");
  for (const value of ["Private diagnostic", JSON.stringify({ version: 1, enabled: "true", revision: randomUUID() })]) {
    f.values.set(capacityPolicyName, value);
    const state = await f.policy.refresh(true);
    assert.equal(state.enabled, false);
    assert.ok(!state.issue!.includes("Private diagnostic"));
  }
  f.values.set(capacityPolicyName, JSON.stringify({ version: 1, enabled: true, revision: randomUUID() }));
  f.azure.secrets.getSecret = async () => ({ value: f.values.get(capacityPolicyName), properties: { enabled: false } });
  assert.equal((await f.policy.refresh(true)).available, false);
});

it("rejects stale confirmations and verifies uncertain writes without replaying them", async () => {
  const f = fixture();
  const enabled = await f.policy.set(true, null);
  await assert.rejects(f.policy.set(false, null), { code: "CapacityPolicyChanged" });
  assert.equal(f.writes(), 1);
  f.setFault("after-write");
  const disabled = await f.policy.set(false, enabled.revision);
  assert.equal(disabled.enabled, false);
  assert.equal(f.writes(), 2);
  f.setFault("before-write");
  await assert.rejects(f.policy.set(true, disabled.revision), { code: "CapacityPolicyOutcomeUnknown" });
  assert.equal(f.writes(), 3);
  assert.equal(f.azure.config.AutoResumeCapacities, false);
  f.setFault("none");
  assert.equal((await f.policy.refresh(true)).enabled, false);
});

it("serializes policy writes and refreshes so an older read cannot restore a disabled setting", async () => {
  const f = fixture();
  const enabled = await f.policy.set(true, null);
  const [disabled, refreshed] = await Promise.all([f.policy.set(false, enabled.revision), f.policy.refresh(true)]);
  assert.equal(disabled.enabled, false);
  assert.equal(refreshed.enabled, false);
  assert.equal(f.azure.config.AutoResumeCapacities, false);
});
