import { randomUUID } from "node:crypto";
import { it } from "node:test";
import assert from "node:assert/strict";
import type { AzureServices } from "../src/azure.js";
import { config } from "../src/config.js";
import type { Database, Executor, Params } from "../src/db.js";
import { allPermissions, type ContentItem, type Tenant, type User } from "../src/domain.js";
import { AppError } from "../src/errors.js";
import { FabricService, type Workspace } from "../src/fabric.js";
import { Repository } from "../src/repository.js";
import { setupSchema, TenantProvisioner } from "../src/provisioning.js";

type Operation = Awaited<ReturnType<TenantProvisioner["operation"]>>;
const ids = { directory: randomUUID(), admin: randomUUID(), operator: randomUUID(), capacity: randomUUID(),
  management: randomUUID(), managementWorkspace: randomUUID(), workspace: randomUUID(), newCapacity: randomUUID(),
  sampleImport: randomUUID(), report: randomUUID(), model: randomUUID(), otherReport: randomUUID() };
const actor: User = { Id: ids.operator, ObjectId: ids.operator, DirectoryId: ids.directory, TenantId: null,
  DisplayName: "Operator", IsPlatformAdmin: true, IsTenantAdmin: false, DefaultPermissions: 0 };
const equal = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const emptyTenant = (id: string, name: string): Tenant => ({ Id: id, Name: name, WorkspaceId: null, Status: "NeedsConfiguration",
  EmbeddingClientId: null, EmbeddingObjectId: null, EmbeddingAppObjectId: null, SecretName: null,
  LastIssue: null, ReadinessJson: null, LastCheckedAt: null });
const member = (tenantId: string | null, objectId = ids.admin, admin = false, permissions = 0): User =>
  ({ ...actor, Id: randomUUID(), ObjectId: objectId, TenantId: tenantId, IsPlatformAdmin: false,
    IsTenantAdmin: admin, DefaultPermissions: permissions });

