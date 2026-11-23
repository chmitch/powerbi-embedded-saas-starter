export interface User {
  Id: string; TenantId: string | null; DisplayName: string; ObjectId: string;
  IsPlatformAdmin: boolean; IsTenantAdmin: boolean; DefaultPermissions: number;
}
export interface Session {
  configured: boolean; csrf: string; bootstrapComplete: boolean; canBootstrap: boolean; resourceNamePrefix: string;
  identity: { name: string; username: string } | null; user: User | null;
}
export interface Tenant {
  Id: string; Name: string; WorkspaceId: string | null; Status: string;
  EmbeddingClientId: string | null; EmbeddingObjectId: string | null; LastIssue: string | null;
  ReadinessJson: string | null; LastCheckedAt: string | null;
}
export interface ContentItem {
  Id: string; Name: string; Kind: "Report" | "Model"; Published: boolean;
  UnsafeDependency: boolean; RequiresIdentity: boolean;
}
export interface ReportItem extends ContentItem {
  label: string; nodeId: string; permissions: number; canAuthorModel: boolean; canCreateCopy: boolean;
}
export interface NavNode {
  Id: string; ParentId: string | null; ContentItemId: string | null; Label: string;
  BreakInheritance: boolean; SortOrder: number;
}
export interface Grant { UserId: string; NodeId: string; Mask: number }
export interface ManageData { tenant: Tenant; content: ContentItem[]; users: User[]; nodes: NavNode[]; grants: Grant[] }
export interface Catalog { tenant: { Name: string; Status: string }; reports: ReportItem[]; models: ContentItem[]; nodes: NavNode[] }
export interface Workspace { id: string; name: string; tenant: string | null; capacityId?: string }
export interface Capacity { id: string; displayName: string; state: string }
export interface ArmCapacity { name: string; sku: { name: string }; properties: { state?: string; provisioningState?: string } }
export interface TenantCapacity extends ArmCapacity { tenants: { id: string; name: string }[] }
export interface CapacityInventory {
  value: TenantCapacity[]; issues: string[]; excludedTenants: { id: string; name: string }[];
}
export interface TenantCapacityStatus { capacity: TenantCapacity | null; issue: string | null }
export interface CapacityResult {
  name: string; status: "accepted" | "skipped" | "failed" | "succeeded" | "unconfirmed"; message: string;
}
export interface CapacityPolicyStatus {
  enabled: boolean; source: "deployment" | "platform"; revision: string | null; available: boolean; issue: string | null;
}
export interface Check { key: string; status: string; message: string }
export interface SetupOperation {
  id: string; tenantId: string; status: "Running" | "Interrupted" | "Succeeded" | "Failed";
  steps: { key: string; label: string; status: "pending" | "running" | "done" | "failed"; message?: string }[];
  error: string | null; canRetry: boolean; recoveryRequired: boolean;
}
export interface TenantSettings {
  tenant: Tenant; workspace: Workspace | null; workspaceIssue: string | null; administratorUpn: string | null;
  administrators: { Id: string; ObjectId: string; DisplayName: string }[]; operation: SetupOperation | null;
}
export interface EmbedConfiguration {
  id?: string; datasetId?: string; embedUrl: string; accessToken: string;
  expiration: string; mode: "view" | "edit" | "copy"; create: boolean;
  targetWorkspaceId?: string;
  autoResumeCapacities?: boolean; capacityResumed?: boolean;
  renderReceipt?: string; renderTrackingUnavailable?: boolean;
  requestTrackingUnavailable?: boolean;
}
export const permissions = { ViewReport: 1, EditReport: 2, CreateReport: 4, CopyReport: 8,
  UseSemanticModelForAuthoring: 16, ManageContent: 32, ManageNavigation: 64 };
let csrf = "";
export function setCsrf(value: string) { csrf = value; }
export async function api<T>(url: string, method = "GET", body?: unknown, options: { keepalive?: boolean } = {}): Promise<T> {
  const response = await fetch(url, { method, credentials: "same-origin", keepalive: options.keepalive, headers: {
    "Content-Type": "application/json", "X-CSRF-Token": csrf,
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json() as { message?: string; code?: string };
  if (!response.ok) throw new Error(data.message ?? `Request failed (${response.status})`);
  return data as T;
}
