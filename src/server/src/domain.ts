import { AppError, requireCondition } from "./errors.js";

export const Permission = {
  ViewReport: 1, EditReport: 2, CreateReport: 4, CopyReport: 8,
  UseSemanticModelForAuthoring: 16, ManageContent: 32, ManageNavigation: 64,
} as const;
export const allPermissions = Object.values(Permission).reduce((a, b) => a | b, 0);
export interface Identity { objectId: string; directoryId: string; name: string; username: string }
export interface User {
  Id: string; TenantId: string | null; DirectoryId: string; ObjectId: string; DisplayName: string;
  IsPlatformAdmin: boolean; IsTenantAdmin: boolean; DefaultPermissions: number;
}
export interface Tenant {
  Id: string; Name: string; WorkspaceId: string | null; Status: string;
  EmbeddingClientId: string | null; EmbeddingObjectId: string | null;
  EmbeddingAppObjectId: string | null; SecretName: string | null; LastIssue: string | null;
  ReadinessJson: string | null; LastCheckedAt: string | null;
  PrimaryAdminObjectId?: string | null; PrimaryAdminUpn?: string | null;
}
export interface ContentItem {
  Id: string; TenantId: string; ExternalId: string; Kind: "Report" | "Model"; Name: string;
  ModelExternalId: string | null; EmbedUrl: string | null; Published: boolean; Deleted: boolean;
  RequiresIdentity: boolean; UnsafeDependency: boolean;
}
export interface NavigationNode {
  Id: string; TenantId: string; ParentId: string | null; ContentItemId: string | null;
  Label: string; BreakInheritance: boolean; SortOrder: number;
}
export interface Grant { TenantId: string; NodeId: string; UserId: string; Mask: number }
export const sameId = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

export function tenantMembership(user: User) {
  requireCondition(user.TenantId, 403, "TenantMembershipRequired", "An explicit tenant membership is required for tenant content.");
  return user.TenantId;
}

export function assertNotManagementResource(id: string | null | undefined, managementId: string | null | undefined) {
  requireCondition(!sameId(id, managementId), 409, "ProtectedManagementResource",
    "Management infrastructure cannot be adopted, assigned to customers, or changed through tenant administration.");
}

export function tenantIdentityNames(namespace: string, tenantId: string, existingSecret: string | null) {
  return {
    displayName: namespace ? `${namespace}-tenant-${tenantId}` : `PBIEmbeddedAOD-${tenantId}`,
    secretName: existingSecret || `${namespace ? `${namespace}-` : ""}tenant-${tenantId.replaceAll("-", "").toLowerCase()}`,
  };
}

export function assertCapacityNamespace(resourceName: string, namespace: string) {
  const prefix = namespace.replaceAll("-", "");
  requireCondition(!prefix || resourceName.startsWith(prefix), 400, "CapacityNamePrefix",
    `New capacity names must start with ${prefix}; Fabric capacity names use lowercase letters and digits, without hyphens.`);
}

export function effectivePermissions(user: User, targetId: string, nodes: NavigationNode[], grants: Grant[]): number {
  let node = nodes.find(n => sameId(n.Id, targetId) && sameId(n.TenantId, user.TenantId));
  let mask = 0;
  const visited = new Set<string>();
  while (node) {
    if (visited.has(node.Id.toLowerCase())) throw new AppError(409, "NavigationCycle", "Navigation contains a cycle.");
    visited.add(node.Id.toLowerCase());
    mask |= grants.filter(g => sameId(g.TenantId, user.TenantId) && sameId(g.UserId, user.Id) && sameId(g.NodeId, node!.Id))
      .reduce((a, g) => a | g.Mask, 0);
    if (node.BreakInheritance) return mask;
    if (!node.ParentId) return mask | user.DefaultPermissions;
    node = nodes.find(n => sameId(n.Id, node!.ParentId) && sameId(n.TenantId, user.TenantId));
  }
  return 0;
}

export function assertEmbedding(
  user: User, tenant: Tenant, report: ContentItem, model: ContentItem, mask: number, mode: "view" | "edit" | "copy",
  modelMask: number = mask,
) {
  requireCondition(sameId(user.TenantId, tenant.Id) && sameId(report.TenantId, tenant.Id) && sameId(model.TenantId, tenant.Id),
    404, "NotFound", "The requested content is not available in your tenant.");
  requireCondition(tenant.WorkspaceId && report.Kind === "Report" && model.Kind === "Model" &&
    sameId(report.ModelExternalId, model.ExternalId), 409, "InvalidDependency", "The report's model dependency is invalid.");
  requireCondition(report.Published && !report.Deleted && !model.Deleted && !report.UnsafeDependency && !model.UnsafeDependency,
    403, "ContentUnavailable", "The content is unpublished, deleted, or has unsupported dependencies.");
  requireCondition(!model.RequiresIdentity, 409, "RlsNotSupported",
    "This model requires an effective identity. Effective-username RLS is a future capability; unfiltered fallback is not allowed.");
  let needed: number = Permission.ViewReport;
  if (mode === "edit") needed |= Permission.EditReport;
  if (mode === "copy") needed |= Permission.EditReport | Permission.CopyReport;
  requireCondition((mask & needed) === needed, 403, "Forbidden", "You do not have permission for this report operation.");
  if (mode !== "view") requireCondition(model.Published && Boolean(modelMask & Permission.UseSemanticModelForAuthoring),
    403, "ModelAuthoringForbidden", "The model must be published and explicitly authorized for authoring.");
}

export function tokenPayload(reportId: string, modelId: string, workspaceId: string, mode: "view" | "edit" | "copy") {
  return {
    reports: [{ id: reportId, allowEdit: mode !== "view" }],
    datasets: [{ id: modelId }],
    ...(mode === "copy" ? { targetWorkspaces: [{ id: workspaceId }] } : {}),
  };
}

export function assertMove(nodeId: string, parentId: string, nodes: NavigationNode[], tenantId: string) {
  const node = nodes.find(n => sameId(n.Id, nodeId) && sameId(n.TenantId, tenantId));
  requireCondition(node?.ParentId, 400, "InvalidMove", "The tenant root cannot be moved.");
  let parent = nodes.find(n => sameId(n.Id, parentId) && sameId(n.TenantId, tenantId));
  requireCondition(parent && !parent.ContentItemId, 400, "InvalidParent", "Choose a folder in the same tenant.");
  const visited = new Set<string>();
  while (parent) {
    requireCondition(!sameId(parent.Id, nodeId) && !visited.has(parent.Id), 400, "NavigationCycle", "A move cannot create a cycle.");
    visited.add(parent.Id);
    parent = nodes.find(n => sameId(n.Id, parent!.ParentId) && sameId(n.TenantId, tenantId));
  }
}
