import sql from "mssql";
import type { TokenCredential } from "@azure/identity";
import { ClientSecretCredential } from "@azure/identity";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Database, Executor, Params } from "./db.js";
import type { Tenant } from "./domain.js";
import { sameId } from "./domain.js";
import { AppError, requireCondition } from "./errors.js";
import { remoteJson, type AzureServices } from "./azure.js";
import type { Repository } from "./repository.js";
import type { FabricService } from "./fabric.js";

export const analyticsViews = {
  Tenants: "SELECT CONVERT(uniqueidentifier,Id) AS TenantId,Name FROM app.Tenants",
  Users: `SELECT CONVERT(uniqueidentifier,TenantId) AS TenantId,CONVERT(uniqueidentifier,Id) AS UserId,
    DisplayName,IsTenantAdmin FROM app.Users WHERE TenantId IS NOT NULL`,
  Reports: `SELECT CONVERT(uniqueidentifier,TenantId) AS TenantId,CONVERT(uniqueidentifier,Id) AS ReportId,
    Name,Published,Deleted FROM app.Content WHERE Kind='Report'`,
  Requests: `SELECT CONVERT(uniqueidentifier,TenantId) AS TenantId,CONVERT(uniqueidentifier,Id) AS RequestId,
    CONVERT(uniqueidentifier,UserId) AS UserId,CONVERT(uniqueidentifier,ContentId) AS ReportId,
    CONVERT(uniqueidentifier,RenderId) AS RenderId,ReportName,UserDisplayName,
    Mode,RequestedAt,ServerReceivedAt,Status FROM app.ReportRequests`,
  Renders: `SELECT CONVERT(uniqueidentifier,TenantId) AS TenantId,CONVERT(uniqueidentifier,Id) AS RenderId,
    CONVERT(uniqueidentifier,UserId) AS UserId,CONVERT(uniqueidentifier,ContentId) AS ReportId,
    ReportName,UserDisplayName,Mode,RequestedAt,ServerReceivedAt,DurationMs FROM app.ReportRenders`,
} as const;
const targets = ["Tenants", "Users", "Content", "Nodes", "Grants", "ReportRequests", "ReportRenders"] as const;
export const analyticsPredicate = `CREATE FUNCTION analytics.TenantPrincipalPredicate(@TenantId uniqueidentifier)
  RETURNS TABLE WITH SCHEMABINDING AS RETURN
  SELECT 1 AS permitted FROM app.AnalyticsPrincipalTenants AS p
  WHERE p.TenantId=@TenantId AND
    (CONVERT(binary(16),CONVERT(uniqueidentifier,p.ClientId))=SUSER_SID() OR
     CONVERT(binary(16),CONVERT(uniqueidentifier,p.ObjectId))=SUSER_SID())`;

export function analyticsConfigured(config: AppConfig) {
  const pins = [config.AgentWorkspaceId, config.AnalyticsReaderGroupId, config.AnalyticsReaderGroupName,
    config.AnalyticsEndpointId, config.AnalyticsSqlServer, config.AnalyticsSqlDatabase];
  if (!pins.some(Boolean)) return false;
  requireCondition(pins.every(Boolean), 409, "AnalyticsNotConfigured", "Complete the pinned analytics setup before provisioning tenants.");
  requireCondition(!sameId(config.AgentWorkspaceId, config.ManagementWorkspaceId), 409, "ProtectedManagementResource",
    "The data agent must not be hosted in the management workspace.");
  return true;
}

export async function mapAnalyticsPrincipal(db: Executor, tenant: Tenant) {
  const tenantId = z.uuid().parse(tenant.Id), clientId = z.uuid().parse(tenant.EmbeddingClientId),
    objectId = z.uuid().parse(tenant.EmbeddingObjectId);
  await db.query(`IF EXISTS(SELECT 1 FROM app.AnalyticsPrincipalTenants
      WHERE TenantId=@tenantId AND (ClientId<>@clientId OR ObjectId<>@objectId))
    THROW 51001,'Analytics identity changed; review existing grants explicitly',1;
    IF NOT EXISTS(SELECT 1 FROM app.AnalyticsPrincipalTenants WHERE TenantId=@tenantId)
      INSERT app.AnalyticsPrincipalTenants(TenantId,ClientId,ObjectId) VALUES(@tenantId,@clientId,@objectId);`,
  { tenantId, clientId, objectId });
}

