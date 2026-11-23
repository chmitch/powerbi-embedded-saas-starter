import { randomUUID } from "node:crypto";
import { it } from "node:test";
import assert from "node:assert/strict";
import type { AzureServices } from "../src/azure.js";
import { CapacityManagement, type ManagedCapacity } from "../src/capacity-management.js";
import { config } from "../src/config.js";
import type { Tenant, User } from "../src/domain.js";
import { AppError } from "../src/errors.js";
import type { FabricService, Workspace } from "../src/fabric.js";
import type { Repository } from "../src/repository.js";

function fixture() {
  const ids = { first: randomUUID(), second: randomUUID(), management: randomUUID(), unused: randomUUID() };
  const base = `/subscriptions/${randomUUID()}/resourceGroups/fixture/providers/Microsoft.Fabric/capacities`;
  const resources: ManagedCapacity[] = ["fixtureone", "fixturetwo", "fixturemgmt", "fixtureunused"].map(name =>
    ({ id: `${base}/${name}`, name, sku: { name: "F2" }, properties: { state: "Active", provisioningState: "Succeeded" } }));
  const tenants = ["First", "Second", "Shared"].map(Name => ({
    Id: randomUUID(), Name, WorkspaceId: randomUUID(),
  })) as Tenant[];
  const workspaces: Workspace[] = tenants.map((tenant, index) => ({
    id: tenant.WorkspaceId!, name: tenant.Name, capacityId: index === 1 ? ids.second : ids.first,
  }));
  const remote = resources.map((resource, index) => ({
    id: [ids.first, ids.second, ids.management, ids.unused][index]!, displayName: resource.name,
  }));
  const calls: { suffix: string; method: string; body?: unknown }[] = [];
  const audits: { action: string; resource: string; outcome: string }[] = [];
  const denied = new Set<string>();
  const azure = {
    config: { ...config, SubscriptionId: base.split("/")[2]!, ResourceGroup: "fixture",
      ManagementCapacityId: ids.management, ManagementCapacityResourceId: `${base}/fixturemgmt`,
      ManagementWorkspaceId: randomUUID() },
    capacity: async (suffix = "", method = "GET", body?: unknown) => {
      calls.push({ suffix, method, body });
      if (!suffix) return { value: structuredClone(resources) };
      const name = suffix.split("/")[1]!, resource = resources.find(item => item.name === name);
      assert.ok(resource);
      if (method === "GET") return structuredClone(resource);
      if (denied.has(name)) throw new AppError(502, "Upstream403", "Capacity operation denied.");
      if (method === "PATCH") resource.sku.name = (body as { sku: { name: string } }).sku.name;
      else resource.properties.state = suffix.endsWith("/suspend") ? "Suspended" : "Active";
      return {};
    },
  } as unknown as AzureServices;
  const repo = {
    tenant: async (id: string) => { const tenant = tenants.find(item => item.Id === id); assert.ok(tenant); return structuredClone(tenant); },
    tenants: async () => structuredClone(tenants),
    audit: async (_actor: unknown, action: string, resource: string, outcome: string) => { audits.push({ action, resource, outcome }); return []; },
  } as unknown as Repository;
  const fabric = { workspaces: async () => structuredClone(workspaces),
    operator: async () => ({ value: structuredClone(remote) }) } as unknown as FabricService;
  const actor = { Id: randomUUID(), TenantId: null, IsPlatformAdmin: true } as User;
  return { service: new CapacityManagement(repo, azure, fabric), repo, azure, fabric, resources, workspaces, tenants,
    remote, ids, calls, audits, denied, actor, base };
}

it("resumes only the currently verified tenant capacity, including shared compute, and rejects stale confirmation", async () => {
  const f = fixture(), tenantId = f.tenants[0]!.Id;
  f.azure.config.AutoResumeCapacities = false;
  f.resources[0]!.properties.state = "Paused";
  assert.deepEqual((await f.service.forTenant(tenantId, "token")).capacity!.tenants.map(item => item.name), ["First", "Shared"]);
  await assert.rejects(f.service.resumeTenant(tenantId, "token", "fixturetwo", f.actor), { code: "CapacitySelectionChanged" });
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
  assert.equal((await f.service.resumeTenant(tenantId, "token", "fixtureone", f.actor)).status, "accepted");
  assert.equal((await f.service.resumeTenant(tenantId, "token", "fixtureone", f.actor)).status, "skipped");
  assert.deepEqual(f.calls.filter(call => call.method !== "GET").map(call => call.suffix), ["/fixtureone/resume"]);
  f.workspaces[0]!.capacityId = f.ids.second;
  await assert.rejects(f.service.resumeTenant(tenantId, "token", "fixtureone", f.actor), { code: "CapacitySelectionChanged" });
});

it("reports a possibly submitted tenant resume when its completion audit fails without replaying", async () => {
  const f = fixture();
  f.resources[0]!.properties.state = "Suspended";
  f.repo.audit = async (_actor, _action, _resource, outcome) => {
    if (outcome === "Accepted") throw new Error("Audit unavailable");
    return [];
  };
  await assert.rejects(f.service.resumeTenant(f.tenants[0]!.Id, "token", "fixtureone", f.actor),
    { code: "CapacityAuditUnavailable" });
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 1);
  assert.equal(f.resources[0]!.properties.state, "Active");
});

