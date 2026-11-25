import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { remoteJson, AzureServices } from "./azure.js";
import { Repository } from "./repository.js";
import { FabricService, type SampleImport, type Workspace } from "./fabric.js";
import { config } from "./config.js";
import { Database } from "./db.js";
import type { ContentItem, Grant, NavigationNode, Tenant, User } from "./domain.js";
import { assertNotManagementResource, effectivePermissions, Permission, sameId } from "./domain.js";
import { requireCondition } from "./errors.js";
import { assertDemoDataUnchanged, buildDemoData, demoFields, demoId, demoMarkerName, demoSource, type DemoData } from "./demo-data.js";

export const demoSampleRevision = "bcc573acd49faeea262c1398e80a34e72d0f4679";
export const demoSampleCatalog = [
  { key: "marketing", title: "Competitive Marketing Analysis", slot: 0, sources: [0, 5],
    sha256: "68c76baa60f9efc7e90a4e2bfec224dc2814cbbba4fac5225baffdbf272e5af6" },
  { key: "store", title: "Store Sales", slot: 1, sources: [1],
    sha256: "e639ec4f230fbab27fa890df58c67dd70b0d4858d26bdfbe2b5c709f7526725a" },
  { key: "opportunities", title: "Revenue Opportunities", slot: 2, sources: [2, 9],
    sha256: "8c5a7c309d80af96bea0e90060b7c0f7e5c9582df844d4fcf78be36036d5f3b6" },
  { key: "spend", title: "Corporate Spend", slot: 3, sources: [3, 4],
    sha256: "b7c59b54761ca0fa988d629c022bfdd9c411a2cd0279a802d7c014259ee7a7e5" },
  { key: "hiring", title: "Employee Hiring and History", slot: 8, sources: [8],
    sha256: "6938d4747896cd631aec0d1e9870a5641150c48af2786ee8bdd3a28311825591" },
  { key: "regional", title: "Regional Sales Sample", slot: 7, sources: [6, 7],
    sha256: "aba504345740406fe35ea83c4dc194bb408ce467f09840bac1b82e5e8725cdab" },
] as const;
type Sample = typeof demoSampleCatalog[number];
export interface SampleBinding {
  key: Sample["key"]; reportId: string; modelId: string; reportContentId: string;
  model: ContentItem; modelNode: NavigationNode; embedUrl: string;
}
const stateSchema = z.object({
  revision: z.literal(demoSampleRevision), workspaceId: z.uuid(), sha256: z.string().length(64),
  requested: z.boolean(), importId: z.uuid().optional(), reportId: z.uuid().optional(), modelId: z.uuid().optional(),
});
type State = z.infer<typeof stateSchema>;
const pbi = "https://api.powerbi.com/v1.0/myorg";
export const demoSamplesBoundName = (tenantId: string) => `DemoSamplesBound:v1:${tenantId.toLowerCase()}`;
const itemName = (tenantId: string, key: string) => `DemoSample:v1:${tenantId.toLowerCase()}:${key}`;

export function validateSampleAsset(sample: { sha256: string }, bytes: Uint8Array) {
  requireCondition(bytes.length > 0 && bytes.length <= 64 * 1024 * 1024 &&
    createHash("sha256").update(bytes).digest("hex") === sample.sha256, 409, "DemoSampleAssetChanged",
  "The sample bytes do not match the pinned, reviewed Microsoft sample.");
}

