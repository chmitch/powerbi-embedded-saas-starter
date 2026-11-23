import type { AzureServices } from "./azure.js";
import type { User } from "./domain.js";
import { assertNotManagementResource, sameId } from "./domain.js";
import { AppError, requireCondition } from "./errors.js";
import type { FabricService } from "./fabric.js";
import type { Repository } from "./repository.js";

export interface ManagedCapacity {
  id?: string; name: string; sku: { name: string };
  properties: { state?: string; provisioningState?: string; fabricCapacityId?: string };
}
interface CapacityAssignment { id: string; name: string }
export interface CapacityInventory {
  value: (ManagedCapacity & { tenants: CapacityAssignment[] })[];
  issues: string[]; excludedTenants: CapacityAssignment[];
}
export interface TenantCapacityStatus { capacity: CapacityInventory["value"][number] | null; issue: string | null }
export type CapacityAction = "suspend" | "resume" | "resize";
export interface CapacityResult { name: string; status: "accepted" | "skipped" | "failed"; message: string }
const paused = (state?: string) => state === "Paused" || state === "Suspended";

export class CapacityManagement {
  constructor(private repo: Repository, private azure: AzureServices, private fabric: FabricService) {}

  private assertConfigured() {
    requireCondition(this.azure.config.ManagementCapacityResourceId && this.azure.config.ManagementCapacityId &&
      this.azure.config.ManagementWorkspaceId, 409, "MissingManagementConfiguration",
      "Capacity management requires pinned management workspace and capacity references.");
  }
  async list() {
    this.assertConfigured();
    const value: ManagedCapacity[] = [];
    const base = `https://management.azure.com/subscriptions/${encodeURIComponent(this.azure.config.SubscriptionId)}/resourceGroups/${encodeURIComponent(this.azure.config.ResourceGroup)}/providers/Microsoft.Fabric/capacities`;
    let suffix = "";
    const visited = new Set<string>();
    for (let page = 0; page < 100; page++) {
      requireCondition(!visited.has(suffix), 502, "IncompleteCapacityInventory", "Azure repeated a capacity inventory page.");
      visited.add(suffix);
      const result = await this.azure.capacity<{ value: ManagedCapacity[]; nextLink?: string }>(suffix);
      requireCondition(Array.isArray(result.value), 502, "IncompleteCapacityInventory", "Azure did not return a complete capacity inventory.");
      for (const capacity of result.value) {
        requireCondition(/^[a-z][a-z0-9]{2,62}$/.test(capacity.name) && capacity.sku?.name && capacity.properties,
          502, "IncompleteCapacityInventory", "Azure returned an invalid capacity resource.");
        if (sameId(capacity.name, this.azure.config.ManagementCapacityResourceId.split("/").at(-1)) ||
          sameId(capacity.id, this.azure.config.ManagementCapacityResourceId) ||
          sameId(capacity.properties.fabricCapacityId, this.azure.config.ManagementCapacityId)) continue;
        requireCondition(!value.some(item => sameId(item.name, capacity.name)), 502, "IncompleteCapacityInventory",
          "Azure returned duplicate capacity resources.");
        value.push(capacity);
      }
      if (!result.nextLink) return { value };
      const next = new URL(result.nextLink), expected = new URL(base);
      requireCondition(next.origin === expected.origin && next.pathname.toLowerCase() === expected.pathname.toLowerCase() &&
        !next.username && !next.password, 502, "IncompleteCapacityInventory", "Azure returned an out-of-scope continuation URL.");
      next.searchParams.delete("api-version");
      requireCondition(next.searchParams.size > 0, 502, "IncompleteCapacityInventory", "Azure returned an invalid continuation URL.");
      suffix = next.search;
    }
    throw new AppError(409, "DiscoveryLimit", "Capacity inventory exceeded its pagination limit.");
  }

