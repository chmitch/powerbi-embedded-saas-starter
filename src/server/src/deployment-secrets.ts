import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { AzureServices, remoteJson } from "./azure.js";
import type { AppConfig } from "./config.js";

type BootstrapServices = Pick<AzureServices, "secretWriter" | "provisioner"> & { wait?: () => Promise<void> };
const missing = (error: unknown) => (error as { code?: string } | null)?.code === "SecretNotFound";

export async function initializeDeploymentSecrets(c: AppConfig, applicationObjectId: string, services?: BootstrapServices) {
  try {
    z.uuid().parse(applicationObjectId);
    z.uuid().parse(c.WebClientId);
    z.uuid().parse(c.RuntimeManagedIdentityClientId);
    z.uuid().parse(c.ProvisioningManagedIdentityClientId);
    if (c.LocalSecretsPath || !/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/?$/i.test(c.KeyVaultUri) ||
      c.RuntimeManagedIdentityClientId === c.ProvisioningManagedIdentityClientId ||
      !c.WebClientSecretName || !c.SessionSecretName || c.WebClientSecretName === c.SessionSecretName) {
      throw new Error("Invalid deployment secret configuration.");
    }
    const azure: BootstrapServices = services ?? new AzureServices(c);
    async function read<T>(operation: () => Promise<T>): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        try { return await operation(); } catch (error) {
          const failure = error as { statusCode?: number; code?: string };
          const status = failure?.statusCode ?? Number(failure?.code?.match(/^Upstream(\d+)$/)?.[1]);
          if (attempt === 17 || !([401, 403, 429].includes(status) || status >= 500)) throw error;
          await (azure.wait?.() ?? setTimeout(5_000));
        }
      }
    }
    async function graph(path: string, method = "GET", body?: unknown): Promise<unknown> {
      const token = await azure.provisioner.getToken("https://graph.microsoft.com/.default");
      if (!token) throw new Error("Provisioning identity could not authenticate.");
      return remoteJson(`https://graph.microsoft.com/v1.0/applications/${applicationObjectId}${path}`, token.token, method, body);
    }
    async function exists(name: string) {
      try {
        const secret = await read(() => azure.secretWriter.getSecret(name));
        if (!secret.value || secret.properties?.enabled === false ||
          (secret.properties?.expiresOn && secret.properties.expiresOn.getTime() <= Date.now())) {
          throw new Error("An existing credential needs explicit operator recovery or rotation.");
        }
        return true;
      } catch (error) {
        if (missing(error)) return false;
        throw error;
      }
    }
    const hasWebSecret = await exists(c.WebClientSecretName);
    const hasSessionSecret = await exists(c.SessionSecretName);
    if (!hasWebSecret) {
      const application = z.object({ id: z.uuid(), appId: z.uuid() }).parse(
        await read(() => graph("?$select=id,appId")));
      if (application.id.toLowerCase() !== applicationObjectId.toLowerCase() ||
        application.appId.toLowerCase() !== c.WebClientId.toLowerCase()) {
        throw new Error("Deployment sign-in application does not match.");
      }
      const expiresOn = new Date();
      expiresOn.setUTCMonth(expiresOn.getUTCMonth() + 6);
      const password = z.object({ keyId: z.uuid(), secretText: z.string().min(1) }).parse(
        await graph("/addPassword", "POST", {
          passwordCredential: { displayName: "Key Vault portal credential", endDateTime: expiresOn.toISOString() },
        }));
      try {
        await azure.secretWriter.setSecret(c.WebClientSecretName, password.secretText, { expiresOn });
      } catch {
        let persisted = false;
        try {
          const stored = await read(() => azure.secretWriter.getSecret(c.WebClientSecretName));
          persisted = stored.value === password.secretText;
          if (!persisted) await graph("/removePassword", "POST", { keyId: password.keyId });
        } catch (error) {
          if (missing(error)) await graph("/removePassword", "POST", { keyId: password.keyId });
          throw new Error("Credential storage could not be verified.");
        }
        // A timed-out write may have committed; never revoke a verified stored credential.
        if (!persisted) throw new Error("Credential storage failed.");
      }
    }
    if (!hasSessionSecret) {
      await azure.secretWriter.setSecret(c.SessionSecretName, randomBytes(32).toString("base64"));
    }
  } catch {
    throw new Error("Azure credential initialization failed. Check provisioning identity ownership/Graph grants, Key Vault NSP/RBAC, and existing credential health. No secret values were returned.");
  }
}