export function consolidateDemoData(original: DemoData, bindings: SampleBinding[], adminIds: string[]): DemoData {
  requireCondition(bindings.length === 6 && new Set(bindings.map(binding => binding.key)).size === 6,
    409, "DemoBindingsIncomplete", "Exactly six distinct sample bindings are required.");
  requireCondition(new Set(bindings.map(binding => binding.reportId.toLowerCase())).size === 6 &&
    new Set(bindings.map(binding => binding.modelId.toLowerCase())).size === 6,
  409, "DemoBindingsIncomplete", "The six samples must have distinct real reports and models.");
  const tenantId = String(original.users[0]!.TenantId);
  const modelFolder = demoId(tenantId, "folder:models");
  const oldNodes = original.nodes as unknown as NavigationNode[], oldGrants = original.grants as unknown as Grant[];
  const users = original.users as unknown as User[];
  const mapped = new Map<string, { Id: string; Name: string; ExternalId: string }>();
  const reports: DemoData["reports"] = [], reportNodes: NavigationNode[] = [];
  const grants = oldGrants.filter(grant => !oldNodes.some(node => node.ContentItemId && sameId(node.Id, grant.NodeId)));
  const modelNodes: NavigationNode[] = [];
  for (const sample of demoSampleCatalog) {
    const binding = bindings.find(binding => binding.key === sample.key)!;
    [binding.reportId, binding.modelId, binding.reportContentId, binding.model.Id, binding.modelNode.Id].forEach(value => z.uuid().parse(value));
    requireCondition(binding.model.Kind === "Model" && sameId(binding.model.TenantId, tenantId) &&
      sameId(binding.model.ExternalId, binding.modelId) && sameId(binding.modelNode.ContentItemId, binding.model.Id) &&
      sameId(binding.modelNode.TenantId, tenantId) && !binding.model.Deleted && !binding.model.RequiresIdentity && !binding.model.UnsafeDependency,
    409, "UnsupportedDemoSample", "A sample has unsupported security or cross-workspace dependencies; it must remain unpublished.");
    const url = new URL(binding.embedUrl);
    requireCondition(url.protocol === "https:" && (url.hostname === "powerbi.com" || url.hostname.endsWith(".powerbi.com")),
      409, "DemoEmbedUrlInvalid", "The sample embed URL is not a Power BI HTTPS URL.");
    const old = original.reports[sample.slot]!;
    const report: DemoData["reports"][number] = { ...old, ExternalId: binding.reportId, Name: `[DEMO] ${sample.title}`, ModelExternalId: binding.modelId,
      EmbedUrl: binding.embedUrl, Published: true, Deleted: false, UnsafeDependency: false };
    reports.push(report, { ...binding.model, Published: true });
    const node = oldNodes.find(node => sameId(node.ContentItemId, String(old.Id)))!;
    reportNodes.push({ ...node, Label: String(report.Name) });
    modelNodes.push({ ...binding.modelNode, ParentId: modelFolder, BreakInheritance: false });
    sample.sources.forEach(index => mapped.set(String(original.reports[index]!.Id).toLowerCase(),
      { Id: String(report.Id), Name: String(report.Name), ExternalId: binding.reportId }));
    for (const user of users) {
      const mask = sample.sources.reduce<number>((mask, index) => {
        const sourceNode = oldNodes.find(node => sameId(node.ContentItemId, String(original.reports[index]!.Id)))!;
        return mask | effectivePermissions(user, sourceNode.Id, oldNodes, oldGrants);
      }, 0);
      if (mask) grants.push({ TenantId: tenantId, NodeId: node.Id, UserId: user.Id, Mask: mask });
    }
  }
  const folders = oldNodes.filter(node => !node.ContentItemId);
  for (const adminId of adminIds) {
    z.uuid().parse(adminId);
    requireCondition(!users.some(user => sameId(user.Id, adminId)), 409, "DemoAdminInvalid", "Synthetic users are not live administrators.");
    grants.push({ TenantId: tenantId, NodeId: folders[0]!.Id, UserId: adminId, Mask: Permission.ViewReport });
  }
  users.slice(0, 3).forEach(user => grants.push({ TenantId: tenantId, NodeId: modelFolder,
    UserId: user.Id, Mask: Permission.UseSemanticModelForAuthoring }));
  const nodes = [...folders, { Id: modelFolder, TenantId: tenantId, ParentId: folders[0]!.Id, ContentItemId: null,
    Label: "[DEMO] Sample models", BreakInheritance: false, SortOrder: 20 }, ...reportNodes, ...modelNodes];
  return {
    users: original.users, reports, nodes: nodes.map(node => ({ ...node })), grants: grants.map(grant => ({ ...grant })),
    requests: original.requests.map(request => {
      const report = mapped.get(String(request.ContentId).toLowerCase())!;
      requireCondition(report, 409, "DemoHistoryInvalid", "A request references an unknown demo report.");
      return { ...request, ContentId: report.Id, ReportName: report.Name };
    }),
    renders: original.renders.map(render => {
      const report = mapped.get(String(render.ContentId).toLowerCase())!;
      requireCondition(report, 409, "DemoHistoryInvalid", "A render references an unknown demo report.");
      return { ...render, ContentId: report.Id, ReportId: report.ExternalId, ReportName: report.Name };
    }),
  };
}

