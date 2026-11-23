import { randomUUID } from "node:crypto";
import { it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { ReportRenders } from "../src/report-renders.js";
import { Repository } from "../src/repository.js";
import type { Params, Executor } from "../src/db.js";
import type { User, Tenant, ContentItem } from "../src/domain.js";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { AuthService } from "../src/auth.js";
import { FabricService } from "../src/fabric.js";
import { AppError } from "../src/errors.js";

function fixture() {
  const user = { Id: randomUUID(), TenantId: randomUUID(), DirectoryId: randomUUID(), ObjectId: randomUUID(),
    DisplayName: "Fixture viewer", IsPlatformAdmin: false, IsTenantAdmin: false, DefaultPermissions: 1 } as User;
  const tenant = { Id: user.TenantId!, WorkspaceId: randomUUID() } as Tenant;
  const report = { Id: randomUUID(), TenantId: tenant.Id, ExternalId: randomUUID(), Kind: "Report", Name: "Fixture report" } as ContentItem;
  const rows = new Map<string, Params>();
  let clock = new Date("2026-11-23T16:00:00Z"), queue: Promise<unknown> = Promise.resolve();
  const tx: Executor = { query: async <T>(sql: string, params: Params = {}) => {
    if (sql.startsWith("SELECT")) {
      const row = rows.get(String(params.id));
      return (row ? [{ UserId: row.userId, TenantId: row.tenantId }] : []) as T[];
    }
    assert.ok(sql.startsWith("INSERT app.ReportRenders"));
    assert.ok(!rows.has(String(params.id)));
    rows.set(String(params.id), structuredClone(params)); return [];
  } };
  const repo = { tenant: async () => tenant, content: async () => [report], db: {
    transaction: <T>(work: (tx: Executor) => Promise<T>) => {
      const result = queue.then(() => work(tx)); queue = result.catch(() => undefined); return result;
    },
  } } as unknown as Repository;
  const service = new ReportRenders(repo, "fixture-only-render-signing-key", () => clock);
  const requestedAt = new Date(clock.getTime() - 50).toISOString();
  return { service, user, tenant, report, rows, requestedAt, repo,
    issue: () => service.issue(user, report.Id, report.ExternalId, "view", requestedAt, new Date(requestedAt)),
    clock: (value: Date) => { clock = value; } };
}

it("records authorized identity/report snapshots, request and completion times, and full elapsed milliseconds exactly once", async () => {
  const f = fixture(), receipt = await f.issue();
  const results = await Promise.all([f.service.record(f.user, receipt, 8450), f.service.record(f.user, receipt, 8450)]);
  assert.deepEqual(results.map(result => result.duplicate), [false, true]);
  await f.service.record(f.user, receipt, 9999);
  assert.equal(f.rows.size, 1);
  const row = [...f.rows.values()][0]!;
  assert.equal(row.userId, f.user.Id); assert.equal(row.tenantId, f.tenant.Id);
  assert.equal(row.objectId, f.user.ObjectId); assert.equal(row.directoryId, f.user.DirectoryId);
  assert.equal(row.contentId, f.report.Id); assert.equal(row.reportId, f.report.ExternalId);
  assert.equal(row.workspaceId, f.tenant.WorkspaceId); assert.equal(row.reportName, f.report.Name);
  assert.equal(row.durationMs, 8450);
  assert.equal((row.requestedAt as Date).toISOString(), f.requestedAt);
  assert.equal((row.renderedAt as Date).getTime() - (row.requestedAt as Date).getTime(), 8450);
});

it("preserves the original request through capacity recovery and rejects altered retry context", async () => {
  const f = fixture(), original = await f.issue(), later = new Date("2026-11-23T16:03:00Z");
  f.clock(later);
  assert.equal(await f.service.issue(f.user, f.report.Id, f.report.ExternalId, "view", f.requestedAt, later, original), original);
  await assert.rejects(f.service.issue(f.user, f.report.Id, f.report.ExternalId, "edit", f.requestedAt, later, original),
    { code: "RenderContextChanged" });
  await f.service.record(f.user, original, 180050);
  assert.equal([...f.rows.values()][0]!.durationMs, 180050);
  assert.equal((([...f.rows.values()][0]!.serverReceivedAt) as Date).toISOString(), f.requestedAt);
});

it("rejects forged receipts, other users/tenants, expired receipts and invalid measurements without writing rows", async () => {
  const f = fixture(), receipt = await f.issue();
  const [payload, signature] = receipt.split(".");
  const altered = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")); altered.userId = randomUUID();
  await assert.rejects(f.service.record(f.user, `${Buffer.from(JSON.stringify(altered)).toString("base64url")}.${signature}`, 10),
    { code: "InvalidRenderReceipt" });
  await assert.rejects(f.service.record({ ...f.user, Id: randomUUID() }, receipt, 10), { code: "RenderReceiptForbidden" });
  await assert.rejects(f.service.record({ ...f.user, TenantId: randomUUID() }, receipt, 10), { code: "RenderReceiptForbidden" });
  for (const duration of [-1, 0.1, NaN, 86_400_001])
    await assert.rejects(f.service.record(f.user, receipt, duration), { code: "InvalidRenderDuration" });
  f.clock(new Date("2026-11-25T16:00:00Z"));
  await assert.rejects(f.service.record(f.user, receipt, 10), { code: "RenderReceiptExpired" });
  assert.equal(f.rows.size, 0);
});

it("ties render issuance to successful embed authorization and protects completion with sign-in, CSRF and strict input", async context => {
  const f = fixture();
  let authorized = false, issues = 0, records = 0, trackingUnavailable = false;
  context.mock.method(AuthService.prototype, "callback", async req => {
    req.session.identity = { objectId: f.user.ObjectId, directoryId: f.user.DirectoryId, name: f.user.DisplayName, username: "fixture@example.test" };
  });
  context.mock.method(Repository.prototype, "user", async () => f.user);
  context.mock.method(Repository.prototype, "audit", async () => []);
  context.mock.method(FabricService.prototype, "embed", async () => {
    if (!authorized) throw new AppError(403, "Forbidden", "Report access denied.");
    return { id: f.report.ExternalId, accessToken: "fixture-only-token" };
  });
  context.mock.method(ReportRenders.prototype, "issue", async (...args) => {
    issues++;
    assert.equal(args[0], f.user); assert.equal(args[1], f.report.Id);
    if (trackingUnavailable) throw new Error("Storage unavailable");
    return "fixture-receipt";
  });
  context.mock.method(ReportRenders.prototype, "record", async (user, receipt, duration) => {
    records++; assert.equal(user, f.user); assert.equal(receipt, "fixture-receipt"); assert.equal(duration, 1234);
    return { recorded: true, duplicate: false };
  });
  const { app, db } = await createApp({ ...config, DirectoryTenantId: "", WebClientId: "", SqlServer: "",
    SqlDatabase: "", BootstrapObjectId: "", KeyVaultUri: "", LocalSecretsPath: "" });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/telemetry/report-rendered`)).status, 401);
    const login = await fetch(`${base}/auth/callback`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json() as { csrf: string };
    const headers = { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": session.csrf };
    const post = (route: string, body: unknown, csrf = true) => fetch(`${base}${route}`, { method: "POST",
      headers: csrf ? headers : { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const embed = { contentId: f.report.Id, render: { requestedAt: new Date().toISOString() } };
    assert.equal((await post("/api/embed/report", embed)).status, 403); assert.equal(issues, 0);
    authorized = true;
    assert.equal((await post("/api/embed/report", { contentId: f.report.Id })).status, 200); assert.equal(issues, 0);
    assert.equal((await post("/api/embed/report", { ...embed,
      render: { requestedAt: `2026-11-23T16:00:00.${"0".repeat(40)}Z` } })).status, 400);
    assert.equal(issues, 0);
    const embedded = await (await post("/api/embed/report", embed)).json() as { renderReceipt: string };
    assert.equal(embedded.renderReceipt, "fixture-receipt"); assert.equal(issues, 1);
    const completion = { receipt: embedded.renderReceipt, durationMs: 1234 };
    assert.equal((await post("/api/telemetry/report-rendered", completion, false)).status, 403);
    for (const body of [{ ...completion, userId: f.user.Id }, { ...completion, tenantId: f.tenant.Id },
      { ...completion, durationMs: -1 }, { ...completion, durationMs: 1.5 }, { ...completion, durationMs: 86_400_001 }])
      assert.equal((await post("/api/telemetry/report-rendered", body)).status, 400);
    assert.equal(records, 0);
    assert.equal((await post("/api/telemetry/report-rendered", completion)).status, 201); assert.equal(records, 1);
    trackingUnavailable = true;
    const degraded = await post("/api/embed/report", embed);
    assert.equal(degraded.status, 200);
    assert.equal((await degraded.json() as { renderTrackingUnavailable: boolean }).renderTrackingUnavailable, true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});
