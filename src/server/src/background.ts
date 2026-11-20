import type { FabricService } from "./fabric.js";
import type { Repository } from "./repository.js";

export function startReconciliation(repo: Repository, fabric: FabricService) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      for (const tenant of await repo.tenants()) {
        if (!tenant.WorkspaceId || !tenant.EmbeddingClientId || !tenant.SecretName) continue;
        try { await fabric.sync(tenant.Id); }
        catch { console.warn(JSON.stringify({ code: "ReconciliationDeferred", tenantId: tenant.Id })); }
      }
      await repo.db.query("DELETE app.Sessions WHERE ExpiresAt<SYSUTCDATETIME()");
    })().catch(() => console.warn(JSON.stringify({ code: "ReconciliationUnavailable" })))
      .finally(() => { running = false; });
  }, 300_000);
  timer.unref();
  return () => clearInterval(timer);
}
