import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { AzureServices } from "./azure.js";
import { config } from "./config.js";
import { Database, type Executor } from "./db.js";
import { effectivePermissions, Permission, sameId, type Grant, type NavigationNode, type User } from "./domain.js";
import { requireCondition } from "./errors.js";

type Row = Record<string, string | number | boolean | null>;
const fields = {
  users: ["Users", { Id: "uniqueidentifier", TenantId: "uniqueidentifier", DirectoryId: "uniqueidentifier",
    ObjectId: "uniqueidentifier", DisplayName: "nvarchar(200)", IsPlatformAdmin: "bit", IsTenantAdmin: "bit", DefaultPermissions: "int" }],
  reports: ["Content", { Id: "uniqueidentifier", TenantId: "uniqueidentifier", ExternalId: "uniqueidentifier",
    Kind: "nvarchar(20)", Name: "nvarchar(200)", ModelExternalId: "uniqueidentifier", EmbedUrl: "nvarchar(2000)",
    Published: "bit", Deleted: "bit", RequiresIdentity: "bit", UnsafeDependency: "bit" }],
  nodes: ["Nodes", { Id: "uniqueidentifier", TenantId: "uniqueidentifier", ParentId: "uniqueidentifier",
    ContentItemId: "uniqueidentifier", Label: "nvarchar(200)", BreakInheritance: "bit", SortOrder: "int" }],
  grants: ["Grants", { TenantId: "uniqueidentifier", NodeId: "uniqueidentifier", UserId: "uniqueidentifier", Mask: "int" }],
  requests: ["ReportRequests", { Id: "uniqueidentifier", TenantId: "uniqueidentifier", UserId: "uniqueidentifier",
    ContentId: "uniqueidentifier", ReportName: "nvarchar(200)", UserDisplayName: "nvarchar(200)", Mode: "nvarchar(10)",
    RequestedAt: "datetime2", ServerReceivedAt: "datetime2", Status: "nvarchar(20)", RenderId: "uniqueidentifier", RecordedAt: "datetime2" }],
  renders: ["ReportRenders", { Id: "uniqueidentifier", TenantId: "uniqueidentifier", UserId: "uniqueidentifier",
    DirectoryId: "uniqueidentifier", ObjectId: "uniqueidentifier", UserDisplayName: "nvarchar(200)",
    ContentId: "uniqueidentifier", ReportId: "uniqueidentifier", ReportName: "nvarchar(200)", WorkspaceId: "uniqueidentifier",
    Mode: "nvarchar(10)", RequestedAt: "datetime2", ServerReceivedAt: "datetime2", RenderedAt: "datetime2",
    DurationMs: "int", RecordedAt: "datetime2" }],
} as const;
type Section = keyof typeof fields;
export type DemoData = Record<Section, Row[]>;
const sections = Object.keys(fields) as Section[];
export const demoMarkerName = (tenantId: string) => `DemoData:v1:${tenantId.toLowerCase()}`;
const day = 86_400_000;

