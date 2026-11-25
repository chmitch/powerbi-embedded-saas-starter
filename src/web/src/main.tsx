import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api, setCsrf, permissions, type Session,
  type ManageData, type NavNode,
} from "./api";
import { PlatformConsole } from "./platform";
import { TenantSample } from "./tenant-sample";
import { Reports, type ReportsHandle } from "./reports";
import { Icon } from "./icons";
import { InsightsPage } from "./insights";
import "./style.css";

function PermissionPicker({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <div className="permissions">{Object.entries(permissions).map(([label, bit]) =>
    <label key={label}><input type="checkbox" checked={Boolean(value & bit)}
      onChange={event => onChange(event.target.checked ? value | bit : value & ~bit)} />{label.replaceAll(/([A-Z])/g, " $1").trim()}</label>)}</div>;
}
function App() {
  const [session, setSession] = useState<Session>();
  const [tab, setTab] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [reportFocused, setReportFocused] = useState(false);
  const reports = useRef<ReportsHandle>(null);
  const activeTab = tab === "tenant" && session?.user?.IsTenantAdmin && session.user.TenantId ? "tenant" :
    tab === "reports" && session?.user?.TenantId ? "reports" :
    session?.user?.IsPlatformAdmin ? "platform" : "reports";
  const refresh = async () => {
    const data = await api<Session>("/api/session"); setCsrf(data.csrf); setSession(data);
  };
  useEffect(() => { void refresh().catch(e => setError(String(e.message))); }, []);
  async function changeTab(next: string) {
    if (activeTab === "reports" && reports.current && !await reports.current.canLeave()) return;
    setTab(next);
  }
  const run = async (action: () => Promise<unknown>, message = "Saved.") => {
    setError(""); setNotice(""); setBusy(true);
    try { await action(); setNotice(message); setVersion(v => v + 1); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "The operation failed."); }
    finally { setBusy(false); }
  };
  async function signOut() {
    if (reports.current && !await reports.current.canLeave()) return;
    await run(async () => {
      const result = await api<{ redirect: string }>("/auth/logout", "POST"); window.location.assign(result.redirect);
    });
  }
  const focused = activeTab === "reports" && reportFocused;
  const reportPage = activeTab === "reports" && Boolean(session?.user?.TenantId);
  return <div className={`app-shell${reportPage ? " report-page" : ""}${focused ? " report-focused" : ""}`}>
    <header className="app-header"><h1><span className="brand-mark"><Icon name="workspace" /></span>Power BI Embedded SaaS Starter</h1>
    {session?.user && <nav aria-label="Application">
      {session.user.TenantId && <button className={activeTab === "reports" ? "selected" : ""} aria-current={activeTab === "reports" ? "page" : undefined} onClick={() => { if (activeTab !== "reports") void changeTab("reports"); }}><Icon name="reports" />My reports</button>}
      {session.user.IsTenantAdmin && session.user.TenantId && <button className={activeTab === "tenant" ? "selected" : ""} aria-current={activeTab === "tenant" ? "page" : undefined} onClick={() => void changeTab("tenant")}><Icon name="users" />Tenant admin</button>}
      {session.user.IsPlatformAdmin && <button className={activeTab === "platform" ? "selected" : ""} aria-current={activeTab === "platform" ? "page" : undefined} onClick={() => void changeTab("platform")}><Icon name="workspace" />Platform admin</button>}
    </nav>}
    <div className="app-account">{session?.identity && <><span className="app-account-name" title={session.identity.name}>{session.identity.name}</span>
      <button onClick={() => void signOut()} title="Sign out"><Icon name="logout" /><span className="compact-label">Sign out</span></button></>}</div></header>
    <main aria-busy={busy}>{error && <div role="alert" className="error">{error}</div>}
      {notice && <div role="status" className="notice">{notice}</div>}
      {!session ? <section><p>{error ? "Application services could not be reached." : "Connecting to application services..."}</p>
        <small>Capacity startup, when enabled, can take a few minutes.</small>
        {error && <div className="actions"><button disabled={busy} onClick={() => {
          setError(""); setBusy(true);
          void refresh().catch(e => setError(String(e.message))).finally(() => setBusy(false));
        }}>Retry connection</button></div>}</section> :
        !session.configured ? <section><h2>Local setup required</h2><p>The frontend and Node backend are running. No Azure resources have been created automatically.</p>
          <p>Run the documented local provisioning script, then apply database migrations and restart.
          Fabric SQL and credential-store configuration is stored outside this repository.</p><a href="/health/live">Check server liveness</a></section> :
        !session.identity ? <section className="welcome-card"><div className="empty-icon"><Icon name="workspace" /></div><h2>Welcome</h2><p>Sign in with Microsoft Entra to access your tenant.</p><a className="button" href="/auth/login">Sign in with Microsoft</a></section> :
        !session.bootstrapComplete ? <section><h2>Initial administration</h2>
          {session.canBootstrap ? <form onSubmit={event => { event.preventDefault();
            void run(() => api("/api/bootstrap", "POST", {}), "Initial administration configured."); }}>
            <p>This creates a platform administrator with no tenant membership or tenant content access.
              Tenant creation and tenant-admin assignment are separate steps.</p>
            <button disabled={busy}>Complete setup</button></form> : <p>Only the configured bootstrap operator may complete initial setup.</p>}</section> :
        !session.user ? <section><h2>Membership required</h2><p>Ask a tenant administrator to register your Entra object ID. Sign-in alone does not grant application access.</p></section> :
        activeTab === "platform" && session.user.IsPlatformAdmin ? <Platform version={version} run={run} busy={busy} namespace={session.resourceNamePrefix} /> :
        activeTab === "tenant" && session.user.IsTenantAdmin && session.user.TenantId ? <TenantManager tenantId={session.user.TenantId} version={version} run={run} busy={busy} /> :
        <Reports ref={reports} version={version} run={run} focused={focused} onFocusChange={setReportFocused} applicationActions={<>
          <h3>Application</h3>
          {session.user.IsTenantAdmin && <button onClick={() => void changeTab("tenant")}>Tenant admin</button>}
          {session.user.IsPlatformAdmin && <button onClick={() => void changeTab("platform")}>Platform admin</button>}
          <button onClick={() => void signOut()}>Sign out</button>
        </>} />}
    </main></div>;
}
type Run = (action: () => Promise<unknown>, message?: string) => Promise<void>;
function Platform({ version, run, busy, namespace }: { version: number; run: Run; busy: boolean; namespace: string }) {
  return <PlatformConsole version={version} run={run} busy={busy} namespace={namespace}
    administrators={(tenantId, disabled) => <TenantAdministrators key={tenantId} tenantId={tenantId} version={version} run={run} busy={disabled} />} />;
}
function TenantAdministrators({ tenantId, version, run, busy }: { tenantId: string; version: number; run: Run; busy: boolean }) {
  const [admins, setAdmins] = useState<{ Id: string; ObjectId: string; DisplayName: string }[]>([]);
  const [error, setError] = useState("");
  const [identityMode, setIdentityMode] = useState("upn");
  const base = `/api/admin/tenants/${tenantId}/admins`;
  useEffect(() => { setError(""); void api<typeof admins>(base).then(setAdmins).catch(e => setError(e.message)); }, [tenantId, version]);
  return <section><h2>Tenant administrators</h2>
    <p>Appoint an existing Entra identity or promote a member of this tenant. Users assigned to another tenant cannot be moved here.
      Additional administrators receive no automatic report permissions. Tenant content is managed in the separate Tenant admin view.</p>
    <p>Enter the user's exact Entra user principal name (sign-in name, not an email alias).
      The server looks up their object ID and display name. For guests, use their guest UPN in this directory.
      Manual object-ID assignment remains available if directory lookup is unavailable.</p>
    {error && <p className="error">{error}</p>}
    <label>Administrator lookup method<select value={identityMode} disabled={busy} onChange={event => setIdentityMode(event.target.value)}>
      <option value="upn">User principal name</option><option value="objectId">Entra object ID (manual)</option>
    </select></label>
    <form className="inline" onSubmit={event => {
      event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form);
      const identity = identityMode === "upn" ? { userPrincipalName: fields.get("userPrincipalName") } :
        { objectId: fields.get("objectId"), displayName: fields.get("displayName") };
      void run(async () => { await api(base, "POST", identity); form.reset(); },
        "Tenant administrator assigned. Report permissions are unchanged.");
    }}>{identityMode === "upn" ? <input name="userPrincipalName" type="email" aria-label="Administrator user principal name"
      placeholder="user@contoso.com" autoComplete="off" required maxLength={320} /> :
      <><input name="displayName" aria-label="Administrator display name" placeholder="Display name" required maxLength={200} />
        <input name="objectId" aria-label="Administrator Entra object ID" placeholder="Entra user object ID" required /></>}
      <button className="primary" disabled={busy}>Assign tenant administrator</button></form>
    <table><thead><tr><th>Administrator</th><th /></tr></thead><tbody>{admins.map(admin => <tr key={admin.Id}>
      <td>{admin.DisplayName}<small>{admin.ObjectId}</small></td><td><button className="danger" disabled={busy} onClick={() => {
        if (window.confirm(`Remove ${admin.DisplayName}'s tenant administrator role? Tenant membership and report permissions will remain unchanged.`))
          void run(() => api(`${base}/${admin.Id}`, "DELETE"), "Tenant administrator role removed.");
      }}>Remove administrator role</button></td></tr>)}</tbody></table>
  </section>;
}
function TenantManager({ tenantId, version, run, busy }: { tenantId: string; version: number; run: Run; busy: boolean }) {
  const [screen, setScreen] = useState("manage");
  return <>
    <nav className="platform-navigation" aria-label="Tenant administration">
      <button className={screen === "insights" ? "selected" : ""} aria-current={screen === "insights" ? "page" : undefined}
        disabled={busy} onClick={() => setScreen("insights")}>Insights</button>
      <button className={screen === "manage" ? "selected" : ""} aria-current={screen === "manage" ? "page" : undefined}
        disabled={busy} onClick={() => setScreen("manage")}>Users, content and access</button>
    </nav>
    {screen === "insights" ? <InsightsPage key={tenantId} tenantId={tenantId} version={version} /> :
      <TenantManagement tenantId={tenantId} version={version} run={run} busy={busy} />}
  </>;
}
function TenantManagement({ tenantId, version, run, busy }: { tenantId: string; version: number; run: Run; busy: boolean }) {
  const [data, setData] = useState<ManageData>();
  const [error, setError] = useState("");
  const [identityMode, setIdentityMode] = useState("upn");
  const [mask, setMask] = useState(1);
  const [grantMask, setGrantMask] = useState(0);
  const [nodeId, setNodeId] = useState("");
  const [userId, setUserId] = useState("");
  const [folderParentId, setFolderParentId] = useState("");
  useEffect(() => { void api<ManageData>(`/api/tenants/${tenantId}/manage`).then(setData).catch(e => setError(e.message)); }, [tenantId, version]);
  const base = `/api/tenants/${tenantId}`;
  const node = data?.nodes.find(n => n.Id === nodeId);
  const selectedUser = data?.users.find(u => u.Id === userId);
  useEffect(() => { setGrantMask(data?.grants.find(g => g.NodeId === nodeId && g.UserId === userId)?.Mask ?? 0); }, [nodeId, userId, data]);
  return <><section><div className="section-title"><h2>Content and publication</h2><button disabled={busy} onClick={() => void run(() => api(`${base}/sync`, "POST"), "Inventory synchronized. New items remain unreviewed.")}>Synchronize workspace</button></div>
    {error && <p className="error">{error}</p>}
    <p>Deploy reports and semantic models to this tenant's workspace using supported Power BI/Fabric publishing tools, then synchronize.
      General-purpose file upload is not yet implemented. You can also add the bundled sample below.
      Publication and user permissions are managed here; publishing does not grant view access.</p>
    <TenantSample tenantId={tenantId} version={version} run={run} busy={busy} />
    <table><thead><tr><th>Item</th><th>Type</th><th>Status</th><th /></tr></thead><tbody>{data?.content.map(c => <tr key={c.Id}>
      <td>{c.Name}</td><td>{c.Kind}</td><td>{c.RequiresIdentity ? "Requires future RLS support" : c.UnsafeDependency ? "Unsupported dependency" : c.Published ? "Published" : "Unreviewed"}</td>
      <td><button disabled={busy || c.RequiresIdentity || c.UnsafeDependency} onClick={() => void run(() =>
        api(`${base}/content/${c.Id}`, "PATCH", { published: !c.Published }))}>{c.Published ? "Unpublish" : "Publish"}</button></td>
    </tr>)}</tbody></table></section>
    <section><h2>Tenant users</h2><p>Register an existing Entra user by their exact sign-in UPN, not an email alias.
      The server resolves their object ID and display name. For guests, use their guest UPN in this directory.
      This does not create directory accounts or allow multiple tenant memberships.</p>
      <label>User lookup method<select value={identityMode} disabled={busy} onChange={event => setIdentityMode(event.target.value)}>
        <option value="upn">User principal name</option><option value="objectId">Entra object ID (manual)</option>
      </select></label>
      <form onSubmit={event => { event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form);
        const identity = identityMode === "upn" ? { userPrincipalName: fields.get("userPrincipalName") } :
          { objectId: fields.get("objectId"), displayName: fields.get("displayName") };
        void run(async () => { await api(`${base}/users`, "POST", { ...identity, permissions: mask }); form.reset(); }, "Tenant user registered.");
      }}><div className="inline">{identityMode === "upn" ? <input name="userPrincipalName" type="email"
        aria-label="User principal name" placeholder="user@contoso.com" autoComplete="off" required maxLength={320} /> :
        <><input name="displayName" aria-label="User display name" placeholder="Display name" required maxLength={200} />
          <input name="objectId" aria-label="Entra user object ID" placeholder="Entra user object ID" required /></>}</div>
        <PermissionPicker value={mask} onChange={setMask} /><button className="primary" disabled={busy}><Icon name="plus" />Register user</button></form>
      <table><thead><tr><th>User</th><th>Tenant administrator</th><th>Root permissions</th></tr></thead><tbody>{data?.users.map(u => <tr key={u.Id}><td>{u.DisplayName}<small>{u.ObjectId}</small></td>
        <td>{u.IsTenantAdmin ? "Yes" : <button disabled={busy} onClick={() => {
          if (window.confirm(`Appoint ${u.DisplayName} as an additional tenant administrator? They will gain user, content, access and usage administration. Report permissions remain unchanged.`))
            void run(() => api(`${base}/admins`, "POST", { userId: u.Id }), "Additional tenant administrator appointed. Report permissions are unchanged.");
        }}>Appoint administrator</button>}<small>Primary appointments and role removal remain platform-managed.</small></td>
        <td><PermissionPicker value={u.DefaultPermissions} onChange={value => void run(() => api(`${base}/users/${u.Id}`, "PATCH", { permissions: value }))} /></td></tr>)}</tbody></table>
    </section>
    <section><h2>Tenant navigation</h2>
      <p>One shared structure for this tenant. Labels, folders, and ordering apply to everyone.
        User permissions control report access, not a separate navigation layout.</p>
      <form className="inline" onSubmit={event => {
      event.preventDefault(); const fields = new FormData(event.currentTarget);
      void run(() => api(`${base}/folders`, "POST", { parentId: fields.get("parentId"), label: fields.get("label") }));
    }}><input name="label" aria-label="Folder label" placeholder="Folder label" required />
      <select name="parentId" aria-label="Parent folder" value={folderParentId || data?.nodes.find(n => !n.ParentId)?.Id || ""}
        onChange={event => setFolderParentId(event.target.value)}>
      {data?.nodes.filter(n => !n.ContentItemId).map(n => <option key={n.Id} value={n.Id}>{n.ParentId ? n.Label : "Top level"}</option>)}</select><button className="primary" disabled={busy}><Icon name="plus" />Add folder</button></form>
      <label>Navigation item<select value={nodeId} onChange={event => setNodeId(event.target.value)}><option value="">Select folder or report</option>
        {data?.nodes.filter(n => n.ParentId).map(n => <option key={n.Id} value={n.Id}>{n.Label}</option>)}</select></label>
      {node && <NodeEditor key={`${version}:${JSON.stringify(node)}`} node={node} nodes={data!.nodes} busy={busy} save={value => run(() => api(`${base}/nodes/${node.Id}`, "PATCH", value), "Shared navigation updated. Moving items can change inherited access.")} />}
    </section>
    <section><h2>Folder and report access</h2>
      {!node ? <p>Select a navigation item above to manage who can access it.</p> : <>
      <p>Permissions for <strong>{node.Label}</strong>. View Report allows a user to see reports.
        Folder grants apply to reports below that folder unless inheritance is broken.
        Reports must also be published before users can see them.</p>
      <label><input type="checkbox" checked={node.BreakInheritance} disabled={busy} onChange={event => {
        const breakInheritance = event.target.checked;
        if (window.confirm("Change permission inheritance for this item and its inheriting descendants? Existing direct grants will remain.")) void run(() =>
          api(`${base}/nodes/${node.Id}`, "PATCH", { label: node.Label, parentId: node.ParentId,
            sortOrder: node.SortOrder, breakInheritance }), "Permission inheritance updated.");
      }} />Use only direct grants here (stop inheriting tenant and parent permissions)</label>
      <label>User access<select value={userId} onChange={event => setUserId(event.target.value)}><option value="">Select user</option>
        {data?.users.map(u => <option key={u.Id} value={u.Id}>{u.DisplayName}</option>)}</select></label>
      {selectedUser && <><p>Direct grants for {selectedUser.DisplayName} on {node.Label}. These change access, not navigation.
        Tenant defaults and parent grants can also allow access unless inheritance is broken;
        clearing a direct grant does not remove inherited access.</p>
        <PermissionPicker value={grantMask} onChange={setGrantMask} /><button className="primary" disabled={busy} onClick={() => void run(() =>
          api(`${base}/grants`, "PUT", { nodeId, userId, permissions: grantMask }))}>Save user permissions</button></>}
      </>}
    </section></>;
}
function NodeEditor({ node, nodes, busy, save }: { node: NavNode; nodes: NavNode[]; busy: boolean; save: (value: unknown) => Promise<void> }) {
  return <form onSubmit={event => {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    if (window.confirm("Update the shared navigation for everyone in this tenant? Moving items can change inherited access.")) void save({
      label: fields.get("label"), parentId: node.ParentId ? fields.get("parentId") : null,
      breakInheritance: node.BreakInheritance, sortOrder: Number(fields.get("sortOrder")),
    });
  }}><div className="inline"><input name="label" aria-label="Navigation label" defaultValue={node.Label} required />
    {node.ParentId && <select name="parentId" aria-label="Move to folder" defaultValue={node.ParentId}>
      {nodes.filter(n => !n.ContentItemId && n.Id !== node.Id).map(n => <option key={n.Id} value={n.Id}>{n.ParentId ? n.Label : "Top level"}</option>)}</select>}
    <input type="number" aria-label="Sort order" name="sortOrder" defaultValue={node.SortOrder} min={0} max={10000} /></div>
    <button className="primary" disabled={busy}><Icon name="save" />Save navigation</button></form>;
}
createRoot(document.getElementById("root")!).render(<App />);