  async inventory(token: string): Promise<CapacityInventory> {
    const { value } = await this.list();
    const inventory: CapacityInventory = {
      value: value.map(capacity => ({ ...capacity, tenants: [] })), issues: [], excludedTenants: [],
    };
    const tenants = await this.repo.tenants();
    let workspaces, capacities: { id: string; displayName: string }[];
    try {
      const [workspaceList, capacityList] = await Promise.all([
        this.fabric.workspaces(token),
        this.fabric.operator<{ value: { id: string; displayName: string }[] }>(token, "/capacities"),
      ]);
      requireCondition(Array.isArray(capacityList.value), 502, "IncompleteCapacityInventory", "Power BI capacity inventory is incomplete.");
      workspaces = workspaceList; capacities = capacityList.value;
    } catch {
      inventory.issues.push("Tenant capacity assignments could not be verified. Check the operator's Power BI workspace/capacity access and refresh.");
      return inventory;
    }
    for (const tenant of tenants) {
      if (!tenant.WorkspaceId) continue;
      if (sameId(tenant.WorkspaceId, this.azure.config.ManagementWorkspaceId)) {
        inventory.issues.push(`${tenant.Name}: the registered workspace is protected management infrastructure.`);
        continue;
      }
      const matches = workspaces.filter(workspace => sameId(workspace.id, tenant.WorkspaceId));
      if (matches.length !== 1) {
        inventory.issues.push(`${tenant.Name}: the operator cannot uniquely verify its registered workspace.`);
        continue;
      }
      const capacityId = matches[0]!.capacityId;
      if (!capacityId) continue;
      if (sameId(capacityId, this.azure.config.ManagementCapacityId)) {
        inventory.issues.push(`${tenant.Name}: the assigned capacity is protected management infrastructure.`);
        continue;
      }
      const remote = capacities.filter(capacity => sameId(capacity.id, capacityId));
      const uniqueName = remote.length === 1 &&
        capacities.filter(capacity => sameId(capacity.displayName, remote[0]!.displayName)).length === 1;
      const arm = inventory.value.filter(capacity => sameId(capacity.properties.fabricCapacityId, capacityId) ||
        (uniqueName && sameId(capacity.name, remote[0]!.displayName)));
      if (arm.length === 1 && !(arm[0]!.properties.fabricCapacityId &&
        !sameId(arm[0]!.properties.fabricCapacityId, capacityId))) {
        arm[0]!.tenants.push({ id: tenant.Id, name: tenant.Name });
      } else if (!arm.length && uniqueName &&
        !inventory.value.some(capacity => sameId(capacity.name, remote[0]!.displayName))) {
        inventory.excludedTenants.push({ id: tenant.Id, name: tenant.Name });
      } else {
        inventory.issues.push(`${tenant.Name}: its Fabric-to-Azure capacity mapping could not be verified.`);
      }
    }
    return inventory;
  }

  async forTenant(tenantId: string, token: string): Promise<TenantCapacityStatus> {
    this.assertConfigured();
    const tenant = await this.repo.tenant(tenantId);
    assertNotManagementResource(tenant.WorkspaceId, this.azure.config.ManagementWorkspaceId);
    if (!tenant.WorkspaceId) return { capacity: null, issue: "No workspace is assigned. Complete tenant setup first." };
    const inventory = await this.inventory(token);
    const matches = inventory.value.filter(capacity => capacity.tenants.some(item => sameId(item.id, tenantId)));
    if (matches.length === 1) return { capacity: matches[0]!, issue: null };
    return { capacity: null, issue: inventory.excludedTenants.some(item => sameId(item.id, tenantId))
      ? "The assigned capacity is outside this deployment's Azure scope. Manage it in Azure or select another capacity."
      : "The tenant's current customer capacity could not be uniquely verified. Check the assignment and operator visibility before resuming." };
  }

  async resumeTenant(tenantId: string, token: string, confirmName: string, actor: User) {
    const { capacity, issue } = await this.forTenant(tenantId, token);
    requireCondition(capacity, 409, "TenantCapacityUnverified", issue!);
    requireCondition(capacity.name === confirmName, 409, "CapacitySelectionChanged",
      "The tenant's capacity changed. Refresh its configuration and confirm the currently assigned resource.");
    await this.repo.audit(actor, "ResumeTenantCapacity", capacity.name, "Requested", tenantId);
    let result: CapacityResult;
    try { result = await this.change(capacity.name, "resume"); }
    catch (error) {
      await this.repo.audit(actor, "ResumeTenantCapacity", capacity.name, "Failed", tenantId);
      throw error;
    }
    try { await this.repo.audit(actor, "ResumeTenantCapacity", capacity.name, result.status === "accepted" ? "Accepted" : "Skipped", tenantId); }
    catch { throw new AppError(503, "CapacityAuditUnavailable",
      "The capacity request may already have been submitted, but its completion audit failed. Inspect Azure state before retrying."); }
    return result;
  }