export function demoId(tenantId: string, key: string) {
  const bytes = createHash("sha256").update(`PBIEmbeddedAOD:demo:v1:${tenantId.toLowerCase()}:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const id = demoId;
export function demoReportKeys(tenantId: string) {
  z.uuid().parse(tenantId);
  return Array.from({ length: 10 }, (_, i) => ({ Id: id(tenantId, `report:${i}`), ExternalId: id(tenantId, `fictional-report:${i}`) }));
}

export function buildDemoData(tenantId: string, workspaceId: string, rootId: string, anchor: Date): DemoData {
  [tenantId, workspaceId, rootId].forEach(value => z.uuid().parse(value));
  requireCondition(Number.isFinite(anchor.getTime()), 400, "InvalidDemoDate", "Use a valid demo history end date.");
  let state = createHash("sha256").update(tenantId.toLowerCase()).digest().readUInt32LE(0);
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
  const names = ["Avery Stone", "Jordan Brooks", "Morgan Reed", "Taylor Vale", "Riley Hart", "Casey Lane",
    "Quinn Hayes", "Cameron West", "Rowan Blake", "Parker Ellis", "Drew Monroe", "Skyler Wells",
    "Reese Arden", "Alex Rivers", "Jamie North"];
  const titles = ["Executive Overview", "Revenue Trends", "Sales Pipeline", "Financial Performance", "Budget vs Actual",
    "Customer Retention", "Operational Efficiency", "Regional Performance", "Legacy Scorecard (unused)", "Quarterly Planning (unused)"];
  const directoryId = id(tenantId, "fictional-directory");
  const users: User[] = names.map((name, i) => ({ Id: id(tenantId, `user:${i}`), TenantId: tenantId,
    DirectoryId: directoryId, ObjectId: id(tenantId, `fictional-object:${i}`), DisplayName: `[DEMO] ${name}`,
    IsPlatformAdmin: false, IsTenantAdmin: false, DefaultPermissions: 0 }));
  const reports = titles.map((title, i) => ({ Id: id(tenantId, `report:${i}`), TenantId: tenantId,
    ExternalId: id(tenantId, `fictional-report:${i}`), Kind: "Report", Name: `[DEMO] ${title}`, ModelExternalId: null,
    EmbedUrl: null, Published: false, Deleted: false, RequiresIdentity: false, UnsafeDependency: true }));
  const demoRoot = id(tenantId, "folder:demo");
  const folders = ["Executive", "Finance", "Operations"];
  const folderNodes: NavigationNode[] = [
    { Id: demoRoot, TenantId: tenantId, ParentId: rootId, ContentItemId: null, Label: "[DEMO] Sample analytics",
      BreakInheritance: true, SortOrder: 9000 },
    ...folders.map((name, i) => ({ Id: id(tenantId, `folder:${i}`), TenantId: tenantId, ParentId: demoRoot,
      ContentItemId: null, Label: `[DEMO] ${name}`, BreakInheritance: false, SortOrder: i })),
  ];
  const reportFolder = [0, 0, 0, 1, 1, 2, 2, 2, 1, 0];
  const reportNodes = reports.map((report, i) => ({ Id: id(tenantId, `node:${i}`), TenantId: tenantId,
    ParentId: folderNodes[reportFolder[i]! + 1]!.Id, ContentItemId: report.Id, Label: report.Name,
    BreakInheritance: false, SortOrder: i }));
  const nodes = [...folderNodes, ...reportNodes];
  const grants: Grant[] = [];
  users.forEach((user, i) => {
    if (i === 14) return;
    const nodeId = i < 3 ? demoRoot : i < 7 ? folderNodes[2]!.Id : i < 11 ? folderNodes[3]!.Id :
      i < 13 ? folderNodes[1]!.Id : reportNodes[0]!.Id;
    const mask = i < 3 ? Permission.ViewReport | Permission.EditReport | Permission.CopyReport |
      Permission.CreateReport | Permission.ManageContent | Permission.ManageNavigation : Permission.ViewReport;
    grants.push({ TenantId: tenantId, NodeId: nodeId, UserId: user.Id, Mask: mask });
  });
  // A direct, cross-folder grant demonstrates additive access without changing real users.
  grants.push({ TenantId: tenantId, NodeId: reportNodes[6]!.Id, UserId: users[3]!.Id, Mask: Permission.ViewReport });
  const requests: Row[] = [], renders: Row[] = [];
  const midnight = Date.parse(anchor.toISOString().slice(0, 10));
  const dates: number[] = [];
  for (let d = 0; d < 90; d++) {
    const time = midnight - d * day, weekday = new Date(time).getUTCDay();
    for (let w = 0; w < (weekday === 0 || weekday === 6 ? 1 : 4); w++) dates.push(time);
  }
  for (let i = 0; i < 3000; i++) {
    const userIndex = random() < 0.4 ? Math.floor(random() * 3) : Math.floor(random() * 14);
    const user = users[userIndex]!;
    const available = reportNodes.slice(0, 8).map((node, index) => ({ index, mask: effectivePermissions(user, node.Id, nodes, grants) }))
      .filter(report => report.mask & Permission.ViewReport);
    const selected = available[Math.floor(random() ** 2 * available.length)]!;
    const statusRoll = random();
    const status = statusRoll < 0.9 ? "Rendered" : statusRoll < 0.95 ? "Failed" : statusRoll < 0.98 ? "Authorized" : "Requested";
    const reportIndex = status === "Failed" && random() < 0.5 ? Math.floor(random() * 8) : selected.index;
    const report = reports[reportIndex]!;
    const modeRoll = random();
    const mode = (selected.mask & Permission.EditReport) && modeRoll < 0.15 ? "edit" :
      (selected.mask & Permission.CopyReport) && modeRoll < 0.2 ? "copy" : "view";
    let received = dates[Math.floor(random() * dates.length)]! + (8 + Math.floor(random() * 10)) * 3_600_000 +
      Math.floor(random() * 3_600_000);
    if (received > anchor.getTime() - 60_000) received = Math.max(midnight, anchor.getTime() - 60_000 - Math.floor(random() * 3_600_000));
    const requested = received - Math.floor(random() * 300);
    const age = (anchor.getTime() - received) / day;
    const slow = random() < 0.035;
    const duration = Math.round(700 + selected.index * 280 + random() * 2200 + age * 16 + (slow ? 12000 + random() * 22000 : 0));
    const renderId = id(tenantId, `render:${i}`);
    requests.push({ Id: id(tenantId, `request:${i}`), TenantId: tenantId, UserId: user.Id, ContentId: report.Id,
      ReportName: report.Name, UserDisplayName: user.DisplayName, Mode: mode, RequestedAt: new Date(requested).toISOString(),
      ServerReceivedAt: new Date(received).toISOString(), Status: status, RenderId: renderId,
      RecordedAt: new Date(received + (status === "Rendered" ? duration : 500)).toISOString() });
    if (status === "Rendered") renders.push({ Id: renderId, TenantId: tenantId, UserId: user.Id, DirectoryId: directoryId,
      ObjectId: user.ObjectId, UserDisplayName: user.DisplayName, ContentId: report.Id, ReportId: report.ExternalId,
      ReportName: report.Name, WorkspaceId: workspaceId, Mode: mode, RequestedAt: new Date(requested).toISOString(),
      ServerReceivedAt: new Date(received).toISOString(), RenderedAt: new Date(requested + duration).toISOString(),
      DurationMs: duration, RecordedAt: new Date(received + duration).toISOString() });
  }
  return { users: users.map(user => ({ ...user })), reports, nodes: nodes.map(node => ({ ...node })),
    grants: grants.map(grant => ({ ...grant })), requests, renders };
}

function source(section: Section) {
  return `OPENJSON(@data,'$.${section}') WITH (${Object.entries(fields[section][1])
    .map(([name, type]) => `[${name}] ${type}`).join(",")})`;
}
function match(section: Section, a: string, b: string) {
  const keys = section === "grants" ? ["TenantId", "NodeId", "UserId"] : ["Id"];
  return keys.map(key => `${a}.[${key}]=${b}.[${key}]`).join(" AND ");
}
function expected(section: Section) {
  const columns = Object.entries(fields[section][1]).map(([name, type]) => `[${name}] ${type}`).join(",");
  const keys = section === "grants" ? "[TenantId],[NodeId],[UserId]" : "[Id]";
  return `DECLARE @expected TABLE(${columns},PRIMARY KEY(${keys}));
    INSERT @expected SELECT * FROM ${source(section)};`;
}
const counts = (data: DemoData) => Object.fromEntries(sections.map(section => [section, data[section].length]));

async function assertUnchanged(tx: Executor, data: DemoData, allowSyncedReports = false) {
  for (const section of sections) {
    const [table, columns] = fields[section];
    const select = Object.keys(columns).filter(name => !(allowSyncedReports && section === "reports" && name === "Deleted"))
      .map(name => `[${name}]`).join(",");
    await tx.query(`${expected(section)}
      IF EXISTS(SELECT ${select} FROM app.${table} a WHERE EXISTS(SELECT 1 FROM @expected b WHERE ${match(section, "a", "b")})
        EXCEPT SELECT ${select} FROM @expected)
      OR EXISTS(SELECT ${select} FROM @expected
        EXCEPT SELECT ${select} FROM app.${table} a WHERE EXISTS(SELECT 1 FROM @expected b WHERE ${match(section, "a", "b")}))
      THROW 51001,'Demo records changed or are incomplete; review before reseeding/removing',1;`,
    { data: JSON.stringify({ [section]: data[section] }) });
  }
}
export { assertUnchanged as assertDemoDataUnchanged, source as demoSource, fields as demoFields };

export async function manageDemoData(db: Pick<Database, "transaction">, tenantIds: string[],
  action: "preview" | "apply" | "remove", now = new Date()) {
  requireCondition(tenantIds.length > 0 && new Set(tenantIds.map(value => value.toLowerCase())).size === tenantIds.length,
    400, "InvalidDemoTenants", "Specify distinct tenant IDs explicitly.");
  tenantIds.forEach(value => z.uuid().parse(value));
  return db.transaction(async tx => {
    const results = [];
    for (const tenantId of tenantIds) {
      if (action !== "preview") {
        await tx.query("EXEC sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=30000;",
          { resource: `sync:${tenantId.toLowerCase()}` });
      }
      const [tenant] = await tx.query<{ Id: string; WorkspaceId: string; RootId: string }>(`SELECT t.Id,t.WorkspaceId,n.Id AS RootId
        FROM app.Tenants t JOIN app.Nodes n ON n.TenantId=t.Id AND n.ParentId IS NULL WHERE t.Id=@tenantId`, { tenantId });
      requireCondition(tenant?.WorkspaceId && tenant.RootId, 409, "DemoTenantNotReady", "The requested tenant needs an existing workspace and navigation root.");
      const name = demoMarkerName(tenantId);
      const [bound] = await tx.query("SELECT Value FROM app.Settings WHERE Name=@name",
        { name: `DemoSamplesBound:v1:${tenantId.toLowerCase()}` });
      requireCondition(!bound, 409, "DemoSamplesManaged",
        "This tenant's demo records now reference real samples. Use the sample package; the original metadata seeder must not overwrite or remove them.");
      const [marker] = await tx.query<{ Value: string }>("SELECT Value FROM app.Settings WHERE Name=@name", { name });
      const manifest = marker ? z.object({ version: z.literal(1), anchor: z.iso.datetime(), workspaceId: z.uuid(), rootId: z.uuid() })
        .parse(JSON.parse(marker.Value)) : { version: 1, anchor: now.toISOString(), workspaceId: tenant.WorkspaceId, rootId: tenant.RootId };
      requireCondition(sameId(manifest.workspaceId, tenant.WorkspaceId) && sameId(manifest.rootId, tenant.RootId),
        409, "DemoTenantChanged", "Tenant workspace or root changed; review demo records explicitly.");
      const data = buildDemoData(tenantId, tenant.WorkspaceId, tenant.RootId, new Date(manifest.anchor));
      if (marker) await assertUnchanged(tx, data, true);
      else {
        for (const section of sections) {
          await tx.query(`IF EXISTS(SELECT 1 FROM app.${fields[section][0]} a JOIN ${source(section)} b ON ${match(section, "a", "b")})
            THROW 51001,'Demo IDs already exist without their manifest; refusing to adopt existing records',1;`,
          { data: JSON.stringify({ [section]: data[section] }) });
        }
      }
      if (action === "apply" && !marker) {
        for (const section of sections) {
          const columns = Object.keys(fields[section][1]).map(key => `[${key}]`).join(",");
          await tx.query(`INSERT app.${fields[section][0]} (${columns}) SELECT ${columns} FROM ${source(section)}`,
            { data: JSON.stringify({ [section]: data[section] }) });
        }
        await tx.query("INSERT app.Settings(Name,Value) VALUES(@name,@value)", { name, value: JSON.stringify(manifest) });
        await assertUnchanged(tx, data);
      }
      let restoredReports = 0;
      if (action === "apply" && marker) {
        const [restored] = await tx.query<{ restored: number }>(`UPDATE a SET Deleted=0 FROM app.Content a
          JOIN ${source("reports")} b ON a.Id=b.Id WHERE a.Deleted=1;
          SELECT @@ROWCOUNT AS restored;`, { data: JSON.stringify({ reports: data.reports }) });
        restoredReports = restored?.restored ?? 0;
      }
      if (action === "remove" && marker) {
        for (const section of [...sections].reverse()) {
          if (section === "nodes") {
            for (const node of [...data.nodes].reverse()) {
              await tx.query("DELETE app.Nodes WHERE Id=@id AND TenantId=@tenantId", { id: String(node.Id), tenantId });
            }
          } else await tx.query(`DELETE a FROM app.${fields[section][0]} a JOIN ${source(section)} b ON ${match(section, "a", "b")}`,
            { data: JSON.stringify({ [section]: data[section] }) });
        }
        await tx.query("DELETE app.Settings WHERE Name=@name", { name });
      }
      const changed = action === "apply" ? !marker || restoredReports > 0 : action === "remove" && Boolean(marker);
      if (changed) await tx.query(`INSERT app.Audit(TenantId,Action,ResourceId,Outcome)
        VALUES(@tenantId,@action,@name,'Succeeded')`, { tenantId, action: action === "apply" ? "SeedDemoData" : "RemoveDemoData", name });
      results.push({ tenantId, action, changed, existing: Boolean(marker), restoredReports, anchor: manifest.anchor, ...counts(data) });
    }
    return results;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const action = args.shift();
  requireCondition(action === "--preview" || action === "--apply" || action === "--remove", 400, "DemoUsage",
    "Usage: node src/server/dist/demo-data.js --preview|--apply|--remove <tenant-id> [<tenant-id> ...]. Configure the external database first.");
  requireCondition(config.SqlServer && config.SqlDatabase && !config.RuntimeManagedIdentityClientId &&
    !config.ProvisioningManagedIdentityClientId, 400, "DemoOperatorRequired",
  "Use explicit external configuration and the signed-in operator locally, not production managed identities.");
  const db = new Database(new AzureServices(config));
  try { console.log(JSON.stringify(await manageDemoData(db, args, action.slice(2) as "preview" | "apply" | "remove"), null, 2)); }
  finally { await db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Demo data operation failed."); process.exitCode = 1; });
}
