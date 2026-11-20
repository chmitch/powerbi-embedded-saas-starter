import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const schema = z.object({
  DirectoryTenantId: z.string().default(""),
  WebClientId: z.string().default(""),
  WebClientSecretName: z.string().default("web-client-secret"),
  SessionSecretName: z.string().default("session-encryption-key"),
  KeyVaultUri: z.string().default(""),
  LocalSecretsPath: z.string().default(""),
  BootstrapObjectId: z.string().default(""),
  SubscriptionId: z.string().default(""),
  ResourceGroup: z.string().default(""),
  ResourceNamePrefix: z.string().max(21).regex(/^$|^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).default(""),
  AzureLocation: z.string().default("westus3"),
  SqlServer: z.string().default(""),
  SqlDatabase: z.string().default(""),
  ManagementWorkspaceId: z.union([z.literal(""), z.uuid()]).default(""),
  ManagementCapacityId: z.union([z.literal(""), z.uuid()]).default(""),
  ManagementCapacityResourceId: z.string().default(""),
  AutoResumeCapacities: z.preprocess(value => typeof value === "string" && /^(true|false)$/i.test(value)
    ? value.toLowerCase() === "true" : value, z.boolean()).default(false),
  RuntimeManagedIdentityClientId: z.string().default(""),
  ProvisioningManagedIdentityClientId: z.string().default(""),
  PublicOrigin: z.string().default("http://localhost:3000"),
  ServicePrincipalGroupId: z.string().default(""),
  Port: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type AppConfig = z.infer<typeof schema>;
export const configPath = process.env.PBIEMBEDDED_CONFIG ??
  path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), ".config"), "PBIEmbeddedAOD", "configuration.json");
const external = existsSync(configPath)
  ? (JSON.parse(readFileSync(configPath, "utf8")) as { App?: Record<string, unknown> }).App ?? {}
  : {};
const values = { ...external };
for (const key of Object.keys(schema.shape)) {
  if (process.env[`App__${key}`] !== undefined) values[key] = process.env[`App__${key}`];
}
export const config = schema.parse(values);
if (process.env.PORT) config.Port = z.coerce.number().int().parse(process.env.PORT);
export const isProduction = process.env.NODE_ENV === "production";
export const configured = (c: AppConfig) =>
  ["DirectoryTenantId", "WebClientId", "BootstrapObjectId", "SqlServer", "SqlDatabase"]
    .every(key => Boolean(c[key as keyof AppConfig])) &&
  Boolean(c.KeyVaultUri || (!isProduction && c.LocalSecretsPath));
export const powerBiScopes = ["Workspace.ReadWrite.All", "Report.ReadWrite.All", "Dataset.ReadWrite.All", "Capacity.ReadWrite.All"]
  .map(scope => `https://analysis.windows.net/powerbi/api/${scope}`);
