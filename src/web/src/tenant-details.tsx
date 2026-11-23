import React, { useEffect, useRef, useState } from "react";
import { api, type Capacity, type Check, type SetupOperation, type Tenant, type TenantSettings, type Workspace } from "./api";
import { TenantRemediation } from "./tenant-remediation";

type Run = (action: () => Promise<unknown>, message?: string) => Promise<void>;
const sizes = ["F2", "F4", "F8", "F16", "F32", "F64", "F128", "F256", "F512", "F1024", "F2048", "F4096", "F8192"];
const pending = (operation: SetupOperation | null | undefined) => operation?.status === "Running";

export function TenantDetails({ version, run, busy, namespace, administrators, tenantId, openTenant }: {
  version: number; run: Run; busy: boolean; namespace: string;
  tenantId: string | null; openTenant: (id: string) => void;
  administrators: (tenantId: string, disabled: boolean) => React.ReactNode;
}) {
  const selected = tenantId ?? "";
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
  const mounted = useRef(true);
  const dirty = useRef(false);
  const configurationForm = useRef<HTMLFormElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const active = pending(operation), disabled = busy || loading || active;
  async function loadLists() {
    const assignable = await api<{ value: Capacity[] }>("/api/admin/capacities/assignable");
    if (mounted.current) setCapacities(assignable.value);
  }
  function applySettings(value: TenantSettings) {
    setSettings(value); setOperation(value.operation);
    if (dirty.current) return;
    setWorkspaceName(value.workspace?.name ?? value.tenant.Name);
    setUpn(value.administratorUpn ?? "");
    setCapacityMode("existing"); setCapacityId(value.workspace?.capacityId?.toLowerCase() ?? "");
    setReplaceAdministrator(false); setBilling(false); request.current = null;
  }
  useEffect(() => {
    let disposed = false;
    void api<{ value: Capacity[] }>("/api/admin/capacities/assignable")
      .then(assignable => { if (!disposed) setCapacities(assignable.value); })
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
    if (!mounted.current || selectedRef.current !== currentTenant) return;
    dirty.current = false;
    setOperation(result);
    if (!currentTenant) openTenant(result.tenantId);
    await loadLists();
  }
  const editing = Boolean(selected);
  const checks = settings?.tenant.ReadinessJson ? JSON.parse(settings.tenant.ReadinessJson) as Check[] : [];
  function configure(choice: "existing" | "new" | "review") {
    if (choice !== "review") {
      dirty.current = true;
      setCapacityMode(choice); setBilling(false);
      if (choice === "existing") setCapacityId("");
    }
    requestAnimationFrame(() => {
      configurationForm.current?.scrollIntoView({ block: "start" });
      const target = configurationForm.current?.elements.namedItem(choice === "new" ? "sku" : choice === "existing" ? "capacityId" : "workspaceName");
      if (target instanceof HTMLElement) target.focus();
    });
  }
  const administratorChanged = Boolean(editing && upn.trim() &&
    upn.trim().toLowerCase() !== settings?.administratorUpn?.toLowerCase());
  return <>
    <section aria-busy={loading || active}>
      <div className="section-title"><h2>{editing ? `Tenant Details${settings ? `: ${settings.tenant.Name}` : ""}` : "Add Tenant"}</h2>
        {settings && <span className="badge">{settings.tenant.Status}</span>}</div>
      <p className="muted">{editing ? "Manage this tenant's configuration, administrators and runtime readiness." :
        "Create an isolated workspace, embedding identity and initial administrator."}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {loading && <p role="status">Reading current workspace settings...</p>}
      {settings?.workspaceIssue && <p className="error">{settings.workspaceIssue}</p>}
      <form ref={configurationForm} onChangeCapture={() => { dirty.current = true; }}
        onSubmit={event => { event.preventDefault(); void run(submit, "Setup is running. Progress updates automatically below."); }}>
        <fieldset disabled={disabled || (editing && !settings)}>
          <div className="setup-grid">
            <label>Tenant / workspace name<input name="workspaceName" value={workspaceName} maxLength={200} required
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
      {settings && <div className="technical"><h3>Tenant facts</h3>
        <dl><dt>Tenant ID</dt><dd>{settings.tenant.Id}</dd>
          <dt>Primary administrator</dt><dd>{settings.administratorUpn ?? "Not assigned"}</dd>
          <dt>Tenant administrators</dt><dd>{settings.administrators.map(admin => admin.DisplayName).join(", ") || "None"}</dd>
          <dt>Workspace ID</dt><dd>{settings.tenant.WorkspaceId ?? "Not created"}</dd>
          <dt>Embedding application ID</dt><dd>{settings.tenant.EmbeddingClientId ?? "Not created"}</dd>
          <dt>Service principal object ID</dt><dd>{settings.tenant.EmbeddingObjectId ?? "Not created"}</dd>
          <dt>Assigned capacity ID</dt><dd>{settings.workspace?.capacityId ?? "Not assigned"}</dd></dl>
        {settings.tenant.LastIssue && <p className="error">{settings.tenant.LastIssue}</p>}
        <div className="section-title"><h3>Configuration checks</h3>
          <button disabled={disabled} onClick={() => void run(async () => {
            await api(`/api/admin/tenants/${selected}/readiness`, "POST", {});
            const value = await api<TenantSettings>(`/api/admin/tenants/${selected}/settings`);
            if (mounted.current) applySettings(value);
          }, "Tenant configuration checks refreshed.")}>Check configuration</button></div>
        <p className="muted">Checks inspect saved settings, not unsaved edits. Last checked:
          {" "}{settings.tenant.LastCheckedAt ? new Date(settings.tenant.LastCheckedAt).toLocaleString() : "Not yet checked"}.</p>
        <TenantRemediation tenant={settings.tenant} checks={checks} busy={disabled} version={version}
          recoveryRequired={Boolean(operation?.recoveryRequired)} run={run} refreshed={applySettings} configure={configure} />
      </div>}
    </section>
    {settings && administrators(selected, disabled)}
    {!editing && <details className="advanced"><summary>Adopt an existing workspace instead</summary>
      <p>Discovery never exposes tenant content. Adoption requires your direct workspace administrator access; complete setup using the settings above afterward.</p>
      <button disabled={busy} onClick={() => void run(async () => setWorkspaces(await api<Workspace[]>("/api/admin/workspaces")), "Discovery refreshed.")}>Discover workspaces</button>
      {workspaces && <table><thead><tr><th>Workspace</th><th>Tenant</th><th /></tr></thead><tbody>{workspaces.map(workspace =>
        <tr key={workspace.id}><td>{workspace.name}</td><td>{workspace.tenant ?? "Unmanaged"}</td><td>{!workspace.tenant &&
          <button disabled={busy || active} onClick={() => void run(async () => {
            const result = await api<Tenant>("/api/admin/tenants/adopt", "POST", { workspaceId: workspace.id, name: workspace.name });
            if (mounted.current) openTenant(result.Id);
          }, "Workspace adopted. Choose its capacity and administrator, then save settings.")}>Adopt as tenant</button>}</td></tr>)}</tbody></table>}
    </details>}
  </>;
}
