import { randomUUID } from "node:crypto";
import { ConfidentialClientApplication } from "@azure/msal-node";
import { remoteJson, type AzureServices } from "./azure.js";
import type { Repository } from "./repository.js";
import type { ContentItem, Tenant, User } from "./domain.js";
import { assertEmbedding, assertNotManagementResource, effectivePermissions, Permission, sameId, tenantIdentityNames, tenantMembership, tokenPayload } from "./domain.js";
import { AppError, requireCondition } from "./errors.js";
import { capacityDemand, CapacityRecovery, waitForCapacityData } from "./capacity-recovery.js";
import { sampleForm, sampleName } from "./sample.js";

const pbi = "https://api.powerbi.com/v1.0/myorg";
interface Collection<T> { value: T[] }
export interface Workspace { id: string; name: string; capacityId?: string; isOnDedicatedCapacity?: boolean }
interface RemoteReport { id: string; name: string; datasetId?: string; datasetWorkspaceId?: string; embedUrl: string }
interface RemoteModel {
  id: string; name: string; isEffectiveIdentityRequired?: boolean; isEffectiveIdentityRolesRequired?: boolean;
  upstreamDatasets?: unknown[];
}
export interface Check { key: string; status: "pass" | "fail" | "unknown" | "not-tested"; message: string }
export interface SampleImport {
  id: string; importState?: string; reports?: { id: string }[]; datasets?: { id: string }[];
}

