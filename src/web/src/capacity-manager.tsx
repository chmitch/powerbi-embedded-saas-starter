import React, { useEffect, useRef, useState } from "react";
import { api, type ArmCapacity, type CapacityInventory, type CapacityResult, type Tenant, type TenantCapacity } from "./api";
import { CapacityPolicySettings } from "./capacity-policy";

type Action = "suspend" | "resume" | "resize";
const sizes = ["F2", "F4", "F8", "F16", "F32", "F64", "F128", "F256", "F512", "F1024", "F2048", "F4096", "F8192"];
const paused = (capacity: ArmCapacity) => ["Paused", "Suspended"].includes(capacity.properties.state ?? "");
const stable = (capacity: ArmCapacity) =>
  (!capacity.properties.provisioningState || capacity.properties.provisioningState === "Succeeded") &&
  (capacity.properties.state === "Active" || paused(capacity));
const actionable = (capacity: ArmCapacity, action: Action) => stable(capacity) &&
  (action === "resize" || (action === "resume" ? paused(capacity) : capacity.properties.state === "Active"));

export function CapacityManager({ busy, run, version, tenants, tenantsReady, openTenant }: {
  busy: boolean; version: number; tenants: Tenant[]; tenantsReady: boolean; openTenant: (id: string) => void;
  run: (action: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const [inventory, setInventory] = useState<CapacityInventory>({ value: [], issues: [], excludedTenants: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState("");
  const [results, setResults] = useState<CapacityResult[]>([]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function load(valid = () => mounted.current) {
    try {
      const result = await api<CapacityInventory>("/api/admin/capacities/tenants");
      if (valid()) { setInventory(result); setError(""); }
    } catch (e) {
      const result = await api<{ value: ArmCapacity[] }>("/api/admin/capacities");
      if (valid()) {
        setInventory({ value: result.value.map(capacity => ({ ...capacity, tenants: [] })),
          issues: ["Tenant assignments are unavailable. Bulk operations are disabled."], excludedTenants: [] });
        setError(e instanceof Error ? e.message : "Tenant capacity assignments could not be loaded.");
      }
    }
  }
  useEffect(() => {
    let disposed = false; setLoading(true);
    void load(() => !disposed && mounted.current).catch(e => { if (!disposed) setError(e.message); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [version]);
  async function readStates() {
    const result = await api<{ value: ArmCapacity[] }>("/api/admin/capacities");
    if (mounted.current) setInventory(previous => ({ ...previous,
      value: result.value.map(capacity => ({ ...capacity,
        tenants: previous.value.find(item => item.name === capacity.name)?.tenants ?? [] })) }));
    return result.value;
  }
  async function observe(initial: CapacityResult[], action: Action, sku?: string) {
    let current = initial;
    if (mounted.current) setResults(current);
    for (let attempt = 0; attempt < 180 && current.some(result => result.status === "accepted"); attempt++) {
      if (!mounted.current) throw new Error("Capacity requests were submitted. Reopen Platform admin to inspect completion.");
      let capacities: ArmCapacity[];
      try { capacities = await readStates(); }
      catch (error) {
        if (mounted.current) setResults(current.map(result => result.status === "accepted"
          ? { ...result, status: "unconfirmed", message: "Status could not be refreshed. Inspect Azure before retrying." } : result));
        throw error;
      }
      current = current.map(result => {
        if (result.status !== "accepted") return result;
        const capacity = capacities.find(item => item.name === result.name);
        if (!capacity) return { ...result, status: "unconfirmed", message: "Capacity disappeared from inventory. Inspect Azure before retrying." };
        if (["Failed", "Canceled"].includes(capacity.properties.provisioningState ?? "") ||
          ["Failed", "Canceled", "Disabled"].includes(capacity.properties.state ?? ""))
          return { ...result, status: "failed", message: "Azure could not complete the operation. Inspect the capacity before retrying." };
        if (stable(capacity) && (action === "resize" ? capacity.sku.name === sku :
          action === "resume" ? capacity.properties.state === "Active" : paused(capacity)))
          return { ...result, status: "succeeded", message: "Requested state confirmed in Azure." };
        return result;
      });
      if (mounted.current) setResults(current);
      if (current.some(result => result.status === "accepted")) await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (mounted.current) setResults(current.map(result => result.status === "accepted"
      ? { ...result, status: "unconfirmed", message: "Still pending after the observation limit. Refresh Azure status before retrying." } : result));
  }
  async function change(capacity: TenantCapacity, action: Action | "delete", sku?: string) {
    setWaiting(`${capacity.name}: waiting for ${action === "suspend" ? "pause" : action} to complete.`);
    setResults([]);
    try {
      if (action === "delete") {
        await api(`/api/admin/capacities/${capacity.name}`, "DELETE",
          { confirmName: capacity.name, acknowledgeUnmanagedImpact: true });
        for (let attempt = 0; attempt < 180; attempt++) {
          if (!mounted.current) throw new Error("Deletion requested. Reopen Platform admin to inspect Azure status.");
          const observed = (await readStates()).find(item => item.name === capacity.name);
          if (!observed) return;
          if (["Failed", "Canceled"].includes(observed.properties.provisioningState ?? ""))
            throw new Error("Azure could not complete deletion. Inspect the capacity before retrying.");
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        throw new Error("Deletion is still pending. Inspect Azure status before retrying.");
      }
      const result = await api<CapacityResult>(`/api/admin/capacities/${capacity.name}/action`, "POST",
        { action, ...(sku ? { sku } : {}), confirmName: capacity.name });
      await observe([result], action, sku);
    } finally { if (mounted.current) setWaiting(""); }
  }
  async function bulk(action: "suspend" | "resume") {
    setWaiting(`Submitting ${action === "suspend" ? "pause" : "resume"} requests for tenant capacities.`);
    setResults([]);
    try {
      const result = await api<{ results: CapacityResult[] }>("/api/admin/capacities/bulk/action", "POST",
        { action, confirmNames: inventory.value.filter(capacity => capacity.tenants.length).map(capacity => capacity.name) });
      await observe(result.results, action);
    } finally { if (mounted.current) setWaiting(""); }
  }
  const assigned = inventory.value.filter(capacity => capacity.tenants.length);
  const disabled = busy || loading || Boolean(waiting);
  function pauseResumeButtons(capacity: TenantCapacity) {
    return (["suspend", "resume"] as const).map(action =>
      <button key={action} disabled={disabled || !actionable(capacity, action)} onClick={() => {
        if (window.confirm(`${action === "suspend" ? "Pause" : "Resume"} ${capacity.name}? All assigned workspaces are affected. Registered tenants: ${capacity.tenants.map(tenant => tenant.name).join(", ") || "none verified"}.`))
          void run(() => change(capacity, action), "Capacity request finished. Review its result.");
      }}>{action === "suspend" ? "Pause" : "Resume"}</button>);
  }
  function capacityState(capacity: TenantCapacity) {
    return `${capacity.sku.name} / ${capacity.properties.state ?? "Unknown"}${
      capacity.properties.provisioningState && capacity.properties.provisioningState !== "Succeeded"
        ? ` (${capacity.properties.provisioningState})` : ""}`;
  }
  function confirmBulk(action: "suspend" | "resume") {
    const verb = action === "suspend" ? "Pause" : "Resume";
    const impact = assigned.map(capacity => `${capacity.name}: ${capacity.tenants.map(tenant => tenant.name).join(", ")}`).join("\n");
    if (window.confirm(`${verb} ${assigned.length} distinct tenant capacities?\n\n${impact}\n\nAll workspaces on these capacities are affected. Management and unassigned capacities are excluded.${action === "resume" ? " Capacity billing resumes." : ""}`))
      void run(() => bulk(action), "Capacity requests finished. Review the per-capacity results.");
  }
  return <section aria-busy={loading || Boolean(waiting)}>
    <div className="section-title"><h2>Tenant fleet</h2>
      <button disabled={disabled} onClick={() => void run(() => load(), "Capacity inventory refreshed.")}>Refresh fleet</button></div>
    <CapacityPolicySettings busy={disabled} run={run} version={version} />
    <p>Pause, resume or resize the capacity used by a tenant. Shared capacity changes affect every assigned workspace.
      Use Add Tenant to provision a workspace, or open Tenant Details to change its capacity assignment.</p>
    <div className="actions">{(["suspend", "resume"] as const).map(action =>
      <button key={action} className={action === "suspend" ? "danger" : ""}
        disabled={disabled || !tenantsReady || Boolean(inventory.issues.length) || !assigned.some(capacity => actionable(capacity, action))}
        onClick={() => confirmBulk(action)}>{action === "suspend" ? "Pause" : "Resume"} all tenant capacities</button>)}</div>
    <small>Only capacities assigned to registered tenants in this deployment are included, once per capacity.
      Errors do not stop the remaining requests. Management compute is always excluded.
      If automatic resume is enabled, later report access can wake a paused tenant capacity.</small>
    {loading && <p role="status">Loading capacity states and tenant assignments...</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {inventory.issues.length > 0 && <div className="warning" role="alert">
      <strong>Bulk operations are disabled until assignments can be verified.</strong>
      {inventory.issues.map(issue => <p key={issue}>{issue}</p>)}</div>}
    {inventory.excludedTenants.length > 0 && <p className="warning">Outside this deployment's capacity scope:
      {" "}{inventory.excludedTenants.map(tenant => tenant.name).join(", ")}. Their capacities are not changed.</p>}
    {waiting && <p className="notice" role="status">{waiting} Status refreshes automatically.</p>}
    {tenantsReady && !tenants.length && <p>No tenants yet. Choose Add Tenant to provision your first workspace.</p>}
    {tenants.length > 0 && <table aria-label="Tenant fleet"><thead><tr><th>Tenant</th><th>Configuration</th><th>Capacity</th><th>Size / state</th><th>Actions</th></tr></thead>
      <tbody>{tenants.map(tenant => {
        const capacity = inventory.value.find(item => item.tenants.some(assignment => assignment.id === tenant.Id));
        const excluded = inventory.excludedTenants.some(item => item.id === tenant.Id);
        return <tr key={tenant.Id}><td><button className="tenant-link" disabled={disabled} onClick={() => openTenant(tenant.Id)}>{tenant.Name}</button>
          {capacity && capacity.tenants.length > 1 && <small>Shared with {capacity.tenants.filter(item => item.id !== tenant.Id).map(item => item.name).join(", ")}</small>}</td>
          <td><span className="badge">{tenant.Status}</span>{tenant.LastIssue && <small>{tenant.LastIssue}</small>}</td>
          <td>{capacity?.name ?? (loading ? "Loading..." : excluded ? "Outside deployment scope" :
            !tenant.WorkspaceId ? "No workspace" : inventory.issues.length ? "Assignment unverified" : "Not assigned")}</td>
          <td>{capacity ? capacityState(capacity) : "-"}</td>
          <td><div className="actions"><button disabled={disabled} onClick={() => openTenant(tenant.Id)}>Open details</button>
            {capacity && pauseResumeButtons(capacity)}</div></td></tr>;
      })}</tbody></table>}
    {!loading && !inventory.value.length && <p>No customer capacities found in the configured Azure resource group.</p>}
    {inventory.value.length > 0 && <details className="technical"><summary>All customer capacity resources (including unassigned)</summary>
      <table aria-label="Customer capacity resources"><thead><tr><th>Capacity</th><th>Size / state</th><th>Registered tenants</th><th>Actions</th></tr></thead>
      <tbody>{inventory.value.map(capacity => <tr key={capacity.name}>
        <td><strong>{capacity.name}</strong></td>
        <td>{capacityState(capacity)}</td>
        <td>{capacity.tenants.length ? <div className="actions">{capacity.tenants.map(tenant =>
          <button key={tenant.id} className="tenant-link" disabled={disabled} onClick={() => openTenant(tenant.id)}>{tenant.name}</button>)}</div> :
          inventory.issues.length ? "Assignment not verified" : "No registered tenant"}{capacity.tenants.length > 1 && <small>Shared capacity</small>}</td>
        <td><div className="actions">{pauseResumeButtons(capacity)}
          <select aria-label={`Resize ${capacity.name}`} value="" disabled={disabled || !stable(capacity)} onChange={event => {
            const sku = event.target.value;
            if (sku && window.confirm(`Resize ${capacity.name} to ${sku}? Billing and availability change for every assigned workspace. Registered tenants: ${capacity.tenants.map(tenant => tenant.name).join(", ") || "none verified"}.`))
              void run(() => change(capacity, "resize", sku), "Capacity resize request finished. Review its result.");
          }}><option value="">Resize...</option>{sizes.map(size => <option key={size} disabled={size === capacity.sku.name}>{size}</option>)}</select>
          <button className="danger" disabled={disabled || !stable(capacity)} onClick={() => {
            if (window.confirm(`Permanently delete ${capacity.name}? Move registered tenant workspaces first. Unmanaged workspaces may also be affected.`))
              void run(() => change(capacity, "delete"), "Capacity deletion confirmed.");
          }}>Delete</button></div></td>
      </tr>)}</tbody></table></details>}
    {results.length > 0 && <table aria-label="Capacity operation results"><thead><tr><th>Capacity</th><th>Result</th><th>Details</th></tr></thead>
      <tbody>{results.map(result => <tr key={result.name}><td>{result.name}</td><td>{result.status === "accepted" ? "Waiting for Azure" : result.status}</td>
        <td>{result.message}</td></tr>)}</tbody></table>}
  </section>;
}