function fixture(options: { wait?: () => Promise<unknown>; pollLimit?: number } = {}) {
  const tenants = new Map<string, Tenant>(), operations = new Map<string, Operation>(), users: User[] = [];
  const sql: { text: string; params: Params }[] = [], tasks: (() => Promise<void>)[] = [];
  const content: ContentItem[] = [], nodes: { Id: string; TenantId: string; ContentItemId?: string }[] = [];
  const state = {
    identityCreations: 0, workspaceCreations: 0, capacityCreations: 0, assignments: 0, readinessCalls: 0,
    capacityReads: 0, discoveryReads: 0, assignmentReads: 0, grantWrites: 0, waits: 0,
    failAssignment: false, failWorkspace: false, failIdentity: false, failCapacity: false, runtimeReady: true,
    sampleUploads: 0, sampleReads: 0, syncs: 0, failSync: false, samplePending: false,
    ambiguousUpload: false, sampleDenied: false, sampleRls: false, sampleFailed: false,
    heartbeat: null as null | ((complete: () => { Id: string }[]) => Promise<{ Id: string }[]>),
  };
  let resource: { name: string; location: string; sku: { name: string }; tags: Record<string, string>;
    properties: { provisioningState: string; state: string } } | undefined;
  const workspaces = new Map<string, Workspace>(), memberships: { identifier: string; groupUserAccessRight: string }[] = [];
  let assignment: string | undefined;
  function getTenant(id: unknown) {
    const tenant = [...tenants.values()].find(t => equal(t.Id, id));
    assert.ok(tenant, "Expected a persisted tenant"); return tenant;
  }
  async function query(text: string, p: Params = {}): Promise<unknown[]> {
    const q = text.replaceAll(/\s+/g, " ").trim();
    sql.push({ text: q, params: structuredClone(p) });
    const operation = [...operations.values()].find(o => equal(o.Id, p.id));
    if (q.startsWith("SELECT") && q.includes("FROM app.ProvisioningOperations")) {
      const rows = [...operations.values()].filter(o => q.includes("TenantId=@id") ? equal(o.TenantId, p.id) : equal(o.Id, p.id))
        .filter(o => !q.includes("Status='Running'") || o.Status === "Running")
        .filter(o => !q.includes("JSON_VALUE") || JSON.parse(o.StateJson).kind === "sample" ||
          JSON.parse(o.RequestJson).includeSample === true);
      return structuredClone(q.includes("TOP(1)") ? rows.slice(-1) : rows);
    }
    if (q.startsWith("UPDATE app.ProvisioningOperations")) {
      if (!operation) return [];
      if (q.includes("SET LeaseOwner=@owner")) {
        if (operation.Status !== "Running" || (operation.LeaseOwner !== p.owner && operation.LeaseUntil &&
          operation.LeaseUntil.getTime() > Date.now())) return [];
        operation.LeaseOwner = String(p.owner); operation.LeaseUntil = new Date(Date.now() + 90_000);
        return [structuredClone(operation)];
      }
      if (q.includes("SET Status='Running'")) {
        if (operation.Status !== "Failed" && !(operation.Status === "Running" &&
          (operation.LeaseUntil?.getTime() ?? operation.UpdatedAt!.getTime() + 90_000) < Date.now())) return [];
        operation.Status = "Running"; operation.Error = null; operation.LeaseOwner = null; operation.LeaseUntil = null;
        operation.UpdatedAt = new Date(); return [{ Id: operation.Id }];
      }
      const update = () => {
        if (operation.LeaseOwner !== p.owner || operation.Status !== "Running" || operation.LeaseUntil!.getTime() <= Date.now()) return [];
        if (q.includes("SET StateJson")) {
          operation.StateJson = String(p.state); operation.Status = p.status as Operation["Status"];
          operation.Error = p.error as string | null; operation.UpdatedAt = new Date();
        }
        operation.LeaseUntil = new Date(Date.now() + 90_000); return [{ Id: operation.Id }];
      };
      return q.includes("SET LeaseUntil") && state.heartbeat ? state.heartbeat(update) : update();
    }
    if (q.startsWith("INSERT app.ProvisioningOperations")) {
      operations.set(String(p.operationId), { Id: String(p.operationId), TenantId: String(p.id), ActorId: String(p.actorId),
        RequestJson: String(p.request), StateJson: String(p.state), Status: "Running", Error: null,
        LeaseOwner: null, LeaseUntil: null, CreatedAt: new Date(), UpdatedAt: new Date() }); return [];
    }
    if (q.startsWith("SELECT") && q.includes("FROM app.Tenants")) return [structuredClone(getTenant(p.id ?? p.tenantId))];
    if (q.startsWith("INSERT app.Tenants")) { tenants.set(String(p.id), emptyTenant(String(p.id), String(p.name))); return []; }
    if (q.startsWith("INSERT app.Nodes")) {
      nodes.push({ Id: String(p.rootId ?? p.nodeId), TenantId: String(p.id),
        ...(p.contentId ? { ContentItemId: String(p.contentId) } : {}) }); return [];
    }
    if (q.startsWith("SELECT") && q.includes("FROM app.Nodes")) return structuredClone(nodes.filter(n => equal(n.TenantId, p.id) &&
      (p.contentId ? equal(n.ContentItemId, p.contentId) : !n.ContentItemId)));
    if (q.startsWith("EXEC sp_getapplock") || q.startsWith("INSERT app.Audit")) return [];
    if (q.startsWith("SELECT") && q.includes("FROM app.Content")) return structuredClone(content.filter(c => equal(c.TenantId, p.id) &&
      (p.externalId ? equal(c.ExternalId, p.externalId) && c.Kind === p.kind :
        c.Kind === "Report" && equal(c.ExternalId, p.reportId) || c.Kind === "Model" && equal(c.ExternalId, p.modelId))));
    if (q.startsWith("INSERT app.Content")) {
      content.push({ Id: String(p.contentId), TenantId: String(p.id), ExternalId: String(p.externalId),
        Kind: p.kind as "Report" | "Model", Name: String(p.name), ModelExternalId: p.modelId as string | null,
        EmbedUrl: p.embedUrl as string | null, RequiresIdentity: Boolean(p.identity), UnsafeDependency: Boolean(p.unsafe),
        Deleted: false, Published: false }); return [];
    }
    if (q.startsWith("UPDATE app.Content")) {
      for (const c of content.filter(c => equal(c.TenantId, p.id) && (!p.contentId || equal(c.Id, p.contentId)))) {
        if (q.includes("SET Deleted=1")) c.Deleted = true;
        else if (q.includes("SET Published=1")) {
          if (c.Kind === "Report" && equal(c.ExternalId, p.reportId) || c.Kind === "Model" && equal(c.ExternalId, p.modelId)) c.Published = true;
        } else {
          c.Name = String(p.name); c.ModelExternalId = p.modelId as string | null; c.EmbedUrl = p.embedUrl as string | null;
          c.RequiresIdentity = Boolean(p.identity); c.UnsafeDependency = Boolean(p.unsafe); c.Deleted = false;
        }
      }
      return [];
    }
    if (q.startsWith("UPDATE app.Tenants")) {
      const tenant = getTenant(p.id ?? p.tenantId);
      if (p.workspaceId) tenant.WorkspaceId = String(p.workspaceId);
      if (p.name) tenant.Name = String(p.name);
      if (q.includes("PrimaryAdminObjectId")) { tenant.PrimaryAdminObjectId = String(p.objectId); tenant.PrimaryAdminUpn = String(p.upn); }
      if (q.includes("Status='Ready'")) tenant.Status = "Ready";
      if (q.includes("Status='Provisioning'")) tenant.Status = "Provisioning";
      if (q.includes("Status='NeedsConfiguration'")) tenant.Status = "NeedsConfiguration";
      if (p.issue) tenant.LastIssue = String(p.issue); else if (q.includes("LastIssue=NULL")) tenant.LastIssue = null;
      return [];
    }
    if (q.startsWith("SELECT") && q.includes("FROM app.Users")) return structuredClone(users.filter(user =>
      q.includes("ObjectId=@objectId") ? equal(user.ObjectId, p.objectId) && equal(user.DirectoryId, p.directoryId) :
        equal(user.TenantId, p.tenantId)));
    if (q.startsWith("INSERT app.Users")) {
      users.push({ ...member(String(p.tenantId), String(p.objectId), true, Number(p.permissions ?? 0)), Id: String(p.id), DisplayName: String(p.name) }); return [];
    }
    if (q.startsWith("UPDATE app.Users")) {
      const user = users.find(user => p.id ? equal(user.Id, p.id) :
        equal(user.TenantId, p.tenantId) && equal(user.ObjectId, p.objectId) && equal(user.DirectoryId, p.directoryId));
      assert.ok(user); user.IsTenantAdmin = !q.includes("IsTenantAdmin=0");
      if (q.includes("DefaultPermissions=DefaultPermissions|@permissions")) user.DefaultPermissions |= Number(p.permissions);
      if (p.id) user.TenantId = String(p.tenantId); return [];
    }
    throw new Error(`Unexpected SQL in provisioning test: ${q}`);
  }
  const executor = { query } as Executor;
  const db = { query, read: query, transaction: async <T>(work: (tx: Executor) => Promise<T>) => work(executor) } as Database;
  const repo = new Repository(db);
  const azure = {
    config: { ...config, DirectoryTenantId: ids.directory, ResourceNamePrefix: "cgm-pbiembedded", AzureLocation: "centralus",
      SubscriptionId: randomUUID(), ResourceGroup: "cgm-pbiembedded-rg", ManagementCapacityId: ids.management,
      ManagementWorkspaceId: ids.managementWorkspace },
    resolveUserPrincipalName: async () => ({ objectId: ids.admin, displayName: "Tenant administrator" }),
    userPrincipalNameForObjectId: async () => "admin@contoso.com",
    capacity: async (suffix: string, method = "GET", body?: unknown) => {
      if (method === "PUT") {
        state.capacityCreations++;
        if (state.failCapacity) throw new AppError(502, "Upstream403", "Capacity creation forbidden.");
        resource = { ...body as typeof resource & object, name: suffix.slice(1),
          properties: { provisioningState: "Creating", state: "Provisioning" } } as NonNullable<typeof resource>;
        return {};
      }
      if (!resource) throw new AppError(502, "Upstream404", "Not found.");
      if (++state.capacityReads > 1) resource.properties = { provisioningState: "Succeeded", state: "Active" };
      return structuredClone(resource);
    },
  } as unknown as AzureServices;
  const fabric = Object.assign(new FabricService(repo, azure), {
    runtimeToken: async (tenant: Tenant) => {
      assert.equal(tenant.WorkspaceId, ids.workspace); return "tenant-only-token";
    },
    importSample: async (id: string) => {
      assert.equal(getTenant(id).WorkspaceId, ids.workspace);
      assert.ok(state.readinessCalls > 1, "Runtime readiness must precede import");
      state.sampleUploads++;
      if (state.ambiguousUpload) throw new AppError(503, "UpstreamUnavailable", "Upload outcome unknown.");
      if (state.sampleDenied) throw new AppError(502, "Upstream403", "Sample import forbidden.");
      return { id: ids.sampleImport };
    },
    sampleImport: async (id: string, importId: string) => {
      assert.equal(getTenant(id).WorkspaceId, ids.workspace); assert.equal(importId, ids.sampleImport);
      state.sampleReads++;
      if (state.sampleReads === 1) throw new AppError(502, "Upstream404", "Import visibility is still propagating.");
      return { id: ids.sampleImport, importState: state.sampleFailed ? "Failed" :
        state.samplePending ? "Publishing" : "Succeeded",
      reports: [{ id: ids.report }], datasets: [{ id: ids.model }] };
    },
    provisionIdentity: async (id: string) => {
      const tenant = getTenant(id);
      if (state.failIdentity) throw new AppError(503, "UpstreamUnavailable", "Identity creation could not be confirmed.");
      if (!tenant.EmbeddingAppObjectId) {
        state.identityCreations++; tenant.EmbeddingAppObjectId = randomUUID(); tenant.EmbeddingObjectId = randomUUID();
        tenant.EmbeddingClientId = randomUUID(); tenant.SecretName = "external-test-reference";
      }
    },
    operator: async (_token: string, suffix: string, method = "GET", body?: unknown) => {
      const payload = body as Record<string, string>;
      if (suffix === "/capacities") return { value: [
        { id: ids.capacity, displayName: "Shared", state: "Active" },
        ...(resource && ++state.discoveryReads > 1 ? [{ id: ids.newCapacity, displayName: resource.name, state: "Active" }] : []),
      ] };
      if (suffix === "/groups?workspaceV2=true") {
        state.workspaceCreations++;
        if (state.failWorkspace) throw new AppError(503, "UpstreamUnavailable", "Workspace creation could not be confirmed.");
        const workspace = { id: ids.workspace, name: payload.name! };
        workspaces.set(workspace.id, workspace); return structuredClone(workspace);
      }
      const id = suffix.split("/")[2]!, workspace = workspaces.get(id);
      assert.ok(workspace, "Only the pinned tenant workspace may be used");
      if (suffix.endsWith("/reports") || suffix.endsWith("/datasets")) {
        assert.equal(_token, "tenant-only-token");
        if (state.failSync) throw new AppError(503, "Upstream503", "Inventory unavailable.");
        if (suffix.endsWith("/reports")) {
          state.syncs++;
          return { value: [{ id: ids.report, name: "Store Sales", datasetId: ids.model, embedUrl: "https://app.powerbi.com/reportEmbed" },
            { id: ids.otherReport, name: "Unrelated content", datasetId: ids.model, embedUrl: "https://app.powerbi.com/reportEmbed" }] };
        }
        return { value: [{ id: ids.model, name: "Store Sales", isEffectiveIdentityRequired: state.sampleRls }] };
      }
      if (suffix.endsWith("/users")) {
        if (method === "GET") return { value: structuredClone(memberships) };
        state.grantWrites++; memberships.push({ identifier: payload.identifier!, groupUserAccessRight: "Admin" }); return {};
      }
      if (suffix.endsWith("/AssignToCapacity")) {
        state.assignments++;
        if (state.failAssignment) throw new AppError(502, "Upstream403", "Assignment forbidden.");
        assignment = payload.capacityId; return {};
      }
      if (method === "PATCH") { workspace.name = payload.name!; return {}; }
      if (assignment && ++state.assignmentReads > 1) workspace.capacityId = assignment;
      return structuredClone(workspace);
    },
    readiness: async (id: string) => {
      state.readinessCalls++;
      assert.ok(memberships.some(m => equal(m.identifier, getTenant(id).EmbeddingObjectId)));
      return { state: state.runtimeReady && state.readinessCalls > 1 ? "Ready" : "Unknown" };
    },
  });
  const service = new TenantProvisioner(repo, azure, fabric, async () => {
    state.waits++; await options.wait?.();
  }, options.pollLimit ?? 8);
  const worker = service.execute.bind(service);
  service.execute = async (id, token) => { tasks.push(() => worker(id, token)); };
  const input = (capacity: "existing" | "new" = "existing") => setupSchema.parse({
    requestId: randomUUID(), name: "Customer workspace", administratorUpn: "admin@contoso.com",
    capacity: capacity === "new" ? { mode: "new", sku: "F2", confirmBilling: true } : { mode: "existing", id: ids.capacity },
  });
  return { service, repo, azure, fabric, worker, state, tenants, operations, users, workspaces, content, nodes, sql, input,
    drain: async () => { while (tasks.length) await tasks.shift()!(); } };
}

