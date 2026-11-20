import { randomUUID } from "node:crypto";
import type { Database, Executor } from "./db.js";
import type { ContentItem, Grant, Identity, NavigationNode, Tenant, User } from "./domain.js";
import { requireCondition } from "./errors.js";
import { sameId } from "./domain.js";

export class Repository {
  constructor(readonly db: Database) {}
  async bootstrapComplete() {
    const [row] = await this.db.read("SELECT Value FROM app.Settings WHERE Name='BootstrapCompleted'");
    return Boolean(row);
  }
  async user(identity: Pick<Identity, "objectId" | "directoryId">) {
    const [user] = await this.db.read<User>("SELECT * FROM app.Users WHERE ObjectId=@oid AND DirectoryId=@tid",
      { oid: identity.objectId, tid: identity.directoryId });
    return user;
  }
  async tenant(id: string) {
    const [tenant] = await this.db.read<Tenant>("SELECT * FROM app.Tenants WHERE Id=@id", { id });
    requireCondition(tenant, 404, "NotFound", "Tenant not found.");
    return tenant;
  }
  tenants() { return this.db.read<Tenant>("SELECT * FROM app.Tenants ORDER BY Name"); }
  async capacityBinding(tenant: Tenant) {
    const [row] = await this.db.read<{ Value: string }>("SELECT Value FROM app.Settings WHERE Name=@name",
      { name: `WorkspaceCapacity:${tenant.WorkspaceId}` });
    if (!row) return undefined;
    return JSON.parse(row.Value) as { capacityId: string; resourceId: string };
  }
  async setCapacityBinding(tenant: Tenant, value: { capacityId: string; resourceId: string } | null) {
    const name = `WorkspaceCapacity:${tenant.WorkspaceId}`;
    if (!value) { await this.db.query("DELETE app.Settings WHERE Name=@name", { name }); return; }
    await this.db.query(`MERGE app.Settings WITH (HOLDLOCK) AS target USING(SELECT @name Name) source ON target.Name=source.Name
      WHEN MATCHED THEN UPDATE SET Value=@value
      WHEN NOT MATCHED THEN INSERT(Name,Value) VALUES(@name,@value);`, { name, value: JSON.stringify(value) });
  }
  async createTenant(name: string, workspaceId: string | null = null) {
    const id = randomUUID();
    await this.db.transaction(async tx => {
      await tx.query("INSERT app.Tenants(Id,Name,WorkspaceId) VALUES(@id,@name,@workspaceId)", { id, name, workspaceId });
      await this.createRoot(tx, id, name);
    });
    return this.tenant(id);
  }
  async bootstrap(identity: Identity) {
    await this.db.transaction(async tx => {
      await tx.query("EXEC sp_getapplock @Resource='PBIEmbeddedAOD:bootstrap',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=30000;");
      const completed = await tx.query("SELECT Value FROM app.Settings WHERE Name='BootstrapCompleted'");
      requireCondition(!completed.length, 409, "AlreadyConfigured", "Initial setup has already completed.");
      await tx.query(`INSERT app.Users(Id,DirectoryId,ObjectId,DisplayName,IsPlatformAdmin)
        VALUES(@userId,@directoryId,@objectId,@name,1)`,
      { userId: randomUUID(), directoryId: identity.directoryId, objectId: identity.objectId, name: identity.name });
      await tx.query("INSERT app.Settings(Name,Value) VALUES('BootstrapCompleted','true')");
    });
  }
  async assignTenantAdmin(tenantId: string, directoryId: string, objectId: string, displayName: string) {
    await this.db.transaction(async tx => {
      const [tenant] = await tx.query("SELECT Id FROM app.Tenants WHERE Id=@tenantId", { tenantId });
      requireCondition(tenant, 404, "NotFound", "Tenant not found.");
      const [existing] = await tx.query<User>(
        "SELECT * FROM app.Users WITH (UPDLOCK,HOLDLOCK) WHERE DirectoryId=@directoryId AND ObjectId=@objectId",
        { directoryId, objectId });
      if (existing) {
        requireCondition(!existing.TenantId || sameId(existing.TenantId, tenantId), 409, "AlreadyRegistered",
          "This identity belongs to another tenant. Multiple tenant memberships and implicit reassignment are not allowed.");
        await tx.query("UPDATE app.Users SET TenantId=@tenantId,IsTenantAdmin=1 WHERE Id=@userId",
          { tenantId, userId: existing.Id });
      } else {
        await tx.query(`INSERT app.Users(Id,TenantId,DirectoryId,ObjectId,DisplayName,IsTenantAdmin)
          VALUES(@userId,@tenantId,@directoryId,@objectId,@displayName,1)`,
        { userId: randomUUID(), tenantId, directoryId, objectId, displayName });
      }
    });
  }
  private createRoot(tx: Executor, tenantId: string, label: string) {
    return tx.query("INSERT app.Nodes(Id,TenantId,Label) VALUES(@id,@tenantId,@label)", { id: randomUUID(), tenantId, label });
  }
  async security(tenantId: string) {
    const [nodes, grants] = await Promise.all([
      this.db.read<NavigationNode>("SELECT * FROM app.Nodes WHERE TenantId=@tenantId ORDER BY SortOrder,Label", { tenantId }),
      this.db.read<Grant>("SELECT * FROM app.Grants WHERE TenantId=@tenantId", { tenantId }),
    ]);
    return { nodes, grants };
  }
  content(tenantId: string) { return this.db.read<ContentItem>("SELECT * FROM app.Content WHERE TenantId=@tenantId AND Deleted=0 ORDER BY Name", { tenantId }); }
  users(tenantId: string) { return this.db.read<User>("SELECT * FROM app.Users WHERE TenantId=@tenantId ORDER BY DisplayName", { tenantId }); }
  audit(actor: Pick<User, "Id" | "TenantId"> | undefined, action: string, resourceId: string, outcome = "Succeeded", tenantId?: string) {
    return this.db.query(`INSERT app.Audit(ActorId,TenantId,Action,ResourceId,Outcome) VALUES(@actorId,@tenantId,@action,@resourceId,@outcome)`,
      { actorId: actor?.Id, tenantId: tenantId ?? actor?.TenantId, action, resourceId, outcome });
  }
}