  async change(name: string, action: CapacityAction, sku?: string): Promise<CapacityResult> {
    this.assertConfigured();
    requireCondition(/^[a-z][a-z0-9]{2,62}$/.test(name), 400, "InvalidCapacity", "The capacity resource name is invalid.");
    assertNotManagementResource(name, this.azure.config.ManagementCapacityResourceId.split("/").at(-1));
    requireCondition(action !== "resize" || (sku && /^F(2|4|8|16|32|64|128|256|512|1024|2048|4096|8192)$/.test(sku)),
      400, "MissingSku", "Select a supported SKU for resizing.");
    const resource = await this.azure.capacity<ManagedCapacity>(`/${name}`);
    requireCondition(sameId(resource.name, name), 409, "CapacityMappingChanged", "Azure returned a different capacity.");
    assertNotManagementResource(resource.id, this.azure.config.ManagementCapacityResourceId);
    assertNotManagementResource(resource.properties.fabricCapacityId, this.azure.config.ManagementCapacityId);
    requireCondition((!resource.properties.provisioningState || resource.properties.provisioningState === "Succeeded") &&
      (resource.properties.state === "Active" || paused(resource.properties.state)), 409, "CapacityNotReady",
      "The capacity is changing, unavailable, or in an unsupported state. Refresh its Azure status before submitting another operation.");
    if ((action === "suspend" && paused(resource.properties.state)) ||
      (action === "resume" && resource.properties.state === "Active") ||
      (action === "resize" && resource.sku.name === sku))
      return { name, status: "skipped", message: "Already in the requested state." };
    try {
      if (action === "resize") await this.azure.capacity(`/${name}`, "PATCH", { sku: { name: sku, tier: "Fabric" } });
      else await this.azure.capacity(`/${name}/${action}`, "POST");
    } catch (error) {
      throw new AppError(error instanceof AppError ? error.status : 502,
        error instanceof AppError ? error.code : "CapacityOutcomeUnknown",
        `${error instanceof AppError ? error.message : "The capacity request could not be confirmed."} Inspect Azure capacity status before retrying; a request may already have been submitted.`);
    }
    return { name, status: "accepted", message: "Azure accepted the request; completion must still be observed." };
  }

  async bulk(token: string, action: "suspend" | "resume", confirmNames: string[], actor: User) {
    const inventory = await this.inventory(token);
    requireCondition(!inventory.issues.length, 409, "CapacityAssignmentsUnverified",
      "Some tenant capacity assignments could not be verified. Refresh and resolve the inventory warnings before a bulk operation.");
    const targets = inventory.value.filter(capacity => capacity.tenants.length);
    requireCondition(targets.length > 0, 409, "NoTenantCapacities", "No registered tenant capacities are available in this deployment.");
    requireCondition(confirmNames.length === targets.length && new Set(confirmNames).size === confirmNames.length &&
      targets.every(capacity => confirmNames.includes(capacity.name)), 409, "CapacitySelectionChanged",
      "The tenant capacity selection changed or was not fully confirmed. Refresh and confirm the current affected capacities.");
    const results: CapacityResult[] = [];
    for (const capacity of targets) {
      try {
        const current = await this.inventory(token);
        requireCondition(!current.issues.length && current.value.some(item => sameId(item.name, capacity.name) && item.tenants.length),
          409, "CapacitySelectionChanged", "This capacity's tenant assignment could not be reverified; no request was submitted.");
        const result = await this.change(capacity.name, action);
        results.push(result);
      } catch (error) {
        results.push({ name: capacity.name, status: "failed", message: error instanceof AppError ? error.message :
          "The request could not be confirmed. Inspect Azure capacity status before retrying." });
      }
      try {
        await this.repo.audit({ Id: actor.Id, TenantId: null }, `CapacityBulk:${action}`, capacity.name,
          results.at(-1)!.status === "accepted" ? "Accepted" : results.at(-1)!.status === "skipped" ? "Skipped" : "Failed");
      } catch {
        throw new AppError(503, "CapacityAuditUnavailable",
          "Capacity requests may already have been submitted, but audit storage is unavailable. Remaining requests were stopped. Refresh Azure capacity status before retrying.");
      }
    }
    return { action, results };
  }
}