it("provisions identity, billable capacity, workspace, access and admin in order, waiting for actual readiness", async () => {
  const f = fixture(), input = f.input("new");
  const initial = await f.service.start(input, actor, "operator@contoso.com", "server-only");
  assert.equal(initial.status, "Running"); assert.equal(f.state.identityCreations, 0);
  assert.equal((await f.service.start(input, actor, "operator@contoso.com", "server-only")).id, initial.id);
  await f.drain();
  const result = f.service.view(await f.service.operation(initial.id));
  assert.equal(result.status, "Succeeded"); assert.ok(result.steps.every(s => s.status === "done"));
  assert.equal(f.state.identityCreations, 1); assert.equal(f.state.workspaceCreations, 1); assert.equal(f.state.capacityCreations, 1);
  assert.ok(f.state.capacityReads > 1 && f.state.discoveryReads > 1 && f.state.assignmentReads > 1 && f.state.readinessCalls > 1);
  assert.equal(f.tenants.get(initial.tenantId)!.Status, "Ready");
  assert.equal(f.users[0]!.IsTenantAdmin, true); assert.equal(f.users[0]!.DefaultPermissions, allPermissions);
  assert.equal(f.users[0]!.IsPlatformAdmin, false);
  assert.equal(f.sql.find(q => q.text.startsWith("INSERT app.Audit"))!.params.actorId, actor.Id);
  assert.ok(!JSON.stringify([...f.operations.values()]).includes("server-only"));
  assert.equal(f.sql.filter(q => q.text.startsWith("INSERT app.Tenants")).length, 1);
  assert.equal(f.state.sampleUploads, 0); assert.equal(f.state.syncs, 0);
  assert.ok(!result.steps.some(step => step.key === "sample"));
});

