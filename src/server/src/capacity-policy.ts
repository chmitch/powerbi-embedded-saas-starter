import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AzureServices } from "./azure.js";
import { AppError, requireCondition } from "./errors.js";

export const capacityPolicyName = "capacity-auto-resume-policy";
const policySchema = z.object({ version: z.literal(1), enabled: z.boolean(), revision: z.uuid() }).strict();
export interface CapacityPolicyStatus {
  enabled: boolean; source: "deployment" | "platform"; revision: string | null; available: boolean; issue: string | null;
}

export class CapacityPolicy {
  private deploymentDefault: boolean;
  private state: CapacityPolicyStatus;
  private until = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private azure: AzureServices) {
    this.deploymentDefault = azure.config.AutoResumeCapacities;
    this.state = { enabled: this.deploymentDefault, source: "deployment", revision: null, available: true, issue: null };
  }
  private serial<T>(work: () => Promise<T>) {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private apply(enabled: boolean, source: CapacityPolicyStatus["source"], revision: string | null) {
    this.azure.config.AutoResumeCapacities = enabled;
    this.state = { enabled, source, revision, available: true, issue: null };
    this.until = Date.now() + 60_000;
  }
  private unavailable() {
    this.azure.config.AutoResumeCapacities = false;
    this.state = { ...this.state, enabled: false, available: false,
      issue: "Automatic resume is disabled because its saved policy cannot be verified. Check credential-store access and policy configuration, then refresh." };
    this.until = Date.now() + 60_000;
  }
  private assertStore() {
    requireCondition((this.azure.config.KeyVaultUri || this.azure.config.LocalSecretsPath) &&
      ![this.azure.config.WebClientSecretName, this.azure.config.SessionSecretName].includes(capacityPolicyName),
    503, "CapacityPolicyUnavailable", "Capacity policy requires an external credential store and a distinct policy name.");
  }
  private async read() {
    try {
      this.assertStore();
      let stored;
      try { stored = await this.azure.secrets.getSecret(capacityPolicyName); }
      catch (error) {
        const missing = error as { code?: string; statusCode?: number };
        if (missing.code === "LocalSecretMissing" || (missing.statusCode === 404 && missing.code === "SecretNotFound")) {
          this.apply(this.deploymentDefault, "deployment", null);
          return;
        }
        throw error;
      }
      requireCondition(stored.properties?.enabled !== false &&
        (!stored.properties?.expiresOn || stored.properties.expiresOn > new Date()),
      503, "CapacityPolicyUnavailable", "The saved capacity policy is disabled or expired.");
      const policy = policySchema.parse(JSON.parse(stored.value ?? ""));
      this.apply(policy.enabled, "platform", policy.revision);
    } catch { this.unavailable(); }
  }
  refresh(force = false) {
    return this.serial(async () => {
      if (force || Date.now() >= this.until) await this.read();
      return { ...this.state };
    });
  }
  set(enabled: boolean, revision: string | null) {
    return this.serial(async () => {
      await this.read();
      requireCondition(this.state.available, 503, "CapacityPolicyUnavailable", this.state.issue!);
      requireCondition(this.state.revision === revision, 409, "CapacityPolicyChanged",
        "The saved policy changed. Refresh and confirm the current setting before trying again.");
      const next = { version: 1, enabled, revision: randomUUID() };
      const value = JSON.stringify(next);
      try { await this.azure.secretWriter.setSecret(capacityPolicyName, value); }
      catch { /* Verify an indeterminate write without submitting it again. */ }
      try {
        const saved = await this.azure.secretWriter.getSecret(capacityPolicyName);
        requireCondition(saved.value === value && saved.properties?.enabled !== false &&
          (!saved.properties?.expiresOn || saved.properties.expiresOn > new Date()),
        503, "CapacityPolicyUnavailable", "The saved capacity policy could not be confirmed.");
        this.apply(enabled, "platform", next.revision);
        return { ...this.state };
      } catch {
        this.unavailable();
        throw new AppError(503, "CapacityPolicyOutcomeUnknown",
          "The policy change could not be confirmed. Automatic resume is disabled until the saved policy can be verified. Refresh before explicitly retrying.");
      }
    });
  }
}
