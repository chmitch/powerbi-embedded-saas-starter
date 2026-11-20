import React, { useEffect, useImperativeHandle, useRef, useState } from "react";
import * as powerbi from "powerbi-client";
import { api, permissions, type Catalog, type EmbedConfiguration, type ReportItem } from "./api";
import { bindReportLifecycle, embedErrorMessage, reportEmbedPermissions } from "./embedding";
import { Icon } from "./icons";

type Selection = { contentId: string; mode: "view" | "edit" } | { modelId: string };
type Run = (action: () => Promise<unknown>, message?: string) => Promise<void>;
type SaveKind = "existing" | "copy" | "new";
export interface ReportsHandle { canLeave: () => Promise<boolean> }
interface ActiveSession {
  report: powerbi.Report;
  authorize: (mode?: "view" | "edit" | "copy") => Promise<EmbedConfiguration>;
}

function Dialog({ title, id, onClose, children, className = "" }: {
  title: string; id: string; onClose: () => void; children: React.ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} id={id} className={className} aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="section-title"><h2 id={`${id}-title`}>{title}</h2><button className="icon-button" type="button" onClick={onClose} aria-label={`Close ${title}`} title={`Close ${title}`}><Icon name="close" /></button></div>
    {children}
  </dialog>;
}

function ReportMenu({ anchor, open, onOpenChange, children }: {
  anchor: React.RefObject<HTMLButtonElement | null>; open: boolean;
  onOpenChange: (open: boolean) => void; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  function position() {
    const panel = ref.current, button = anchor.current;
    if (!panel || !button) return;
    const bounds = button.getBoundingClientRect();
    const width = Math.min(24 * parseFloat(getComputedStyle(document.documentElement).fontSize), innerWidth - 24);
    const top = Math.max(12, Math.min(bounds.bottom + 8, innerHeight - 12));
    panel.style.left = `${Math.max(12, Math.min(bounds.left, innerWidth - width - 12))}px`;
    panel.style.setProperty("--report-menu-top", `${top}px`);
  }
  useEffect(() => {
    const panel = ref.current!;
    if (!open) {
      if (panel.matches(":popover-open")) panel.hidePopover();
      return;
    }
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, anchor]);
  return <div ref={ref} id="report-menu" className="report-menu" popover="auto"
    role="dialog" aria-modal="false" aria-labelledby="report-menu-title"
    onKeyDown={event => {
      if (event.key === "Escape") {
        event.preventDefault(); onOpenChange(false); anchor.current?.focus({ preventScroll: true });
      }
    }}
    onBeforeToggle={event => { if (event.target === event.currentTarget && event.newState === "open") position(); }}
    onToggle={event => {
      if (event.target !== event.currentTarget) return;
      const shown = event.newState === "open";
      onOpenChange(shown);
      if (shown) {
        const panel = event.currentTarget;
        (panel.querySelector<HTMLButtonElement>(".report-menu-item[aria-current=page]") ??
          panel.querySelector<HTMLButtonElement>(".report-menu-item:not(:disabled)") ??
          panel.querySelector<HTMLButtonElement>("button"))?.focus();
      }
    }}>
    <div className="section-title"><h2 id="report-menu-title">Reports</h2>
      <button className="icon-button" type="button" aria-label="Close Reports" title="Close Reports" onClick={() => {
        onOpenChange(false); anchor.current?.focus({ preventScroll: true });
      }}><Icon name="close" /></button></div>
    {children}
  </div>;
}

export function Reports({ ref, version, run, focused, onFocusChange, applicationActions }: {
  ref?: React.Ref<ReportsHandle>; version: number; run: Run;
  focused: boolean; onFocusChange: (focused: boolean) => void; applicationActions: React.ReactNode;
}) {
  const [data, setData] = useState<Catalog>();
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<Selection>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [modelId, setModelId] = useState("");
  const [changing, setChanging] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const viewer = useRef<ReportsHandle>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useImperativeHandle(ref, () => ({ canLeave: async () => !viewer.current || await viewer.current.canLeave() }));
  const hasSelection = Boolean(selection);
  useEffect(() => { if (!hasSelection) onFocusChange(false); }, [hasSelection, onFocusChange]);
  useEffect(() => () => onFocusChange(false), [onFocusChange]);
  useEffect(() => {
    let cancelled = false;
    void api<Catalog>("/api/me/content").then(value => {
      if (!cancelled) { setData(value); setError(""); }
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [version]);
  useEffect(() => {
    if (!data || !selection) return;
    const available = "contentId" in selection
      ? data.reports.some(r => r.Id === selection.contentId) : data.models.some(m => m.Id === selection.modelId);
    if (!available) { setSelection(undefined); setError("This report or model is no longer available to you."); }
  }, [data, selection]);
  const report = selection && "contentId" in selection ? data?.reports.find(r => r.Id === selection.contentId) : undefined;
  const model = selection && "modelId" in selection ? data?.models.find(m => m.Id === selection.modelId) : undefined;
  async function open(next?: Selection) {
    if (changing) return;
    setChanging(true);
    try {
      if (viewer.current && !await viewer.current.canLeave()) return;
      setSessionKey(value => value + 1); setSelection(next); setMenuOpen(false); setNewOpen(false); setError("");
    } finally { setChanging(false); }
  }
  function tree(parentId: string | null, seen = new Set<string>()): React.ReactNode {
    return data?.nodes.filter(n => n.ParentId === parentId && !seen.has(n.Id)).map(node => {
      const visited = new Set(seen).add(node.Id);
      if (!node.ParentId) return <React.Fragment key={node.Id}>{tree(node.Id, visited)}</React.Fragment>;
      const item = data.reports.find(r => r.nodeId === node.Id);
      return <li key={node.Id}>{item
        ? <button className="report-menu-item" disabled={changing} aria-current={report?.Id === item.Id ? "page" : undefined}
          onClick={() => { if (report?.Id === item.Id) setMenuOpen(false); else void open({ contentId: item.Id, mode: "view" }); }}><Icon name="reports" /><span>{node.Label}</span></button>
        : <details open><summary><Icon name="folder" />{node.Label}</summary><ul>{tree(node.Id, visited)}</ul></details>}</li>;
    });
  }
  function newReport() { setModelId(""); setNewOpen(true); }
  const navigation = <>
      <button ref={menuButton} popoverTarget="report-menu" aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls="report-menu"><Icon name="menu" />Reports</button>
      <div className="report-heading"><h2>{report?.label ?? (model ? "New report" : data?.tenant.Name ?? "Reports")}</h2>
        {!selection && <small>Choose a report or create a new one</small>}</div>
  </>;
  return <div className={`report-workspace${selection ? " has-report" : ""}`}>
    {!selection && <div className="report-toolbar">{navigation}
      <button className="primary" disabled={changing || !data?.models.length} onClick={newReport}
        title={!data?.models.length ? "Report creation requires permission and an approved semantic model." : undefined}><Icon name="plus" />New report</button></div>}
    {error && <div role="alert" className="error">{error}</div>}
    <ReportMenu anchor={menuButton} open={menuOpen} onOpenChange={setMenuOpen}>
      {!data ? <p>Loading reports...</p> : !data.reports.length ? <p>No published reports are available. Ask an administrator to publish content and grant access.</p>
        : <ul className="report-tree">{tree(null)}</ul>}
    </ReportMenu>
    {newOpen && <Dialog title="New report" id="new-report" onClose={() => setNewOpen(false)}>
      <p>Choose the approved semantic model to build your report from.</p>
      <form onSubmit={event => { event.preventDefault(); if (data?.models.some(m => m.Id === modelId)) void open({ modelId }); }}>
        <label>Semantic model<select autoFocus required value={modelId} onChange={event => setModelId(event.target.value)}>
          <option value="">Choose a semantic model</option>{data?.models.map(m => <option key={m.Id} value={m.Id}>{m.Name}</option>)}
        </select></label>
        <div className="actions"><button type="button" onClick={() => setNewOpen(false)}>Cancel</button>
          <button className="primary" disabled={!modelId || changing}>Create report</button></div>
      </form>
    </Dialog>}
    {selection ? <EmbeddedReport key={sessionKey} ref={viewer} selection={selection} report={report} title={report?.label ?? model?.Name ?? "Report"}
      navigation={navigation} onNew={newReport} canCreate={!changing && Boolean(data?.models.length)} applicationActions={applicationActions}
      focused={focused} onFocus={() => onFocusChange(!focused)}
      onView={() => void open(report ? { contentId: report.Id, mode: "view" } : undefined)}
      onEdit={() => { if (report) void open({ contentId: report.Id, mode: "edit" }); }}
      onClose={() => void open()} onCreated={() => {
        setSelection(undefined);
        void run(() => api("/api/me/register-report", "POST"), "Report saved. New reports need administrator publication before they appear in the menu.");
      }} onRename={report && (report.permissions & permissions.ManageNavigation) ? () => {
        const label = window.prompt("Shared navigation label (does not rename the Power BI artifact)", report.label);
        if (label?.trim()) void run(() => api(`/api/me/reports/${report.Id}/label`, "PATCH", { label: label.trim() }));
      } : undefined} /> :
      <section className="report-empty"><div className="empty-icon"><Icon name="reports" /></div><h2>Your reports, without the clutter</h2>
        {!data ? <p>Loading your report catalog...</p> : <p>Open Reports to browse your tenant's folders and reports.
          {data.models.length ? " Or choose New report to start from a semantic model." : " Only published reports you can view appear in the menu."}</p>}
        <button className="primary" popoverTarget="report-menu" aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls="report-menu"><Icon name="reports" />Browse reports</button></section>}
  </div>;
}

function EmbeddedReport({ ref, selection, report, title, onView, onEdit, onClose, onCreated, onRename,
  navigation, onNew, canCreate, applicationActions, focused, onFocus }: {
  ref: React.Ref<ReportsHandle>; selection: Selection; report?: ReportItem; title: string;
  onView: () => void; onEdit: () => void; onClose: () => void; onCreated: () => void; onRename?: () => void;
  navigation: React.ReactNode; onNew: () => void; canCreate: boolean; applicationActions: React.ReactNode;
  focused: boolean; onFocus: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const active = useRef<ActiveSession | undefined>(undefined);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [phase, setPhase] = useState<"authorizing" | "loading" | "rendering" | "ready" | "error">("authorizing");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  function changePhase(value: typeof phase) { phaseRef.current = value; setPhase(value); }
  const loaded = phase === "ready";
  const [actionsOpen, setActionsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [saveKind, setSaveKind] = useState<SaveKind>();
  const [name, setName] = useState("");
  const pending = useRef<SaveKind | undefined>(undefined);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef({ onCreated, report });
  latest.current = { onCreated, report };
  const creating = "modelId" in selection;
  const editing = creating || selection.mode === "edit";
  const canEdit = Boolean(report && (report.permissions & permissions.EditReport) && report.canAuthorModel);
  const copyMask = permissions.ViewReport | permissions.EditReport | permissions.CopyReport;
  const canCopy = Boolean(report && (report.permissions & copyMask) === copyMask && report.canAuthorModel && report.canCreateCopy);
  const disabled = !loaded || saving || uncertain;
  useImperativeHandle(ref, () => ({
    canLeave: async () => {
      if (saving) return window.confirm("A save is still in progress. Leaving will stop waiting for confirmation. Leave anyway?");
      if (!editing || !loaded) return true;
      try { if (active.current && await active.current.report.isSaved()) return true; } catch { /* Ask before discarding an unverified editing session. */ }
      return window.confirm("Leave this editing session? Any unsaved changes will be lost.");
    },
  }));
  useEffect(() => {
    const container = host.current!;
    const service = new powerbi.service.Service(powerbi.factories.hpmFactory, powerbi.factories.wpmpFactory, powerbi.factories.routerFactory);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let embedded: powerbi.Report | undefined;
    let tokenMode: "view" | "edit" | "copy" = "modelId" in selection ? "edit" : selection.mode;
    let queue: Promise<unknown> = Promise.resolve();
    let stopLifecycle = () => {};
    let configuration: EmbedConfiguration | undefined;
    let sdkPermissions: powerbi.models.Permissions | undefined;
    let capacityChecked = false;
    let capacityResumed = false;
    let instance = 0;
    const request = (mode = tokenMode, recoverCapacity = false) => "modelId" in selection
      ? api<EmbedConfiguration>("/api/embed/create", "POST", { modelId: selection.modelId, ...(recoverCapacity ? { recoverCapacity } : {}) })
      : api<EmbedConfiguration>("/api/embed/report", "POST", { contentId: selection.contentId, mode, ...(recoverCapacity ? { recoverCapacity } : {}) });
    function schedule(config: EmbedConfiguration) {
      clearTimeout(timer);
      timer = setTimeout(() => { void authorize().catch(fail); }, Math.max(5_000, Date.parse(config.expiration) - Date.now() - 120_000));
    }
    function fail(e: unknown) {
      if (disposed) return;
      clearTimeout(timer); clearTimeout(saveTimer.current); stopLifecycle(); instance++;
      active.current = undefined; changePhase("error"); setSaving(false); setNotice("");
      setError(embedErrorMessage(e, "The report session could not continue. Close it and try again."));
      service.reset(container);
    }
    function authorize(mode?: "view" | "edit" | "copy") {
      const result = queue.then(async () => {
        const config = await request(mode ?? tokenMode);
        if (disposed || !embedded) throw new Error("The report session has closed.");
        await embedded.setAccessToken(config.accessToken);
        if (disposed) throw new Error("The report session has closed.");
        tokenMode = config.mode; schedule(config); return config;
      });
      queue = result.catch(() => undefined);
      return result;
    }
    function initialFailure(error: unknown) {
      if (disposed) return;
      if (!capacityChecked && configuration?.autoResumeCapacities) {
        capacityChecked = true; instance++; stopLifecycle(); clearTimeout(timer);
        const generation = instance;
        active.current = undefined; embedded = undefined; service.reset(container);
        changePhase("authorizing"); setNotice("Checking whether this report's capacity needs to start...");
        void request(tokenMode, true).then(config => {
          if (disposed || generation !== instance) return;
          if (config.capacityResumed) {
            capacityResumed = true; configuration = config; sdkPermissions = undefined;
            setNotice("Capacity is running. Loading report...");
            mount(config);
          } else fail(error);
        }).catch(fail);
        return;
      }
      fail(error);
    }
    function mount(config: EmbedConfiguration) {
      const item = latest.current.report;
      const editable = config.create || Boolean(item && (item.permissions & permissions.EditReport) && item.canAuthorModel);
      const copyable = config.create || Boolean(item && (item.permissions & copyMask) === copyMask && item.canAuthorModel && item.canCreateCopy);
      sdkPermissions ??= reportEmbedPermissions({ creating: config.create, editable, copyable }, powerbi.models.Permissions);
      const base = { type: "report", tokenType: powerbi.models.TokenType.Embed, embedUrl: config.embedUrl,
        accessToken: config.accessToken,
        permissions: sdkPermissions,
        viewMode: config.mode === "view" ? powerbi.models.ViewMode.View : powerbi.models.ViewMode.Edit,
        settings: { bars: { actionBar: { visible: false } }, useCustomSaveAsDialog: true } };
      changePhase("loading");
      const current = (config.create ? service.createReport(container, { ...base, datasetId: config.datasetId }) :
        service.embed(container, { ...base, id: config.id })) as powerbi.Report;
      embedded = current;
      const generation = ++instance;
      const isCurrent = () => !disposed && generation === instance;
      active.current = { report: current, authorize };
      current.setComponentTitle(config.create ? "New report editor" : "Power BI report");
      stopLifecycle = bindReportLifecycle(current, { creating: config.create,
        onRendering: () => { if (isCurrent()) changePhase("rendering"); },
        onReady: () => {
          if (!isCurrent()) return;
          changePhase("ready");
          if (capacityResumed) setNotice("Capacity is running. Report ready.");
        } });
      current.on("error", event => {
        if (!isCurrent()) return;
        if (phaseRef.current !== "ready") initialFailure(event.detail);
        else setError(embedErrorMessage(event.detail,
          "Power BI could not complete this operation. Check your connection and report configuration."));
      });
      current.on("saveAsTriggered", () => {
        if (!isCurrent() || pending.current || !(config.create || copyable)) return;
        setName(config.create ? "New report" : `${latest.current.report?.label ?? "Report"} (copy)`.slice(0, 200));
        setSaveKind(config.create ? "new" : "copy");
      });
      current.on("saved", () => {
        if (!isCurrent()) return;
        clearTimeout(saveTimer.current);
        const kind = pending.current ?? (config.create ? "new" : "existing");
        pending.current = undefined; setSaving(false); setUncertain(false); setSaveKind(undefined);
        if (kind === "existing") setNotice("Report saved.");
        else latest.current.onCreated();
      });
      schedule(config);
    }
    setError(""); setNotice(""); changePhase("authorizing"); setSaving(false); setUncertain(false); setSaveKind(undefined);
    pending.current = undefined; active.current = undefined;
    void (async () => {
      try {
        configuration = await request();
        if (!disposed) mount(configuration);
      } catch (e) { fail(e); }
    })();
    function beforeUnload(event: BeforeUnloadEvent) {
      if (editing) { event.preventDefault(); event.returnValue = ""; }
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      disposed = true; clearTimeout(timer); clearTimeout(saveTimer.current); stopLifecycle(); active.current = undefined;
      window.removeEventListener("beforeunload", beforeUnload);
      service.reset(container);
    };
  }, [selection]);
  function showSave(kind: "copy" | "new") {
    setName(kind === "new" ? "New report" : `${report?.label ?? "Report"} (copy)`.slice(0, 200));
    setSaveKind(kind);
  }
  async function save(kind: SaveKind) {
    const session = active.current;
    if (!session || disabled || (kind === "existing" && (!canEdit || !editing)) || (kind === "copy" && !canCopy) ||
      (kind === "new" && !creating) || (kind !== "existing" && !name.trim())) return;
    setSaving(true); setError(""); setNotice("");
    let submitted = false;
    try {
      const config = await session.authorize(kind === "copy" ? "copy" : "edit");
      if (active.current !== session) return;
      if (kind !== "existing" && !config.targetWorkspaceId) throw new Error("No authorized destination workspace was returned. Nothing was saved.");
      pending.current = kind;
      saveTimer.current = setTimeout(() => {
        if (active.current !== session || !pending.current) return;
        setSaving(false); setUncertain(true);
        setError("Power BI has not confirmed the save. Check the workspace before retrying; the report may have been saved.");
      }, 40_000);
      submitted = true;
      if (kind === "existing") await session.report.save();
      else await session.report.saveAs({ name: name.trim(), targetWorkspaceId: config.targetWorkspaceId });
    } catch (e) {
      if (active.current !== session) return;
      clearTimeout(saveTimer.current); setSaving(false);
      if (submitted) {
        setUncertain(true);
        setError("Power BI could not confirm the save. Check the workspace before retrying; the report may have been saved.");
      } else {
        pending.current = undefined;
        setError(embedErrorMessage(e, "The report could not be saved."));
      }
    }
  }
  return <section className="report-viewer">
    <div className="report-toolbar report-session-toolbar">
      {navigation}
      <span className="badge">{editing ? "Editing" : "Viewing"}</span>
      <div className="actions">
        {!editing && canEdit && <button disabled={disabled} onClick={onEdit} title="Edit report"><Icon name="edit" /><span className="compact-label">Edit report</span></button>}
        {editing && <button className="primary" disabled={disabled} onClick={() => creating ? showSave("new") : void save("existing")}><Icon name="save" />Save</button>}
        <button aria-pressed={focused} onClick={onFocus} title={focused ? "Restore compact application navigation" : "Expand report canvas"}>
          <Icon name={focused ? "collapse" : "expand"} /><span className="compact-label">{focused ? "Exit focus" : "Focus"}</span></button>
        <button aria-haspopup="dialog" aria-expanded={actionsOpen} aria-controls="report-actions" title="More report actions" onClick={() => setActionsOpen(true)}><Icon name="more" /><span className="compact-label">More</span></button>
      </div>
    </div>
    {error && <div role="alert" className="error">{error}</div>}
    {notice && <div role="status" className="notice report-notice"><span>{notice}</span>
      <button onClick={() => setNotice("")} aria-label="Dismiss notification">Dismiss</button></div>}
    {saving && <p role="status">Saving report...</p>}
    <div className="report-canvas" aria-busy={!loaded && phase !== "error"}>
      <div className="embed" ref={host} inert={!loaded} />
      {!loaded && phase !== "error" && <div className="report-loading" role="status" aria-live="polite">
        <strong>{phase === "authorizing" ? "Preparing secure report access..." :
          phase === "loading" ? (creating ? "Preparing report editor..." : "Loading report...") : "Rendering report..."}</strong>
        <span>{title}</span><progress aria-label="Report loading" />
      </div>}
    </div>
    {actionsOpen && <Dialog title="Report actions" id="report-actions" onClose={() => setActionsOpen(false)}>
      <div className="report-action-list" onClick={event => {
        if ((event.target as HTMLElement).closest("button:not(:disabled)")) setActionsOpen(false);
      }}>
        {!creating && editing && <button disabled={saving} onClick={onView}>View report</button>}
        {canCopy && <button disabled={disabled} onClick={() => showSave("copy")}>Save as new report</button>}
        <button disabled={saving || !canCreate} onClick={onNew}>New report</button>
        {onRename && <button disabled={saving} onClick={onRename}>Rename label</button>}
        <button disabled={saving} onClick={onClose}>Close report</button>
        {applicationActions}
      </div>
    </Dialog>}
    {saveKind && <Dialog title={saveKind === "new" ? "Save new report" : "Save as new report"} id="save-report"
      onClose={() => { if (!saving) setSaveKind(undefined); }}>
      <p>This creates a separate report in your tenant workspace. An administrator must publish it before it appears in the report menu.</p>
      <form onSubmit={event => { event.preventDefault(); void save(saveKind); }}>
        <label>Report name<input autoFocus required maxLength={200} value={name} disabled={saving} onChange={event => setName(event.target.value)} /></label>
        <div className="actions"><button type="button" disabled={saving} onClick={() => setSaveKind(undefined)}>Cancel</button>
          <button className="primary" disabled={disabled || !name.trim()}>Save report</button></div>
        {saving && <p role="status">Saving report...</p>}{error && <p role="alert" className="error">{error}</p>}
      </form>
    </Dialog>}
  </section>;
}
