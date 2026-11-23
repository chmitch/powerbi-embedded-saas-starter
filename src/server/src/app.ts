import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import helmet from "helmet";
import { z } from "zod";
import { AzureServices, userPrincipalNameSchema } from "./azure.js";
import { AuthService, csrfProtection, csrfValue, EncryptedSqlSessionStore } from "./auth.js";
import { configured, isProduction, type AppConfig } from "./config.js";
import { Database } from "./db.js";
import { allPermissions, assertCapacityNamespace, assertMove, assertNotManagementResource, effectivePermissions, Permission, sameId, tenantMembership, type NavigationNode, type User } from "./domain.js";
import { AppError, requireCondition } from "./errors.js";
import { FabricService, type Workspace } from "./fabric.js";
import { Repository } from "./repository.js";
import { startReconciliation } from "./background.js";
import { setupSchema, TenantProvisioner } from "./provisioning.js";
import { capacityDemand, CapacityRecovery } from "./capacity-recovery.js";
import { CapacityManagement } from "./capacity-management.js";
import { CapacityPolicy } from "./capacity-policy.js";
import { ReportRenders } from "./report-renders.js";
import { ReportRequests } from "./report-requests.js";
import { Insights } from "./insights.js";

const uuid = z.uuid();
const name = z.string().trim().min(1).max(200);
const permissionMask = z.number().int().min(0).max(allPermissions);
interface AuthenticatedRequest extends Request { appUser: User }
const getUser = (req: Request) => (req as AuthenticatedRequest).appUser;
const idParam = (req: Request, key = "id") => uuid.parse(req.params[key]);
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

