import React, { useEffect, useRef, useState } from "react";
import { api, type ArmCapacity, type Capacity, type Check, type SetupOperation, type Tenant, type TenantSettings, type Workspace } from "./api";
import { Icon } from "./icons";

type Run = (action: () => Promise<unknown>, message?: string) => Promise<void>;
const sizes = ["F2", "F4", "F8", "F16", "F32", "F64", "F128", "F256", "F512", "F1024", "F2048", "F4096", "F8192"];
const selectionKey = "pbi.platform.tenant";
const pending = (operation: SetupOperation | null | undefined) => operation?.status === "Running";

export function PlatformConsole({ version, run, busy, namespace, administrators }: {
  version: number; run: Run; busy: boolean; namespace: string;
  administrators: (tenantId: string, disabled: boolean) => React.ReactNode;
}) {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selected, setSelected] = useState(() => sessionStorage.getItem(selectionKey) ?? "");
  const [capacities, setCapacities] = useState<Capacity[]>([]);
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [operation, setOperation] = useState<SetupOperation | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [upn, setUpn] = useState("");
  const [capacityMode, setCapacityMode] = useState("existing");
  const [capacityId, setCapacityId] = useState("");
  const [sku, setSku] = useState("F2");
  const [billing, setBilling] = useState(false);
  const [replaceAdministrator, setReplaceAdministrator] = useState(false);
  const [includeSample, setIncludeSample] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const request = useRef<{ payload: string; id: string } | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const active = pending(operation), disabled = busy || loading || active;
  async function loadLists() {
    const [list, assignable] = await Promise.all([
      api<Tenant[]>("/api/admin/tenants"), api<{ value: Capacity[] }>("/api/admin/capacities/assignable"),
    ]);
    setTenants(list); setCapacities(assignable.value);
  }
  function choose(id: string) {
    setSelected(id); setSettings(null); setOperation(null); setError("");
    setWorkspaceName(""); setUpn(""); setCapacityMode("existing"); setCapacityId(""); setBilling(false);
    setReplaceAdministrator(false); setIncludeSample(false); request.current = null;
    if (id) sessionStorage.setItem(selectionKey, id); else sessionStorage.removeItem(selectionKey);
  }
  function applySettings(value: TenantSettings) {
    setSettings(value); setOperation(value.operation);
    setWorkspaceName(value.workspace?.name ?? value.tenant.Name);
    setUpn(value.administratorUpn ?? "");
    setCapacityMode("existing"); setCapacityId(value.workspace?.capacityId?.toLowerCase() ?? "");
    setReplaceAdministrator(false); setBilling(false); request.current = null;
  }
  useEffect(() => {
    let disposed = false;
    void Promise.all([api<Tenant[]>("/api/admin/tenants"), api<{ value: Capacity[] }>("/api/admin/capacities/assignable")])
      .then(([list, assignable]) => { if (!disposed) { setTenants(list); setCapacities(assignable.value); } })
      .catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, [version]);
  useEffect(() => {
    if (!selected) return;
    let disposed = false; setLoading(true);
    void api<TenantSettings>(`/api/admin/tenants/${selected}/settings`)
      .then(value => { if (!disposed) applySettings(value); })
      .catch(e => { if (!disposed) setError(e.message); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [selected, version]);
  useEffect(() => {
    if (!operation || operation.status !== "Running") return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const tenantId = operation.tenantId, operationId = operation.id;
    async function observe() {
      try {
        const next = await api<SetupOperation>(`/api/admin/operations/${operationId}`);
        if (disposed || selectedRef.current !== tenantId) return;
        setError("");
        if (next.status === "Succeeded") {
          await run(async () => {
            const value = await api<TenantSettings>(`/api/admin/tenants/${tenantId}/settings`);
            if (!disposed && selectedRef.current === tenantId) applySettings(value);
            await loadLists();
          }, "Tenant is ready. All selected setup steps are complete.");
        } else {
          setOperation(next);
          if (next.status !== "Running") await loadLists();
        }
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : "Progress could not be refreshed. Retrying automatically.");
      } finally { if (!disposed) timer = setTimeout(observe, 2500); }
    }
    timer = setTimeout(observe, 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [operation?.id, operation?.status]);

  async function submit() {
    const currentTenant = selected;
    const administratorUpn = !selected || upn.trim().toLowerCase() !== settings?.administratorUpn?.toLowerCase() ? upn.trim() : "";
    const body = { name: workspaceName.trim(), ...(administratorUpn ? { administratorUpn } : {}), replaceAdministrator,
      ...(!currentTenant && includeSample ? { includeSample: true } : {}),
      capacity: capacityMode === "new" ? { mode: "new", sku, confirmBilling: billing } : { mode: "existing", id: capacityId } };
    const payload = JSON.stringify({ tenantId: currentTenant, ...body });
    if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
    const result = await api<SetupOperation>(currentTenant ? `/api/admin/tenants/${currentTenant}/setup` : "/api/admin/tenants",
      "POST", { requestId: request.current.id, ...body });
    if (selectedRef.current !== currentTenant) return;
    sessionStorage.setItem(selectionKey, result.tenantId);
    setSelected(result.tenantId); setOperation(result);
    await loadLists();
  }
  const editing = Boolean(selected);
  const administratorChanged = Boolean(editing && upn.trim() &&
    upn.trim().toLowerCase() !== settings?.administratorUpn?.toLowerCase());
  return <>
    <section>
      <div className="section-title"><div><h2>Tenant workspaces</h2><p className="muted">Provision isolated workspaces. Manage infrastructure, not tenant content.</p></div>
        <button className="secondary" disabled={busy || loading} onClick={() => choose("")}><Icon name="plus" />New tenant</button></div>
      <label>Open an existing tenant<select aria-label="Open an existing tenant" value={selected} disabled={busy || loading}
        onChange={event => choose(event.target.value)}><option value="">Create a new tenant</option>
        {selected && !tenants.some(t => t.Id === selected) && <option value={selected}>Loading tenant...</option>}
        {tenants.map(t => <option key={t.Id} value={t.Id}>{t.Name} - {t.Status}</option>)}</select></label>
      <p>Platform status does not grant tenant membership or report access. A capacity may serve multiple tenants; their workspaces and identities remain separate.</p>
    </section>
    <section aria-busy={loading || active}>
      <h2>{editing ? "Tenant settings" : "Provision a tenant"}</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {loading && <p role="status">Reading current workspace settings...</p>}
      {settings?.workspaceIssue && <p className="error">{settings.workspaceIssue}</p>}
      <form onSubmit={event => { event.preventDefault(); void run(submit, "Setup is running. Progress updates automatically below."); }}>
        <fieldset disabled={disabled || (editing && !settings)}>
          <div className="setup-grid">
            <label>Workspace name<input name="workspaceName" value={workspaceName} maxLength={200} required
              onChange={event => { setWorkspaceName(event.target.value); }} /></label>
            <label>Tenant administrator UPN<input name="administratorUpn" type="text" value={upn} required={!editing || !settings?.administrators.length}
              placeholder="admin@contoso.com" maxLength={320} pattern={"[^@\\s\\/\\\\]+@[^@\\s\\/\\\\]+"}
              onChange={event => { setUpn(event.target.value); setReplaceAdministrator(false); }} />
              <small>{editing ? "Leave unchanged to retain current administrators. Enter a new UPN to change the primary admin." :
                "Resolved securely through Entra. The initial admin receives all tenant permissions, including viewing and authoring. They cannot already belong to another tenant."}</small></label>
          </div>
          {administratorChanged && <label className="warning"><input type="checkbox" checked={replaceAdministrator} required
            onChange={event => setReplaceAdministrator(event.target.checked)} />Confirm changing the primary administrator. Only the previous primary administrator's admin role is removed.
            Their tenant membership and report permissions, and any other administrators, are preserved.</label>}
          <div className="setup-grid">
            <label>Capacity<select name="capacityMode" value={capacityMode} onChange={event => { setCapacityMode(event.target.value); setBilling(false); }}>
              <option value="existing">Use an existing capacity</option><option value="new">Create a new capacity</option></select></label>
            {capacityMode === "existing" ? <label>Existing capacity<select name="capacityId" value={capacityId} required
              onChange={event => setCapacityId(event.target.value)}><option value="">Choose an active capacity</option>
              {capacityId && !capacities.some(c => c.id.toLowerCase() === capacityId.toLowerCase()) &&
                <option value={capacityId} disabled>Current capacity unavailable to this operator</option>}
              {capacities.map(c => <option key={c.id} value={c.id.toLowerCase()} disabled={c.state !== "Active"}>{c.displayName} - {c.state}</option>)}</select>
              <small>Existing capacities remain available for other tenants. Management capacity is excluded.</small></label> :
              <label>New capacity size<select name="sku" value={sku} onChange={event => setSku(event.target.value)}>
                {sizes.map(size => <option key={size}>{size}</option>)}</select>
                <small>Name is generated under {namespace.replaceAll("-", "") || "the configured namespace"}; region follows application configuration.</small></label>}
          </div>
          {capacityMode === "new" && <label className="warning"><input type="checkbox" checked={billing} required
            onChange={event => setBilling(event.target.checked)} />I authorize creating a billable {sku} Fabric capacity. It remains billable if a later setup step fails.</label>}
          {!editing && <label><input name="includeSample" type="checkbox" checked={includeSample}
            onChange={event => setIncludeSample(event.target.checked)} />Include sample
            <small>Import and publish the bundled Store Sales report and semantic model. The initial tenant admin can view and author the sample; other users still need permission grants.</small></label>}
          {editing && <p>Saving reuses this tenant's workspace and service principal. Capacity changes can affect availability; existing reports and permissions are preserved.</p>}
          <button className="primary" type="submit">{editing ? "Save and verify settings" : "Provision tenant"}</button>
          <small className="setup-hint">Service-principal creation, workspace access, capacity assignment and readiness checks are automatic. You may reopen the tenant to view progress.</small>
        </fieldset>
      </form>
      {operation && <div className="setup-progress" aria-live="polite">
        <div className="section-title"><h3>{operation.status === "Succeeded" ? "Tenant ready" :
          operation.status === "Running" ? "Setting up your tenant" : operation.status === "Interrupted" ? "Setup interrupted" : "Setup needs attention"}</h3>
          <span className={`badge ${operation.status === "Succeeded" ? "pass" : operation.status === "Running" ? "unknown" : "fail"}`}>{operation.status}</span></div>
        <ol>{operation.steps.map(step => <li key={step.key} className={step.status}>
          <strong>{step.label}</strong><span className="step-status">{step.status}</span>
          {(step.status === "running" || step.status === "failed") && <small>{step.message}</small>}</li>)}</ol>
        {operation.error && <p className="error">{operation.error}</p>}
        {operation.status === "Interrupted" && <p>The server stopped tracking this operation. Resume with your signed-in account; completed resources will be reused.</p>}
        {operation.recoveryRequired && <p className="warning">Resource creation or sample import requires manual recovery. Inspect Entra/Fabric and reconcile the existing resource/import before continuing. Automatic recreation is blocked.</p>}
        {operation.canRetry && <button disabled={busy} onClick={() => void run(async () => {
          setOperation(await api<SetupOperation>(`/api/admin/operations/${operation.id}/retry`, "POST"));
        }, "Resuming setup from its saved checkpoints.")}>Retry unfinished steps</button>}
      </div>}
      {settings && <details className="technical"><summary>Workspace and service-principal details</summary>
        <dl><dt>Workspace ID</dt><dd>{settings.tenant.WorkspaceId ?? "Not created"}</dd>
          <dt>Embedding application ID</dt><dd>{settings.tenant.EmbeddingClientId ?? "Not created"}</dd>
          <dt>Service principal object ID</dt><dd>{settings.tenant.EmbeddingObjectId ?? "Not created"}</dd>
          <dt>Assigned capacity ID</dt><dd>{settings.workspace?.capacityId ?? "Not assigned"}</dd></dl>
        {settings.tenant.LastIssue && <p className="error">{settings.tenant.LastIssue}</p>}
        <table><thead><tr><th>Readiness check</th><th>Status</th><th>Finding</th></tr></thead><tbody>
          {(settings.tenant.ReadinessJson ? JSON.parse(settings.tenant.ReadinessJson) as Check[] : []).map(check =>
            <tr key={check.key}><td>{check.key}</td><td>{check.status}</td><td>{check.message}</td></tr>)}</tbody></table>
      </details>}
    </section>
    {settings && <details className="advanced"><summary>Additional tenant administrators</summary>
      <p>These appointments do not change the primary administrator or grant report permissions.</p>{administrators(selected, disabled)}</details>}
    <details className="advanced"><summary>Adopt an existing workspace</summary>
      <p>Discovery never exposes tenant content. Adoption requires your direct workspace administrator access; complete setup using the settings above afterward.</p>
      <button disabled={busy} onClick={() => void run(async () => setWorkspaces(await api<Workspace[]>("/api/admin/workspaces")), "Discovery refreshed.")}>Discover workspaces</button>
      {workspaces && <table><thead><tr><th>Workspace</th><th>Tenant</th><th /></tr></thead><tbody>{workspaces.map(workspace =>
        <tr key={workspace.id}><td>{workspace.name}</td><td>{workspace.tenant ?? "Unmanaged"}</td><td>{!workspace.tenant &&
          <button disabled={busy || active} onClick={() => void run(async () => {
            const result = await api<Tenant>("/api/admin/tenants/adopt", "POST", { workspaceId: workspace.id, name: workspace.name });
            choose(result.Id); await loadLists(); setWorkspaces(null);
          }, "Workspace adopted. Choose its capacity and administrator, then save settings.")}>Adopt as tenant</button>}</td></tr>)}</tbody></table>}
    </details>
    <CapacityManager busy={busy || active} run={run} />
  </>;
}

function CapacityManager({ busy, run }: { busy: boolean; run: Run }) {
  const [capacities, setCapacities] = useState<ArmCapacity[]>([]);
  const [waiting, setWaiting] = useState("");
  const [loaded, setLoaded] = useState(false);
  async function refresh() {
    const result = await api<{ value: ArmCapacity[] }>("/api/admin/capacities");
    setCapacities(result.value); setLoaded(true); return result.value;
  }
  async function change(capacity: ArmCapacity, action: string, sku?: string) {
    setWaiting(`${capacity.name}: waiting for ${action} to complete. Status refreshes automatically.`);
    try {
      await api(`/api/admin/capacities/${capacity.name}${action === "delete" ? "" : "/action"}`, action === "delete" ? "DELETE" : "POST",
        action === "delete" ? { confirmName: capacity.name, acknowledgeUnmanagedImpact: true } : { action, sku, confirmName: capacity.name });
      for (let attempt = 0; attempt < 180; attempt++) {
        const observed = (await refresh()).find(c => c.name === capacity.name);
        if (action === "delete" && !observed) return;
        if (observed) {
          if (["Failed", "Canceled"].includes(observed.properties.provisioningState)) throw new Error("Azure could not complete the capacity operation. Inspect the resource before retrying.");
          if (action !== "delete" && observed.properties.provisioningState === "Succeeded" &&
            (action === "resize" ? observed.sku.name === sku : observed.properties.state === (action === "resume" ? "Active" : "Paused"))) return;
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      throw new Error("Capacity change is still pending. Inspect its Azure status before submitting another change.");
    } finally { setWaiting(""); }
  }
  return <section><div className="section-title"><h2>Capacity management</h2>
    <button disabled={busy || Boolean(waiting)} onClick={() => void run(refresh, "Capacity settings refreshed.")}>{loaded ? "Refresh capacities" : "Load Azure capacities"}</button></div>
    <p>Pause, resume, resize or delete existing capacities. Changes affect every assigned tenant. Create a new capacity as part of tenant setup above.</p>
    {waiting && <p className="notice" role="status">{waiting}</p>}
    {capacities.map(capacity => <div className="capacity" key={capacity.name}>
      <strong>{capacity.name}</strong><span>{capacity.sku.name} / {capacity.properties.state ?? capacity.properties.provisioningState}</span>
      {(["resume", "suspend"] as const).map(action => <button key={action} disabled={busy || Boolean(waiting)} onClick={() => {
        if (window.confirm(`${action === "suspend" ? "Pause" : "Resume"} ${capacity.name}? All assigned workspaces are affected.`))
          void run(() => change(capacity, action), "Capacity state confirmed.");
      }}>{action === "suspend" ? "Pause" : "Resume"}</button>)}
      <select aria-label={`Resize ${capacity.name}`} value="" disabled={busy || Boolean(waiting)} onChange={event => {
        if (event.target.value && window.confirm(`Resize ${capacity.name} to ${event.target.value}? Billing and availability change for all assigned tenants.`))
          void run(() => change(capacity, "resize", event.target.value), "Capacity size confirmed.");
      }}><option value="">Resize...</option>{sizes.map(size => <option key={size}>{size}</option>)}</select>
      <button className="danger" disabled={busy || Boolean(waiting)} onClick={() => {
        if (window.confirm(`Permanently delete ${capacity.name}? Move registered tenant workspaces first. Unmanaged workspaces may also be affected.`))
          void run(() => change(capacity, "delete"), "Capacity deletion confirmed.");
      }}>Delete</button>
    </div>)}
  </section>;
}