it("seeds an opted-in new tenant, synchronizes metadata/navigation and publishes only the returned sample artifacts", async () => {
  const f = fixture();
  const first = await f.service.start({ ...f.input(), includeSample: true }, actor, "operator@contoso.com", "operator-token");
  await f.drain();
  assert.equal(f.service.view(await f.service.operation(first.id)).status, "Succeeded");
  assert.equal(f.state.sampleUploads, 1); assert.ok(f.state.sampleReads > 1);
  assert.equal(f.content.length, 3);
  assert.deepEqual(f.content.filter(c => c.Published).map(c => c.ExternalId).sort(), [ids.report, ids.model].sort());
  assert.ok(f.content.every(c => c.TenantId === first.tenantId && f.nodes.some(n => n.ContentItemId === c.Id)));
  assert.equal(f.users[0]!.DefaultPermissions, allPermissions);
  await assert.rejects(f.service.start({ ...f.input(), includeSample: true }, actor, "operator@contoso.com", "token", first.tenantId),
    { code: "NewTenantSampleOnly" });
  assert.equal(f.state.sampleUploads, 1);
});

it("lets an own-tenant admin add the sample once without infrastructure, role, grant or readiness changes", async () => {
  const f = fixture();
  const setup = await f.service.start(f.input(), actor, "operator@contoso.com", "token"); await f.drain();
  const admin = f.users[0]!; admin.DefaultPermissions = 0;
  assert.equal((await f.service.sampleStatus(admin)).operation, null);
  await assert.rejects(f.service.addSample(admin, setup.id), { code: "RequestIdConflict" });
  const requestId = randomUUID(), sample = await f.service.addSample(admin, requestId);
  assert.equal(sample.status, "Running");
  assert.equal((await f.service.addSample(admin, requestId)).id, sample.id);
  assert.equal((await f.service.addSample(admin, randomUUID())).id, sample.id);
  await f.drain();
  assert.equal((await f.service.sampleStatus(admin)).operation?.status, "Succeeded");
  assert.equal(f.tenants.get(setup.tenantId)!.Status, "Ready");
  assert.equal(f.state.sampleUploads, 1); assert.equal(f.operations.size, 2);
  assert.equal(f.state.identityCreations, 1); assert.equal(f.state.workspaceCreations, 1);
  assert.equal(f.state.capacityCreations, 0); assert.equal(f.state.assignments, 1);
  assert.equal(admin.DefaultPermissions, 0);
  assert.deepEqual(f.content.filter(c => c.Published).map(c => c.ExternalId).sort(), [ids.model, ids.report].sort());
  f.content.forEach(c => { c.Published = false; });
  assert.equal((await f.service.addSample(admin, randomUUID())).id, sample.id);
  await f.drain();
  assert.equal(f.state.sampleUploads, 1); assert.ok(f.content.every(c => !c.Published));
  assert.ok(f.sql.some(q => q.text.startsWith("INSERT app.Audit") && q.params.action === "AddSampleReport"));
});

