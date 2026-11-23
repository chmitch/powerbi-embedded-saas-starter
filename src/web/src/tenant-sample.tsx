import React, { useEffect, useRef, useState } from "react";
import { api, type SetupOperation } from "./api";

export function TenantSample({ tenantId, version, busy, run }: {
  tenantId: string; version: number; busy: boolean;
  run: (action: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const [operation, setOperation] = useState<SetupOperation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef<string | null>(null);
  const base = `/api/tenants/${tenantId}/sample`;
  useEffect(() => {
    let disposed = false;
    setLoading(true); setError(""); setOperation(null); requestId.current = null;
    void api<{ operation: SetupOperation | null }>(base)
      .then(result => { if (!disposed) setOperation(result.operation); })
      .catch(e => { if (!disposed) setError(e.message); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [tenantId, version]);
  useEffect(() => {
    if (operation?.status !== "Running") return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function observe() {
      try {
        const result = await api<{ operation: SetupOperation | null }>(base);
        if (disposed) return;
        setError(""); setOperation(result.operation);
        if (result.operation?.status === "Succeeded")
          await run(async () => {}, "Sample report added and published. User permissions are unchanged.");
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "Sample progress could not be refreshed."); }
      finally { if (!disposed) timer = setTimeout(observe, 2500); }
    }
    timer = setTimeout(observe, 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [tenantId, operation?.id, operation?.status]);
  const complete = operation?.status === "Succeeded";
  const failedSetupStep = operation?.status === "Failed"
    ? operation.steps.find(step => step.status === "failed" && step.key !== "sample") : undefined;
  const blocked = operation && (operation.status === "Running" || operation.recoveryRequired ||
    (!operation.canRetry && !complete));
  return <div aria-busy={loading || operation?.status === "Running"}>
    <button disabled={busy || loading || Boolean(error) || complete || Boolean(blocked)} onClick={() => void run(async () => {
      requestId.current ??= crypto.randomUUID();
      setOperation(await api<SetupOperation>(operation?.canRetry ? `${base}/${operation.id}/retry` : base,
        "POST", operation?.canRetry ? {} : { requestId: requestId.current }));
    }, "Sample request recorded. Progress is shown below.")}>
      {complete ? "Sample report added" : operation?.canRetry ? "Retry sample report" : "Add sample report"}
    </button>
    <small>Import and publish the bundled Store Sales report and model in this tenant.
      Existing content and user permissions are preserved. The sample is added at most once.</small>
    {failedSetupStep ? <p role="status">Sample not added. Initial tenant setup failed at: {failedSetupStep.label}.
      The sample import has not started.</p> : operation && <p role="status">Sample: {operation.status}.
      {operation.status === "Running" && " Waiting for import and metadata registration."}</p>}
    {operation?.error && <p className="error">{operation.error}</p>}
    {operation?.recoveryRequired && <p className="warning">Ask a platform administrator to reconcile the workspace/import history before recovery. No duplicate upload will be attempted.</p>}
    {operation && !complete && operation.status !== "Running" && !operation.canRetry && !operation.recoveryRequired &&
      <p>The original operator must resume this operation. Initial tenant setup must be resumed from Platform admin.</p>}
    {error && <p className="error" role="alert">{error}
      <button disabled={busy} onClick={() => void run(async () => {
        setOperation((await api<{ operation: SetupOperation | null }>(base)).operation); setError("");
      }, "Sample status refreshed.")}>Refresh sample status</button></p>}
  </div>;
}
