import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertCapacityNamespace, assertEmbedding, assertMove, assertNotManagementResource, effectivePermissions, Permission, tenantIdentityNames, tokenPayload,
  type User, type Tenant, type ContentItem, type NavigationNode, type Grant } from "../src/domain.js";
import { FabricService } from "../src/fabric.js";
import type { Repository } from "../src/repository.js";
import type { AzureServices } from "../src/azure.js";

const user: User = { Id: "user", TenantId: "tenant-a", DirectoryId: "directory", ObjectId: "object",
  DisplayName: "Test", IsPlatformAdmin: true, IsTenantAdmin: true, DefaultPermissions: 1 };
const tenant = { Id: "tenant-a", WorkspaceId: "workspace-a" } as Tenant;
const report: ContentItem = { Id: "report", TenantId: "tenant-a", ExternalId: "external-report",
  Kind: "Report", Name: "Report", ModelExternalId: "external-model", EmbedUrl: null, Published: true,
  Deleted: false, RequiresIdentity: false, UnsafeDependency: false };
const model: ContentItem = { ...report, Id: "model", ExternalId: "external-model", Kind: "Model", ModelExternalId: null };
const nodes: NavigationNode[] = [
  { Id: "root", TenantId: "tenant-a", ParentId: null, ContentItemId: null, Label: "Root", BreakInheritance: false, SortOrder: 0 },
  { Id: "folder", TenantId: "tenant-a", ParentId: "root", ContentItemId: null, Label: "Folder", BreakInheritance: false, SortOrder: 0 },
  { Id: "leaf", TenantId: "tenant-a", ParentId: "folder", ContentItemId: "report", Label: "Report", BreakInheritance: false, SortOrder: 0 },
];
const grants: Grant[] = [{ TenantId: "tenant-a", NodeId: "folder", UserId: "user", Mask: 2 }];

describe("deployment namespace compatibility", () => {
  it("protects management workspace/capacity identifiers without blocking customer or legacy resources", () => {
    assert.throws(() => assertNotManagementResource("management-id", "MANAGEMENT-ID"), /Management infrastructure/);
    assert.doesNotThrow(() => assertNotManagementResource("customer-id", "management-id"));
    assert.doesNotThrow(() => assertNotManagementResource("customer-id", ""));
    assert.doesNotThrow(() => assertNotManagementResource(null, "management-id"));
  });
  it("uses the namespace for new tenant identities but preserves an existing secret reference", () => {
    const names = tenantIdentityNames("cgm-pbiembedded", "tenant-a", null);
    assert.match(names.displayName, /^cgm-pbiembedded-tenant-/);
    assert.match(names.secretName, /^cgm-pbiembedded-tenant-/);
    assert.equal(tenantIdentityNames("cgm-pbiembedded", "tenant-a", "existing-credential").secretName, "existing-credential");
    assert.equal(tenantIdentityNames("", "tenant-a", null).secretName, "tenant-tenanta");
  });
  it("enforces the hyphen-free namespace on new capacities without changing legacy deployments", () => {
    assert.doesNotThrow(() => assertCapacityNamespace("cgmpbiembeddedcap01", "cgm-pbiembedded"));
    assert.throws(() => assertCapacityNamespace("unrelatedcap01", "cgm-pbiembedded"), /must start/);
    assert.doesNotThrow(() => assertCapacityNamespace("existingcap01", ""));
  });
});

