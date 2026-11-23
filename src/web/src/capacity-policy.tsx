import React, { useEffect, useState } from "react";
import { api, type CapacityPolicyStatus } from "./api";

export function CapacityPolicySettings({ busy, version, run }: {
  busy: boolean; version: number; run: (action: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const [policy, setPolicy] = useState<CapacityPolicyStatus>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    void api<CapacityPolicyStatus>("/api/admin/capacities/auto-resume").then(value => {
      if (!disposed) { setPolicy(value); setError(""); }
    }).catch(e => { if (!disposed) { setPolicy(undefined); setError(e.message); } })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [version]);
  function change(enabled: boolean) {
    if (!policy) return;
    const confirmation = enabled ?
      "Enable automatic capacity resume? Foreground sign-in/database requests, including anonymous visitors, can restart management F2 billing. Authorized report access can restart tenant capacity billing. Health checks and background work do not wake capacities." :
      "Disable automatic capacity resume? This does not pause running capacities or cancel submitted resumes. If management compute is later paused, sign-in and this console may be unavailable until an Azure operator resumes it.";
    if (!window.confirm(confirmation)) return;
    void run(async () => {
      const next = await api<CapacityPolicyStatus>("/api/admin/capacities/auto-resume", "PUT",
        { enabled, revision: policy.revision, ...(enabled ? { confirmBilling: true } : {}) });
      setPolicy(next);
    }, `Automatic capacity resume ${enabled ? "enabled" : "disabled"} and saved.`);
  }
  return <div aria-busy={loading}>
    <h3>Automatic capacity resume</h3>
    {loading && <p role="status">Checking the automatic-resume setting...</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {policy && <p>Status: <strong>{policy.enabled ? "Enabled" : "Disabled"}</strong>
      {" "}- {policy.source === "platform" ? "saved platform policy" : "deployment default"}.</p>}
    {policy?.issue && <p className="warning" role="alert">{policy.issue}</p>}
    {policy?.available && !policy.enabled && <p className="warning">
      Automatic resume is disabled. Would you like to enable it so paused management compute and authorized tenant reports can recover on foreground access?</p>}
    <p className="muted">This is an application policy, not a Fabric capacity property. Enabling it can restart compute billing.
      Health checks and background jobs never wake capacities. Changes apply to future requests, not already submitted operations.</p>
    <div className="actions">
      <button disabled={busy || loading || !policy?.available} onClick={() => change(!policy?.enabled)}>
        {policy?.enabled ? "Disable" : "Enable"} automatic resume</button>
      <button disabled={busy || loading} onClick={() => void run(async () => {
        setPolicy(await api<CapacityPolicyStatus>("/api/admin/capacities/auto-resume")); setError("");
      }, "Automatic-resume policy refreshed.")}>Refresh setting</button>
    </div>
  </div>;
}
