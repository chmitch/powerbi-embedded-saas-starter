import React, { useEffect, useRef, useState } from "react";
import { api, type CapacityResult, type Check, type Tenant, type TenantCapacityStatus, type TenantSettings } from "./api";

type ConfigurationChoice = "existing" | "new" | "review";
export function TenantRemediation({ tenant, checks, busy, version, recoveryRequired, run, refreshed, configure }: {
  tenant: Tenant; checks: Check[]; busy: boolean; version: number; recoveryRequired: boolean;
  run: (action: () => Promise<unknown>, message?: string) => Promise<void>;
  refreshed: (settings: TenantSettings) => void; configure: (choice: ConfigurationChoice) => void;
}) {
  const [status, setStatus] = useState<TenantCapacityStatus>();
  const [waiting, setWaiting] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let disposed = false;
    void api<TenantCapacityStatus>(`/api/admin/tenants/${tenant.Id}/capacity`)
      .then(value => { if (!disposed) setStatus(value); })
      .catch(e => { if (!disposed) setStatus({ capacity: null, issue: e.message }); });
    return () => { disposed = true; };
  }, [tenant.Id, version]);
  const disabled = busy || Boolean(waiting);
  async function recheck() {
    if (!mounted.current) throw new Error("Repair was submitted. Reopen this tenant's details to check the outcome.");
    setWaiting("Rechecking saved tenant configuration...");
    await api(`/api/admin/tenants/${tenant.Id}/readiness`, "POST", {});
    const value = await api<TenantSettings>(`/api/admin/tenants/${tenant.Id}/settings`);
    if (mounted.current) refreshed(value);
  }
  async function resume(name: string) {
    setWaiting("Submitting the confirmed resume request...");
    try {
      const result = await api<CapacityResult>(`/api/admin/tenants/${tenant.Id}/capacity/resume`, "POST",
        { confirmName: name, confirmBilling: true });
      if (result.status !== "accepted" && result.status !== "skipped")
        throw new Error("Capacity resume was not confirmed. Inspect Azure before submitting another request.");
      if (result.status === "accepted") {
        let active = false;
        for (let attempt = 0; attempt < 180; attempt++) {
          if (!mounted.current) throw new Error("Resume was submitted. Reopen this tenant's details to inspect completion.");
          const current = await api<TenantCapacityStatus>(`/api/admin/tenants/${tenant.Id}/capacity`);
          setStatus(current);
          if (!current.capacity || current.capacity.name !== name)
            throw new Error("The tenant capacity could not be reverified or its assignment changed. Inspect Azure and refresh before retrying.");
          const properties = current.capacity.properties;
          if (["Failed", "Canceled", "Deleting", "Disabled"].includes(properties.state ?? "") ||
            ["Failed", "Canceled", "Deleting"].includes(properties.provisioningState ?? ""))
            throw new Error("Azure could not complete the resume. Inspect its capacity state before retrying.");
          if (properties.state === "Active" && (!properties.provisioningState || properties.provisioningState === "Succeeded")) {
            active = true; break;
          }
          setWaiting("Azure accepted the request. Waiting for the assigned capacity to become Active...");
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        if (!active) throw new Error("Capacity resume is still unconfirmed after the observation limit. Inspect Azure before retrying.");
      }
      await recheck();
    } finally { if (mounted.current) setWaiting(""); }
  }
  function resumeConfirmed() {
    const capacity = status?.capacity;
    if (!capacity) return;
    if (window.confirm(`Resume ${capacity.name} for ${tenant.Name}? This restarts billing and affects every workspace on this capacity. Registered tenants: ${capacity.tenants.map(item => item.name).join(", ")}.`))
      void run(() => resume(capacity.name), "Capacity request finished. Configuration checks refreshed; review any remaining findings.");
  }
  function accessConfirmed() {
    if (window.confirm(`Grant workspace Admin access to this tenant's configured service principal?\nWorkspace: ${tenant.WorkspaceId}\nPrincipal: ${tenant.EmbeddingObjectId}\nThis does not grant human users report permissions or repair credentials/Fabric tenant policy.`))
      void run(async () => {
        setWaiting("Repairing configured service-principal workspace access...");
        try {
          await api(`/api/admin/tenants/${tenant.Id}/remediation/access`, "POST",
            { confirmWorkspaceId: tenant.WorkspaceId, confirmPrincipalId: tenant.EmbeddingObjectId, confirmAccess: true });
          await recheck();
        } finally { if (mounted.current) setWaiting(""); }
      }, "Workspace access request finished. Configuration checks refreshed; permissions may need time to propagate.");
  }
  function actions(check: Check) {
    if (check.status === "pass") return "-";
    if (check.key === "Capacity" || check.key === "Capacity state") {
      const capacity = status?.capacity;
      const canResume = capacity && ["Paused", "Suspended"].includes(capacity.properties.state ?? "");
      const changing = capacity?.properties.provisioningState && capacity.properties.provisioningState !== "Succeeded";
      return <><div className="actions">
        {canResume && <button disabled={disabled || Boolean(changing)} onClick={resumeConfirmed}>Resume tenant capacity</button>}
        <button disabled={disabled || recoveryRequired} onClick={() => configure("existing")}>Select another capacity</button>
        <button disabled={disabled || recoveryRequired} onClick={() => configure("new")}>Create replacement capacity</button>
      </div><small>Replacement uses the setup form and explicit billing approval. The existing capacity is not deleted.</small></>;
    }
    if (check.key === "Runtime access") return <>
      {tenant.WorkspaceId && tenant.EmbeddingClientId && tenant.EmbeddingObjectId ?
        <button disabled={disabled} onClick={accessConfirmed}>Repair service-principal access</button> :
        <button disabled={disabled} onClick={() => configure("review")}>Review identity setup</button>}
      <small>Failed verification does not prove a missing workspace role. Credential expiry, group restrictions and Fabric tenant settings may need external administrator action.</small>
    </>;
    if (check.key === "Workspace") return <><button disabled={disabled} onClick={() => configure("review")}>Review tenant setup</button>
      <small>Use saved setup/retry controls for missing configuration. An inaccessible or unknown workspace must be reconciled, not blindly recreated.</small></>;
    return <small>Review the finding and correct the required external configuration.</small>;
  }
  return <div aria-busy={Boolean(waiting)}>
    {status?.capacity && <p className="muted">Verified customer capacity: {status.capacity.name} / {status.capacity.sku.name} / {status.capacity.properties.state ?? "Unknown"}.</p>}
    {status?.issue && <p className="warning">{status.issue} Manual resume is unavailable until the current resource is verified.</p>}
    {waiting && <p className="notice" role="status">{waiting}</p>}
    <table aria-label="Tenant configuration checks"><thead><tr><th>Readiness check</th><th>Status</th><th>Finding</th><th>Repair</th></tr></thead>
      <tbody>{checks.map(check => <tr key={check.key}><td>{check.key}</td><td>{check.status}</td><td>{check.message}</td><td>{actions(check)}</td></tr>)}</tbody></table>
  </div>;
}