export class DemoSamplePackage {
  constructor(private repo: Repository, private azure: AzureServices, private fabric: FabricService) {}

  private async save(tenantId: string, key: string, state: State) {
    await this.repo.db.query(`MERGE app.Settings WITH(HOLDLOCK) AS t USING(SELECT @name AS Name) s ON t.Name=s.Name
      WHEN MATCHED THEN UPDATE SET Value=@value WHEN NOT MATCHED THEN INSERT(Name,Value) VALUES(@name,@value);`,
    { name: itemName(tenantId, key), value: JSON.stringify(state) });
  }

  private async renew(tenantId: string, owner: string) {
    await this.repo.db.query(`UPDATE app.Settings SET Value=JSON_MODIFY(Value,'$.until',
      CONVERT(varchar(33),DATEADD(minute,20,SYSUTCDATETIME()),126)+'Z')
      WHERE Name=@name AND JSON_VALUE(Value,'$.owner')=@owner
        AND TRY_CONVERT(datetime2,JSON_VALUE(Value,'$.until'))>SYSUTCDATETIME();
      IF @@ROWCOUNT<>1 THROW 51001,'Demo package lease was lost; inspect journals before retrying',1;`,
    { name: itemName(tenantId, "lease"), owner });
  }

  private async imported(tenant: Tenant, sample: Sample, bytes: Uint8Array, owner?: string): Promise<State> {
    validateSampleAsset(sample, bytes);
    if (owner) await this.renew(tenant.Id, owner);
    const name = itemName(tenant.Id, sample.key);
    const [row] = await this.repo.db.read<{ Value: string }>("SELECT Value FROM app.Settings WHERE Name=@name", { name });
    let state: State = row ? stateSchema.parse(JSON.parse(row.Value)) :
      { revision: demoSampleRevision, workspaceId: tenant.WorkspaceId!, sha256: sample.sha256, requested: false };
    requireCondition(sameId(state.workspaceId, tenant.WorkspaceId) && state.sha256 === sample.sha256, 409, "DemoSampleScopeChanged",
      "Saved sample scope or bytes changed. Review instead of overwriting or importing again.");
    if (!state.importId) {
      requireCondition(!state.requested, 409, "DemoImportRecoveryRequired",
        "A previous upload has an unknown outcome. Inspect/pin the import ID explicitly; no upload will be replayed.");
      const token = await this.fabric.runtimeToken(tenant);
      const inventory = await this.fabric.operator<{ value: { name: string }[] }>(token, `/groups/${tenant.WorkspaceId}/reports`);
      requireCondition(!inventory.value.some(report => report.name === `[DEMO] ${sample.title}`), 409, "DemoSampleNameConflict",
        "A demo-named report already exists without this package's ownership journal. It will not be adopted or overwritten.");
      state.requested = true;
      await this.save(tenant.Id, sample.key, state);
      const form = new FormData(), fileName = `[DEMO] ${sample.title}.pbix`;
      form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), fileName);
      const result = await remoteJson<SampleImport>(
        `${pbi}/groups/${tenant.WorkspaceId}/imports?datasetDisplayName=${encodeURIComponent(fileName)}&nameConflict=Abort`,
        token, "POST", form, 180_000);
      state.importId = z.uuid().parse(result.id);
      await this.save(tenant.Id, sample.key, state);
    }
    for (let attempt = 0; attempt < 90; attempt++) {
      if (owner) await this.renew(tenant.Id, owner);
      const result = await this.fabric.sampleImport(tenant.Id, state.importId);
      requireCondition(sameId(result.id, state.importId) && result.importState !== "Failed",
        409, "DemoSampleImportFailed", "The saved sample import failed or returned another import. Nothing was published.");
      if (result.importState === "Succeeded") {
        requireCondition(result.reports?.length === 1 && result.datasets?.length === 1, 409, "DemoSampleImportInvalid",
          "A sample import must contain exactly one report and one model.");
        const reportId = z.uuid().parse(result.reports[0]!.id), modelId = z.uuid().parse(result.datasets[0]!.id);
        requireCondition((!state.reportId || sameId(state.reportId, reportId)) && (!state.modelId || sameId(state.modelId, modelId)),
          409, "DemoSampleIdentityChanged", "The sample import identities changed.");
        state = { ...state, reportId, modelId };
        await this.save(tenant.Id, sample.key, state);
        return state;
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error("Sample import remains pending. Rerun observes the saved import without uploading again.");
  }

  private async ensureCapacity(tenant: Tenant, resumeAllowed: boolean) {
    const workspace = await this.fabric.operator<Workspace>(await this.fabric.runtimeToken(tenant), `/groups/${tenant.WorkspaceId}`);
    const savedBinding = await this.repo.capacityBinding(tenant);
    const binding = savedBinding ?? (sameId(workspace.capacityId, this.azure.config.ManagementCapacityId) &&
      this.azure.config.ManagementCapacityResourceId ? { capacityId: this.azure.config.ManagementCapacityId,
        resourceId: this.azure.config.ManagementCapacityResourceId } : undefined);
    requireCondition(sameId(workspace.id, tenant.WorkspaceId) && workspace.isOnDedicatedCapacity &&
      binding && sameId(binding.capacityId, workspace.capacityId), 409, "DemoCapacityUnverified",
    "Verify the tenant's current assigned capacity before importing samples; no capacity will be reassigned.");
    let capacity = await this.azure.capacityResource<{ properties: { state: string } }>(binding.resourceId);
    if (capacity.properties.state === "Active") return;
    requireCondition(!sameId(binding.capacityId, this.azure.config.ManagementCapacityId),
      409, "DemoManagementCapacityPaused", "Resume management compute only with separate approval outside this sample package.");
    requireCondition(resumeAllowed && ["Paused", "Suspended"].includes(capacity.properties.state),
      409, "DemoCapacityPaused", "Sample import needs active compute. Explicitly approve resuming its verified existing capacity.");
    console.log(JSON.stringify({ tenantId: tenant.Id, phase: "resume-existing-capacity", resourceId: binding.resourceId }));
    await this.azure.capacityResource(binding.resourceId, "POST");
    for (let attempt = 0; attempt < 90; attempt++) {
      capacity = await this.azure.capacityResource(binding.resourceId);
      if (capacity.properties.state === "Active") return;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error("Existing capacity resume remains pending. Inspect before retrying; no second resume was submitted.");
  }

  async apply(tenantId: string, assets: Map<string, Uint8Array>, grantAdmins: boolean, resumeCapacity = false) {
    const tenant = await this.repo.tenant(tenantId);
    assertNotManagementResource(tenant.WorkspaceId, this.azure.config.ManagementWorkspaceId, this.azure.config.AgentWorkspaceId);
    requireCondition(tenant.WorkspaceId, 409, "DemoTenantNotReady", "Use an existing tenant workspace.");
    for (const sample of demoSampleCatalog) {
      const asset = assets.get(`${sample.title}.pbix`);
      requireCondition(asset, 409, "DemoSampleMissing", "Download every pinned sample before starting workspace writes.");
      validateSampleAsset(sample, asset);
    }
    const owner = randomUUID(), leaseName = itemName(tenant.Id, "lease");
    await this.repo.db.transaction(async tx => {
      await tx.query(`DECLARE @lease nvarchar(1000);
        SELECT @lease=Value FROM app.Settings WITH(UPDLOCK,HOLDLOCK) WHERE Name=@name;
        IF @lease IS NOT NULL AND (ISJSON(@lease)=0 OR
          TRY_CONVERT(datetime2,JSON_VALUE(@lease,'$.until')) IS NULL OR
          TRY_CONVERT(datetime2,JSON_VALUE(@lease,'$.until'))>SYSUTCDATETIME())
          THROW 51001,'Another demo package operation is running or its lease needs review',1;
        DECLARE @value nvarchar(1000)=CONCAT('{"owner":"',@owner,'","until":"',
          CONVERT(varchar(33),DATEADD(minute,20,SYSUTCDATETIME()),126),'Z"}');
        MERGE app.Settings AS a USING(SELECT @name AS Name) b ON a.Name=b.Name
        WHEN MATCHED THEN UPDATE SET Value=@value WHEN NOT MATCHED THEN INSERT(Name,Value) VALUES(@name,@value);`,
      { name: leaseName, owner });
    });
    try {
    const [manifestRow] = await this.repo.db.read<{ Value: string }>("SELECT Value FROM app.Settings WHERE Name=@name",
      { name: demoMarkerName(tenant.Id) });
    requireCondition(manifestRow, 409, "DemoDataMissing", "Seed the synthetic history before importing the sample package.");
    const manifest = z.object({ version: z.literal(1), anchor: z.iso.datetime(), workspaceId: z.uuid(), rootId: z.uuid() })
      .parse(JSON.parse(manifestRow.Value));
    requireCondition(sameId(manifest.workspaceId, tenant.WorkspaceId), 409, "DemoTenantChanged", "The demo workspace changed.");
    const original = buildDemoData(tenant.Id, tenant.WorkspaceId, manifest.rootId, new Date(manifest.anchor));
    const [completed] = await this.repo.db.read("SELECT Value FROM app.Settings WHERE Name=@name",
      { name: demoSamplesBoundName(tenant.Id) });
    if (!completed) await this.repo.db.transaction(tx => assertDemoDataUnchanged(tx, original, true));
    await this.ensureCapacity(tenant, resumeCapacity);
    const states = new Map<string, State>();
    for (const sample of demoSampleCatalog) {
      console.log(JSON.stringify({ tenantId: tenant.Id, sample: sample.title, phase: "import" }));
      states.set(sample.key, await this.imported(tenant, sample, assets.get(`${sample.title}.pbix`)!, owner));
    }

    await this.fabric.sync(tenant.Id);
    const content = await this.repo.content(tenant.Id), security = await this.repo.security(tenant.Id);
    const bindings: SampleBinding[] = demoSampleCatalog.map(sample => {
      const state = states.get(sample.key)!;
      const report = content.find(item => item.Kind === "Report" && sameId(item.ExternalId, state.reportId));
      const model = content.find(item => item.Kind === "Model" && sameId(item.ExternalId, state.modelId));
      const node = security.nodes.find(node => sameId(node.ContentItemId, model?.Id));
      requireCondition(report && model && node && !report.UnsafeDependency && !model.UnsafeDependency &&
        !model.RequiresIdentity && report.EmbedUrl && sameId(report.ModelExternalId, model.ExternalId),
      409, "UnsupportedDemoSample", "A sample has unsupported security/dependencies or incomplete metadata and remains unpublished.");
      return { key: sample.key, reportId: state.reportId!, modelId: state.modelId!, reportContentId: report.Id,
        model, modelNode: node, embedUrl: report.EmbedUrl };
    });
    const admins = grantAdmins ? (await this.repo.users(tenant.Id)).filter(user => user.IsTenantAdmin &&
      !original.users.some(synthetic => sameId(String(synthetic.Id), user.Id))) : [];
    const plan = consolidateDemoData(original, bindings, admins.map(user => user.Id));
    if (completed) {
      await this.repo.db.transaction(tx => assertDemoDataUnchanged(tx, plan));
      return { tenantId: tenant.Id, existing: true, reports: 6, models: 6, requests: plan.requests.length, renders: plan.renders.length };
    }

    await this.renew(tenant.Id, owner);
    await this.repo.db.transaction(async tx => {
      await tx.query("EXEC sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=30000",
        { resource: `sync:${tenant.Id}` });
      await assertDemoDataUnchanged(tx, original, true);
      for (const admin of admins) await tx.query(`IF NOT EXISTS(SELECT 1 FROM app.Users WHERE Id=@id AND
        TenantId=@tenantId AND IsTenantAdmin=1) THROW 51001,'Tenant administrator changed before demo access grant',1;`,
      { id: admin.Id, tenantId: tenant.Id });
      const oldReports = JSON.stringify({ reports: original.reports });
      for (const table of ["ReportRequests", "ReportRenders"]) {
        const section = table === "ReportRequests" ? "requests" : "renders";
        await tx.query(`DECLARE @reports TABLE(Id uniqueidentifier PRIMARY KEY);
          INSERT @reports SELECT Id FROM OPENJSON(@reportIds) WITH(Id uniqueidentifier);
          DECLARE @events TABLE(Id uniqueidentifier PRIMARY KEY);
          INSERT @events SELECT Id FROM OPENJSON(@eventIds) WITH(Id uniqueidentifier);
          IF EXISTS(SELECT 1 FROM app.${table} a JOIN @reports c ON a.ContentId=c.Id
            WHERE NOT EXISTS(SELECT 1 FROM @events d WHERE a.Id=d.Id))
          THROW 51001,'Live telemetry references a demo placeholder; review before consolidating',1;`,
        { reportIds: JSON.stringify(original.reports.map(row => ({ Id: row.Id }))),
          eventIds: JSON.stringify(original[section].map(row => ({ Id: row.Id }))) });
      }
      const autoReports = bindings.map(binding => ({ Id: binding.reportContentId }));
      const autoPayload = JSON.stringify(autoReports);
      for (const table of ["ReportRequests", "ReportRenders"]) {
        await tx.query(`IF EXISTS(SELECT 1 FROM app.${table} a
          JOIN OPENJSON(@auto) WITH(Id uniqueidentifier) r ON a.ContentId=r.Id)
          THROW 51001,'Imported reports already have live telemetry; review before consolidating',1;`,
        { auto: autoPayload });
      }
      await tx.query(`IF EXISTS(SELECT 1 FROM app.Grants g JOIN app.Nodes n ON n.Id=g.NodeId
          JOIN OPENJSON(@auto) WITH(Id uniqueidentifier) r ON n.ContentItemId=r.Id)
        THROW 51001,'Imported report nodes have live grants; do not remove them automatically',1;
        DELETE n FROM app.Nodes n JOIN OPENJSON(@auto) WITH(Id uniqueidentifier) r ON n.ContentItemId=r.Id;`,
      { auto: autoPayload });
      await tx.query(`DELETE g FROM app.Grants g JOIN ${demoSource("grants")} d
        ON g.TenantId=d.TenantId AND g.NodeId=d.NodeId AND g.UserId=d.UserId`, { data: JSON.stringify({ grants: original.grants }) });
      for (const node of original.nodes.filter(node => node.ContentItemId)) {
        await tx.query("DELETE app.Nodes WHERE Id=@id AND TenantId=@tenantId", { id: String(node.Id), tenantId: tenant.Id });
      }
      await tx.query(`DELETE a FROM app.Content a JOIN OPENJSON(@auto) WITH(Id uniqueidentifier) b ON a.Id=b.Id;
        DELETE a FROM app.Content a JOIN ${demoSource("reports")} b ON a.Id=b.Id;`, { auto: autoPayload, data: oldReports });
      const reportRows = plan.reports.filter(report => report.Kind === "Report");
      const columns = Object.keys(demoFields.reports[1]).map(key => `[${key}]`).join(",");
      await tx.query(`INSERT app.Content(${columns}) SELECT ${columns} FROM ${demoSource("reports")}`,
        { data: JSON.stringify({ reports: reportRows }) });
      const newNodes = plan.nodes.filter(node => !original.nodes.some(old => old.Id === node.Id) &&
        !bindings.some(binding => sameId(binding.modelNode.Id, String(node.Id))));
      const nodeColumns = Object.keys(demoFields.nodes[1]).map(key => `[${key}]`).join(",");
      await tx.query(`INSERT app.Nodes(${nodeColumns}) SELECT ${nodeColumns} FROM ${demoSource("nodes")}`,
        { data: JSON.stringify({ nodes: [...plan.nodes.filter(node => node.ContentItemId &&
          reportRows.some(report => sameId(String(report.Id), String(node.ContentItemId)))), ...newNodes] }) });
      for (const binding of bindings) {
        await tx.query("UPDATE app.Nodes SET ParentId=@parent,Label=@label,BreakInheritance=0 WHERE Id=@id AND TenantId=@tenantId",
          { parent: demoId(tenant.Id, "folder:models"), label: binding.modelNode.Label, id: binding.modelNode.Id, tenantId: tenant.Id });
        await tx.query("UPDATE app.Content SET Published=1 WHERE Id=@id AND TenantId=@tenantId AND Kind='Model'",
          { id: binding.model.Id, tenantId: tenant.Id });
      }
      await tx.query(`MERGE app.Grants AS a USING ${demoSource("grants")} b
        ON a.TenantId=b.TenantId AND a.NodeId=b.NodeId AND a.UserId=b.UserId
        WHEN MATCHED THEN UPDATE SET Mask=a.Mask|b.Mask
        WHEN NOT MATCHED THEN INSERT(TenantId,NodeId,UserId,Mask) VALUES(b.TenantId,b.NodeId,b.UserId,b.Mask);`,
      { data: JSON.stringify({ grants: plan.grants }) });
      for (const section of ["requests", "renders"] as const) {
        const renderColumn = section === "renders" ? ",ReportId uniqueidentifier" : "";
        await tx.query(`DECLARE @updates TABLE(Id uniqueidentifier PRIMARY KEY,TenantId uniqueidentifier,
          ContentId uniqueidentifier,ReportName nvarchar(512)${renderColumn});
          INSERT @updates SELECT * FROM OPENJSON(@changes) WITH(Id uniqueidentifier,TenantId uniqueidentifier,
            ContentId uniqueidentifier,ReportName nvarchar(512)${renderColumn});
          UPDATE a SET ContentId=b.ContentId,ReportName=b.ReportName${section === "renders" ? ",ReportId=b.ReportId" : ""}
          FROM app.${demoFields[section][0]} a JOIN @updates b ON a.Id=b.Id AND a.TenantId=b.TenantId`,
        { changes: JSON.stringify(plan[section].map(row => ({ Id: row.Id, TenantId: row.TenantId,
          ContentId: row.ContentId, ReportName: row.ReportName, ...(section === "renders" ? { ReportId: row.ReportId } : {}) }))) });
      }
      await assertDemoDataUnchanged(tx, plan);
      await tx.query("INSERT app.Settings(Name,Value) VALUES(@name,@value)",
        { name: demoSamplesBoundName(tenant.Id), value: JSON.stringify({ revision: demoSampleRevision, reports: 6, models: 6 }) });
      await tx.query(`INSERT app.Audit(TenantId,Action,ResourceId,Outcome) VALUES(@tenantId,'BindDemoSamples',@resource,'Succeeded')`,
        { tenantId: tenant.Id, resource: demoSamplesBoundName(tenant.Id) });
    });
    return { tenantId: tenant.Id, existing: false, reports: 6, models: 6, requests: plan.requests.length,
      renders: plan.renders.length, adminViewGrants: admins.length };
    } finally {
      await this.repo.db.query("DELETE app.Settings WHERE Name=@name AND JSON_VALUE(Value,'$.owner')=@owner", { name: leaseName, owner });
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  requireCondition(args.shift() === "--apply", 400, "DemoSampleUsage",
    "Usage: node src/server/dist/demo-samples.js --apply <absolute-asset-directory> <tenant-id> ... [--grant-admin-view] [--resume-capacity]");
  const directory = args.shift();
  requireCondition(directory && path.isAbsolute(directory), 400, "DemoSampleAssetsPath", "Specify the approved absolute sample asset directory.");
  const grantAdmins = args.includes("--grant-admin-view"), resumeCapacity = args.includes("--resume-capacity");
  const tenantIds = args.filter(arg => !["--grant-admin-view", "--resume-capacity"].includes(arg));
  requireCondition(tenantIds.length > 0 && new Set(tenantIds.map(id => id.toLowerCase())).size === tenantIds.length,
    400, "DemoSampleTenants", "Specify distinct tenant IDs explicitly.");
  tenantIds.forEach(id => z.uuid().parse(id));
  const assets = new Map<string, Uint8Array>();
  for (const sample of demoSampleCatalog) assets.set(`${sample.title}.pbix`, await readFile(path.join(directory, `${sample.title}.pbix`)));
  const azure = new AzureServices(config), db = new Database(azure), repo = new Repository(db);
  const packageService = new DemoSamplePackage(repo, azure, new FabricService(repo, azure));
  try {
    for (const tenantId of tenantIds) console.log(JSON.stringify(await packageService.apply(tenantId, assets, grantAdmins, resumeCapacity)));
  } finally { await db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Sample package failed."); process.exitCode = 1; });
}