it("recognizes the sample seeded during platform setup rather than importing or republishing it", async () => {
  const f = fixture();
  const setup = await f.service.start({ ...f.input(), includeSample: true }, actor, "operator@contoso.com", "token");
  await f.drain();
  f.content.forEach(c => { c.Published = false; });
  const sample = await f.service.addSample(f.users[0]!, randomUUID());
  assert.equal(sample.id, setup.id); assert.equal(sample.status, "Succeeded"); assert.equal(sample.canRetry, false);
  assert.equal(f.state.sampleUploads, 1); assert.equal(f.operations.size, 1);
  assert.ok(f.content.every(c => !c.Published));
});

it("allows adding the sample after a later setup succeeds when the original setup failed before importing", async () => {
  const f = fixture(), provisionIdentity = f.fabric.provisionIdentity;
  f.fabric.provisionIdentity = async id => {
    await provisionIdentity(id);
    throw new AppError(502, "Upstream403", "Identity access forbidden.");
  };
  const original = await f.service.start({ ...f.input(), includeSample: true }, actor, "operator@contoso.com", "token");
  await f.drain();
  assert.equal(f.service.view(await f.service.operation(original.id)).status, "Failed");
  assert.equal(f.state.sampleUploads, 0);
  f.fabric.provisionIdentity = provisionIdentity;
  const replacement = await f.service.start(f.input(), actor, "operator@contoso.com", "token", original.tenantId);
  const admin = member(original.tenantId, ids.admin, true);
  assert.equal((await f.service.sampleStatus(admin)).operation?.id, original.id,
    "An unfinished replacement must not hide the original setup failure");
  await f.drain();
  assert.equal(f.service.view(await f.service.operation(replacement.id)).status, "Succeeded");
  assert.equal((await f.service.sampleStatus(f.users[0]!)).operation, null);
  await assert.rejects(f.service.retry(original.id, actor, "token"), { code: "CannotRetry" });
  const sample = await f.service.addSample(f.users[0]!, randomUUID());
  assert.notEqual(sample.id, original.id); assert.equal(sample.status, "Running");
  await f.drain();
  assert.equal((await f.service.sampleStatus(f.users[0]!)).operation?.status, "Succeeded");
  assert.equal(f.state.sampleUploads, 1);
  assert.equal(f.state.identityCreations, 1); assert.equal(f.state.workspaceCreations, 1);
  await assert.rejects(f.service.retry(original.id, actor, "token"), { code: "CannotRetry" });
  assert.equal(f.tenants.get(original.tenantId)!.Status, "Ready");
  assert.equal(f.service.view(await f.service.operation(original.id)).status, "Failed",
    "The historical failure must remain intact for platform diagnostics");
});

it("does not bypass an attempted sample import after a later setup succeeds", async () => {
  for (const failure of ["samplePending", "ambiguousUpload", "sampleFailed", "sampleDenied"] as const) {
    const f = fixture({ pollLimit: 2 }); f.state[failure] = true;
    const original = await f.service.start({ ...f.input(), includeSample: true }, actor, "operator@contoso.com", "token");
    await f.drain();
    assert.equal(f.service.view(await f.service.operation(original.id)).status, "Failed");
    const replacement = await f.service.start(f.input(), actor, "operator@contoso.com", "token", original.tenantId);
    await f.drain();
    assert.equal(f.service.view(await f.service.operation(replacement.id)).status, "Succeeded");
    assert.equal((await f.service.sampleStatus(f.users[0]!)).operation?.id, original.id);
    assert.equal((await f.service.addSample(f.users[0]!, randomUUID())).id, original.id);
    await f.drain();
    assert.equal(f.state.sampleUploads, 1);
  }
});