it("blocks unverified, external, management and unstable tenant capacity repairs without blocking unrelated verified tenants", async () => {
  const f = fixture(), tenantId = f.tenants[0]!.Id;
  f.workspaces.splice(1, 1);
  assert.equal((await f.service.forTenant(tenantId, "token")).capacity!.name, "fixtureone");
  f.resources[0]!.properties.state = "Resuming";
  await assert.rejects(f.service.resumeTenant(tenantId, "token", "fixtureone", f.actor), { code: "CapacityNotReady" });
  f.workspaces[0]!.capacityId = randomUUID();
  assert.equal((await f.service.forTenant(tenantId, "token")).capacity, null);
  await assert.rejects(f.service.resumeTenant(tenantId, "token", "fixtureone", f.actor), { code: "TenantCapacityUnverified" });
  f.remote.push({ id: f.workspaces[0]!.capacityId, displayName: "outsidecapacity" });
  assert.match((await f.service.forTenant(tenantId, "token")).issue!, /outside/);
  f.workspaces[0]!.capacityId = f.ids.management;
  await assert.rejects(f.service.resumeTenant(tenantId, "token", "fixturemgmt", f.actor), { code: "TenantCapacityUnverified" });
  f.tenants[0]!.WorkspaceId = f.azure.config.ManagementWorkspaceId;
  await assert.rejects(f.service.forTenant(tenantId, "token"), { code: "ProtectedManagementResource" });
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});

it("maps registered tenants to distinct capacities and excludes management and external capacity from bulk scope", async () => {
  const f = fixture();
  const outside = { Id: randomUUID(), Name: "External", WorkspaceId: randomUUID() } as Tenant;
  f.tenants.push(outside);
  const externalId = randomUUID();
  f.workspaces.push({ id: outside.WorkspaceId!, name: outside.Name, capacityId: externalId });
  f.remote.push({ id: externalId, displayName: "externalcapacity" });
  const inventory = await f.service.inventory("operator-token");
  assert.equal(inventory.issues.length, 0);
  assert.equal(inventory.value.length, 3);
  assert.deepEqual(inventory.value.find(capacity => capacity.name === "fixtureone")!.tenants.map(tenant => tenant.name), ["First", "Shared"]);
  assert.deepEqual(inventory.excludedTenants, [{ id: outside.Id, name: outside.Name }]);
  const result = await f.service.bulk("operator-token", "suspend", ["fixtureone", "fixturetwo"], f.actor);
  assert.deepEqual(result.results.map(row => row.status), ["accepted", "accepted"]);
  assert.deepEqual(f.calls.filter(call => call.method !== "GET").map(call => call.suffix), ["/fixtureone/suspend", "/fixturetwo/suspend"]);
  assert.equal(f.resources.find(capacity => capacity.name === "fixturemgmt")!.properties.state, "Active");
  assert.equal(f.resources.find(capacity => capacity.name === "fixtureunused")!.properties.state, "Active");
});

it("continues bulk operations after a failure, audits each result, and resumes suspended capacities", async () => {
  const f = fixture();
  f.denied.add("fixtureone");
  const paused = await f.service.bulk("token", "suspend", ["fixtureone", "fixturetwo"], f.actor);
  assert.deepEqual(paused.results.map(result => result.status), ["failed", "accepted"]);
  assert.match(paused.results[0]!.message, /Inspect Azure capacity status before retrying/);
  assert.deepEqual(f.audits.map(audit => audit.outcome), ["Failed", "Accepted"]);
  f.denied.clear(); f.calls.length = 0;
  const resumed = await f.service.bulk("token", "resume", ["fixtureone", "fixturetwo"], f.actor);
  assert.deepEqual(resumed.results.map(result => result.status), ["skipped", "accepted"]);
  assert.deepEqual(f.calls.filter(call => call.method !== "GET").map(call => call.suffix), ["/fixturetwo/resume"]);
});

it("rejects unconfirmed selections and unverifiable or protected tenant assignments before any capacity write", async () => {
  const f = fixture();
  for (const names of [["fixtureone"], ["fixtureone", "fixtureone"], ["fixtureone", "fixturetwo", "fixturemgmt"],
    ["fixtureone", "fixturetwo", "fixtureunused"]])
    await assert.rejects(f.service.bulk("token", "suspend", names, f.actor), { code: "CapacitySelectionChanged" });
  const workspace = f.workspaces.shift()!;
  await assert.rejects(f.service.bulk("token", "suspend", ["fixtureone", "fixturetwo"], f.actor), { code: "CapacityAssignmentsUnverified" });
  f.workspaces.unshift({ ...workspace, capacityId: f.ids.management });
  await assert.rejects(f.service.bulk("token", "suspend", ["fixtureone", "fixturetwo"], f.actor), { code: "CapacityAssignmentsUnverified" });
  assert.equal(f.calls.filter(call => call.method !== "GET").length, 0);
});

