import React, { useEffect, useState } from "react";
import { api, type Tenant } from "./api";
import { CapacityManager } from "./capacity-manager";
import { Icon } from "./icons";
import { platformRoute } from "./platform-route";
import { TenantDetails } from "./tenant-details";
import { InsightsPage } from "./insights";

type Run = (action: () => Promise<unknown>, message?: string) => Promise<void>;

export function PlatformConsole({ version, run, busy, namespace, administrators }: {
  version: number; run: Run; busy: boolean; namespace: string;
  administrators: (tenantId: string, disabled: boolean) => React.ReactNode;
}) {
  const [route, setRoute] = useState(() => platformRoute(window.location.hash));
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const changed = () => setRoute(platformRoute(window.location.hash));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    if (route.screen !== "fleet") return;
    let disposed = false; setLoading(true); setError("");
    void api<Tenant[]>("/api/admin/tenants").then(value => { if (!disposed) setTenants(value); })
      .catch(e => { if (!disposed) setError(e.message); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [route.screen, version]);
  const navigate = (hash: string) => { window.location.hash = hash; };
  const openTenant = (id: string) => navigate(`#platform/tenants/${id}`);
  return <div className="platform-console">
    <nav className="platform-navigation" aria-label="Platform administration">
      <button className={route.screen === "fleet" ? "selected" : ""} aria-current={route.screen === "fleet" ? "page" : undefined}
        disabled={busy} onClick={() => navigate("#platform/fleet")}><Icon name="workspace" />Fleet Management</button>
      {route.screen === "details" && <span aria-current="page">Tenant Details</span>}
      <button className={route.screen === "add" ? "selected" : ""} aria-current={route.screen === "add" ? "page" : undefined}
        disabled={busy} onClick={() => navigate("#platform/add-tenant")}><Icon name="plus" />Add Tenant</button>
      <button className={route.screen === "insights" ? "selected" : ""} aria-current={route.screen === "insights" ? "page" : undefined}
        disabled={busy} onClick={() => navigate("#platform/insights")}>Insights</button>
    </nav>
    {route.screen === "insights" ? <InsightsPage version={version} /> : route.screen === "fleet" ? <>
      <section><h2>Fleet Management</h2>
        <p className="muted">All tenants and their assigned customer compute. Open a tenant to manage its configuration.</p>
        <p>Shared-capacity operations affect every assigned workspace. Platform administration does not grant tenant report access.</p>
        {loading && <p role="status">Loading tenants...</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <CapacityManager busy={busy || loading} run={run} version={version}
        tenants={tenants} tenantsReady={!loading && !error} openTenant={openTenant} />
    </> : <TenantDetails key={route.screen === "details" ? route.tenantId : "add"}
      tenantId={route.screen === "details" ? route.tenantId : null} openTenant={openTenant}
      version={version} run={run} busy={busy} namespace={namespace} administrators={administrators} />}
  </div>;
}