it("retries tenant-admin imports with the saved ID while leaving unrelated tenant availability unchanged", async () => {
  const f = fixture({ pollLimit: 2 });
  const setup = await f.service.start(f.input(), actor, "operator@contoso.com", "token"); await f.drain();
  const admin = f.users[0]!;
  f.state.samplePending = true;
  const sample = await f.service.addSample(admin, randomUUID()); await f.drain();
  assert.equal((await f.service.sampleStatus(admin)).operation?.canRetry, true);
  assert.equal(f.tenants.get(setup.tenantId)!.Status, "Ready");
  await assert.rejects(f.service.retrySample(setup.id, admin), { code: "NotFound" });
  const otherTenant = emptyTenant(randomUUID(), "Other");
  f.tenants.set(otherTenant.Id, otherTenant);
  await assert.rejects(f.service.retrySample(sample.id, member(otherTenant.Id, randomUUID(), true)), { code: "NotFound" });
  const otherAdmin = member(setup.tenantId, randomUUID(), true);
  f.users.push(otherAdmin);
  assert.equal((await f.service.sampleStatus(otherAdmin)).operation?.canRetry, false);
  await assert.rejects(f.service.retrySample(sample.id, otherAdmin), { code: "OriginalOperatorRequired" });
  f.state.samplePending = false;
  await f.service.retrySample(sample.id, admin); await f.drain();
  assert.equal((await f.service.sampleStatus(admin)).operation?.status, "Succeeded");
  assert.equal(f.state.sampleUploads, 1);
});

it("rejects unready/protected tenants and rechecks the initiating admin and workspace before importing", async () => {
  const f = fixture();
  const setup = await f.service.start(f.input(), actor, "operator@contoso.com", "token"); await f.drain();
  const admin = f.users[0]!, tenant = f.tenants.get(setup.tenantId)!;
  await assert.rejects(f.service.addSample(actor, randomUUID()), { code: "TenantAdminRequired" });
  f.operations.get(setup.id)!.Status = "Running";
  await assert.rejects(f.service.addSample(admin, randomUUID()), { code: "SetupInProgress" });
  f.operations.get(setup.id)!.Status = "Succeeded";
  tenant.Status = "NeedsConfiguration";
  await assert.rejects(f.service.addSample(admin, randomUUID()), { code: "TenantNotReady" });
  tenant.Status = "Ready"; tenant.WorkspaceId = ids.managementWorkspace;
  await assert.rejects(f.service.addSample(admin, randomUUID()), { code: "ProtectedManagementResource" });
  tenant.WorkspaceId = ids.workspace;
  const sample = await f.service.addSample(admin, randomUUID());
  admin.IsTenantAdmin = false; await f.drain();
  assert.equal(f.service.view(await f.service.operation(sample.id)).status, "Failed");
  assert.equal(f.state.sampleUploads, 0); assert.equal(tenant.Status, "Ready");
  admin.IsTenantAdmin = true; tenant.WorkspaceId = randomUUID();
  await assert.rejects(f.service.retrySample(sample.id, admin), { code: "TenantNotReady" });
  tenant.WorkspaceId = ids.workspace;
  await f.service.retrySample(sample.id, admin); await f.drain();
  assert.equal(f.service.view(await f.service.operation(sample.id)).status, "Succeeded");
  assert.equal(f.state.sampleUploads, 1);
});

it("resumes a pending sample import and a failed metadata sync without uploading the PBIX again", async () => {
  const f = fixture({ pollLimit: 2 }); f.state.samplePending = true;
  const first = await f.service.start({ ...f.input(), includeSample: true }, actor, "operator@contoso.com", "token");
  await f.drain();
  assert.equal(f.service.view(await f.service.operation(first.id)).canRetry, true);
  assert.equal(JSON.parse(f.operations.get(first.id)!.StateJson).sample.importId, ids.sampleImport);
  f.state.samplePending = false; f.state.failSync = true;
  await f.service.retry(first.id, actor, "fresh-token"); await f.drain();
  assert.equal(f.service.view(await f.service.operation(first.id)).canRetry, true);
  f.state.failSync = false;
  await f.service.retry(first.id, actor, "fresh-token"); await f.drain();
  assert.equal(f.service.view(await f.service.operation(first.id)).status, "Succeeded");
  assert.equal(f.state.sampleUploads, 1);
  const row = f.operations.get(first.id)!, checkpoint = JSON.parse(row.StateJson);
  assert.equal(checkpoint.sample.published, true);
  f.content.forEach(c => { c.Published = false; });
  checkpoint.steps.find((s: { key: string }) => s.key === "sample").status = "running";
  row.StateJson = JSON.stringify(checkpoint); row.Status = "Failed";
  await f.service.retry(first.id, actor, "token"); await f.drain();
  assert.equal(f.service.view(await f.service.operation(first.id)).status, "Succeeded");
  assert.equal(f.state.sampleUploads, 1);
  assert.ok(f.content.every(c => !c.Published), "A retry must preserve post-seeding publication edits");
});

it("fails closed for unknown or failed sample imports and unsupported model security", async () => {
  for (const failure of ["ambiguousUpload", "sampleFailed", "sampleRls"] as const) {
    const f = fixture(); f.state[failure] = true;
    const first = await f.service.start({ ...f.input(), includeSample: true }, actor, "operator@contoso.com", "token");
    await f.drain();
    const result = f.service.view(await f.service.operation(first.id));
    assert.equal(result.status, "Failed"); assert.equal(f.tenants.get(first.tenantId)!.Status, "NeedsConfiguration");
    assert.ok(f.content.every(c => !c.Published));
    if (failure !== "sampleRls") {
      assert.equal(result.recoveryRequired, true); assert.equal(result.canRetry, false);
      await assert.rejects(f.service.retry(first.id, actor, "token"), { code: "CannotRetry" });
    }
    assert.equal(f.state.sampleUploads, 1);
  }
});