describe("tenant and hierarchy authorization", () => {
  it("inherits ancestor grants and root defaults", () => assert.equal(effectivePermissions(user, "leaf", nodes, grants), 3));
  it("breaks inheritance without accidentally retaining root defaults", () => {
    const changed = nodes.map(n => n.Id === "folder" ? { ...n, BreakInheritance: true } : n);
    assert.equal(effectivePermissions(user, "leaf", changed, grants), 2);
  });
  it("does not grant report access just because a user is platform/tenant admin", () => {
    assert.throws(() => assertEmbedding(user, tenant, report, model, 0, "view"), /permission/);
  });
  it("ignores another tenant's grants and node IDs", () => {
    assert.equal(effectivePermissions(user, "leaf", nodes, [{ ...grants[0]!, TenantId: "tenant-b", Mask: 127 }]), 1);
    assert.equal(effectivePermissions({ ...user, TenantId: "tenant-b" }, "leaf", nodes, grants), 0);
  });
  it("rejects cross-tenant report and model references", () => {
    assert.throws(() => assertEmbedding(user, tenant, { ...report, TenantId: "tenant-b" }, model, 127, "view"), /tenant/);
    assert.throws(() => assertEmbedding(user, tenant, report, { ...model, TenantId: "tenant-b" }, 127, "view"), /tenant/);
  });
  it("rejects unpublished content even with inherited full access", () => {
    assert.throws(() => assertEmbedding(user, tenant, { ...report, Published: false }, model, 127, "view"), /unpublished/);
  });
  it("fails closed for models requiring an effective identity", () => {
    assert.throws(() => assertEmbedding(user, tenant, report, { ...model, RequiresIdentity: true }, 127, "view"), /effective identity/);
  });
  it("requires authoring rights for edits and edit/create rights for copying", () => {
    assert.throws(() => assertEmbedding(user, tenant, report, model, 3, "edit"), /authoriz/);
    assert.throws(() => assertEmbedding(user, tenant, report, model, 29, "copy"), /permission/);
    assert.doesNotThrow(() => assertEmbedding(user, tenant, report, model, 31, "copy"));
  });
  it("checks semantic-model authoring independently of report editing", () => {
    assert.throws(() => assertEmbedding(user, tenant, report, model, 127, "edit", 0), /authoriz/);
    assert.doesNotThrow(() => assertEmbedding(user, tenant, report, model, 3, "edit", Permission.UseSemanticModelForAuthoring));
    assert.throws(() => assertEmbedding(user, tenant, report, { ...model, Published: false }, 127, "edit", 127), /published/);
  });
  it("rejects cycles and cross-tenant navigation parents", () => {
    assert.throws(() => assertMove("folder", "leaf", nodes, "tenant-a"), /folder/);
    assert.throws(() => assertMove("folder", "folder", nodes, "tenant-a"), /cycle/);
    assert.throws(() => assertMove("root", "folder", nodes, "tenant-a"), /root/);
    assert.throws(() => assertMove("leaf", "folder", nodes, "tenant-b"), /root/);
  });
  it("issues view/edit tokens without creation workspaces and scopes copy to one workspace", () => {
    assert.deepEqual(tokenPayload("r", "m", "w", "view"), { reports: [{ id: "r", allowEdit: false }], datasets: [{ id: "m" }] });
    assert.deepEqual(tokenPayload("r", "m", "w", "edit"), { reports: [{ id: "r", allowEdit: true }], datasets: [{ id: "m" }] });
    assert.deepEqual(tokenPayload("r", "m", "w", "copy").targetWorkspaces, [{ id: "w" }]);
  });
});
describe("backend token generation boundary", () => {
  it("denies viewing and authoring for platform-only users before reading tenant data or contacting Power BI", async () => {
    const service = new FabricService({} as Repository, {} as AzureServices);
    const platformOnly = { ...user, TenantId: null, IsTenantAdmin: false };
    await assert.rejects(service.embed(platformOnly, report.Id, "view"), /tenant membership/);
    await assert.rejects(service.createReport(platformOnly, model.Id), /tenant membership/);
    assert.equal(effectivePermissions(platformOnly, "leaf", nodes, grants), 0);
  });
  it("rejects a tenant mapped to the management workspace before provisioning or token requests", async () => {
    const service = new FabricService({} as Repository,
      { config: { ManagementWorkspaceId: "management-workspace" } } as AzureServices);
    await assert.rejects(service.runtimeToken({ ...tenant, WorkspaceId: "MANAGEMENT-WORKSPACE" }), /Management infrastructure/);
  });
  function fixture(items: ContentItem[]) {
    let remoteCalls = 0;
    const repository = {
      tenant: async (id: string) => { assert.equal(id, user.TenantId); return tenant; },
      content: async (id: string) => { assert.equal(id, user.TenantId); return items; },
      security: async () => ({ nodes: [...nodes, { ...nodes[2]!, Id: "model-leaf", ContentItemId: model.Id }], grants }),
    } as unknown as Repository;
    const service = new FabricService(repository, {} as AzureServices);
    service.runtimeToken = async () => { remoteCalls++; return "test-only"; };
    return { service, calls: () => remoteCalls };
  }
  it("does not contact Power BI for an inaccessible report", async () => {
    const test = fixture([]);
    await assert.rejects(test.service.embed(user, "another-tenant-report", "view"), /your tenant/);
    assert.equal(test.calls(), 0);
  });
  it("does not generate any token for an unreviewed report", async () => {
    const test = fixture([{ ...report, Published: false }, model]);
    await assert.rejects(test.service.embed(user, report.Id, "view"), /unpublished/);
    assert.equal(test.calls(), 0);
  });
  it("rejects a live report that was rebound after synchronization", async () => {
    const test = fixture([report, model]);
    let generated = false;
    test.service.operator = async <T>(_token: string, suffix: string): Promise<T> => {
      if (suffix === "/GenerateToken") { generated = true; return {} as T; }
      if (suffix.endsWith("/datasets/external-model")) return { id: "external-model" } as T;
      if (suffix.endsWith("/reports/external-report")) return { datasetId: "other-model" } as T;
      return { isOnDedicatedCapacity: true, capacityId: "capacity" } as T;
    };
    await assert.rejects(test.service.embed(user, report.Id, "view"), /dependencies changed/);
    assert.equal(generated, false);
  });
  it("rechecks live RLS before generating any token", async () => {
    const test = fixture([report, model]);
    let generated = false;
    test.service.operator = async <T>(_token: string, suffix: string): Promise<T> => {
      if (suffix === "/GenerateToken") { generated = true; return {} as T; }
      return (suffix.includes("/datasets/") ? { isEffectiveIdentityRequired: true } : { isOnDedicatedCapacity: true, capacityId: "capacity" }) as T;
    };
    await assert.rejects(test.service.embed(user, report.Id, "view"), /effective-identity RLS/);
    assert.equal(generated, false);
  });
  it("returns only the authorized tenant destination for new reports and copies, never for view/edit", async () => {
    const test = fixture([report, model]);
    const actor = { ...user, DefaultPermissions: 127 };
    const generated: unknown[] = [];
    test.service.operator = async <T>(_token: string, suffix: string, _method?: string, body?: unknown): Promise<T> => {
      if (suffix === "/GenerateToken") {
        generated.push(body);
        return { token: "test-only", expiration: new Date(Date.now() + 3_600_000).toISOString() } as T;
      }
      if (suffix.endsWith("/reports/external-report")) return { datasetId: model.ExternalId,
        embedUrl: "https://app.powerbi.com/reportEmbed" } as T;
      return { isOnDedicatedCapacity: true, capacityId: "capacity" } as T;
    };
    for (const mode of ["view", "edit", "copy"] as const) {
      const result = await test.service.embed(actor, report.Id, mode);
      assert.equal(result.targetWorkspaceId, mode === "copy" ? tenant.WorkspaceId : undefined);
      assert.deepEqual(generated.at(-1), tokenPayload(report.ExternalId, model.ExternalId, tenant.WorkspaceId!, mode));
    }
    const result = await test.service.createReport(actor, model.Id);
    assert.equal(result.targetWorkspaceId, tenant.WorkspaceId);
    assert.deepEqual(generated.at(-1), { datasets: [{ id: model.ExternalId }], targetWorkspaces: [{ id: tenant.WorkspaceId }] });
    const before = generated.length;
    await assert.rejects(test.service.embed({ ...actor, DefaultPermissions: 3 | 16 }, report.Id, "copy"), /permission/);
    await assert.rejects(test.service.embed({ ...actor, DefaultPermissions: 3 | 8 | 16 }, report.Id, "copy"), /tenant root/);
    await assert.rejects(test.service.createReport({ ...actor, DefaultPermissions: 4 }, model.Id), /authoring permissions/);
    assert.equal(generated.length, before, "Denied save/create actions must not generate a token");
  });
});