export async function syncAnalyticsMappings(db: Database) {
  const tenants = await db.read<Tenant>("SELECT * FROM app.Tenants WHERE EmbeddingClientId IS NOT NULL AND EmbeddingObjectId IS NOT NULL");
  for (const tenant of tenants) await mapAnalyticsPrincipal(db, tenant);
  return tenants.length;
}

export async function analyticsConnection(config: AppConfig, credential: TokenCredential) {
  requireCondition(analyticsConfigured(config), 409, "AnalyticsNotConfigured", "Analytics is not configured.");
  requireCondition(/^[a-z0-9.-]+\.datawarehouse\.fabric\.microsoft\.com$/i.test(config.AnalyticsSqlServer) &&
    config.AnalyticsSqlServer !== config.SqlServer, 409, "AnalyticsEndpointInvalid", "Use the independently pinned SQL analytics endpoint.");
  const token = await credential.getToken("https://database.windows.net/.default");
  requireCondition(token, 503, "AnalyticsIdentityUnavailable", "Analytics SQL authentication failed.");
  const pool = new sql.ConnectionPool({
    server: config.AnalyticsSqlServer, database: config.AnalyticsSqlDatabase,
    authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
    options: { encrypt: true, trustServerCertificate: false }, requestTimeout: 45_000,
  });
  try {
    await pool.connect();
    const result = await pool.request().query("SELECT DB_NAME() AS name");
    requireCondition(result.recordset[0]?.name === config.AnalyticsSqlDatabase, 409, "AnalyticsEndpointInvalid",
      "Connected to an unexpected analytics database.");
    return pool;
  } catch (error) { await pool.close(); throw error; }
}

export async function setupAnalyticsSecurity(config: AppConfig, credential: TokenCredential) {
  const pool = await analyticsConnection(config, credential);
  const group = `[${config.AnalyticsReaderGroupName.replaceAll("]", "]]")}]`;
  try {
    for (const table of [...targets, "AnalyticsPrincipalTenants"]) {
      const result = await pool.request().input("name", `app.${table}`)
        .query("SELECT OBJECT_ID(@name,'U') AS id");
      requireCondition(result.recordset[0]?.id, 409, "AnalyticsReplicationPending",
        "Required analytics tables have not replicated. Retry the same setup after checking Fabric replication.");
    }
    await pool.request().query("IF SCHEMA_ID('analytics') IS NULL EXEC('CREATE SCHEMA analytics')");
    const fn = await pool.request().query("SELECT OBJECT_DEFINITION(OBJECT_ID('analytics.TenantPrincipalPredicate')) AS definition");
    if (fn.recordset[0]?.definition) {
      requireCondition(normalize(fn.recordset[0].definition) === normalize(analyticsPredicate), 409, "AnalyticsPolicyChanged",
        "Existing analytics predicate differs; review explicitly rather than replacing a live security boundary.");
    } else await pool.request().query(analyticsPredicate);
    const existing = await pool.request().query(`SELECT p.is_enabled AS enabled,sp.target_object_id AS targetId,
      OBJECT_NAME(sp.target_object_id) AS tableName,sp.predicate_type AS predicateType,
      sp.predicate_definition AS definition FROM sys.security_policies p
      JOIN sys.security_predicates sp ON sp.object_id=p.object_id
      WHERE p.name='TenantIsolation' AND SCHEMA_NAME(p.schema_id)='analytics'`);
    if (existing.recordset.length) {
      requireCondition(existing.recordset.length === targets.length && existing.recordset.every(row =>
        row.enabled && row.predicateType === 0 && targets.includes(row.tableName) &&
        normalize(row.definition).replace(/^\((.*)\)$/, "$1") === normalize(`[analytics].[TenantPrincipalPredicate]([${row.tableName === "Tenants" ? "Id" : "TenantId"}])`)),
      409, "AnalyticsPolicyChanged", "Existing analytics policy differs or is disabled. Review it before retrying.");
      const expected = await pool.request().query(`SELECT object_id AS id FROM sys.tables
        WHERE SCHEMA_NAME(schema_id)='app' AND name IN (${targets.map(t => `'${t}'`).join(",")})`);
      requireCondition(expected.recordset.length === targets.length && expected.recordset.every(row => existing.recordset.some(p => p.targetId === row.id)),
        409, "AnalyticsPolicyChanged", "Existing policy does not protect all required tables.");
    } else {
      await pool.request().query(`CREATE SECURITY POLICY analytics.TenantIsolation
        ${targets.map(t => `ADD FILTER PREDICATE analytics.TenantPrincipalPredicate(${t === "Tenants" ? "Id" : "TenantId"}) ON app.${t}`).join(",")}
        WITH(STATE=ON,SCHEMABINDING=ON)`);
    }
    for (const [name, definition] of Object.entries(analyticsViews)) {
      await pool.request().query(`CREATE OR ALTER VIEW analytics.${name} AS ${definition}`);
      await pool.request().query(`GRANT SELECT ON OBJECT::analytics.${name} TO ${group}`);
    }
    for (const table of ["Sessions", "Settings", "ProvisioningOperations", "Audit", "AnalyticsPrincipalTenants"]) {
      await pool.request().query(`DENY SELECT ON OBJECT::app.${table} TO ${group}`);
    }
  } finally { await pool.close(); }
}