export class FabricService {
  private recovery: CapacityRecovery;
  constructor(private repo: Repository, private azure: AzureServices, recovery?: CapacityRecovery) {
    this.recovery = recovery ?? new CapacityRecovery(azure);
  }
  async cacheCapacityBinding(tenant: Tenant, workspace: Workspace, token: string) {
    if (!this.azure.config.AutoResumeCapacities) return;
    requireCondition(sameId(workspace.id, tenant.WorkspaceId), 409, "WorkspaceChanged", "The workspace does not match the tenant.");
    await this.repo.setCapacityBinding(tenant, null);
    if (!workspace.capacityId) return;
    assertNotManagementResource(workspace.capacityId, this.azure.config.ManagementCapacityId);
    const capacities = await this.operator<Collection<{ id: string; displayName: string }>>(token, "/capacities");
    const capacity = capacities.value.find(c => sameId(c.id, workspace.capacityId));
    requireCondition(capacity && /^[a-z][a-z0-9]{2,62}$/i.test(capacity.displayName) &&
      capacities.value.filter(c => c.displayName.toLowerCase() === capacity.displayName.toLowerCase()).length === 1,
    409, "CapacityMappingUnavailable", "The tenant capacity cannot be uniquely mapped to an Azure Fabric resource.");
    const resourceId = `/subscriptions/${this.azure.config.SubscriptionId}/resourceGroups/${this.azure.config.ResourceGroup}/providers/Microsoft.Fabric/capacities/${capacity.displayName}`;
    const resource = await this.azure.capacityResource<{ id: string; name: string; properties?: { fabricCapacityId?: string } }>(resourceId);
    requireCondition(sameId(resource.id, resourceId) && sameId(resource.name, capacity.displayName) &&
      (!resource.properties?.fabricCapacityId || sameId(resource.properties.fabricCapacityId, capacity.id)), 409,
    "CapacityMappingUnavailable", "The Azure and Fabric capacity references do not match.");
    await this.repo.setCapacityBinding(tenant, { capacityId: capacity.id, resourceId });
  }
  private async resumeTenant(tenant: Tenant) {
    if (!this.azure.config?.AutoResumeCapacities || !capacityDemand.getStore()) return false;
    const binding = await this.repo.capacityBinding(tenant);
    requireCondition(binding?.capacityId && binding.resourceId, 409, "CapacityMappingUnavailable",
      "Automatic startup is not configured for this tenant capacity. A platform administrator must refresh the tenant settings.");
    assertNotManagementResource(binding.capacityId, this.azure.config.ManagementCapacityId);
    assertNotManagementResource(binding.resourceId, this.azure.config.ManagementCapacityResourceId);
    const prefix = `/subscriptions/${this.azure.config.SubscriptionId}/resourceGroups/${this.azure.config.ResourceGroup}/providers/Microsoft.Fabric/capacities/`;
    requireCondition(binding.resourceId.toLowerCase().startsWith(prefix.toLowerCase()), 409, "CapacityMappingUnavailable",
      "The tenant capacity is outside the configured Azure management scope.");
    const token = await this.runtimeToken(tenant);
    const workspace = await this.operator<Workspace>(token, `/groups/${tenant.WorkspaceId}`);
    requireCondition(sameId(workspace.capacityId, binding.capacityId), 409, "CapacityMappingChanged",
      "The workspace capacity changed. A platform administrator must refresh tenant settings before automatic startup.");
    return this.recovery.resume(binding.resourceId);
  }
  private capacityFailure(error: unknown) {
    return error instanceof AppError && ["Upstream400", "Upstream403", "Upstream404", "Upstream500",
      "Upstream502", "Upstream503", "UpstreamUnavailable"].includes(error.code);
  }
  private async recoveryUser(user: User) {
    const current = await this.repo.user({ objectId: user.ObjectId, directoryId: user.DirectoryId });
    requireCondition(current && sameId(current.Id, user.Id) && sameId(current.TenantId, user.TenantId),
      403, "MembershipChanged", "Your tenant membership changed during capacity startup. Sign in again.");
    return current;
  }
  operator<T>(token: string, suffix: string, method = "GET", body?: unknown) {
    return remoteJson<T>(`${pbi}${suffix}`, token, method, body);
  }
  async importSample(id: string) {
    const tenant = await this.repo.tenant(id);
    assertNotManagementResource(tenant.WorkspaceId, this.azure.config.ManagementWorkspaceId);
    requireCondition(tenant.WorkspaceId, 409, "MissingWorkspace", "Assign a tenant workspace before importing the sample.");
    const token = await this.runtimeToken(tenant);
    return remoteJson<SampleImport>(
      `${pbi}/groups/${tenant.WorkspaceId}/imports?datasetDisplayName=${encodeURIComponent(sampleName)}&nameConflict=Abort`,
      token, "POST", await sampleForm(), 180_000);
  }
  async sampleImport(id: string, importId: string) {
    const tenant = await this.repo.tenant(id);
    assertNotManagementResource(tenant.WorkspaceId, this.azure.config.ManagementWorkspaceId);
    requireCondition(tenant.WorkspaceId, 409, "MissingWorkspace", "The sample's tenant workspace is missing.");
    return this.operator<SampleImport>(await this.runtimeToken(tenant), `/groups/${tenant.WorkspaceId}/imports/${importId}`);
  }
  async workspaces(token: string) {
    const items: Workspace[] = [];
    for (let skip = 0; skip < 50_000; skip += 5_000) {
      const page = await this.operator<Collection<Workspace>>(token, `/groups?$top=5000&$skip=${skip}`);
      items.push(...page.value);
      if (page.value.length < 5_000) return items;
    }
    throw new AppError(409, "DiscoveryLimit", "Discovery exceeded the initial application's 50,000-workspace limit. Refine the deployment scope.");
  }
  async runtimeToken(tenant: Tenant) {
    assertNotManagementResource(tenant.WorkspaceId, this.azure.config.ManagementWorkspaceId);
    requireCondition(tenant.EmbeddingClientId && tenant.SecretName, 409, "MissingIdentity", "Provision this tenant's embedding service principal first.");
    const client = new ConfidentialClientApplication({
      auth: { clientId: tenant.EmbeddingClientId, clientSecret: await this.azure.secret(tenant.SecretName),
        authority: `https://login.microsoftonline.com/${this.azure.config.DirectoryTenantId}` },
    });
    try {
      const result = await client.acquireTokenByClientCredential({ scopes: ["https://analysis.windows.net/powerbi/api/.default"] });
      requireCondition(result?.accessToken, 503, "IdentityUnavailable", "The embedding identity did not return an access token.");
      return result.accessToken;
    } catch {
      throw new AppError(503, "IdentityUnavailable", "The tenant embedding identity could not authenticate. Check its Key Vault credential and Entra configuration.");
    }
  }
  async provisionIdentity(id: string) {
    let tenant = await this.repo.tenant(id);
    const graphToken = await this.azure.provisioner.getToken("https://graph.microsoft.com/.default");
    requireCondition(graphToken, 503, "ProvisioningIdentityUnavailable", "The provisioning identity cannot authenticate to Microsoft Graph.");
    const graph = <T>(suffix: string, method = "GET", body?: unknown) =>
      remoteJson<T>(`https://graph.microsoft.com/v1.0${suffix}`, graphToken.token, method, body);
    if (!tenant.EmbeddingAppObjectId) {
      const app = await graph<{ id: string; appId: string }>("/applications", "POST",
        { displayName: tenantIdentityNames(this.azure.config.ResourceNamePrefix, id, tenant.SecretName).displayName, signInAudience: "AzureADMyOrg" });
      await this.repo.db.query("UPDATE app.Tenants SET EmbeddingAppObjectId=@appObjectId,EmbeddingClientId=@clientId WHERE Id=@id",
        { id, appObjectId: app.id, clientId: app.appId });
      tenant = await this.repo.tenant(id);
    }
    if (!tenant.EmbeddingObjectId) {
      const existing = await graph<Collection<{ id: string }>>(`/servicePrincipals?$filter=appId eq '${tenant.EmbeddingClientId}'`);
      const principal = existing.value[0] ?? await graph<{ id: string }>("/servicePrincipals", "POST", { appId: tenant.EmbeddingClientId });
      await this.repo.db.query("UPDATE app.Tenants SET EmbeddingObjectId=@objectId WHERE Id=@id", { id, objectId: principal.id });
      tenant = await this.repo.tenant(id);
    }
    const secretName = tenantIdentityNames(this.azure.config.ResourceNamePrefix, id, tenant.SecretName).secretName;
    let exists = false;
    try { await this.azure.secretWriter.getSecret(secretName); exists = true; }
    catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw new AppError(503, "SecretStoreUnavailable", "The provisioning identity cannot inspect or write the configured credential store."); }
    if (!exists) {
      const password = await graph<{ keyId: string; secretText: string }>(`/applications/${tenant.EmbeddingAppObjectId}/addPassword`, "POST",
        { passwordCredential: { displayName: "Key Vault embedding credential", endDateTime: new Date(Date.now() + 180 * 86400_000).toISOString() } });
      try { await this.azure.secretWriter.setSecret(secretName, password.secretText, { expiresOn: new Date(Date.now() + 180 * 86400_000) }); }
      catch {
        await graph(`/applications/${tenant.EmbeddingAppObjectId}/removePassword`, "POST", { keyId: password.keyId }).catch(() => undefined);
        throw new AppError(503, "SecretStoreUnavailable", "Could not store the generated credential in the configured credential store. The new credential was revoked.");
      }
    }
    await this.repo.db.query("UPDATE app.Tenants SET SecretName=@secretName,LastIssue=NULL WHERE Id=@id", { id, secretName });
    if (this.azure.config.ServicePrincipalGroupId) {
      let member = false;
      try {
        await graph(`/groups/${this.azure.config.ServicePrincipalGroupId}/members/${tenant.EmbeddingObjectId}`);
        member = true;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "Upstream404") throw error;
      }
      if (!member) {
        await graph(`/groups/${this.azure.config.ServicePrincipalGroupId}/members/$ref`, "POST",
          { "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${tenant.EmbeddingObjectId}` });
      }
    }
    return this.repo.tenant(id);
  }
  async readiness(id: string, operatorToken: string) {
    const tenant = await this.repo.tenant(id);
    const checks: Check[] = [];
    let workspace: Workspace | undefined;
    if (!tenant.WorkspaceId) checks.push({ key: "Workspace", status: "fail", message: "No workspace is assigned." });
    else {
      try {
        workspace = await this.operator<Workspace>(operatorToken, `/groups/${tenant.WorkspaceId}`);
        checks.push({ key: "Workspace", status: "pass", message: "The operator can inspect the registered workspace." });
        checks.push({ key: "Capacity", status: workspace.isOnDedicatedCapacity && workspace.capacityId ? "pass" : "fail",
          message: workspace.isOnDedicatedCapacity && workspace.capacityId ? `Assigned capacity: ${workspace.capacityId}` : "Assign an eligible capacity before embedding." });
        if (workspace.capacityId) {
          try {
            const capacities = await this.operator<Collection<{ id: string; state: string }>>(operatorToken, "/capacities");
            const capacity = capacities.value.find(c => sameId(c.id, workspace?.capacityId));
            checks.push({ key: "Capacity state", status: capacity ? (capacity.state === "Active" ? "pass" : "fail") : "unknown",
              message: capacity ? `State: ${capacity.state}` : "The operator cannot inspect this capacity. Verify its state separately." });
          } catch { checks.push({ key: "Capacity state", status: "unknown", message: "Capacity state could not be inspected." }); }
        }
      } catch {
        checks.push({ key: "Workspace", status: "unknown", message: "The workspace could not be inspected. It may be inaccessible, deleted, or temporarily unavailable." });
      }
    }
    if (!tenant.EmbeddingClientId || !tenant.SecretName) checks.push({ key: "Runtime access", status: "fail", message: "Provision the tenant embedding identity and credential." });
    else if (tenant.WorkspaceId) {
      try {
        const token = await this.runtimeToken(tenant);
        await this.operator<Workspace>(token, `/groups/${tenant.WorkspaceId}`);
        checks.push({ key: "Runtime access", status: "pass", message: "The actual tenant service principal can access the workspace." });
      } catch {
        checks.push({ key: "Runtime access", status: "unknown", message: "The service principal cannot be verified. Check workspace access, credential, service-principal group, and Fabric tenant settings." });
      }
    }
    const state = checks.some(c => c.status === "fail") ? "NeedsConfiguration" : checks.some(c => c.status === "unknown") ? "Unknown" : "Ready";
    await this.repo.db.query(`UPDATE app.Tenants SET Status=@state,ReadinessJson=@json,LastCheckedAt=SYSUTCDATETIME() WHERE Id=@id`,
      { id, state, json: JSON.stringify(checks) });
    return { state, checks, checkedAt: new Date().toISOString() };
  }
  async sync(id: string) {
    const tenant = await this.repo.tenant(id);
    requireCondition(tenant.WorkspaceId, 409, "MissingWorkspace", "Assign a workspace first.");
    const token = await this.runtimeToken(tenant);
    const [reports, models] = await Promise.all([
      this.operator<Collection<RemoteReport>>(token, `/groups/${tenant.WorkspaceId}/reports`),
      this.operator<Collection<RemoteModel>>(token, `/groups/${tenant.WorkspaceId}/datasets`),
    ]);
    requireCondition(Array.isArray(reports.value) && Array.isArray(models.value), 503, "IncompleteInventory", "The service did not return a complete inventory.");
    await this.repo.db.transaction(async tx => {
      await tx.query("EXEC sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=30000", { resource: `sync:${id}` });
      const [root] = await tx.query<{ Id: string }>("SELECT Id FROM app.Nodes WHERE TenantId=@id AND ParentId IS NULL", { id });
      requireCondition(root, 409, "MissingRoot", "The tenant navigation root is missing.");
      await tx.query("UPDATE app.Content SET Deleted=1 WHERE TenantId=@id", { id });
      for (const item of [...models.value.map(m => ({ externalId: m.id, kind: "Model", name: m.name, modelId: null,
        embedUrl: null, identity: Boolean(m.isEffectiveIdentityRequired || m.isEffectiveIdentityRolesRequired),
        unsafe: Boolean(m.upstreamDatasets?.length) })),
      ...reports.value.map(r => ({ externalId: r.id, kind: "Report", name: r.name, modelId: r.datasetId ?? null,
        embedUrl: r.embedUrl, identity: false, unsafe: !r.datasetId ||
          Boolean(r.datasetWorkspaceId && !sameId(r.datasetWorkspaceId, tenant.WorkspaceId)) ||
          !models.value.some(m => sameId(m.id, r.datasetId)) }))]) {
        const existing = await tx.query<ContentItem>("SELECT * FROM app.Content WHERE TenantId=@id AND ExternalId=@externalId AND Kind=@kind",
          { id, externalId: item.externalId, kind: item.kind });
        const contentId = existing[0]?.Id ?? randomUUID();
        const params = { id, contentId, externalId: item.externalId, kind: item.kind, name: item.name, modelId: item.modelId,
          embedUrl: item.embedUrl, identity: item.identity, unsafe: item.unsafe };
        if (existing.length) await tx.query(`UPDATE app.Content SET Name=@name,ModelExternalId=@modelId,EmbedUrl=@embedUrl,
          RequiresIdentity=@identity,UnsafeDependency=@unsafe,Deleted=0 WHERE Id=@contentId AND TenantId=@id`, params);
        else {
          await tx.query(`INSERT app.Content(Id,TenantId,ExternalId,Kind,Name,ModelExternalId,EmbedUrl,RequiresIdentity,UnsafeDependency)
            VALUES(@contentId,@id,@externalId,@kind,@name,@modelId,@embedUrl,@identity,@unsafe)`, params);
        }
        const [policy] = await tx.query("SELECT Id FROM app.Nodes WHERE TenantId=@id AND ContentItemId=@contentId", { id, contentId });
        if (!policy) await tx.query(`INSERT app.Nodes(Id,TenantId,ParentId,ContentItemId,Label)
          VALUES(@nodeId,@id,@parentId,@contentId,@label)`, { nodeId: randomUUID(), id, parentId: root.Id, contentId, label: item.name });
      }
    });
    return { reports: reports.value.length, models: models.value.length };
  }
  async embed(user: User, contentId: string, mode: "view" | "edit" | "copy", recoverCapacity = false, retry = true): Promise<{
    id: string; embedUrl: string; accessToken: string; expiration: string; mode: "view" | "edit" | "copy";
    create: boolean; targetWorkspaceId?: string; capacityResumed?: boolean; autoResumeCapacities?: boolean;
  }> {
    const tenantId = tenantMembership(user);
    const tenant = await this.repo.tenant(tenantId);
    const content = await this.repo.content(tenantId);
    const report = content.find(c => sameId(c.Id, contentId));
    requireCondition(report, 404, "NotFound", "Report not found in your tenant.");
    const model = content.find(c => c.Kind === "Model" && sameId(c.ExternalId, report.ModelExternalId));
    requireCondition(model, 409, "MissingModel", "Synchronize and review the report's semantic model.");
    const { nodes, grants } = await this.repo.security(tenantId);
    const node = nodes.find(n => sameId(n.ContentItemId, report.Id));
    requireCondition(node, 403, "MissingPolicy", "This report has no navigation security policy.");
    const modelNode = nodes.find(n => sameId(n.ContentItemId, model.Id));
    const modelMask = modelNode ? effectivePermissions(user, modelNode.Id, nodes, grants) : 0;
    assertEmbedding(user, tenant, report, model, effectivePermissions(user, node.Id, nodes, grants), mode, modelMask);
    if (mode === "copy") {
      const root = nodes.find(n => !n.ParentId);
      requireCondition(root && (effectivePermissions(user, root.Id, nodes, grants) & Permission.CreateReport),
        403, "CreateForbidden", "Creating a copy requires permission at the tenant root.");
    }
    const capacityResumed = recoverCapacity ? await this.resumeTenant(tenant) : false;
    if (capacityResumed) {
      return { ...await waitForCapacityData(async () => this.embed(await this.recoveryUser(user), contentId, mode, false, false),
        error => this.capacityFailure(error)), capacityResumed: true };
    }
    try {
      const token = await this.validateRuntimeModel(tenant, model);
      const liveReport = await this.operator<RemoteReport>(token, `/groups/${tenant.WorkspaceId}/reports/${report.ExternalId}`);
      requireCondition(sameId(liveReport.datasetId, model.ExternalId) &&
        (!liveReport.datasetWorkspaceId || sameId(liveReport.datasetWorkspaceId, tenant.WorkspaceId)),
      409, "DependencyChanged", "Report dependencies changed. Synchronize and review the report before embedding.");
      const result = await this.operator<{ token: string; expiration: string }>(token, "/GenerateToken", "POST",
        tokenPayload(report.ExternalId, model.ExternalId, tenant.WorkspaceId!, mode));
      requireCondition(new URL(liveReport.embedUrl).protocol === "https:" &&
        new URL(liveReport.embedUrl).hostname === "app.powerbi.com", 409, "UnsupportedEmbedHost", "This deployment supports the public Power BI cloud only.");
      return { id: report.ExternalId, embedUrl: liveReport.embedUrl, accessToken: result.token,
        expiration: result.expiration, mode, create: false,
        autoResumeCapacities: Boolean(this.azure.config?.AutoResumeCapacities),
        ...(recoverCapacity ? { capacityResumed } : {}),
        ...(mode === "copy" ? { targetWorkspaceId: tenant.WorkspaceId! } : {}) };
    } catch (error) {
      if (retry && !recoverCapacity && this.capacityFailure(error) && await this.resumeTenant(tenant)) {
        return waitForCapacityData(async () => this.embed(await this.recoveryUser(user), contentId, mode, false, false), e => this.capacityFailure(e));
      }
      throw error;
    }
  }
  async createReport(user: User, modelId: string, recoverCapacity = false, retry = true): Promise<{
    datasetId: string; embedUrl: string; accessToken: string; expiration: string; create: boolean; mode: string;
    targetWorkspaceId: string; capacityResumed?: boolean; autoResumeCapacities?: boolean;
  }> {
    const tenantId = tenantMembership(user);
    const tenant = await this.repo.tenant(tenantId);
    const model = (await this.repo.content(tenantId)).find(c => sameId(c.Id, modelId) && c.Kind === "Model");
    requireCondition(model?.Published && !model.Deleted && !model.UnsafeDependency, 403, "ModelUnavailable", "The model is not approved for authoring.");
    const { nodes, grants } = await this.repo.security(tenantId);
    const root = nodes.find(n => !n.ParentId);
    const modelNode = nodes.find(n => sameId(n.ContentItemId, model.Id));
    requireCondition(root && modelNode && (effectivePermissions(user, root.Id, nodes, grants) & Permission.CreateReport) &&
      (effectivePermissions(user, modelNode.Id, nodes, grants) & Permission.UseSemanticModelForAuthoring),
      403, "Forbidden", "Report creation and semantic-model authoring permissions are required.");
    const capacityResumed = recoverCapacity ? await this.resumeTenant(tenant) : false;
    if (capacityResumed) {
      return { ...await waitForCapacityData(async () => this.createReport(await this.recoveryUser(user), modelId, false, false),
        error => this.capacityFailure(error)), capacityResumed: true };
    }
    try {
      const token = await this.validateRuntimeModel(tenant, model);
      const result = await this.operator<{ token: string; expiration: string }>(token, "/GenerateToken", "POST",
        { datasets: [{ id: model.ExternalId }], targetWorkspaces: [{ id: tenant.WorkspaceId }] });
      return { datasetId: model.ExternalId, embedUrl: `https://app.powerbi.com/reportEmbed?groupId=${tenant.WorkspaceId}`,
        accessToken: result.token, expiration: result.expiration, create: true, mode: "edit",
        autoResumeCapacities: Boolean(this.azure.config?.AutoResumeCapacities),
        targetWorkspaceId: tenant.WorkspaceId!, ...(recoverCapacity ? { capacityResumed } : {}) };
    } catch (error) {
      if (retry && !recoverCapacity && this.capacityFailure(error) && await this.resumeTenant(tenant)) {
        return waitForCapacityData(async () => this.createReport(await this.recoveryUser(user), modelId, false, false), e => this.capacityFailure(e));
      }
      throw error;
    }
  }
  private async validateRuntimeModel(tenant: Tenant, model: ContentItem) {
    requireCondition(tenant.WorkspaceId, 409, "MissingWorkspace", "The tenant has no workspace.");
    const token = await this.runtimeToken(tenant);
    const workspace = await this.operator<Workspace>(token, `/groups/${tenant.WorkspaceId}`);
    requireCondition(workspace.isOnDedicatedCapacity && workspace.capacityId, 409, "MissingCapacity", "Assign an eligible active capacity before embedding.");
    const live = await this.operator<RemoteModel>(token, `/groups/${tenant.WorkspaceId}/datasets/${model.ExternalId}`);
    requireCondition(!live.isEffectiveIdentityRequired && !live.isEffectiveIdentityRolesRequired && !model.RequiresIdentity,
      409, "RlsNotSupported", "This model requires effective-identity RLS, which is not yet implemented. No unfiltered token will be issued.");
    requireCondition(!live.upstreamDatasets?.length && !model.UnsafeDependency, 409, "UnsupportedModelChain",
      "Chained/composite semantic-model dependencies are not supported by this initial implementation.");
    return token;
  }
}