it("allows retry after a definitively denied sample upload without recreating the tenant resources", async () => {
  const f = fixture(); f.state.sampleDenied = true;
  const first = await f.service.start({ ...f.input(), includeSample: true }, actor, "operator@contoso.com", "token");
  await f.drain();
  assert.equal(f.service.view(await f.service.operation(first.id)).canRetry, true);
  f.state.sampleDenied = false;
  await f.service.retry(first.id, actor, "token"); await f.drain();
  assert.equal(f.service.view(await f.service.operation(first.id)).status, "Succeeded");
  assert.equal(f.state.sampleUploads, 2);
  assert.equal(f.state.workspaceCreations, 1); assert.equal(f.state.identityCreations, 1);
});

it("shares an existing capacity across tenant setups without creating or reserving compute", async () => {
  for (let count = 0; count < 2; count++) {
    const f = fixture(), operation = await f.service.start(f.input(), actor, "operator@contoso.com", "token");
    await f.drain();
    assert.equal(f.service.view(await f.service.operation(operation.id)).status, "Succeeded");
    assert.equal(f.state.capacityCreations, 0); assert.equal(f.state.assignments, 1);
    assert.equal(f.workspaces.get(ids.workspace)!.capacityId, ids.capacity);
  }
});

it("grants full initial tenant permissions when attaching an unassigned platform admin", async () => {
  const f = fixture();
  const platformAdmin = { ...actor, Id: randomUUID(), ObjectId: ids.admin };
  f.users.push(platformAdmin);
  const operation = await f.service.start(f.input(), actor, "operator@contoso.com", "token");
  await f.drain();
  assert.equal(f.service.view(await f.service.operation(operation.id)).status, "Succeeded");
  assert.equal(platformAdmin.TenantId, operation.tenantId);
  assert.equal(platformAdmin.IsTenantAdmin, true);
  assert.equal(platformAdmin.IsPlatformAdmin, true);
  assert.equal(platformAdmin.DefaultPermissions, allPermissions);
});

it("does not reapply initial permissions when resuming after the admin transaction committed", async () => {
  const f = fixture(); f.state.runtimeReady = false;
  const operation = await f.service.start(f.input(), actor, "operator@contoso.com", "token");
  await f.drain();
  const admin = f.users[0]!, row = f.operations.get(operation.id)!;
  assert.equal(admin.DefaultPermissions, allPermissions);
  admin.DefaultPermissions = 1;
  const checkpoint = JSON.parse(row.StateJson);
  checkpoint.steps.find((step: { key: string }) => step.key === "administrator").status = "running";
  checkpoint.steps.find((step: { key: string }) => step.key === "verification").status = "pending";
  row.StateJson = JSON.stringify(checkpoint);
  row.Status = "Running"; row.LeaseUntil = new Date(Date.now() - 1000);
  f.state.runtimeReady = true;
  await f.service.retry(operation.id, actor, "token"); await f.drain();
  assert.equal(f.service.view(await f.service.operation(operation.id)).status, "Succeeded");
  assert.equal(admin.DefaultPermissions, 1);
});

it("loads and edits existing settings without recreating identities/workspaces or changing report grants", async () => {
  const f = fixture(), first = await f.service.start(f.input(), actor, "operator@contoso.com", "token");
  await f.drain();
  const tenant = f.tenants.get(first.tenantId)!, originalAdmin = f.users[0]!;
  originalAdmin.DefaultPermissions = 17;
  const otherAdmin = member(tenant.Id, randomUUID(), true, 1);
  f.users.push(otherAdmin);
  const replacement = member(tenant.Id, randomUUID(), false, 9); f.users.push(replacement);
  f.azure.resolveUserPrincipalName = async () => ({ objectId: replacement.ObjectId, displayName: "Replacement" });
  const input = { ...f.input(), name: "Renamed workspace", administratorUpn: "replacement@contoso.com" };
  await assert.rejects(f.service.start(input, actor, "operator@contoso.com", "token", tenant.Id), { code: "ConfirmAdministratorChange" });
  const operation = await f.service.start({ ...input, replaceAdministrator: true }, actor, "operator@contoso.com", "token", tenant.Id);
  await f.drain();
  assert.equal(f.service.view(await f.service.operation(operation.id)).status, "Succeeded");
  assert.equal(f.state.identityCreations, 1); assert.equal(f.state.workspaceCreations, 1); assert.equal(f.state.assignments, 1);
  assert.equal(originalAdmin.IsTenantAdmin, false); assert.equal(originalAdmin.TenantId, tenant.Id); assert.equal(originalAdmin.DefaultPermissions, 17);
  assert.equal(replacement.IsTenantAdmin, true); assert.equal(replacement.DefaultPermissions, 9); assert.equal(otherAdmin.IsTenantAdmin, true);
  const settings = await f.service.settings(tenant.Id, "token");
  assert.equal(settings.workspace!.name, "Renamed workspace"); assert.equal(settings.administratorUpn, "replacement@contoso.com");
  assert.ok(!f.sql.some(q => /(?:UPDATE|DELETE|INSERT) app\.(?:Grants|Content)/.test(q.text)));
});