const normalize = (text: string) => text.replaceAll(/\s+/g, "").replaceAll("[", "").replaceAll("]", "").toLowerCase();

export function isAnalyticsSelectDenied(error: unknown) {
  const sqlError = error as { number?: number; message?: string };
  return sqlError?.number === 229 || (sqlError?.number === 373 &&
    /^The SELECT permission .* was denied on the object '/.test(sqlError.message ?? ""));
}

export class TenantAnalytics {
  constructor(private repo: Repository, private azure: AzureServices) {}

  async withTenant<T>(tenantId: string, work: (reader: Pick<Database, "read">) => Promise<T>) {
    requireCondition(analyticsConfigured(this.azure.config), 409, "AnalyticsNotConfigured",
      "Configure the tenant analytics endpoint and database RLS before opening Tenant Insights.");
    const tenant = await this.repo.tenant(tenantId);
    const clientId = z.uuid().parse(tenant.EmbeddingClientId), objectId = z.uuid().parse(tenant.EmbeddingObjectId);
    requireCondition(tenant.SecretName, 409, "MissingIdentity", "Tenant credentials are not configured.");
    const credential = new ClientSecretCredential(this.azure.config.DirectoryTenantId, clientId,
      await this.azure.secret(tenant.SecretName));
    const pool = await analyticsConnection(this.azure.config, credential);
    try {
      const identity = await pool.request().input("clientId", sql.UniqueIdentifier, clientId)
        .input("objectId", sql.UniqueIdentifier, objectId).query(`SELECT CASE WHEN
          SUSER_SID()=CONVERT(binary(16),@clientId) OR SUSER_SID()=CONVERT(binary(16),@objectId)
          THEN 1 ELSE 0 END AS matched,
          HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CONTROL') AS databaseControl,
          HAS_PERMS_BY_NAME('analytics','SCHEMA','ALTER') AS schemaAlter`);
      requireCondition(identity.recordset[0]?.matched === 1, 409, "AnalyticsIdentityMismatch",
        "The analytics connection did not resolve the expected tenant principal.");
      requireCondition(identity.recordset[0]?.databaseControl === 0 && identity.recordset[0]?.schemaAlter === 0,
        409, "AnalyticsPermissionsTooBroad", "Tenant principal can alter the analytics security boundary.");
      const reader = {
        read: async <R>(text: string, params: Params = {}) => {
          const request = pool.request();
          for (const [name, value] of Object.entries(params)) request.input(name, value ?? null);
          return (await request.query<R>(text)).recordset;
        },
      };
      return await work(reader);
    } finally { await pool.close(); }
  }
}

export class AnalyticsProvisioner {
  constructor(private repo: Repository, private azure: AzureServices, private fabric: FabricService) {}

  async ensure(tenantId: string, operatorToken: string) {
    const config = this.azure.config;
    if (!analyticsConfigured(config)) return;
    const tenant = await this.repo.tenant(tenantId);
    requireCondition(!sameId(tenant.WorkspaceId, config.AgentWorkspaceId), 409, "ProtectedManagementResource",
      "The data agent workspace cannot be adopted as a tenant workspace.");
    z.uuid().parse(tenant.EmbeddingObjectId);
    await mapAnalyticsPrincipal(this.repo.db, tenant);
    const token = await this.azure.provisioner.getToken("https://graph.microsoft.com/.default");
    requireCondition(token, 503, "ProvisioningIdentityUnavailable", "Analytics group authentication failed.");
    const management = await this.fabric.operator<{ value: { identifier: string; principalType?: string }[] }>(
      operatorToken, `/groups/${config.ManagementWorkspaceId}/users`);
    requireCondition(!management.value.some(user => sameId(user.identifier, tenant.EmbeddingObjectId) ||
      sameId(user.identifier, tenant.EmbeddingClientId)), 409, "AnalyticsPermissionsTooBroad",
    "Tenant principal has management-workspace membership. Review and remove it explicitly before analytics setup.");
    for (const workspaceGroup of management.value.filter(user => user.principalType === "Group")) {
      let url: string | undefined = `https://graph.microsoft.com/v1.0/groups/${z.uuid().parse(workspaceGroup.identifier)}/transitiveMembers?$select=id&$top=999`;
      for (let page = 0; url && page < 100; page++) {
        requireCondition(url.startsWith("https://graph.microsoft.com/v1.0/"), 502, "AnalyticsMembershipInvalid",
          "Unexpected Graph continuation URL; credentials were not forwarded.");
        const members: { value: { id: string }[]; "@odata.nextLink"?: string } = await remoteJson(url, token.token);
        requireCondition(!members.value.some(member => sameId(member.id, tenant.EmbeddingObjectId)),
          409, "AnalyticsPermissionsTooBroad", "Tenant principal inherits management-workspace membership through a group.");
        url = members["@odata.nextLink"];
      }
      requireCondition(!url, 409, "AnalyticsMembershipInvalid", "Management group membership enumeration exceeded its limit.");
    }
    const group = `https://graph.microsoft.com/v1.0/groups/${config.AnalyticsReaderGroupId}/members`;
    let member = false;
    try { await remoteJson(`${group}/${tenant.EmbeddingObjectId}`, token.token); member = true; }
    catch (error) { if (!(error instanceof AppError) || error.code !== "Upstream404") throw error; }
    if (!member) await remoteJson(`${group}/$ref`, token.token, "POST",
      { "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${tenant.EmbeddingObjectId}` });
    const memberships = await this.fabric.operator<{ value: { identifier: string; groupUserAccessRight: string }[] }>(
      operatorToken, `/groups/${config.AgentWorkspaceId}/users`);
    const matching = memberships.value.filter(user => sameId(user.identifier, tenant.EmbeddingObjectId) ||
      sameId(user.identifier, tenant.EmbeddingClientId));
    requireCondition(matching.length <= 1 && (!matching.length || matching[0]!.groupUserAccessRight === "Contributor"),
      409, "AnalyticsPermissionsTooBroad", "Unexpected agent-workspace role; review it explicitly before retrying.");
    if (!matching.length) await this.fabric.operator(operatorToken, `/groups/${config.AgentWorkspaceId}/users`, "POST",
      { identifier: tenant.EmbeddingObjectId, groupUserAccessRight: "Contributor", principalType: "App" });
    const confirmed = await this.fabric.operator<{ value: { identifier: string; groupUserAccessRight: string }[] }>(
      operatorToken, `/groups/${config.AgentWorkspaceId}/users`);
    const roles = confirmed.value.filter(user => sameId(user.identifier, tenant.EmbeddingObjectId) ||
      sameId(user.identifier, tenant.EmbeddingClientId));
    requireCondition(roles.length === 1 && roles[0]!.groupUserAccessRight === "Contributor",
      409, "AnalyticsAccessPending", "Agent workspace access is not confirmed. Retry after permission propagation.");
    await remoteJson(`${group}/${tenant.EmbeddingObjectId}`, token.token);
  }

  async verify(tenantId: string) {
    const tenant = await this.repo.tenant(tenantId);
    requireCondition(tenant.EmbeddingClientId && tenant.SecretName, 409, "MissingIdentity", "Tenant credentials are not configured.");
    const credential = new ClientSecretCredential(this.azure.config.DirectoryTenantId, tenant.EmbeddingClientId,
      await this.azure.secret(tenant.SecretName));
    const pool = await analyticsConnection(this.azure.config, credential);
    try {
      const identity = await pool.request().query("SELECT CONVERT(varchar(130),SUSER_SID(),1) AS sid");
      const expected = await this.repo.db.query<{ clientSid: string; objectSid: string }>(`SELECT
        CONVERT(varchar(130),CONVERT(binary(16),EmbeddingClientId),1) AS clientSid,
        CONVERT(varchar(130),CONVERT(binary(16),EmbeddingObjectId),1) AS objectSid FROM app.Tenants WHERE Id=@id`, { id: tenantId });
      requireCondition(expected[0] && [expected[0].clientSid, expected[0].objectSid].some(sid =>
        sid.toLowerCase() === String(identity.recordset[0]?.sid).toLowerCase()),
      409, "AnalyticsIdentityMismatch", "Analytics endpoint did not resolve the expected tenant principal identity.");
      const privileges = await pool.request().query(`SELECT
        HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CONTROL') AS databaseControl,
        HAS_PERMS_BY_NAME('analytics','SCHEMA','ALTER') AS schemaAlter`);
      requireCondition(privileges.recordset[0]?.databaseControl === 0 && privileges.recordset[0]?.schemaAlter === 0,
        409, "AnalyticsPermissionsTooBroad", "Tenant principal can alter the analytics security boundary.");
      for (const view of Object.keys(analyticsViews)) {
        const result = await pool.request().input("tenantId", sql.UniqueIdentifier, tenantId)
          .query(`SELECT COUNT(*) AS foreignRows FROM analytics.${view} WHERE TenantId<>@tenantId OR TenantId IS NULL`);
        requireCondition(result.recordset[0]?.foreignRows === 0, 409, "AnalyticsIsolationFailed", "Foreign tenant rows were visible.");
      }
      const own = await pool.request().input("tenantId", sql.UniqueIdentifier, tenantId)
        .query("SELECT COUNT(*) AS rows FROM analytics.Tenants WHERE TenantId=@tenantId");
      requireCondition(own.recordset[0]?.rows === 1, 409, "AnalyticsReplicationPending",
        "Own tenant is not visible yet. Check item Read sharing, group/replication propagation and RLS.");
      for (const table of ["Sessions", "Settings", "ProvisioningOperations", "Audit", "AnalyticsPrincipalTenants"]) {
        let denied = false;
        try { await pool.request().query(`SELECT TOP(1) * FROM app.${table}`); }
        catch (error) { denied = isAnalyticsSelectDenied(error); }
        requireCondition(denied, 409, "AnalyticsPermissionsTooBroad", "Sensitive application table access was not explicitly denied.");
      }
      return { verified: true, viewsChecked: Object.keys(analyticsViews).length };
    } finally { await pool.close(); }
  }
}
