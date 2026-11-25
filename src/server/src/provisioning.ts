import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { userPrincipalNameSchema, type AzureServices } from "./azure.js";
import { allPermissions, assertCapacityNamespace, assertNotManagementResource, sameId, tenantMembership, type ContentItem, type Tenant, type User } from "./domain.js";
import { AppError, requireCondition } from "./errors.js";
import type { FabricService, SampleImport, Workspace } from "./fabric.js";
import type { Repository } from "./repository.js";
import type { Executor } from "./db.js";
import { assertSampleAvailable } from "./sample.js";
import { AnalyticsProvisioner, analyticsConfigured } from "./analytics-security.js";

export const setupSchema = z.object({
  requestId: z.uuid(), name: z.string().trim().min(1).max(200),
  administratorUpn: userPrincipalNameSchema.optional(),
  replaceAdministrator: z.boolean().default(false),
  includeSample: z.boolean().optional(),
  capacity: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("existing"), id: z.uuid() }).strict(),
    z.object({ mode: z.literal("new"), sku: z.string().regex(/^F(2|4|8|16|32|64|128|256|512|1024|2048|4096|8192)$/), confirmBilling: z.literal(true) }).strict(),
  ]),
}).strict();
export type SetupInput = z.infer<typeof setupSchema>;
interface Capacity { id: string; displayName: string; state: string }
interface ArmCapacity {
  name: string; location: string; sku: { name: string };
  tags?: Record<string, string>; properties: { state?: string; provisioningState?: string };
}
type StepKey = "identity" | "capacity" | "workspace" | "access" | "assignment" | "administrator" | "verification" | "sample" | "analytics";
interface Step { key: StepKey; label: string; status: "pending" | "running" | "done" | "failed"; message?: string }
interface State {
  kind?: "setup";
  input: SetupInput; identity?: { objectId: string; displayName: string };
  previousAdminId?: string; operatorUpn: string; steps: Step[];
  isNewTenant?: boolean;
  capacityId?: string; capacityName?: string; capacityRequested?: boolean;
  identityRequested?: boolean; workspaceRequested?: boolean; recoveryRequired?: boolean;
  sample?: { requested?: boolean; importId?: string; published?: boolean };
}
interface SampleState extends Pick<State, "steps" | "sample" | "recoveryRequired"> {
  kind: "sample"; workspaceId: string;
}
type OperationState = State | SampleState;
interface Operation {
  Id: string; TenantId: string; ActorId: string; RequestJson: string; StateJson: string;
  Status: "Running" | "Succeeded" | "Failed"; Error: string | null;
  LeaseOwner: string | null; LeaseUntil: Date | null;
  CreatedAt?: Date; UpdatedAt?: Date;
}
const stepLabels: [StepKey, string][] = [
  ["identity", "Create tenant service principal"], ["capacity", "Prepare capacity"],
  ["workspace", "Create or update workspace"], ["access", "Grant service principal access"],
  ["assignment", "Assign workspace capacity"], ["administrator", "Set tenant administrator"],
  ["verification", "Verify workspace and runtime access"],
  ["sample", "Import and publish bundled sample"],
];
const isNotFound = (error: unknown) => error instanceof AppError && error.code === "Upstream404";

export class TenantProvisioner {
  private owner = randomUUID();
  private running = new Set<string>();
  private lostLeases = new Set<string>();
  constructor(private repo: Repository, private azure: AzureServices, private fabric: FabricService,
    private wait: () => Promise<unknown> = () => delay(5000), private pollLimit = 180) {}