it("rejects cross-tenant admins and management capacity before creating resources", async () => {
  const f = fixture(); f.users.push(member(randomUUID()));
  await assert.rejects(f.service.start(f.input(), actor, "operator@contoso.com", "token"), { code: "AlreadyRegistered" });
  f.users.length = 0;
  await assert.rejects(f.service.start({ ...f.input(), capacity: { mode: "existing", id: ids.management } },
    actor, "operator@contoso.com", "token"), { status: 409 });
  assert.equal(f.tenants.size, 0); assert.equal(f.operations.size, 0); assert.equal(f.state.identityCreations, 0);
});

it("retries a failed assignment from checkpoints, rejects competing operations and requires the original operator", async () => {
  const f = fixture(); f.state.failAssignment = true;
  const input = f.input(), first = await f.service.start(input, actor, "operator@contoso.com", "token");
  await assert.rejects(f.service.start(f.input(), actor, "operator@contoso.com", "token", first.tenantId), { code: "SetupInProgress" });
  await f.drain();
  assert.equal(f.service.view(await f.service.operation(first.id)).canRetry, true);
  await assert.rejects(f.service.retry(first.id, { ...actor, Id: randomUUID() }, "token"), { status: 403 });
  f.state.failAssignment = false;
  await f.service.retry(first.id, actor, "refreshed-token"); await f.drain();
  assert.equal(f.service.view(await f.service.operation(first.id)).status, "Succeeded");
  assert.equal(f.state.identityCreations, 1); assert.equal(f.state.workspaceCreations, 1); assert.equal(f.state.grantWrites, 1);
});

it("does not recreate a workspace after an ambiguous creation outcome, including a new setup request", async () => {
  const f = fixture(); f.state.failWorkspace = true;
  const first = await f.service.start(f.input(), actor, "operator@contoso.com", "token");
  await f.drain();
  const failed = f.service.view(await f.service.operation(first.id));
  assert.equal(failed.recoveryRequired, true); assert.equal(failed.canRetry, false);
  await assert.rejects(f.service.retry(first.id, actor, "token"), { code: "CannotRetry" });
  await assert.rejects(f.service.start(f.input(), actor, "operator@contoso.com", "token", first.tenantId), { code: "RecoveryRequired" });
  assert.equal(f.state.workspaceCreations, 1);
});

it("retries a definitively denied capacity creation against the same generated name", async () => {
  const f = fixture(); f.state.failCapacity = true;
  const first = await f.service.start(f.input("new"), actor, "operator@contoso.com", "token");
  await f.drain();
  const name = JSON.parse((await f.service.operation(first.id)).StateJson).capacityName;
  f.state.failCapacity = false;
  await f.service.retry(first.id, actor, "token"); await f.drain();
  assert.equal(f.service.view(await f.service.operation(first.id)).status, "Succeeded");
  assert.equal(JSON.parse((await f.service.operation(first.id)).StateJson).capacityName, name);
  assert.equal(f.state.identityCreations, 1); assert.equal(f.state.capacityCreations, 2);
});

it("keeps a tenant unready when runtime verification times out and safely retries verification only", async () => {
  const f = fixture(); f.state.runtimeReady = false;
  const first = await f.service.start(f.input(), actor, "operator@contoso.com", "token");
  await f.drain();
  assert.equal(f.service.view(await f.service.operation(first.id)).status, "Failed");
  assert.equal(f.tenants.get(first.tenantId)!.Status, "NeedsConfiguration");
  f.state.runtimeReady = true; await f.service.retry(first.id, actor, "token"); await f.drain();
  assert.equal(f.service.view(await f.service.operation(first.id)).status, "Succeeded");
  assert.equal(f.state.workspaceCreations, 1); assert.equal(f.state.assignments, 1);
});

it("recovers expired and never-claimed operations without stealing a live lease", async () => {
  const f = fixture(), first = await f.service.start(f.input(), actor, "operator@contoso.com", "token");
  const row = f.operations.get(first.id)!;
  row.LeaseOwner = randomUUID(); row.LeaseUntil = new Date(Date.now() + 90_000);
  await f.worker(first.id, "token"); assert.equal(f.state.identityCreations, 0);
  row.LeaseUntil = null; row.UpdatedAt = new Date(Date.now() - 100_000);
  assert.equal(f.service.view(row).status, "Interrupted");
  await f.service.retry(first.id, actor, "token"); await f.drain();
  assert.equal(f.service.view(await f.service.operation(first.id)).status, "Succeeded");
});

it("an in-flight heartbeat cannot revert a terminal operation or overwrite completed progress", async context => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  let blockedOnce = false;
  const f = fixture({ wait: async () => { if (!blockedOnce) { blockedOnce = true; entered(); await blocked; } } });
  const first = await f.service.start(f.input("new"), actor, "operator@contoso.com", "token");
  let finishHeartbeat!: () => void;
  f.state.heartbeat = complete => new Promise(resolve => { finishHeartbeat = () => resolve(complete()); });
  const running = f.drain(); await waiting;
  context.mock.timers.tick(20_000);
  release(); await running;
  assert.equal(f.service.view(await f.service.operation(first.id)).status, "Succeeded");
  finishHeartbeat(); await Promise.resolve(); await Promise.resolve();
  const final = f.service.view(await f.service.operation(first.id));
  assert.equal(final.status, "Succeeded"); assert.ok(final.steps.every(s => s.status === "done"));
});
