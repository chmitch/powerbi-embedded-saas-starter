import type { Database } from "./db.js";

const initialSchema = `
IF SCHEMA_ID('app') IS NULL EXEC('CREATE SCHEMA app');
IF OBJECT_ID('app.SchemaVersions') IS NULL CREATE TABLE app.SchemaVersions (Version int NOT NULL PRIMARY KEY);
IF NOT EXISTS (SELECT 1 FROM app.SchemaVersions WHERE Version=1)
BEGIN
 CREATE TABLE app.Tenants (
  Id uniqueidentifier NOT NULL PRIMARY KEY, Name nvarchar(200) NOT NULL,
  WorkspaceId uniqueidentifier NULL, Status nvarchar(40) NOT NULL DEFAULT 'NeedsConfiguration',
  EmbeddingClientId uniqueidentifier NULL, EmbeddingObjectId uniqueidentifier NULL,
  EmbeddingAppObjectId uniqueidentifier NULL, SecretName nvarchar(127) NULL,
  LastIssue nvarchar(500) NULL, ReadinessJson nvarchar(max) NULL, LastCheckedAt datetime2 NULL
 );
 CREATE UNIQUE INDEX IX_Tenants_Workspace ON app.Tenants(WorkspaceId) WHERE WorkspaceId IS NOT NULL;
 CREATE TABLE app.Users (
  Id uniqueidentifier NOT NULL PRIMARY KEY, TenantId uniqueidentifier NOT NULL REFERENCES app.Tenants(Id),
  DirectoryId uniqueidentifier NOT NULL, ObjectId uniqueidentifier NOT NULL, DisplayName nvarchar(200) NOT NULL,
  IsPlatformAdmin bit NOT NULL DEFAULT 0, IsTenantAdmin bit NOT NULL DEFAULT 0,
  DefaultPermissions int NOT NULL DEFAULT 0,
  CONSTRAINT UQ_UserIdentity UNIQUE(DirectoryId,ObjectId),
  CONSTRAINT UQ_UserTenant UNIQUE(TenantId,Id)
 );
 CREATE TABLE app.Content (
  Id uniqueidentifier NOT NULL PRIMARY KEY, TenantId uniqueidentifier NOT NULL REFERENCES app.Tenants(Id),
  ExternalId uniqueidentifier NOT NULL, Kind nvarchar(20) NOT NULL CHECK(Kind IN ('Report','Model')),
  Name nvarchar(200) NOT NULL, ModelExternalId uniqueidentifier NULL, EmbedUrl nvarchar(2000) NULL,
  Published bit NOT NULL DEFAULT 0, Deleted bit NOT NULL DEFAULT 0, RequiresIdentity bit NOT NULL DEFAULT 0,
  UnsafeDependency bit NOT NULL DEFAULT 0,
  CONSTRAINT UQ_ContentExternal UNIQUE(TenantId,Kind,ExternalId),
  CONSTRAINT UQ_ContentTenant UNIQUE(TenantId,Id)
 );
 CREATE TABLE app.Nodes (
  Id uniqueidentifier NOT NULL PRIMARY KEY, TenantId uniqueidentifier NOT NULL REFERENCES app.Tenants(Id),
  ParentId uniqueidentifier NULL, ContentItemId uniqueidentifier NULL, Label nvarchar(200) NOT NULL,
  BreakInheritance bit NOT NULL DEFAULT 0, SortOrder int NOT NULL DEFAULT 0,
  CONSTRAINT UQ_NodeTenant UNIQUE(TenantId,Id),
  CONSTRAINT FK_NodeParent FOREIGN KEY(TenantId,ParentId) REFERENCES app.Nodes(TenantId,Id),
  CONSTRAINT FK_NodeContent FOREIGN KEY(TenantId,ContentItemId) REFERENCES app.Content(TenantId,Id)
 );
 CREATE UNIQUE INDEX IX_NodeRoot ON app.Nodes(TenantId) WHERE ParentId IS NULL;
 CREATE UNIQUE INDEX IX_NodeContent ON app.Nodes(TenantId,ContentItemId) WHERE ContentItemId IS NOT NULL;
 CREATE TABLE app.Grants (
  TenantId uniqueidentifier NOT NULL, NodeId uniqueidentifier NOT NULL, UserId uniqueidentifier NOT NULL,
  Mask int NOT NULL, PRIMARY KEY(TenantId,NodeId,UserId),
  FOREIGN KEY(TenantId,NodeId) REFERENCES app.Nodes(TenantId,Id),
  FOREIGN KEY(TenantId,UserId) REFERENCES app.Users(TenantId,Id)
 );
 CREATE TABLE app.Settings (Name nvarchar(100) NOT NULL PRIMARY KEY, Value nvarchar(1000) NOT NULL);
 CREATE TABLE app.Audit (
  Id bigint IDENTITY PRIMARY KEY, At datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
  ActorId uniqueidentifier NULL, TenantId uniqueidentifier NULL,
  Action nvarchar(100) NOT NULL, ResourceId nvarchar(200) NULL, Outcome nvarchar(100) NOT NULL
 );
 CREATE TABLE app.Sessions (
  Id nvarchar(450) NOT NULL PRIMARY KEY, Data nvarchar(max) NOT NULL, ExpiresAt datetime2 NOT NULL
 );
 INSERT app.SchemaVersions(Version) VALUES(1);
END`;

