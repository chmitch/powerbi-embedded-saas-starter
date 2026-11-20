import { AzureCliCredential, ManagedIdentityCredential, type TokenCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { isProduction, type AppConfig } from "./config.js";
import { AppError, requireCondition } from "./errors.js";
import { assertNotManagementResource } from "./domain.js";
import { LocalSecretStore } from "./local-secrets.js";
import { z } from "zod";

export const userPrincipalNameSchema = z.string().trim().max(320).regex(/^[^@\s/\\]+@[^@\s/\\]+$/);

interface SecretStore {
  getSecret(name: string): Promise<{ value?: string; properties?: { enabled?: boolean; expiresOn?: Date } }>;
  setSecret(name: string, value: string, options?: { expiresOn?: Date }): Promise<{ value?: string }>;
}

export class AzureServices {
  readonly runtime: TokenCredential;
  readonly provisioner: TokenCredential;
  readonly secrets: SecretStore;
  readonly secretWriter: SecretStore;
  private cache = new Map<string, { value: string; until: number }>();
  constructor(readonly config: AppConfig) {
    this.runtime = config.RuntimeManagedIdentityClientId
      ? new ManagedIdentityCredential({ clientId: config.RuntimeManagedIdentityClientId })
      : new AzureCliCredential({ tenantId: config.DirectoryTenantId || undefined });
    this.provisioner = config.ProvisioningManagedIdentityClientId
      ? new ManagedIdentityCredential({ clientId: config.ProvisioningManagedIdentityClientId })
      : this.runtime;
    this.secrets = config.LocalSecretsPath
      ? new LocalSecretStore(config.LocalSecretsPath, isProduction)
      : new SecretClient(config.KeyVaultUri || "https://unconfigured.vault.azure.net", this.runtime);
    this.secretWriter = config.LocalSecretsPath ? this.secrets
      : new SecretClient(config.KeyVaultUri || "https://unconfigured.vault.azure.net", this.provisioner);
  }
  async secret(name: string): Promise<string> {
    const cached = this.cache.get(name);
    if (cached && cached.until > Date.now()) return cached.value;
    try {
      const result = await this.secrets.getSecret(name);
      if (!result.value) throw new Error("Empty secret");
      this.cache.set(name, { value: result.value, until: Date.now() + 60_000 });
      return result.value;
    } catch {
      throw new AppError(503, this.config.LocalSecretsPath ? "LocalSecretsUnavailable" : "KeyVaultUnavailable",
        this.config.LocalSecretsPath ? "A required local credential could not be read. Check the external secret file and credential expiry."
          : "The runtime identity cannot read a required Key Vault secret. Check identity, secret name, and RBAC.");
    }
  }
  async resolveUserPrincipalName(input: string) {
    const upn = userPrincipalNameSchema.parse(input);
    const key = encodeURIComponent(upn.replaceAll("'", "''")).replaceAll("'", "%27");
    let response: unknown;
    try {
      const token = await this.provisioner.getToken("https://graph.microsoft.com/.default");
      if (!token) throw new Error("Missing Graph token");
      response = await remoteJson<unknown>(
        `https://graph.microsoft.com/v1.0/users('${key}')?$select=id,displayName,userPrincipalName`, token.token);
    } catch (error) {
      if (error instanceof AppError) {
        if (error.code === "Upstream404") throw new AppError(404, "DirectoryUserNotFound",
          "No Entra user with that exact user principal name was found in the configured directory.");
        if (error.code === "Upstream401" || error.code === "Upstream403") throw new AppError(503, "DirectoryLookupForbidden",
          "The provisioning identity cannot read Entra users. Check Microsoft Graph user-read permissions and consent, or assign by object ID instead.");
        if (error.status === 429) throw error;
      }
      throw new AppError(503, "DirectoryLookupUnavailable",
        "Entra user lookup is unavailable. Check the provisioning identity's Azure sign-in and Microsoft Graph access, or assign by object ID instead.");
    }
    const result = z.object({
      id: z.uuid(), displayName: z.string().nullish(), userPrincipalName: userPrincipalNameSchema,
    }).safeParse(response);
    if (!result.success || result.data.userPrincipalName.toLowerCase() !== upn.toLowerCase())
      throw new AppError(502, "DirectoryLookupInvalid", "Entra did not return a verifiable exact user principal name match. No user was registered or assigned.");
    return { objectId: result.data.id, displayName: (result.data.displayName?.trim() || result.data.userPrincipalName).slice(0, 200) };
  }
  async userPrincipalNameForObjectId(objectId: string) {
    z.uuid().parse(objectId);
    const token = await this.provisioner.getToken("https://graph.microsoft.com/.default");
    requireCondition(token, 503, "DirectoryLookupUnavailable", "The provisioning identity cannot authenticate to Microsoft Graph.");
    const user = await remoteJson<{ id: string; userPrincipalName: string }>(
      `https://graph.microsoft.com/v1.0/users/${objectId}?$select=id,userPrincipalName`, token.token);
    requireCondition(user.id?.toLowerCase() === objectId.toLowerCase(), 502, "DirectoryLookupInvalid", "Directory identity verification failed.");
    return userPrincipalNameSchema.parse(user.userPrincipalName);
  }
  async capacity<T = Record<string, unknown>>(suffix = "", method = "GET", body?: unknown): Promise<T> {
    if (method !== "GET") assertNotManagementResource(suffix.split("/")[1], this.config.ManagementCapacityResourceId.split("/").at(-1));
    requireCondition(this.config.SubscriptionId && this.config.ResourceGroup, 409, "AzureNotConfigured", "Configure the subscription and resource group first.");
    const token = await this.provisioner.getToken("https://management.azure.com/.default");
    requireCondition(token, 503, "AzureIdentityUnavailable", "The provisioning identity cannot authenticate to Azure Resource Manager.");
    const base = `https://management.azure.com/subscriptions/${encodeURIComponent(this.config.SubscriptionId)}/resourceGroups/${encodeURIComponent(this.config.ResourceGroup)}/providers/Microsoft.Fabric/capacities`;
    return remoteJson<T>(`${base}${suffix}${suffix.includes("?") ? "&" : "?"}api-version=2023-11-01`, token.token, method, body);
  }
  async capacityResource<T = Record<string, unknown>>(resourceId: string, method: "GET" | "POST" = "GET"): Promise<T> {
    requireCondition(/^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/?#]+\/providers\/Microsoft\.Fabric\/capacities\/[a-z][a-z0-9]{2,62}$/i.test(resourceId),
      409, "CapacityMappingInvalid", "The Fabric capacity resource reference is invalid.");
    const token = await this.provisioner.getToken("https://management.azure.com/.default");
    requireCondition(token, 503, "AzureIdentityUnavailable", "The capacity identity could not authenticate to Azure.");
    return remoteJson<T>(`https://management.azure.com${resourceId}${method === "POST" ? "/resume" : ""}?api-version=2023-11-01`,
      token.token, method);
  }
}

export async function remoteJson<T>(
  url: string, accessToken: string, method = "GET", body?: unknown, timeoutMs = 45_000,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new AppError(503, "UpstreamUnavailable", "A required Azure or Fabric service could not be reached. Retry the operation.");
  }
  if (!response.ok) {
    throw new AppError(response.status === 429 ? 429 : 502, `Upstream${response.status}`,
      `The upstream service returned HTTP ${response.status}. Check the caller's permissions, tenant settings, resource state, and configuration.`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) as T : {} as T;
}
