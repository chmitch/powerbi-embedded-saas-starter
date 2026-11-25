import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDemoData, manageDemoData } from "../src/demo-data.js";
import { consolidateDemoData, demoSampleCatalog, demoSampleRevision, DemoSamplePackage, validateSampleAsset,
  type SampleBinding } from "../src/demo-samples.js";
import { effectivePermissions, Permission, type Grant, type NavigationNode, type User, type Tenant } from "../src/domain.js";
import type { Repository } from "../src/repository.js";
import type { AzureServices } from "../src/azure.js";
import type { FabricService } from "../src/fabric.js";
import type { Database, Params } from "../src/db.js";

const tenantId = randomUUID(), workspaceId = randomUUID();
const original = buildDemoData(tenantId, workspaceId, randomUUID(), new Date("2026-11-24T18:00:00Z"));
function bindings(): SampleBinding[] {
  return demoSampleCatalog.map(sample => {
    const modelId = randomUUID(), contentId = randomUUID();
    return { key: sample.key, reportId: randomUUID(), modelId, reportContentId: randomUUID(),
      embedUrl: `https://app.powerbi.com/reportEmbed?reportId=${randomUUID()}`,
      model: { Id: contentId, TenantId: tenantId, ExternalId: modelId, Kind: "Model", Name: `[DEMO] ${sample.title}`,
        ModelExternalId: null, EmbedUrl: null, Published: false, Deleted: false, RequiresIdentity: false, UnsafeDependency: false },
      modelNode: { Id: randomUUID(), TenantId: tenantId, ParentId: randomUUID(), ContentItemId: contentId,
        Label: `[DEMO] ${sample.title}`, BreakInheritance: false, SortOrder: 0 } };
  });
}

it("consolidates ten placeholders into six actual reports/models without changing event IDs, timings or actors", () => {
  const actual = bindings(), adminId = randomUUID();
  const plan = consolidateDemoData(original, actual, [adminId]);
  assert.equal(plan.reports.filter(item => item.Kind === "Report").length, 6);
  assert.equal(plan.reports.filter(item => item.Kind === "Model").length, 6);
  assert.deepEqual(plan.users, original.users);
  for (const section of ["requests", "renders"] as const) {
    assert.equal(plan[section].length, original[section].length);
    for (let i = 0; i < original[section].length; i++) {
      const before = { ...original[section][i] }, after = { ...plan[section][i] };
      for (const field of ["ContentId", "ReportId", "ReportName"]) { delete before[field]; delete after[field]; }
      assert.deepEqual(after, before);
    }
  }
  for (const render of plan.renders) {
    const report = plan.reports.find(report => report.Id === render.ContentId)!;
    assert.equal(report.ExternalId, render.ReportId); assert.equal(report.Name, render.ReportName);
    assert.ok(actual.some(binding => binding.reportId === report.ExternalId));
    const node = plan.nodes.find(node => node.ContentItemId === report.Id)!;
    const user = plan.users.find(user => user.Id === render.UserId)!;
    const mask = effectivePermissions(user as unknown as User, String(node.Id),
      plan.nodes as unknown as NavigationNode[], plan.grants as unknown as Grant[]);
    assert.ok(mask & Permission.ViewReport);
    if (render.Mode !== "view") {
      assert.ok(mask & Permission.EditReport);
      const model = plan.reports.find(item => item.Kind === "Model" && item.ExternalId === report.ModelExternalId)!;
      const modelNode = plan.nodes.find(node => node.ContentItemId === model.Id)!;
      assert.ok(effectivePermissions(user as unknown as User, String(modelNode.Id),
        plan.nodes as unknown as NavigationNode[], plan.grants as unknown as Grant[]) & Permission.UseSemanticModelForAuthoring);
    }
  }
  const hiring = plan.reports.find(report => report.Kind === "Report" && String(report.Name).includes("Employee Hiring"))!;
  assert.ok(!plan.requests.some(request => request.ContentId === hiring.Id));
  assert.equal(plan.grants.filter(grant => grant.UserId === adminId).length, 1);
  assert.equal(plan.grants.find(grant => grant.UserId === adminId)!.Mask, Permission.ViewReport);
});

it("rejects unsupported model security, foreign models, untrusted embed URLs and incomplete bindings before publication", () => {
  const secured = bindings(); secured[0]!.model.RequiresIdentity = true;
  assert.throws(() => consolidateDemoData(original, secured, []), { code: "UnsupportedDemoSample" });
  const foreign = bindings(); foreign[0]!.model.TenantId = randomUUID();
  assert.throws(() => consolidateDemoData(original, foreign, []), { code: "UnsupportedDemoSample" });
  const unsafe = bindings(); unsafe[0]!.embedUrl = "https://example.com/embed";
  assert.throws(() => consolidateDemoData(original, unsafe, []), { code: "DemoEmbedUrlInvalid" });
  assert.throws(() => consolidateDemoData(original, bindings().slice(0, 5), []), { code: "DemoBindingsIncomplete" });
  const shared = bindings(); shared[1]!.modelId = shared[0]!.modelId;
  assert.throws(() => consolidateDemoData(original, shared, []), { code: "DemoBindingsIncomplete" });
});

