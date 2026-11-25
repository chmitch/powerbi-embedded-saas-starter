import { config, configured, isProduction } from "./config.js";
import { AzureServices } from "./azure.js";
import { Database } from "./db.js";
import { migrate } from "./migrations.js";
import { createApp } from "./app.js";
import { z } from "zod";
import { initializeDeploymentSecrets } from "./deployment-secrets.js";
import { setupAnalyticsSecurity, syncAnalyticsMappings } from "./analytics-security.js";

async function main() {
  const initializeIndex = process.argv.indexOf("--initialize-secrets");
  if (initializeIndex >= 0) {
    if (!isProduction) throw new Error("Deployment secret initialization runs only in production with managed identities.");
    await initializeDeploymentSecrets(config, z.uuid().parse(process.argv[initializeIndex + 1]));
    console.log("Deployment credentials verified in Azure. No secret values were returned.");
    return;
  }
  if (process.argv.includes("--migrate") || process.argv.includes("--grant-database-principal") ||
    process.argv.includes("--check-database") || process.argv.includes("--setup-analytics") ||
    process.argv.includes("--analytics-inventory")) {
    if (!config.SqlServer || !config.SqlDatabase) throw new Error("Configure the SQL endpoint before database operations.");
    const db = new Database(new AzureServices(config));
    try {
      if (process.argv.includes("--analytics-inventory")) {
        console.log(JSON.stringify(await db.query(`SELECT Id,EmbeddingClientId,EmbeddingObjectId
          FROM app.Tenants WHERE EmbeddingClientId IS NOT NULL AND EmbeddingObjectId IS NOT NULL ORDER BY Id`)));
        return;
      }
      if (process.argv.includes("--check-database")) {
        const [result] = await db.query<{ DatabaseName: string }>("SELECT DB_NAME() AS DatabaseName");
        if (result?.DatabaseName !== config.SqlDatabase) throw new Error("Connected to an unexpected database.");
        console.log("SQL database connectivity verified.");
      }
      if (process.argv.includes("--migrate")) { await migrate(db); console.log("Database migrations applied."); }
      if (process.argv.includes("--setup-analytics")) {
        const count = await syncAnalyticsMappings(db);
        await setupAnalyticsSecurity(config, new AzureServices(config).runtime);
        console.log(`Analytics endpoint policy and read-only views configured for ${count} tenant identities. Verify item Read sharing and real principal access before enabling queries.`);
      }
      const grantIndex = process.argv.indexOf("--grant-database-principal");
      if (grantIndex >= 0) {
        const clientId = z.uuid().parse(process.argv[grantIndex + 1]);
        const principalName = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/).parse(process.argv[grantIndex + 2]);
        await db.query(`DECLARE @statement nvarchar(max);
          IF EXISTS(SELECT 1 FROM sys.database_principals WHERE name=@name
            AND sid<>CONVERT(binary(16),CONVERT(uniqueidentifier,@oid)))
           THROW 51001,'Existing database principal has a different identity; review grants explicitly',1;
          IF NOT EXISTS(SELECT 1 FROM sys.database_principals WHERE name=@name)
          BEGIN
           SET @statement=N'CREATE USER '+QUOTENAME(@name)+N' WITH SID='+sys.fn_varbintohexstr(CONVERT(binary(16),CONVERT(uniqueidentifier,@oid)))+N', TYPE=E';
           EXEC sp_executesql @statement;
          END;
          SET @statement=N'GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::app TO '+QUOTENAME(@name);
          EXEC sp_executesql @statement;`,
        { name: principalName, oid: clientId });
        console.log("Database principal permissions applied.");
      }
    } finally { await db.close(); }
    return;
  }
  const origin = new URL(config.PublicOrigin);
  if (isProduction && (origin.protocol !== "https:" || !config.RuntimeManagedIdentityClientId ||
    !config.ProvisioningManagedIdentityClientId ||
    config.RuntimeManagedIdentityClientId === config.ProvisioningManagedIdentityClientId || !configured(config))) {
    throw new Error("Production requires HTTPS, complete configuration, and distinct configured runtime/provisioning managed identities.");
  }
  if (!isProduction && origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname))
    throw new Error("HTTP is supported only on localhost.");
  const { app, db, stopBackground } = await createApp(config);
  const server = app.listen(config.Port, isProduction ? "0.0.0.0" : "127.0.0.1", () => {
    console.log(`Portal listening on ${config.PublicOrigin}. Configuration ${configured(config) ? "loaded" : "required"}.`);
  });
  const shutdown = () => { stopBackground(); server.close(() => { void db.close().finally(() => process.exit(0)); }); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
main().catch(() => {
  console.error(process.argv.includes("--initialize-secrets")
    ? "Azure credential initialization failed. Verify the provisioning managed identity's sign-in app ownership/Graph grants, Key Vault NSP/RBAC, and existing credential health."
    : "Startup failed. Verify the non-secret external configuration, Azure sign-in, SQL permissions/migrations, and Key Vault access.");
  process.exitCode = 1;
});