export async function migrate(db: Database) {
  await db.transaction(async tx => {
    await tx.query("EXEC sp_getapplock @Resource='PBIEmbeddedAOD:migrations', @LockMode='Exclusive', @LockOwner='Transaction', @LockTimeout=30000;");
    await tx.query(initialSchema);
    await tx.query(`
      IF NOT EXISTS(SELECT 1 FROM app.SchemaVersions WHERE Version=2)
      BEGIN
        ALTER TABLE app.Users ALTER COLUMN TenantId uniqueidentifier NULL;
        ALTER TABLE app.Users WITH CHECK ADD CONSTRAINT CK_UserTenantMembership CHECK (
          TenantId IS NOT NULL OR (IsPlatformAdmin=1 AND IsTenantAdmin=0 AND DefaultPermissions=0)
        );
        INSERT app.SchemaVersions(Version) VALUES(2);
      END`);
    await tx.query(`
      IF NOT EXISTS(SELECT 1 FROM app.SchemaVersions WHERE Version=3)
      BEGIN
        ALTER TABLE app.Tenants ADD PrimaryAdminObjectId uniqueidentifier NULL, PrimaryAdminUpn nvarchar(320) NULL;
        CREATE TABLE app.ProvisioningOperations (
          Id uniqueidentifier NOT NULL PRIMARY KEY,
          TenantId uniqueidentifier NOT NULL REFERENCES app.Tenants(Id),
          ActorId uniqueidentifier NOT NULL REFERENCES app.Users(Id),
          RequestJson nvarchar(max) NOT NULL, StateJson nvarchar(max) NOT NULL,
          Status nvarchar(20) NOT NULL, Error nvarchar(1500) NULL,
          LeaseOwner uniqueidentifier NULL, LeaseUntil datetime2 NULL,
          CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
          UpdatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE UNIQUE INDEX IX_Provisioning_ActiveTenant ON app.ProvisioningOperations(TenantId) WHERE Status='Running';
        INSERT app.SchemaVersions(Version) VALUES(3);
      END`);
    await tx.query(`
      IF NOT EXISTS(SELECT 1 FROM app.SchemaVersions WHERE Version=4)
      BEGIN
        CREATE TABLE app.ReportRenders (
          Id uniqueidentifier NOT NULL PRIMARY KEY,
          TenantId uniqueidentifier NOT NULL REFERENCES app.Tenants(Id),
          UserId uniqueidentifier NOT NULL, DirectoryId uniqueidentifier NOT NULL, ObjectId uniqueidentifier NOT NULL,
          UserDisplayName nvarchar(200) NOT NULL, ContentId uniqueidentifier NOT NULL,
          ReportId uniqueidentifier NOT NULL, ReportName nvarchar(200) NOT NULL, WorkspaceId uniqueidentifier NOT NULL,
          Mode nvarchar(10) NOT NULL CHECK(Mode IN ('view','edit','copy')),
          RequestedAt datetime2 NOT NULL, ServerReceivedAt datetime2 NOT NULL, RenderedAt datetime2 NOT NULL,
          DurationMs int NOT NULL CHECK(DurationMs BETWEEN 0 AND 86400000),
          RecordedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE INDEX IX_ReportRenders_Tenant_Request ON app.ReportRenders(TenantId,ServerReceivedAt)
          INCLUDE(UserId,ContentId,DurationMs,Mode);
        INSERT app.SchemaVersions(Version) VALUES(4);
      END`);
    await tx.query(`
      IF NOT EXISTS(SELECT 1 FROM app.SchemaVersions WHERE Version=5)
      BEGIN
        CREATE TABLE app.ReportRequests (
          Id uniqueidentifier NOT NULL PRIMARY KEY,
          TenantId uniqueidentifier NOT NULL REFERENCES app.Tenants(Id),
          UserId uniqueidentifier NOT NULL, ContentId uniqueidentifier NOT NULL,
          ReportName nvarchar(200) NOT NULL, UserDisplayName nvarchar(200) NOT NULL,
          Mode nvarchar(10) NOT NULL CHECK(Mode IN ('view','edit','copy')),
          RequestedAt datetime2 NOT NULL, ServerReceivedAt datetime2 NOT NULL,
          Status nvarchar(20) NOT NULL CHECK(Status IN ('Requested','Authorized','Failed','Rendered')),
          RenderId uniqueidentifier NOT NULL,
          RecordedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
        );
        CREATE INDEX IX_ReportRequests_Tenant_User_Time ON app.ReportRequests(TenantId,UserId,ServerReceivedAt DESC,Id)
          INCLUDE(ContentId,ReportName,Mode,Status,RenderId);
        CREATE INDEX IX_ReportRenders_Tenant_User_Time ON app.ReportRenders(TenantId,UserId,ServerReceivedAt DESC,Id)
          INCLUDE(ContentId,ReportName,DurationMs,Mode,RequestedAt);
        CREATE INDEX IX_ReportRenders_Tenant_Report_Time ON app.ReportRenders(TenantId,ContentId,ServerReceivedAt)
          INCLUDE(DurationMs);
        INSERT app.SchemaVersions(Version) VALUES(5);
      END`);
    await tx.query(`
      IF NOT EXISTS(SELECT 1 FROM app.SchemaVersions WHERE Version=6)
      BEGIN
        CREATE TABLE app.AnalyticsPrincipalTenants (
          TenantId uniqueidentifier NOT NULL PRIMARY KEY REFERENCES app.Tenants(Id),
          ClientId uniqueidentifier NOT NULL UNIQUE,
          ObjectId uniqueidentifier NOT NULL UNIQUE
        );
        INSERT app.SchemaVersions(Version) VALUES(6);
      END`);
  });
}