export async function createApp(config: AppConfig) {
  const readyConfig = configured(config);
  const azure = new AzureServices(config);
  const capacityPolicy = new CapacityPolicy(azure);
  if (readyConfig) await capacityPolicy.refresh(true);
  const recovery = new CapacityRecovery(azure);
  const db = new Database(azure, recovery);
  const repo = new Repository(db);
  const auth = new AuthService(azure);
  const fabric = new FabricService(repo, azure, recovery);
  const provisioner = new TenantProvisioner(repo, azure, fabric);
  const capacityManagement = new CapacityManagement(repo, azure, fabric);
  const app = express();
  const embedReceivedAt = new WeakMap<Request, Date>();
  app.use((req, _res, next) => {
    if (req.method === "POST" && req.path.toLowerCase() === "/api/embed/report") embedReceivedAt.set(req, new Date());
    next();
  });
  app.disable("x-powered-by");
  if (isProduction) app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    "default-src": ["'self'"], "frame-src": ["https://app.powerbi.com", "https://*.powerbi.com"],
    "connect-src": ["'self'", "https://*.powerbi.com"], "img-src": ["'self'", "data:", "https://*.powerbi.com"],
    "worker-src": ["'self'", "blob:"], "upgrade-insecure-requests": isProduction ? [] : null,
  } } }));
  app.use(express.json({ limit: "64kb" }));
  app.get("/health/live", (_req, res) => res.json({ status: "live" }));
  app.get("/health/ready", wrap(async (_req, res) => {
    requireCondition(readyConfig, 503, "NotConfigured", "Provision and configure the application.");
    await db.query("SELECT TOP(1) Version FROM app.SchemaVersions");
    await azure.secret(config.WebClientSecretName);
    await azure.secret(config.SessionSecretName);
    res.json({ status: "ready" });
  }));
  app.get("/api/status", (_req, res) => res.json({ configured: readyConfig, stack: "Node.js / TypeScript", cloud: "Azure public" }));
  const webPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  app.use(express.static(webPath, { index: false }));
  app.get("/", (_req, res) => res.sendFile(path.join(webPath, "index.html")));
  app.use((req, _res, next) => {
    const foreground = req.path.startsWith("/api/") || req.path.startsWith("/auth/");
    if (readyConfig && foreground) {
      void capacityPolicy.refresh().then(() => capacityDemand.run(true, next)).catch(next);
    } else capacityDemand.run(foreground, next);
  });
  const sessionKey = readyConfig ? await azure.secret(config.SessionSecretName) : randomBytes(32).toString("base64");
  const reportRenders = new ReportRenders(repo, sessionKey);
  const reportRequests = new ReportRequests(repo);
  const insights = new Insights(db);
  app.use(session({
    name: "pbi.sid", secret: sessionKey, resave: false, saveUninitialized: false,
    store: readyConfig ? new EncryptedSqlSessionStore(db, () => azure.secret(config.SessionSecretName)) : undefined,
    cookie: { httpOnly: true, secure: isProduction, sameSite: "lax", maxAge: 8 * 3_600_000, path: "/" },
  }));
  app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.use(csrfProtection);
  app.get("/api/session", wrap(async (req, res) => {
    req.session.csrf ??= csrfValue();
    const identity = req.session.identity;
    res.json({
      configured: readyConfig, csrf: req.session.csrf, resourceNamePrefix: config.ResourceNamePrefix,
      bootstrapComplete: readyConfig ? await repo.bootstrapComplete() : false,
      canBootstrap: Boolean(identity && sameId(identity.objectId, config.BootstrapObjectId) && sameId(identity.directoryId, config.DirectoryTenantId)),
      identity: identity ? { name: identity.name, username: identity.username } : null,
      user: identity ? (await repo.user(identity) ?? null) : null,
    });
  }));
  app.get("/auth/login", wrap(async (req, res) => {
    requireCondition(readyConfig, 503, "NotConfigured", "Run Initialize-Local.ps1 and restart the server.");
    res.redirect(await auth.login(req));
  }));
  app.get("/auth/callback", wrap(async (req, res) => { await auth.callback(req); res.redirect("/"); }));
  app.post("/auth/logout", wrap(async (req, res) => {
    await new Promise<void>((resolve, reject) => req.session.destroy(e => e ? reject(e) : resolve()));
    res.clearCookie("pbi.sid", { path: "/" });
    res.json({ redirect: `https://login.microsoftonline.com/${config.DirectoryTenantId}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(config.PublicOrigin)}` });
  }));
  app.post("/api/bootstrap", wrap(async (req, res) => {
    const identity = req.session.identity;
    requireCondition(identity && sameId(identity.objectId, config.BootstrapObjectId) && sameId(identity.directoryId, config.DirectoryTenantId),
      403, "BootstrapForbidden", "Only the configured bootstrap operator may perform first-run setup.");
    z.object({}).strict().parse(req.body);
    await auth.operatorToken(req);
    await repo.bootstrap(identity);
    res.status(201).json({ complete: true });
  }));
  app.use("/api", (req, res, next) => { void Promise.resolve((async () => {
    requireCondition(req.session.identity, 401, "SignInRequired", "Sign in first.");
    const user = await repo.user(req.session.identity);
    requireCondition(user, 403, "NotRegistered", "An administrator must register your application account.");
    (req as AuthenticatedRequest).appUser = user;
  })()).then(() => next()).catch(next); });
  const platform = (req: Request) => requireCondition(getUser(req).IsPlatformAdmin, 403, "PlatformAdminRequired", "Platform administrator permission is required.");
  const manageTenant = (req: Request, tenantId: string) => requireCondition(
    sameId(getUser(req).TenantId, tenantId) && getUser(req).IsTenantAdmin, 403, "TenantAdminRequired",
    "An explicit tenant administrator role in this tenant is required. Platform administration grants no tenant access.");
  async function ownRootPermission(req: Request, permission: number) {
    const user = getUser(req);
    const { nodes, grants } = await repo.security(tenantMembership(user));
    const root = nodes.find(n => !n.ParentId);
    requireCondition(root && (effectivePermissions(user, root.Id, nodes, grants) & permission) === permission,
      403, "Forbidden", "The required tenant permission is not granted.");
  }
  app.get("/api/admin/insights", wrap(async (req, res) => {
    res.json(await insights.platform(getUser(req), req.query));
  }));
  app.get("/api/tenants/:id/insights", wrap(async (req, res) => {
    res.json(await insights.tenant(getUser(req), idParam(req), req.query));
  }));
  app.get("/api/me/content", wrap(async (req, res) => {
    const user = getUser(req);
    const tenantId = tenantMembership(user);
    const [tenant, content, security] = await Promise.all([repo.tenant(tenantId), repo.content(tenantId), repo.security(tenantId)]);
    const root = security.nodes.find(n => !n.ParentId);
    const rootMask = root ? effectivePermissions(user, root.Id, security.nodes, security.grants) : 0;
    const reports = content.filter(c => c.Kind === "Report" && c.Published && !c.UnsafeDependency).flatMap(c => {
      const node = security.nodes.find(n => sameId(n.ContentItemId, c.Id));
      const permissions = node ? effectivePermissions(user, node.Id, security.nodes, security.grants) : 0;
      const model = content.find(m => m.Kind === "Model" && sameId(m.ExternalId, c.ModelExternalId));
      const modelNode = model && security.nodes.find(n => sameId(n.ContentItemId, model.Id));
      const modelPermissions = modelNode ? effectivePermissions(user, modelNode.Id, security.nodes, security.grants) : 0;
      return permissions & Permission.ViewReport ? [{ ...c, label: node!.Label, nodeId: node!.Id, permissions,
        canCreateCopy: Boolean(rootMask & Permission.CreateReport),
        canAuthorModel: Boolean(model?.Published && !model.RequiresIdentity && !model.UnsafeDependency &&
          (modelPermissions & Permission.UseSemanticModelForAuthoring)) }] : [];
    });
    const models = (rootMask & Permission.CreateReport)
      ? content.filter(c => {
        const modelNode = security.nodes.find(n => sameId(n.ContentItemId, c.Id));
        return c.Kind === "Model" && c.Published && !c.RequiresIdentity && !c.UnsafeDependency && modelNode &&
          (effectivePermissions(user, modelNode.Id, security.nodes, security.grants) & Permission.UseSemanticModelForAuthoring);
      }) : [];
    const visibleIds = new Set(reports.map(r => r.nodeId.toLowerCase()));
    for (const report of reports) {
      let node = security.nodes.find(n => sameId(n.Id, report.nodeId));
      const visited = new Set<string>();
      while (node?.ParentId && !visited.has(node.Id)) {
        visited.add(node.Id);
        visibleIds.add(node.ParentId.toLowerCase());
        node = security.nodes.find(n => sameId(n.Id, node!.ParentId));
      }
    }
    res.json({ tenant: { Id: tenant.Id, Name: tenant.Name, Status: tenant.Status }, reports, models,
      nodes: security.nodes.filter(n => visibleIds.has(n.Id.toLowerCase())) });
  }));
  app.post("/api/embed/report", wrap(async (req, res) => {
    const input = z.object({ contentId: uuid, mode: z.enum(["view", "edit", "copy"]).default("view"),
      recoverCapacity: z.boolean().default(false),
      render: z.object({ requestedAt: z.string().datetime().max(40), receipt: z.string().max(6000).optional(),
        requestId: uuid.optional() }).strict().optional(),
    }).strict().parse(req.body);
    const user = getUser(req);
    let requestTracked = false;
    let requestContext: Awaited<ReturnType<ReportRequests["start"]>> | undefined;
    let requestTrackingUnavailable = false;
    if (input.render?.requestId) {
      try {
        requestContext = await reportRequests.start(user, input.render.requestId, input.contentId, input.mode,
          input.render.requestedAt, embedReceivedAt.get(req) ?? new Date());
        requestTracked = true;
      } catch { requestTrackingUnavailable = true; console.error(JSON.stringify({ code: "ReportRequestTrackingUnavailable" })); }
    }
    async function outcome(status: "Authorized" | "Failed") {
      if (!requestTracked) return;
      try { await reportRequests.outcome(user, input.render!.requestId!, status); }
      catch { requestTrackingUnavailable = true; console.error(JSON.stringify({ code: "ReportRequestTrackingUnavailable" })); }
    }
    let result: Awaited<ReturnType<FabricService["embed"]>>;
    try { result = await fabric.embed(user, input.contentId, input.mode, input.recoverCapacity); }
    catch (error) { await outcome("Failed"); throw error; }
    await outcome("Authorized");
    await repo.audit(getUser(req), "EmbedToken", input.contentId, input.mode);
    if (!input.render) { res.json(result); return; }
    try {
      const renderReceipt = await reportRenders.issue(getUser(req), input.contentId, result.id, input.mode,
        input.render.requestedAt, requestContext?.receivedAt ?? embedReceivedAt.get(req) ?? new Date(), input.render.receipt,
        requestTracked ? input.render.requestId : undefined, requestContext?.renderId);
      res.json({ ...result, renderReceipt, ...(requestTrackingUnavailable ? { requestTrackingUnavailable: true } : {}) });
    } catch {
      console.error(JSON.stringify({ code: "ReportRenderTrackingUnavailable" }));
      res.json({ ...result, renderTrackingUnavailable: true });
    }
  }));
  app.post("/api/telemetry/report-rendered", wrap(async (req, res) => {
    const input = z.object({ receipt: z.string().min(1).max(6000), durationMs: z.number().int().min(0).max(86_400_000) })
      .strict().parse(req.body);
    const result = await reportRenders.record(getUser(req), input.receipt, input.durationMs);
    res.status(result.duplicate ? 200 : 201).json(result);
  }));
  app.post("/api/embed/create", wrap(async (req, res) => {
    const { modelId, recoverCapacity } = z.object({ modelId: uuid, recoverCapacity: z.boolean().default(false) }).strict().parse(req.body);
    res.json(await fabric.createReport(getUser(req), modelId, recoverCapacity));
  }));
  app.post("/api/me/register-report", wrap(async (req, res) => {
    await ownRootPermission(req, Permission.CreateReport);
    await fabric.sync(tenantMembership(getUser(req)));
    res.json({ message: "Workspace inventory refreshed. Newly created reports require administrator publication." });
  }));
  app.patch("/api/me/reports/:contentId/label", wrap(async (req, res) => {
    const user = getUser(req);
    const tenantId = tenantMembership(user);
    const { label } = z.object({ label: name }).strict().parse(req.body);
    const { nodes, grants } = await repo.security(tenantId);
    const node = nodes.find(n => sameId(n.ContentItemId, idParam(req, "contentId")));
    requireCondition(node && (effectivePermissions(user, node.Id, nodes, grants) & Permission.ManageNavigation),
      403, "Forbidden", "Navigation management permission is required for this report.");
    await db.query("UPDATE app.Nodes SET Label=@label WHERE Id=@nodeId AND TenantId=@tenantId",
      { label, nodeId: node.Id, tenantId });
    await repo.audit(user, "RenameNavigationLabel", node.Id);
    res.json({ updated: true });
  }));
  app.get("/api/admin/tenants", wrap(async (req, res) => { platform(req); res.json(await repo.tenants()); }));
  app.use("/api/admin/tenants/:id", (req, _res, next) => {
    if (["GET", "HEAD"].includes(req.method) || req.path === "/setup" || !uuid.safeParse(req.params.id).success) return next();
    try { platform(req); } catch (error) { next(error); return; }
    void db.query("SELECT Id FROM app.ProvisioningOperations WHERE TenantId=@id AND Status='Running'", { id: req.params.id as string })
      .then(rows => { requireCondition(!rows.length, 409, "SetupInProgress", "Wait for tenant setup to finish before changing infrastructure or administrator appointments."); next(); })
      .catch(next);
  });
  app.get("/api/admin/tenants/:id/settings", wrap(async (req, res) => {
    platform(req); res.json(await provisioner.settings(idParam(req), await auth.operatorToken(req)));
  }));
  app.get("/api/admin/tenants/:id/capacity", wrap(async (req, res) => {
    platform(req);
    res.json(await capacityManagement.forTenant(idParam(req), await auth.operatorToken(req)));
  }));
  app.post("/api/admin/tenants/:id/capacity/resume", wrap(async (req, res) => {
    platform(req);
    const input = z.object({ confirmName: z.string().regex(/^[a-z][a-z0-9]{2,62}$/), confirmBilling: z.literal(true) }).strict().parse(req.body);
    res.status(202).json(await capacityManagement.resumeTenant(idParam(req), await auth.operatorToken(req), input.confirmName, getUser(req)));
  }));
  app.post("/api/admin/tenants/:id/remediation/access", wrap(async (req, res) => {
    platform(req);
    const input = z.object({ confirmWorkspaceId: uuid, confirmPrincipalId: uuid, confirmAccess: z.literal(true) }).strict().parse(req.body);
    res.json(await fabric.repairWorkspaceAccess(idParam(req), await auth.operatorToken(req),
      input.confirmWorkspaceId, input.confirmPrincipalId, getUser(req)));
  }));
  app.post("/api/admin/tenants/:id/setup", wrap(async (req, res) => {
    platform(req);
    res.status(202).json(await provisioner.start(setupSchema.parse(req.body), getUser(req),
      req.session.identity!.username, await auth.operatorToken(req), idParam(req)));
  }));
  app.get("/api/admin/operations/:id", wrap(async (req, res) => {
    platform(req); res.json(provisioner.view(await provisioner.operation(idParam(req))));
  }));
  app.post("/api/admin/operations/:id/retry", wrap(async (req, res) => {
    platform(req); res.status(202).json(await provisioner.retry(idParam(req), getUser(req), await auth.operatorToken(req)));
  }));
  app.get("/api/admin/tenants/:id/admins", wrap(async (req, res) => {
    platform(req);
    const id = idParam(req);
    await repo.tenant(id);
    res.json((await repo.users(id)).filter(user => user.IsTenantAdmin)
      .map(({ Id, ObjectId, DisplayName }) => ({ Id, ObjectId, DisplayName })));
  }));
  app.post("/api/admin/tenants/:id/admins", wrap(async (req, res) => {
    platform(req);
    const id = idParam(req);
    const input = z.union([
      z.object({ userPrincipalName: userPrincipalNameSchema }).strict(),
      z.object({ objectId: uuid, displayName: name }).strict(),
    ]).parse(req.body);
    await repo.tenant(id);
    const identity = "userPrincipalName" in input ? await azure.resolveUserPrincipalName(input.userPrincipalName) : input;
    await repo.assignTenantAdmin(id, config.DirectoryTenantId, identity.objectId, identity.displayName);
    await repo.audit(getUser(req), "AssignTenantAdmin", identity.objectId, "Succeeded", id);
    res.json({ assigned: true });
  }));
  app.delete("/api/admin/tenants/:id/admins/:userId", wrap(async (req, res) => {
    platform(req);
    const id = idParam(req), userId = idParam(req, "userId");
    await repo.tenant(id);
    requireCondition((await repo.users(id)).some(user => sameId(user.Id, userId)), 404, "NotFound", "User not found in this tenant.");
    await db.query(`UPDATE app.Users SET IsTenantAdmin=0 WHERE Id=@userId AND TenantId=@id;
      UPDATE app.Tenants SET PrimaryAdminObjectId=NULL,PrimaryAdminUpn=NULL WHERE Id=@id AND
      PrimaryAdminObjectId IN(SELECT ObjectId FROM app.Users WHERE Id=@userId AND TenantId=@id);`, { userId, id });
    await repo.audit(getUser(req), "RevokeTenantAdmin", userId, "Succeeded", id);
    res.json({ revoked: true });
  }));
  app.get("/api/admin/workspaces", wrap(async (req, res) => {
    platform(req);
    const [workspaces, tenants] = await Promise.all([fabric.workspaces(await auth.operatorToken(req)), repo.tenants()]);
    res.json(workspaces.filter(w => !sameId(w.id, config.ManagementWorkspaceId))
      .map(w => ({ ...w, tenant: tenants.find(t => sameId(t.WorkspaceId, w.id))?.Name ?? null })));
  }));
  app.post("/api/admin/tenants/adopt", wrap(async (req, res) => {
    platform(req);
    const input = z.object({ workspaceId: uuid, name, pendingTenantId: uuid.optional() }).strict().parse(req.body);
    assertNotManagementResource(input.workspaceId, config.ManagementWorkspaceId);
    const token = await auth.operatorToken(req);
    const workspace = await fabric.operator<Workspace>(token, `/groups/${input.workspaceId}`);
    const users = await fabric.operator<{ value: { identifier?: string; groupUserAccessRight: string }[] }>(token, `/groups/${input.workspaceId}/users`);
    const identity = req.session.identity!;
    requireCondition(users.value.some(u => u.groupUserAccessRight === "Admin" &&
      (sameId(u.identifier, identity.objectId) || u.identifier?.toLowerCase() === identity.username.toLowerCase())),
    403, "WorkspaceAdminRequired", "Adoption requires verifiable direct workspace administrator access in this initial version.");
    let tenant;
    if (input.pendingTenantId) {
      requireCondition(!(await db.query("SELECT Id FROM app.ProvisioningOperations WHERE TenantId=@id AND Status='Running'",
        { id: input.pendingTenantId })).length, 409, "SetupInProgress", "Wait for the current setup operation to finish before adopting a workspace.");
      tenant = await repo.tenant(input.pendingTenantId);
      requireCondition(!tenant.WorkspaceId, 409, "AlreadyConfigured", "This tenant already has a workspace.");
      await db.query(`UPDATE app.Tenants SET WorkspaceId=@workspaceId WHERE Id=@id AND WorkspaceId IS NULL;
        IF @@ROWCOUNT<>1 THROW 51000,'Tenant workspace changed concurrently',1;`, { workspaceId: workspace.id, id: tenant.Id });
      tenant = await repo.tenant(tenant.Id);
    } else tenant = await repo.createTenant(input.name, workspace.id);
    await repo.audit(getUser(req), "AdoptWorkspace", workspace.id, "NeedsConfiguration", tenant.Id);
    res.status(201).json(tenant);
  }));
  app.post("/api/admin/tenants", wrap(async (req, res) => {
    platform(req);
    res.status(202).json(await provisioner.start(setupSchema.parse(req.body), getUser(req),
      req.session.identity!.username, await auth.operatorToken(req)));
  }));
  app.post("/api/admin/tenants/:id/workspace", wrap(async (req, res) => {
    platform(req);
    const tenant = await repo.tenant(idParam(req));
    requireCondition(!tenant.WorkspaceId, 409, "AlreadyConfigured", "This tenant already has a workspace.");
    const workspace = await fabric.operator<Workspace>(await auth.operatorToken(req), "/groups?workspaceV2=true", "POST", { name: tenant.Name });
    await db.query(`UPDATE app.Tenants SET WorkspaceId=@workspaceId WHERE Id=@id AND WorkspaceId IS NULL;
      IF @@ROWCOUNT<>1 THROW 51000,'Tenant workspace changed concurrently',1;`, { workspaceId: workspace.id, id: tenant.Id });
    await repo.audit(getUser(req), "CreatePendingTenantWorkspace", workspace.id, "Succeeded", tenant.Id);
    res.status(201).json(await repo.tenant(tenant.Id));
  }));
  app.post("/api/admin/tenants/:id/identity", wrap(async (req, res) => {
    platform(req); const id = idParam(req);
    await fabric.provisionIdentity(id);
    await repo.audit(getUser(req), "ProvisionIdentity", id, "Succeeded", id);
    res.json(await repo.tenant(id));
  }));
  app.post("/api/admin/tenants/:id/access", wrap(async (req, res) => {
    platform(req); const tenant = await repo.tenant(idParam(req));
    assertNotManagementResource(tenant.WorkspaceId, config.ManagementWorkspaceId);
    requireCondition(tenant.WorkspaceId && tenant.EmbeddingObjectId, 409, "MissingConfiguration", "Create the workspace and embedding identity first.");
    await fabric.operator(await auth.operatorToken(req), `/groups/${tenant.WorkspaceId}/users`, "POST",
      { identifier: tenant.EmbeddingObjectId, groupUserAccessRight: "Admin", principalType: "App" });
    await repo.audit(getUser(req), "GrantEmbeddingAccess", tenant.Id, "Succeeded", tenant.Id);
    res.json(await fabric.readiness(tenant.Id, await auth.operatorToken(req)));
  }));
  app.get("/api/admin/capacities/assignable", wrap(async (req, res) => {
    platform(req);
    const result = await fabric.operator<{ value: { id: string }[] }>(await auth.operatorToken(req), "/capacities");
    res.json({ ...result, value: result.value.filter(c => !sameId(c.id, config.ManagementCapacityId)) });
  }));
  app.post("/api/admin/tenants/:id/capacity", wrap(async (req, res) => {
    platform(req); const tenant = await repo.tenant(idParam(req));
    const { capacityId } = z.object({ capacityId: uuid }).strict().parse(req.body);
    assertNotManagementResource(capacityId, config.ManagementCapacityId);
    assertNotManagementResource(tenant.WorkspaceId, config.ManagementWorkspaceId);
    requireCondition(tenant.WorkspaceId, 409, "MissingWorkspace", "Create or adopt a workspace first.");
    const token = await auth.operatorToken(req);
    const capacities = await fabric.operator<{ value: { id: string }[] }>(token, "/capacities");
    requireCondition(capacities.value.some(c => sameId(c.id, capacityId)), 403, "CapacityUnavailable", "The operator cannot assign this capacity.");
    await fabric.operator(token, `/groups/${tenant.WorkspaceId}/AssignToCapacity`, "POST", { capacityId });
    await repo.audit(getUser(req), "AssignCapacity", tenant.Id, "Accepted", tenant.Id);
    res.status(202).json({ message: "Assignment requested. Recheck readiness after the service completes it." });
  }));
  app.post("/api/admin/tenants/:id/readiness", wrap(async (req, res) => {
    platform(req); res.json(await fabric.readiness(idParam(req), await auth.operatorToken(req)));
  }));
  app.get("/api/tenants/:id/manage", wrap(async (req, res) => {
    const id = idParam(req); manageTenant(req, id);
    const [tenant, content, users, security] = await Promise.all([repo.tenant(id), repo.content(id), repo.users(id), repo.security(id)]);
    res.json({ tenant, content, users, ...security });
  }));
  app.post("/api/tenants/:id/sync", wrap(async (req, res) => {
    const id = idParam(req); manageTenant(req, id);
    res.json(await fabric.sync(id));
  }));
  app.get("/api/tenants/:id/sample", wrap(async (req, res) => {
    manageTenant(req, idParam(req));
    res.json(await provisioner.sampleStatus(getUser(req)));
  }));
  app.post("/api/tenants/:id/sample", wrap(async (req, res) => {
    manageTenant(req, idParam(req));
    const { requestId } = z.object({ requestId: uuid }).strict().parse(req.body);
    res.status(202).json(await provisioner.addSample(getUser(req), requestId));
  }));
  app.post("/api/tenants/:id/sample/:operationId/retry", wrap(async (req, res) => {
    manageTenant(req, idParam(req));
    z.object({}).strict().parse(req.body);
    res.status(202).json(await provisioner.retrySample(idParam(req, "operationId"), getUser(req)));
  }));
  app.patch("/api/tenants/:id/content/:contentId", wrap(async (req, res) => {
    const id = idParam(req); manageTenant(req, id);
    const { published } = z.object({ published: z.boolean() }).strict().parse(req.body);
    const contentId = idParam(req, "contentId");
    const item = (await repo.content(id)).find(c => sameId(c.Id, contentId));
    requireCondition(item, 404, "NotFound", "Content not found.");
    requireCondition(!published || (!item.UnsafeDependency && !item.RequiresIdentity), 409, "UnsupportedContent", "Resolve model security/dependencies before publication.");
    await db.query("UPDATE app.Content SET Published=@published WHERE Id=@contentId AND TenantId=@id", { id, contentId, published });
    await repo.audit(getUser(req), "PublishContent", contentId, String(published), id);
    res.json({ published });
  }));
  app.post("/api/tenants/:id/users", wrap(async (req, res) => {
    const id = idParam(req); manageTenant(req, id);
    const input = z.union([
      z.object({ userPrincipalName: userPrincipalNameSchema, permissions: permissionMask.default(0) }).strict(),
      z.object({ objectId: uuid, displayName: name, permissions: permissionMask.default(0) }).strict(),
    ]).parse(req.body);
    const identity = "userPrincipalName" in input ? await azure.resolveUserPrincipalName(input.userPrincipalName) :
      { objectId: input.objectId, displayName: input.displayName };
    const existing = await db.query("SELECT Id FROM app.Users WHERE DirectoryId=@directoryId AND ObjectId=@objectId",
      { directoryId: config.DirectoryTenantId, objectId: identity.objectId });
    requireCondition(!existing.length, 409, "AlreadyRegistered", "This identity is already assigned to an application tenant.");
    await db.query(`INSERT app.Users(Id,TenantId,DirectoryId,ObjectId,DisplayName,DefaultPermissions)
      VALUES(@userId,@id,@directoryId,@objectId,@displayName,@permissions)`,
    { ...identity, permissions: input.permissions, userId: randomUUID(), id, directoryId: config.DirectoryTenantId });
    await repo.audit(getUser(req), "RegisterUser", identity.objectId, "Succeeded", id);
    res.status(201).json({ registered: true });
  }));
  app.patch("/api/tenants/:id/users/:userId", wrap(async (req, res) => {
    const id = idParam(req); manageTenant(req, id);
    const userId = idParam(req, "userId");
    const input = z.object({ permissions: permissionMask }).strict().parse(req.body);
    requireCondition((await repo.users(id)).some(u => sameId(u.Id, userId)), 404, "NotFound", "User not found in this tenant.");
    await db.query("UPDATE app.Users SET DefaultPermissions=@permissions WHERE TenantId=@id AND Id=@userId", { ...input, id, userId });
    await repo.audit(getUser(req), "UpdateUserPermissions", userId, "Succeeded", id);
    res.json({ updated: true });
  }));
  app.post("/api/tenants/:id/folders", wrap(async (req, res) => {
    const id = idParam(req); manageTenant(req, id);
    const input = z.object({ parentId: uuid, label: name }).strict().parse(req.body);
    const { nodes } = await repo.security(id);
    requireCondition(nodes.some(n => sameId(n.Id, input.parentId) && !n.ContentItemId), 400, "InvalidParent", "Choose a tenant folder.");
    await db.query("INSERT app.Nodes(Id,TenantId,ParentId,Label) VALUES(@nodeId,@id,@parentId,@label)", { ...input, nodeId: randomUUID(), id });
    res.status(201).json({ created: true });
  }));
  app.patch("/api/tenants/:id/nodes/:nodeId", wrap(async (req, res) => {
    const id = idParam(req); manageTenant(req, id);
    const nodeId = idParam(req, "nodeId");
    const input = z.object({ label: name, parentId: uuid.nullable(), breakInheritance: z.boolean(), sortOrder: z.number().int().min(0).max(10000) }).strict().parse(req.body);
    await db.transaction(async tx => {
      await tx.query("EXEC sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=30000", { resource: `navigation:${id}` });
      const nodes = await tx.query<NavigationNode>("SELECT * FROM app.Nodes WHERE TenantId=@id", { id });
      const node = nodes.find(n => sameId(n.Id, nodeId));
      requireCondition(node, 404, "NotFound", "Navigation item not found.");
      if (node.ParentId) { requireCondition(input.parentId, 400, "InvalidParent", "Only one tenant root is allowed."); assertMove(nodeId, input.parentId, nodes, id); }
      else requireCondition(!input.parentId, 400, "InvalidMove", "The tenant root cannot be moved.");
      await tx.query(`UPDATE app.Nodes SET Label=@label,ParentId=@parentId,BreakInheritance=@breakInheritance,SortOrder=@sortOrder
        WHERE Id=@nodeId AND TenantId=@id`, { ...input, id, nodeId });
    });
    await repo.audit(getUser(req), "UpdateNavigation", nodeId, "Succeeded", id);
    res.json({ updated: true });
  }));
  app.put("/api/tenants/:id/grants", wrap(async (req, res) => {
    const id = idParam(req); manageTenant(req, id);
    const input = z.object({ nodeId: uuid, userId: uuid, permissions: permissionMask }).strict().parse(req.body);
    const [{ nodes }, users] = await Promise.all([repo.security(id), repo.users(id)]);
    requireCondition(nodes.some(n => sameId(n.Id, input.nodeId)) && users.some(u => sameId(u.Id, input.userId)),
      400, "InvalidScope", "The user and navigation item must belong to this tenant.");
    await db.query(`MERGE app.Grants WITH(HOLDLOCK) AS target USING(SELECT @id TenantId,@nodeId NodeId,@userId UserId) source
      ON target.TenantId=source.TenantId AND target.NodeId=source.NodeId AND target.UserId=source.UserId
      WHEN MATCHED THEN UPDATE SET Mask=@permissions
      WHEN NOT MATCHED THEN INSERT(TenantId,NodeId,UserId,Mask) VALUES(@id,@nodeId,@userId,@permissions);`, { ...input, id });
    await repo.audit(getUser(req), "SetAccessGrant", input.nodeId, "Succeeded", id);
    res.json({ updated: true });
  }));
  async function arm(req: Request, suffix = "", method = "GET", body?: unknown) {
    platform(req);
    return azure.capacity(suffix, method, body);
  }
  app.get("/api/admin/capacities", wrap(async (req, res) => {
    platform(req); res.json(await capacityManagement.list());
  }));
  app.get("/api/admin/capacities/tenants", wrap(async (req, res) => {
    platform(req);
    res.json(await capacityManagement.inventory(await auth.operatorToken(req)));
  }));
  app.get("/api/admin/capacities/auto-resume", wrap(async (req, res) => {
    platform(req);
    res.json(await capacityPolicy.refresh(true));
  }));
  app.put("/api/admin/capacities/auto-resume", wrap(async (req, res) => {
    platform(req);
    const input = z.object({ enabled: z.boolean(), revision: z.uuid().nullable(), confirmBilling: z.boolean().optional() }).strict().parse(req.body);
    requireCondition(!input.enabled || input.confirmBilling === true, 400, "BillingConfirmationRequired",
      "Confirm that automatic resume can restart management and authorized tenant capacity billing.");
    const actor = { Id: getUser(req).Id, TenantId: null };
    await repo.audit(actor, "CapacityAutoResumePolicy", input.enabled ? "enabled" : "disabled", "Requested");
    const result = await capacityPolicy.set(input.enabled, input.revision);
    try { await repo.audit(actor, "CapacityAutoResumePolicy", input.enabled ? "enabled" : "disabled", "Applied"); }
    catch { throw new AppError(503, "CapacityPolicyAuditUnavailable",
      "The capacity policy was saved, but its completion audit failed. Refresh the setting before retrying."); }
    res.json(result);
  }));
  app.post("/api/admin/capacities/bulk/action", wrap(async (req, res) => {
    platform(req);
    const input = z.object({ action: z.enum(["suspend", "resume"]),
      confirmNames: z.array(z.string().regex(/^[a-z][a-z0-9]{2,62}$/)).min(1).max(1000) }).strict().parse(req.body);
    res.status(202).json(await capacityManagement.bulk(await auth.operatorToken(req), input.action, input.confirmNames, getUser(req)));
  }));
  const capacityName = z.string().regex(/^[a-z][a-z0-9]{2,62}$/);
  app.post("/api/admin/capacities", wrap(async (req, res) => {
    const input = z.object({ name: capacityName, sku: z.string().regex(/^F(2|4|8|16|32|64|128|256|512|1024|2048|4096|8192)$/) }).strict().parse(req.body);
    assertCapacityNamespace(input.name, config.ResourceNamePrefix);
    requireCondition(req.session.identity?.username, 409, "MissingAdministrator", "A workforce UPN is required for capacity administration.");
    const result = await arm(req, `/${input.name}`, "PUT", { location: config.AzureLocation, sku: { name: input.sku, tier: "Fabric" },
      properties: { administration: { members: [req.session.identity.username] } } });
    await repo.audit(getUser(req), "CreateCapacity", input.name, "Accepted");
    res.status(202).json(result);
  }));
  app.post("/api/admin/capacities/:name/action", wrap(async (req, res) => {
    platform(req);
    const resourceName = capacityName.parse(req.params.name);
    const input = z.object({ action: z.enum(["resume", "suspend", "resize"]), sku: z.string().regex(/^F(2|4|8|16|32|64|128|256|512|1024|2048|4096|8192)$/).optional(),
      confirmName: z.string() }).strict().parse(req.body);
    requireCondition(input.confirmName === resourceName, 400, "ConfirmationRequired", "Confirm the affected capacity name.");
    requireCondition(input.action !== "resize" || input.sku, 400, "MissingSku", "Select a SKU for resizing.");
    const result = await capacityManagement.change(resourceName, input.action, input.sku);
    await repo.audit(getUser(req), `Capacity:${input.action}`, resourceName, result.status === "accepted" ? "Accepted" : "Skipped");
    res.status(202).json(result);
  }));
  app.delete("/api/admin/capacities/:name", wrap(async (req, res) => {
    platform(req);
    const resourceName = capacityName.parse(req.params.name);
    const input = z.object({ confirmName: z.string(), acknowledgeUnmanagedImpact: z.literal(true) }).strict().parse(req.body);
    requireCondition(input.confirmName === resourceName, 400, "ConfirmationRequired", "Confirm the capacity resource name.");
    const token = await auth.operatorToken(req);
    const assignable = await fabric.operator<{ value: { id: string; displayName: string }[] }>(token, "/capacities");
    const capacity = assignable.value.find(c => c.displayName.toLowerCase() === resourceName.toLowerCase());
    requireCondition(capacity, 409, "CannotVerifyCapacity", "Cannot verify the Azure-to-Power BI capacity mapping; deletion is blocked.");
    for (const tenant of await repo.tenants()) {
      if (!tenant.WorkspaceId) continue;
      const workspace = await fabric.operator<Workspace>(token, `/groups/${tenant.WorkspaceId}`);
      requireCondition(!sameId(workspace.capacityId, capacity.id), 409, "CapacityInUse",
        "A registered tenant workspace still uses this capacity. Move its workspace before deleting.");
    }
    const result = await arm(req, `/${resourceName}`, "DELETE");
    await repo.audit(getUser(req), "DeleteCapacity", resourceName, "Accepted");
    res.status(202).json(result);
  }));
  app.use("/api", (_req, _res, next) => next(new AppError(404, "NotFound", "API route not found.")));
  app.get("/{*path}", (_req, res) => res.sendFile(path.join(webPath, "index.html")));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const correlationId = randomUUID();
    const status = error instanceof AppError ? error.status : error instanceof z.ZodError ? 400 : 500;
    const code = error instanceof AppError ? error.code : error instanceof z.ZodError ? "InvalidRequest" : "UnexpectedError";
    if (status >= 500) console.error(JSON.stringify({ correlationId, code }));
    res.status(status).json({ code, message: error instanceof AppError ? error.message :
      error instanceof z.ZodError ? "The request contains missing, invalid, or unexpected fields." : "The operation failed. Check application configuration and service permissions.", correlationId });
  });
  const stopBackground = readyConfig ? startReconciliation(repo, fabric) : () => undefined;
  return { app, db, stopBackground };
}