it("blocks ambiguous names and rechecks tenant assignments before submitting each bulk request", async () => {
  const f = fixture();
  f.remote.push({ id: randomUUID(), displayName: "FIXTUREONE" });
  await assert.rejects(f.service.bulk("token", "suspend", ["fixtureone", "fixturetwo"], f.actor), { code: "CapacityAssignmentsUnverified" });
  f.remote.pop();
  const list = f.fabric.workspaces;
  let reads = 0;
  f.fabric.workspaces = async token => {
    const result = await list(token);
    if (++reads > 1) for (const workspace of result) if (workspace.capacityId === f.ids.first) workspace.capacityId = undefined;
    return result;
  };
  const result = await f.service.bulk("token", "suspend", ["fixtureone", "fixturetwo"], f.actor);
  assert.deepEqual(result.results.map(row => row.status), ["failed", "accepted"]);
  assert.deepEqual(f.calls.filter(call => call.method !== "GET").map(call => call.suffix), ["/fixturetwo/suspend"]);
});

it("safeguards individual operations, skips repeated state changes, and resizes without changing tenant assignment", async () => {
  const f = fixture();
  await assert.rejects(f.service.change("fixturemgmt", "suspend"), { code: "ProtectedManagementResource" });
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.change("fixtureone", "resize"), { code: "MissingSku" });
  f.resources[0]!.properties.provisioningState = "Updating";
  await assert.rejects(f.service.change("fixtureone", "suspend"), { code: "CapacityNotReady" });
  f.resources[0]!.properties.provisioningState = "Failed";
  await assert.rejects(f.service.change("fixtureone", "resize", "F4"), { code: "CapacityNotReady" });
  f.resources[0]!.properties.provisioningState = "Succeeded";
  const workspaces = structuredClone(f.workspaces);
  assert.equal((await f.service.change("fixtureone", "resize", "F4")).status, "accepted");
  assert.deepEqual(f.calls.find(call => call.method === "PATCH")?.body, { sku: { name: "F4", tier: "Fabric" } });
  assert.deepEqual(f.workspaces, workspaces);
  assert.equal((await f.service.change("fixtureone", "resize", "F4")).status, "skipped");
  assert.equal((await f.service.change("fixtureone", "suspend")).status, "accepted");
  assert.equal((await f.service.change("fixtureone", "suspend")).status, "skipped");
  assert.equal((await f.service.change("fixtureone", "resume")).status, "accepted");
  f.resources[0]!.properties.fabricCapacityId = f.ids.management;
  await assert.rejects(f.service.change("fixtureone", "suspend"), { code: "ProtectedManagementResource" });
});

it("enumerates all ARM pages without forwarding credentials outside the configured capacity scope", async () => {
  const f = fixture(), requests: string[] = [];
  f.azure.capacity = async <T>(suffix = "") => {
    requests.push(suffix);
    return (suffix ? { value: [f.resources[1]] } :
      { value: [f.resources[0]], nextLink: `https://management.azure.com${f.base}?api-version=2023-11-01&%24skiptoken=page2` }) as T;
  };
  assert.equal((await f.service.list()).value.length, 2);
  assert.deepEqual(requests, ["", "?%24skiptoken=page2"]);
  f.azure.capacity = async <T>() => ({ value: [], nextLink: "https://example.invalid/capacities?next=2" }) as T;
  await assert.rejects(f.service.list(), { code: "IncompleteCapacityInventory" });
  f.azure.capacity = async <T>() => ({ value: [], nextLink: `https://management.azure.com${f.base}?next=2` }) as T;
  await assert.rejects(f.service.list(), { code: "IncompleteCapacityInventory" });
});

it("keeps individual ARM inventory available when tenant discovery fails, but blocks bulk and unpinned management resources", async () => {
  const f = fixture();
  f.fabric.workspaces = async () => { throw new Error("Operator cannot access Power BI."); };
  const inventory = await f.service.inventory("token");
  assert.equal(inventory.value.length, 3);
  assert.equal(inventory.issues.length, 1);
  assert.ok(inventory.value.every(capacity => !capacity.tenants.length));
  await assert.rejects(f.service.bulk("token", "suspend", ["fixtureone", "fixturetwo"], f.actor), { code: "CapacityAssignmentsUnverified" });
  f.calls.length = 0;
  f.azure.config.ManagementCapacityResourceId = "";
  await assert.rejects(f.service.list(), { code: "MissingManagementConfiguration" });
  await assert.rejects(f.service.change("fixtureone", "resume"), { code: "MissingManagementConfiguration" });
  assert.equal(f.calls.length, 0);
});

it("stops further privileged requests when audit storage fails and explains potentially submitted work", async () => {
  const f = fixture();
  f.repo.audit = async () => { throw new Error("SQL unavailable."); };
  await assert.rejects(f.service.bulk("token", "suspend", ["fixtureone", "fixturetwo"], f.actor),
    { code: "CapacityAuditUnavailable", message: /Remaining requests were stopped/ });
  assert.deepEqual(f.calls.filter(call => call.method !== "GET").map(call => call.suffix), ["/fixtureone/suspend"]);
});