it("requires checksum-pinned sample bytes and protects converted packages from the original metadata-only seeder", async () => {
  const bytes = new Uint8Array([1, 2, 3]), sha256 = createHash("sha256").update(bytes).digest("hex");
  validateSampleAsset({ sha256 }, bytes);
  assert.throws(() => validateSampleAsset({ sha256 }, new Uint8Array([4])), { code: "DemoSampleAssetChanged" });
  const db = { transaction: async work => work({ query: async (text: string, params: Params) => {
    if (text.startsWith("EXEC sp_getapplock")) return [];
    if (text.startsWith("SELECT t.Id")) return [{ Id: tenantId, WorkspaceId: workspaceId, RootId: randomUUID() }];
    if (String(params.name).startsWith("DemoSamplesBound:")) return [{ Value: "{}" }];
    assert.fail("No data mutation is allowed after conversion");
  } }) } as Pick<Database, "transaction">;
  await assert.rejects(manageDemoData(db, [tenantId], "remove"), { code: "DemoSamplesManaged" });
});

it("journals before uploading and refuses to replay an ambiguous PBIX upload", async context => {
  const bytes = new Uint8Array([7, 8, 9]);
  const sample = { ...demoSampleCatalog[0], sha256: createHash("sha256").update(bytes).digest("hex") };
  let saved: string | undefined, uploads = 0;
  const repo = { db: { read: async () => saved ? [{ Value: saved }] : [],
    query: async (_text: string, params: Params) => { saved = String(params.value); return []; } } } as unknown as Repository;
  const fabric = { runtimeToken: async () => "test-only", operator: async () => ({ value: [] }) } as unknown as FabricService;
  context.mock.method(globalThis, "fetch", async () => {
    uploads++;
    assert.equal(JSON.parse(saved!).requested, true);
    return new Response(null, { status: 503 });
  });
  const packageService = new DemoSamplePackage(repo, {} as AzureServices, fabric);
  const load = (packageService as unknown as {
    imported(tenant: Tenant, entry: typeof sample, bytes: Uint8Array): Promise<unknown>;
  }).imported.bind(packageService);
  const tenant = { Id: tenantId, WorkspaceId: workspaceId } as Tenant;
  await assert.rejects(load(tenant, sample, bytes), { code: "Upstream503" });
  await assert.rejects(load(tenant, sample, bytes), { code: "DemoImportRecoveryRequired" });
  assert.equal(uploads, 1);
  assert.equal(JSON.parse(saved!).revision, demoSampleRevision);
});

it("observes a saved successful import without uploading or adopting another report", async context => {
  const bytes = new Uint8Array([7, 8, 9]);
  const sample = { ...demoSampleCatalog[0], sha256: createHash("sha256").update(bytes).digest("hex") };
  const importId = randomUUID(), reportId = randomUUID(), modelId = randomUUID();
  let saved = JSON.stringify({ revision: demoSampleRevision, workspaceId, sha256: sample.sha256,
    requested: true, importId, reportId, modelId });
  const repo = { db: { read: async () => [{ Value: saved }],
    query: async (_text: string, params: Params) => { saved = String(params.value); return []; } } } as unknown as Repository;
  const fabric = { sampleImport: async (_tenant: string, id: string) => {
    assert.equal(id, importId);
    return { id, importState: "Succeeded", reports: [{ id: reportId }], datasets: [{ id: modelId }] };
  } } as unknown as FabricService;
  context.mock.method(globalThis, "fetch", async () => assert.fail("Saved imports must never upload again"));
  const packageService = new DemoSamplePackage(repo, {} as AzureServices, fabric);
  const load = (packageService as unknown as {
    imported(tenant: Tenant, entry: typeof sample, bytes: Uint8Array): Promise<{ reportId: string; modelId: string }>;
  }).imported.bind(packageService);
  const result = await load({ Id: tenantId, WorkspaceId: workspaceId } as Tenant, sample, bytes);
  assert.equal(result.reportId, reportId); assert.equal(result.modelId, modelId);
});

it("runs the standalone CLI and rejects missing arguments before accessing Azure", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx",
    fileURLToPath(new URL("../src/demo-samples.ts", import.meta.url))], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node src\/server\/dist\/demo-samples\.js --apply/);
});

it("does not treat tenant sample resume consent as permission to wake protected management compute", async () => {
  const capacityId = randomUUID(), methods: string[] = [];
  const repo = { capacityBinding: async () => ({ capacityId, resourceId: "/test/management-capacity" }) } as unknown as Repository;
  const azure = { config: { ManagementCapacityId: capacityId },
    capacityResource: async (_id: string, method = "GET") => {
      methods.push(method); return { properties: { state: "Paused" } };
    } } as unknown as AzureServices;
  const fabric = { runtimeToken: async () => "test-only",
    operator: async () => ({ id: workspaceId, capacityId, isOnDedicatedCapacity: true }) } as unknown as FabricService;
  const packageService = new DemoSamplePackage(repo, azure, fabric);
  const ensure = (packageService as unknown as {
    ensureCapacity(tenant: Tenant, resumeAllowed: boolean): Promise<void>;
  }).ensureCapacity.bind(packageService);
  await assert.rejects(ensure({ Id: tenantId, WorkspaceId: workspaceId } as Tenant, true),
    { code: "DemoManagementCapacityPaused" });
  assert.deepEqual(methods, ["GET"]);
});