  async operation(id: string) {
    const [operation] = await this.repo.db.query<Operation>("SELECT * FROM app.ProvisioningOperations WHERE Id=@id", { id });
    requireCondition(operation, 404, "NotFound", "Provisioning operation not found.");
    return operation;
  }
  view(operation: Operation) {
    const state = JSON.parse(operation.StateJson) as OperationState;
    const expires = operation.LeaseUntil ? new Date(operation.LeaseUntil).getTime() :
      new Date(operation.UpdatedAt ?? operation.CreatedAt ?? Date.now()).getTime() + 90_000;
    const interrupted = operation.Status === "Running" && expires < Date.now();
    return { id: operation.Id, tenantId: operation.TenantId, status: interrupted ? "Interrupted" : operation.Status,
      steps: state.steps, error: operation.Error, recoveryRequired: Boolean(state.recoveryRequired),
      canRetry: !state.recoveryRequired && (operation.Status === "Failed" || Boolean(interrupted)) };
  }
  private async sampleTenant(actor: User) {
    requireCondition(actor.IsTenantAdmin, 403, "TenantAdminRequired", "An explicit tenant administrator role is required.");
    const tenant = await this.repo.tenant(tenantMembership(actor));
    assertNotManagementResource(tenant.WorkspaceId, this.azure.config.ManagementWorkspaceId, this.azure.config.AgentWorkspaceId);
    return tenant;
  }
  private sampleView(operation: Operation, actor: User) {
    const state = JSON.parse(operation.StateJson) as OperationState;
    const view = this.view(operation);
    return { ...view, canRetry: state.kind === "sample" && sameId(operation.ActorId, actor.Id) && view.canRetry };
  }
  private async latestSample(tenantId: string, executor: Executor = this.repo.db) {
    const [operation] = await executor.query<Operation>(`SELECT TOP(1) * FROM app.ProvisioningOperations
      WHERE TenantId=@id AND (JSON_VALUE(StateJson,'$.kind')='sample' OR JSON_VALUE(RequestJson,'$.includeSample')='true')
      ORDER BY CreatedAt DESC`, { id: tenantId });
    if (operation?.Status === "Failed") {
      const state = JSON.parse(operation.StateJson) as OperationState;
      if (state.kind !== "sample" && !state.recoveryRequired && !state.sample?.requested &&
        !state.sample?.importId && !state.sample?.published &&
        state.steps.find(step => step.key === "sample")?.status === "pending") {
        const [latest] = await executor.query<Operation>(
          "SELECT TOP(1) * FROM app.ProvisioningOperations WHERE TenantId=@id ORDER BY CreatedAt DESC", { id: tenantId });
        if (latest?.Status === "Succeeded" && !sameId(latest.Id, operation.Id) &&
          (JSON.parse(latest.StateJson) as OperationState).kind !== "sample") return undefined;
      }
    }
    return operation;
  }
  async sampleStatus(actor: User) {
    const tenant = await this.sampleTenant(actor);
    const operation = await this.latestSample(tenant.Id);
    return { operation: operation ? this.sampleView(operation, actor) : null };
  }
  async addSample(actor: User, requestId: string) {
    z.uuid().parse(requestId);
    const tenant = await this.sampleTenant(actor);
    const operation = await this.repo.db.transaction(async tx => {
      await tx.query("SELECT Id FROM app.Tenants WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id", { id: tenant.Id });
      const [prior] = await tx.query<Operation>("SELECT * FROM app.ProvisioningOperations WHERE Id=@id", { id: requestId });
      if (prior) {
        requireCondition(sameId(prior.TenantId, tenant.Id) && sameId(prior.ActorId, actor.Id) &&
          (JSON.parse(prior.StateJson) as OperationState).kind === "sample", 409, "RequestIdConflict",
        "This request ID belongs to another operation.");
        return prior;
      }
      const previous = await this.latestSample(tenant.Id, tx);
      if (previous) return previous;
      const active = await tx.query("SELECT Id FROM app.ProvisioningOperations WITH(UPDLOCK,HOLDLOCK) WHERE TenantId=@id AND Status='Running'", { id: tenant.Id });
      requireCondition(!active.length, 409, "SetupInProgress", "Wait for tenant setup to finish before adding the sample.");
      requireCondition(tenant.Status === "Ready" && tenant.WorkspaceId, 409, "TenantNotReady", "A platform administrator must complete workspace setup before adding the sample.");
      await assertSampleAvailable();
      const state: SampleState = { kind: "sample", workspaceId: tenant.WorkspaceId,
        steps: [{ key: "sample", label: "Import and publish bundled sample", status: "pending" }] };
      await tx.query(`INSERT app.ProvisioningOperations(Id,TenantId,ActorId,RequestJson,StateJson,Status)
        VALUES(@operationId,@id,@actorId,@request,@state,'Running')`,
      { operationId: requestId, id: tenant.Id, actorId: actor.Id,
        request: JSON.stringify({ kind: "sample", requestId }), state: JSON.stringify(state) });
      return null;
    });
    if (operation) return this.sampleView(operation, actor);
    this.launch(requestId, "");
    return this.sampleView(await this.operation(requestId), actor);
  }
  async retrySample(id: string, actor: User) {
    const tenant = await this.sampleTenant(actor), operation = await this.operation(id);
    requireCondition(sameId(operation.TenantId, tenant.Id) && (JSON.parse(operation.StateJson) as OperationState).kind === "sample",
      404, "NotFound", "Sample operation not found in your tenant.");
    await this.authorizeSample(operation, JSON.parse(operation.StateJson) as SampleState);
    return this.retry(id, actor, "");
  }
  private async authorizeSample(operation: Operation, state: SampleState) {
    const actor = (await this.repo.users(operation.TenantId)).find(user => sameId(user.Id, operation.ActorId));
    requireCondition(actor && actor.IsTenantAdmin && sameId(actor.TenantId, operation.TenantId), 403, "TenantAdminRequired",
      "The administrator who started this sample import must still administer this tenant.");
    const tenant = await this.sampleTenant(actor);
    requireCondition(tenant.Status === "Ready" && sameId(tenant.WorkspaceId, state.workspaceId), 409, "TenantNotReady",
      "The tenant workspace changed or is not ready. Ask a platform administrator to repair it before retrying.");
  }
  async settings(tenantId: string, token: string) {
    const tenant = await this.repo.tenant(tenantId);
    assertNotManagementResource(tenant.WorkspaceId, this.azure.config.ManagementWorkspaceId, this.azure.config.AgentWorkspaceId);
    const administrators = (await this.repo.users(tenantId)).filter(user => user.IsTenantAdmin);
    const primary = administrators.find(user => sameId(user.ObjectId, tenant.PrimaryAdminObjectId));
    const primaryId = primary?.ObjectId ?? (administrators.length === 1 ? administrators[0]!.ObjectId : undefined);
    let upn = primary ? tenant.PrimaryAdminUpn ?? null : null;
    if (!upn && primaryId) upn = await this.azure.userPrincipalNameForObjectId(primaryId).catch(() => null);
    let workspace: Workspace | null = null, workspaceIssue: string | null = null;
    if (tenant.WorkspaceId) {
      try {
        workspace = await this.fabric.operator<Workspace>(token, `/groups/${tenant.WorkspaceId}`);
        if (this.azure.config.AutoResumeCapacities) await this.fabric.cacheCapacityBinding(tenant, workspace, token);
      }
      catch { workspaceIssue = "Workspace settings or automatic capacity mapping could not be verified. Check operator access and the Azure capacity scope. No infrastructure was changed."; }
    }
    const [latest] = await this.repo.db.query<Operation>(
      "SELECT TOP(1) * FROM app.ProvisioningOperations WHERE TenantId=@id ORDER BY CreatedAt DESC", { id: tenantId });
    return { tenant, workspace, workspaceIssue, administratorUpn: upn,
      administrators: administrators.map(({ Id, ObjectId, DisplayName }) => ({ Id, ObjectId, DisplayName })),
      operation: latest ? this.view(latest) : null };
  }
  async start(input: SetupInput, actor: User, operatorUpn: string, token: string, tenantId?: string) {
    const [prior] = await this.repo.db.query<Operation>("SELECT * FROM app.ProvisioningOperations WHERE Id=@id", { id: input.requestId });
    if (prior) {
      requireCondition(sameId(prior.ActorId, actor.Id) && prior.RequestJson === JSON.stringify(input) &&
        (!tenantId || sameId(prior.TenantId, tenantId)), 409, "RequestIdConflict", "This request ID belongs to another setup request.");
      return this.view(prior);
    }
    const id = tenantId ?? randomUUID();
    const tenant = tenantId ? await this.repo.tenant(id) : undefined;
    assertNotManagementResource(tenant?.WorkspaceId, this.azure.config.ManagementWorkspaceId, this.azure.config.AgentWorkspaceId);
    requireCondition(!input.includeSample || !tenant, 400, "NewTenantSampleOnly", "The bundled sample can only be included when creating a new tenant.");
    if (input.includeSample) await assertSampleAvailable();
    if (tenant) {
      const [latest] = await this.repo.db.query<Operation>(
        "SELECT TOP(1) * FROM app.ProvisioningOperations WHERE TenantId=@id ORDER BY CreatedAt DESC", { id });
      if (latest) {
        const checkpoint = JSON.parse(latest.StateJson) as OperationState;
        requireCondition(checkpoint.kind === "sample" || !checkpoint.recoveryRequired ||
          ((!checkpoint.identityRequested || tenant.EmbeddingAppObjectId) && (!checkpoint.workspaceRequested || tenant.WorkspaceId)),
        409, "RecoveryRequired", "An earlier creation has an unknown outcome. Reconcile and pin the existing Entra application/workspace before starting another setup.");
      }
    }
    requireCondition(tenant || input.administratorUpn, 400, "AdministratorRequired", "Enter the tenant administrator's user principal name.");
    const identity = input.administratorUpn ? await this.azure.resolveUserPrincipalName(input.administratorUpn) : undefined;
    if (identity) {
      const [member] = await this.repo.db.query<User>("SELECT * FROM app.Users WHERE DirectoryId=@directoryId AND ObjectId=@objectId",
        { directoryId: this.azure.config.DirectoryTenantId, objectId: identity.objectId });
      requireCondition(!member?.TenantId || sameId(member.TenantId, id), 409, "AlreadyRegistered",
        "The selected administrator belongs to another tenant. No resources were created.");
    }
    const admins = tenant ? (await this.repo.users(id)).filter(user => user.IsTenantAdmin) : [];
    requireCondition(identity || admins.length, 400, "AdministratorRequired", "Enter the tenant administrator's user principal name.");
    const previousAdminId = admins.find(user => sameId(user.ObjectId, tenant?.PrimaryAdminObjectId))?.ObjectId ??
      (admins.length === 1 ? admins[0]!.ObjectId : undefined);
    requireCondition(!identity || !previousAdminId || sameId(identity.objectId, previousAdminId) || input.replaceAdministrator,
      400, "ConfirmAdministratorChange", "Confirm replacing the current primary tenant administrator.");
    const state: State = { input, identity, previousAdminId, operatorUpn, isNewTenant: !tenant,
      steps: [...stepLabels, ...(analyticsConfigured(this.azure.config) ? [["analytics", "Configure tenant analytics access"] as [StepKey, string]] : [])]
        .filter(([key]) => key !== "sample" || input.includeSample)
        .map(([key, label]) => ({ key, label, status: "pending" })) };
    if (input.capacity.mode === "existing") {
      assertNotManagementResource(input.capacity.id, this.azure.config.ManagementCapacityId);
      const capacities = await this.fabric.operator<{ value: Capacity[] }>(token, "/capacities");
      requireCondition(capacities.value.some(c => sameId(c.id, input.capacity.mode === "existing" ? input.capacity.id : "") && c.state === "Active"),
        409, "CapacityUnavailable", "Select an active capacity that the operator can assign.");
      state.capacityId = input.capacity.id;
    } else {
      requireCondition(this.azure.config.SubscriptionId && this.azure.config.ResourceGroup && operatorUpn,
        409, "AzureNotConfigured", "Configure Azure provisioning and sign in with a workforce account before creating a capacity.");
      state.capacityName = `${this.azure.config.ResourceNamePrefix.replaceAll("-", "") || "pbi"}cap${input.requestId.replaceAll("-", "")}`;
      assertCapacityNamespace(state.capacityName, this.azure.config.ResourceNamePrefix);
      requireCondition(/^[a-z][a-z0-9]{2,62}$/.test(state.capacityName), 409, "CapacityNameInvalid",
        "The configured namespace is too long for generated capacity names. Choose an existing capacity instead.");
    }
    await this.repo.db.transaction(async tx => {
      const existing = await tx.query("SELECT Id FROM app.ProvisioningOperations WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id", { id: input.requestId });
      requireCondition(!existing.length, 409, "RequestAlreadySubmitted", "This setup request was already submitted. Reopen the tenant to see its progress.");
      const active = await tx.query("SELECT Id FROM app.ProvisioningOperations WITH(UPDLOCK,HOLDLOCK) WHERE TenantId=@id AND Status='Running'", { id });
      requireCondition(!active.length, 409, "SetupInProgress", "This tenant already has a running setup operation.");
      if (!tenant) {
        await tx.query("INSERT app.Tenants(Id,Name) VALUES(@id,@name)", { id, name: input.name });
        await tx.query("INSERT app.Nodes(Id,TenantId,Label) VALUES(@rootId,@id,@name)", { rootId: randomUUID(), id, name: input.name });
      }
      await tx.query(`INSERT app.ProvisioningOperations(Id,TenantId,ActorId,RequestJson,StateJson,Status)
        VALUES(@operationId,@id,@actorId,@request,@state,'Running')`,
      { operationId: input.requestId, id, actorId: actor.Id, request: JSON.stringify(input), state: JSON.stringify(state) });
      await tx.query("UPDATE app.Tenants SET Status='Provisioning',LastIssue=NULL WHERE Id=@id", { id });
    });
    this.launch(input.requestId, token);
    return this.view(await this.operation(input.requestId));
  }
  async retry(id: string, actor: User, token: string) {
    const operation = await this.operation(id);
    requireCondition(sameId(operation.ActorId, actor.Id), 403, "OriginalOperatorRequired", "The operator who started this setup must resume it.");
    const view = this.view(operation);
    requireCondition(view.canRetry, 409, "CannotRetry", "This operation is running, complete, or requires manual resource recovery.");
    const state = JSON.parse(operation.StateJson) as OperationState;
    if (state.kind !== "sample" && state.input.includeSample &&
      state.steps.find(step => step.key === "sample")?.status === "pending") {
      const current = await this.latestSample(operation.TenantId);
      requireCondition(current && sameId(current.Id, operation.Id), 409, "CannotRetry",
        "A later setup completed or another sample request replaced this operation. Reopen the tenant and use its current sample controls.");
    }
    const updated = await this.repo.db.query(`UPDATE app.ProvisioningOperations
      SET Status='Running',Error=NULL,LeaseOwner=NULL,LeaseUntil=NULL,UpdatedAt=SYSUTCDATETIME()
      OUTPUT inserted.Id WHERE Id=@id AND (Status='Failed' OR (Status='Running' AND
        (LeaseUntil<SYSUTCDATETIME() OR (LeaseUntil IS NULL AND UpdatedAt<DATEADD(second,-90,SYSUTCDATETIME())))))`, { id });
    requireCondition(updated.length, 409, "CannotRetry", "The operation changed concurrently. Reopen the tenant to inspect its current status.");
    this.launch(id, token);
    return this.view(await this.operation(id));
  }
  private launch(id: string, token: string) {
    if (this.running.has(id)) return;
    this.running.add(id);
    void this.execute(id, token).catch(() => console.warn(JSON.stringify({ code: "ProvisioningCheckpointUnavailable", operationId: id })))
      .finally(() => this.running.delete(id));
  }
  private async save(operation: Operation, state: OperationState, status = "Running", error: string | null = null, executor: Executor = this.repo.db) {
    const updated = await executor.query(`UPDATE app.ProvisioningOperations
      SET StateJson=@state,Status=@status,Error=@error,UpdatedAt=SYSUTCDATETIME(),LeaseUntil=DATEADD(second,90,SYSUTCDATETIME())
      OUTPUT inserted.Id WHERE Id=@id AND LeaseOwner=@owner AND Status='Running' AND LeaseUntil>SYSUTCDATETIME()`,
    { state: JSON.stringify(state), status, error, id: operation.Id, owner: this.owner });
    requireCondition(updated.length, 409, "LeaseLost", "Another worker owns this provisioning operation.");
  }
  private async poll(id: string, check: () => Promise<boolean>, message: string, retryTransient = true) {
    for (let attempt = 0; attempt < this.pollLimit; attempt++) {
      requireCondition(!this.lostLeases.has(id), 409, "LeaseLost", "The operation lease was lost. Reopen the tenant before retrying.");
      try { if (await check()) return; }
      catch (error) {
        if (!retryTransient || !(error instanceof AppError) ||
          !["Upstream429", "Upstream502", "Upstream503", "Upstream504", "UpstreamUnavailable"].includes(error.code)) throw error;
      }
      await this.wait();
    }
    throw new AppError(409, "ProvisioningTimeout", message);
  }
  async execute(id: string, token: string) {
    const [operation] = await this.repo.db.query<Operation>(`UPDATE app.ProvisioningOperations
      SET LeaseOwner=@owner,LeaseUntil=DATEADD(second,90,SYSUTCDATETIME()) OUTPUT inserted.*
      WHERE Id=@id AND Status='Running' AND (LeaseOwner=@owner OR LeaseUntil IS NULL OR LeaseUntil<SYSUTCDATETIME())`,
    { id, owner: this.owner });
    if (!operation) return;
    this.lostLeases.delete(id);
    const state = JSON.parse(operation.StateJson) as OperationState;
    let lostLease = false, heartbeatBusy = false, finished = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.repo.db.query(`UPDATE app.ProvisioningOperations SET LeaseUntil=DATEADD(second,90,SYSUTCDATETIME())
        OUTPUT inserted.Id WHERE Id=@id AND LeaseOwner=@owner AND Status='Running'`, { id, owner: this.owner })
        .then(rows => { if (!rows.length) throw new Error("Lease lost"); })
        .catch(() => { if (!finished) { lostLease = true; this.lostLeases.add(id); } }).finally(() => { heartbeatBusy = false; });
    }, 20_000);
    heartbeat.unref();
    try {
      if (state.kind === "sample") {
        await this.authorizeSample(operation, state);
        const step = state.steps[0]!;
        step.status = "running"; step.message = "Importing and registering the sample report.";
        await this.save(operation, state);
        await this.seedSample(operation, state);
        step.status = "done"; step.message = "Confirmed.";
        await this.repo.audit({ Id: operation.ActorId, TenantId: operation.TenantId }, "AddSampleReport", operation.Id);
        await this.save(operation, state, "Succeeded");
        return;
      }
      for (const step of state.steps) {
        requireCondition(!lostLease, 409, "LeaseLost", "Provisioning lease was lost; inspect the operation before retrying.");
        if (step.status === "done") continue;
        step.status = "running"; step.message = "In progress; waiting for the service to confirm completion.";
        await this.save(operation, state);
        const tenant = await this.repo.tenant(operation.TenantId);
        assertNotManagementResource(tenant.WorkspaceId, this.azure.config.ManagementWorkspaceId, this.azure.config.AgentWorkspaceId);
        if (step.key === "identity") {
          requireCondition(!state.identityRequested || tenant.EmbeddingAppObjectId, 409, "RecoveryRequired",
            "An earlier service-principal creation could not be confirmed. Inspect Entra before retrying; no duplicate will be created.");
          state.identityRequested = true; await this.save(operation, state);
          await this.poll(id, async () => {
            try { await this.fabric.provisionIdentity(tenant.Id); return true; }
            catch (error) {
              if (error instanceof AppError && ["Upstream400", "Upstream404", "Upstream429"].includes(error.code) &&
                (await this.repo.tenant(tenant.Id)).EmbeddingAppObjectId) return false;
              throw error;
            }
          }, "The Entra application exists, but its service principal or group membership has not propagated. Retry to reuse it.", false);
        } else if (step.key === "capacity") {
          if (state.input.capacity.mode === "new") await this.prepareCapacity(operation, state, token);
        } else if (step.key === "workspace") {
          if (!tenant.WorkspaceId) {
            requireCondition(!state.workspaceRequested, 409, "RecoveryRequired",
              "An earlier workspace creation could not be confirmed. Discover and adopt the workspace before starting another setup; no duplicate will be created.");
            state.workspaceRequested = true; await this.save(operation, state);
            const workspace = await this.fabric.operator<Workspace>(token, "/groups?workspaceV2=true", "POST", { name: state.input.name });
            await this.repo.db.query(`UPDATE app.Tenants SET WorkspaceId=@workspaceId WHERE Id=@id AND WorkspaceId IS NULL;
              IF @@ROWCOUNT<>1 THROW 51000,'Tenant workspace changed concurrently',1;`,
              { id: tenant.Id, workspaceId: z.uuid().parse(workspace.id) });
          } else {
            const workspace = await this.fabric.operator<Workspace>(token, `/groups/${tenant.WorkspaceId}`);
            if (workspace.name !== state.input.name)
              await this.fabric.operator(token, `/groups/${tenant.WorkspaceId}`, "PATCH", { name: state.input.name });
          }
          await this.repo.db.query("UPDATE app.Tenants SET Name=@name WHERE Id=@id", { id: tenant.Id, name: state.input.name });
        } else if (step.key === "access") {
          requireCondition(tenant.WorkspaceId && tenant.EmbeddingObjectId, 409, "MissingConfiguration", "Workspace or tenant identity is missing.");
          await this.poll(id, async () => {
            try {
              const users = await this.fabric.operator<{ value: { identifier: string; groupUserAccessRight: string }[] }>(token, `/groups/${tenant.WorkspaceId}/users`);
              const existing = users.value.find(user => sameId(user.identifier, tenant.EmbeddingObjectId) || sameId(user.identifier, tenant.EmbeddingClientId));
              if (existing?.groupUserAccessRight === "Admin") return true;
              await this.fabric.operator(token, `/groups/${tenant.WorkspaceId}/users`, existing ? "PUT" : "POST",
                { identifier: tenant.EmbeddingObjectId, groupUserAccessRight: "Admin", principalType: "App" });
              return true;
            } catch (error) {
              if (error instanceof AppError && ["Upstream400", "Upstream404", "Upstream409", "Upstream429"].includes(error.code)) return false;
              throw error;
            }
          }, "Workspace access has not propagated. Check Fabric tenant settings and retry.");
        } else if (step.key === "assignment") {
          assertNotManagementResource(state.capacityId, this.azure.config.ManagementCapacityId);
          requireCondition(tenant.WorkspaceId && state.capacityId, 409, "MissingConfiguration", "Workspace or capacity is missing.");
          let workspace = await this.fabric.operator<Workspace>(token, `/groups/${tenant.WorkspaceId}`);
          if (!sameId(workspace.capacityId, state.capacityId))
            await this.fabric.operator(token, `/groups/${tenant.WorkspaceId}/AssignToCapacity`, "POST", { capacityId: state.capacityId });
          await this.poll(id, async () => {
            workspace = await this.fabric.operator<Workspace>(token, `/groups/${tenant.WorkspaceId}`);
            return sameId(workspace.capacityId, state.capacityId);
          }, "Capacity assignment is still pending. Retry to recheck the same workspace; no replacement is created.");
          if (this.azure.config.AutoResumeCapacities) await this.fabric.cacheCapacityBinding(tenant, workspace, token);
        } else if (step.key === "administrator" && state.identity) {
          await this.setAdministrator(tenant, state);
        } else if (step.key === "verification") {
          await this.poll(id, async () => {
            const workspace = await this.fabric.operator<Workspace>(token, `/groups/${tenant.WorkspaceId}`);
            if (workspace.name !== state.input.name || !sameId(workspace.capacityId, state.capacityId)) return false;
            return (await this.fabric.readiness(tenant.Id, token)).state === "Ready";
          }, "Resources exist, but embedding readiness could not be verified. Check diagnostics and Fabric service-principal tenant settings, then retry.");
        } else if (step.key === "sample") {
          requireCondition(state.isNewTenant && state.input.includeSample, 409, "NewTenantSampleOnly", "Sample seeding is restricted to opted-in new tenants.");
          await this.seedSample(operation, state);
        } else if (step.key === "analytics") {
          await new AnalyticsProvisioner(this.repo, this.azure, this.fabric).ensure(tenant.Id, token);
        }
        step.status = "done"; step.message = "Confirmed.";
        await this.save(operation, state);
      }
      await this.repo.db.query("UPDATE app.Tenants SET Status='Ready',LastIssue=NULL WHERE Id=@id", { id: operation.TenantId });
      await this.repo.audit({ Id: operation.ActorId, TenantId: null }, "TenantSetup", operation.Id, "Succeeded", operation.TenantId);
      await this.save(operation, state, "Succeeded");
    } catch (error) {
      const step = state.steps.find(item => item.status === "running");
      if (step) step.status = "failed";
      const tenant = await this.repo.tenant(operation.TenantId);
      const denied = error instanceof AppError && ["Upstream400", "Upstream401", "Upstream403", "Upstream404", "Upstream409", "Upstream429", "ProvisioningIdentityUnavailable"].includes(error.code);
      const setup = state.kind !== "sample" ? state : undefined;
      if (setup && step?.key === "identity" && !tenant.EmbeddingAppObjectId && setup.identityRequested) {
        if (denied) setup.identityRequested = false; else setup.recoveryRequired = true;
      }
      if (setup && step?.key === "capacity" && denied) setup.capacityRequested = false;
      if (setup && step?.key === "workspace" && !tenant.WorkspaceId && setup.workspaceRequested) {
        if (denied) setup.workspaceRequested = false; else setup.recoveryRequired = true;
      }
      if (step?.key === "sample" && state.sample?.requested && !state.sample.importId) {
        const notSubmitted = error instanceof AppError && ["SampleUnavailable", "IdentityUnavailable", "MissingIdentity",
          "KeyVaultUnavailable", "LocalSecretsUnavailable", "MissingWorkspace", "ProtectedManagementResource"].includes(error.code);
        if (denied || notSubmitted) state.sample.requested = false; else state.recoveryRequired = true;
      }
      if (error instanceof AppError && error.code === "RecoveryRequired") state.recoveryRequired = true;
      const message = (error instanceof AppError ? error.message : "Provisioning could not finish. Check service permissions and retry; completed resources were preserved.").slice(0, 1500);
      if (step) step.message = message;
      await this.save(operation, state, "Failed", message);
      if (setup) await this.repo.db.query("UPDATE app.Tenants SET Status='NeedsConfiguration',LastIssue=@issue WHERE Id=@id",
        { id: operation.TenantId, issue: message.slice(0, 500) });
      await this.repo.audit({ Id: operation.ActorId, TenantId: null }, setup ? "TenantSetup" : "AddSampleReport", operation.Id, "Failed", operation.TenantId);
    } finally { finished = true; clearInterval(heartbeat); this.lostLeases.delete(id); }
  }
  private async seedSample(operation: Operation, state: OperationState) {
    if (state.kind === "sample") await this.authorizeSample(operation, state);
    if (state.sample?.published) return;
    state.sample ??= {};
    if (!state.sample.importId) {
      requireCondition(!state.sample.requested, 409, "RecoveryRequired",
        "The sample upload has an unknown outcome. Inspect the tenant workspace/import history and pin its import ID in the operation before retrying; no duplicate will be uploaded.");
      state.sample.requested = true;
      await this.save(operation, state);
      const imported = await this.fabric.importSample(operation.TenantId);
      const parsed = z.uuid().safeParse(imported.id);
      requireCondition(parsed.success, 502, "SampleImportInvalid", "Power BI did not return a valid sample import ID. Inspect the workspace before recovery.");
      state.sample.importId = parsed.data;
      await this.save(operation, state);
    }
    let reportId = "", modelId = "";
    await this.poll(operation.Id, async () => {
      let imported: SampleImport;
      try { imported = await this.fabric.sampleImport(operation.TenantId, state.sample!.importId!); }
      catch (error) { if (isNotFound(error)) return false; throw error; }
      requireCondition(sameId(imported.id, state.sample!.importId), 502, "SampleImportInvalid", "The sample import response does not match the saved import.");
      requireCondition(imported.importState !== "Failed", 409, "RecoveryRequired",
        "Power BI failed the sample import. Inspect the tenant workspace/import history before manual recovery; resources were not overwritten or deleted.");
      if (imported.importState !== "Succeeded") return false;
      const report = z.uuid().safeParse(imported.reports?.[0]?.id), model = z.uuid().safeParse(imported.datasets?.[0]?.id);
      requireCondition(imported.reports?.length === 1 && imported.datasets?.length === 1 && report.success && model.success,
        409, "SampleImportInvalid", "The sample import must return exactly one report and one semantic model.");
      reportId = report.data; modelId = model.data;
      return true;
    }, "The sample import is still pending. Retry to observe the same import; the PBIX will not be uploaded again.");
    await this.poll(operation.Id, async () => {
      if (state.kind === "sample") await this.authorizeSample(operation, state);
      await this.fabric.sync(operation.TenantId);
      const published = await this.repo.db.transaction(async tx => {
        const content = await tx.query<ContentItem>(`SELECT * FROM app.Content WITH(UPDLOCK,HOLDLOCK) WHERE TenantId=@id AND
          ((Kind='Report' AND ExternalId=@reportId) OR (Kind='Model' AND ExternalId=@modelId))`,
        { id: operation.TenantId, reportId, modelId });
        const report = content.find(c => c.Kind === "Report" && sameId(c.ExternalId, reportId));
        const model = content.find(c => c.Kind === "Model" && sameId(c.ExternalId, modelId));
        if (!report || !model || report.Deleted || model.Deleted) return false;
        requireCondition(sameId(report.ModelExternalId, model.ExternalId) && !report.UnsafeDependency &&
          !model.UnsafeDependency && !model.RequiresIdentity, 409, "UnsupportedSample",
        "The imported sample has unsupported model security or dependencies. It remains unpublished.");
        await tx.query(`UPDATE app.Content SET Published=1 WHERE TenantId=@id AND
          ((Kind='Report' AND ExternalId=@reportId) OR (Kind='Model' AND ExternalId=@modelId))`,
        { id: operation.TenantId, reportId, modelId });
        await this.save(operation, { ...state, sample: { ...state.sample, published: true } }, "Running", null, tx);
        return true;
      });
      if (published) state.sample!.published = true;
      return published;
    }, "The imported sample is not yet visible in metadata. Retry to synchronize it without uploading again.");
  }
  private async prepareCapacity(operation: Operation, state: State, token: string) {
    requireCondition(state.capacityName && state.input.capacity.mode === "new", 409, "MissingCapacity", "Capacity request is missing.");
    const name = state.capacityName;
    const sku = state.input.capacity.sku;
    let resource: ArmCapacity | undefined;
    try { resource = await this.azure.capacity<ArmCapacity>(`/${name}`); }
    catch (error) { if (!isNotFound(error)) throw error; }
    if (resource) requireCondition(resource.tags?.pbiEmbeddedOperation === operation.Id, 409, "CapacityNameConflict",
      "The generated capacity name is already in use by another operation. No existing capacity was changed.");
    if (!resource && !state.capacityRequested) {
      state.capacityRequested = true; await this.save(operation, state);
      await this.azure.capacity(`/${name}`, "PUT", { location: this.azure.config.AzureLocation,
        sku: { name: sku, tier: "Fabric" },
        tags: { pbiEmbeddedOperation: operation.Id, pbiEmbeddedTenant: operation.TenantId },
        properties: { administration: { members: [state.operatorUpn] } } });
    }
    await this.poll(operation.Id, async () => {
      try { resource = await this.azure.capacity<ArmCapacity>(`/${name}`); }
      catch (error) { if (isNotFound(error)) return false; throw error; }
      requireCondition(resource.tags?.pbiEmbeddedOperation === operation.Id, 409, "CapacityNameConflict", "Capacity ownership could not be verified.");
      requireCondition(resource.sku.name === sku &&
        resource.location.replaceAll(/\s/g, "").toLowerCase() === this.azure.config.AzureLocation.replaceAll(/\s/g, "").toLowerCase(),
      409, "CapacityConfigurationChanged", "The created capacity's region or size changed. Inspect it before retrying; it was not overwritten.");
      requireCondition(!["Failed", "Canceled"].includes(resource.properties.provisioningState ?? ""), 409, "CapacityFailed", "Azure capacity provisioning failed. Inspect the resource; it was not deleted or replaced.");
      if (resource.properties.provisioningState !== "Succeeded" || resource.properties.state !== "Active") return false;
      const capacities = await this.fabric.operator<{ value: Capacity[] }>(token, "/capacities");
      const matches = capacities.value.filter(capacity => capacity.displayName.toLowerCase() === name.toLowerCase());
      requireCondition(matches.length < 2, 409, "AmbiguousCapacity", "The created capacity cannot be uniquely identified.");
      if (!matches[0] || matches[0].state !== "Active") return false;
      state.capacityId = z.uuid().parse(matches[0].id);
      assertNotManagementResource(state.capacityId, this.azure.config.ManagementCapacityId);
      return true;
    }, "Azure/Fabric is still preparing the same capacity. Retry to continue observing it; do not create another billable capacity.");
  }
  private async setAdministrator(tenant: Tenant, state: State) {
    const identity = state.identity!;
    const permissions = state.isNewTenant && !tenant.PrimaryAdminObjectId ? allPermissions : 0;
    await this.repo.db.transaction(async tx => {
      const [user] = await tx.query<User>("SELECT * FROM app.Users WITH(UPDLOCK,HOLDLOCK) WHERE DirectoryId=@directoryId AND ObjectId=@objectId",
        { directoryId: this.azure.config.DirectoryTenantId, objectId: identity.objectId });
      requireCondition(!user?.TenantId || sameId(user.TenantId, tenant.Id), 409, "AlreadyRegistered", "The administrator was assigned to another tenant while setup was running.");
      if (user) await tx.query(`UPDATE app.Users SET TenantId=@tenantId,IsTenantAdmin=1,
        DefaultPermissions=DefaultPermissions|@permissions WHERE Id=@id`, { tenantId: tenant.Id, id: user.Id, permissions });
      else await tx.query(`INSERT app.Users(Id,TenantId,DirectoryId,ObjectId,DisplayName,IsTenantAdmin,DefaultPermissions)
        VALUES(@id,@tenantId,@directoryId,@objectId,@name,1,@permissions)`,
      { id: randomUUID(), tenantId: tenant.Id, directoryId: this.azure.config.DirectoryTenantId, objectId: identity.objectId, name: identity.displayName, permissions });
      if (state.previousAdminId && !sameId(state.previousAdminId, identity.objectId))
        await tx.query("UPDATE app.Users SET IsTenantAdmin=0 WHERE TenantId=@tenantId AND ObjectId=@objectId AND DirectoryId=@directoryId",
          { tenantId: tenant.Id, objectId: state.previousAdminId, directoryId: this.azure.config.DirectoryTenantId });
      await tx.query("UPDATE app.Tenants SET PrimaryAdminObjectId=@objectId,PrimaryAdminUpn=@upn WHERE Id=@tenantId",
        { tenantId: tenant.Id, objectId: identity.objectId, upn: state.input.administratorUpn });
    });
  }
}
