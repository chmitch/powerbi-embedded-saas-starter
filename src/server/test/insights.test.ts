import { it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { insightWindow, Insights } from "../src/insights.js";
import { Database, type Params } from "../src/db.js";
import { Repository } from "../src/repository.js";
import { AuthService } from "../src/auth.js";
import { FabricService } from "../src/fabric.js";
import { AzureServices } from "../src/azure.js";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import type { User } from "../src/domain.js";
import type { PlatformInsights, TenantInsights, UserInsights } from "../../web/src/insight-types.js";
import { dailySeries, hourlySeries, insightPresets, lineSegments, presetWindow } from "../../web/src/insight-chart-data.js";

const tenantId = randomUUID(), otherTenant = randomUUID(), reportId = randomUUID(), userId = randomUUID();
const user: User = { Id: userId, TenantId: tenantId, DirectoryId: randomUUID(), ObjectId: randomUUID(),
  DisplayName: "Tenant operator", IsPlatformAdmin: false, IsTenantAdmin: true, DefaultPermissions: 0 };
const range = { from: "2026-11-01", to: "2026-11-23" };

it("defaults to a UTC week, accepts year/leap-year ranges and bounds custom dates, filters and pagination", () => {
  const w = insightWindow(range);
  assert.equal(w.start.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(w.until.toISOString(), "2026-11-24T00:00:00.000Z");
  assert.equal(insightWindow({}, new Date("2026-11-23T23:59:59Z")).from, "2026-11-17");
  assert.doesNotThrow(() => insightWindow({ from: "2026-01-01", to: "2026-12-31" }));
  assert.doesNotThrow(() => insightWindow({ from: "2024-01-01", to: "2024-12-31" }));
  for (const input of [{ from: "2026-02-30" }, { from: "2026-11-24", to: "2026-11-23" },
    { from: "2024-01-01", to: "2025-01-01" }, { userId, reportId }, { page: -1 }, { page: 1001 },
    { userId: "' OR 1=1" }, { tenantId: otherTenant }])
    assert.throws(() => insightWindow(input));
});

it("builds inclusive rolling presets across UTC year/leap boundaries that the backend accepts", () => {
  const now = new Date("2024-03-01T00:15:00Z");
  for (const preset of insightPresets) {
    const window = presetWindow(preset.value, now), validated = insightWindow(window);
    assert.equal(window.to, "2024-03-01");
    assert.equal((validated.until.getTime() - validated.start.getTime()) / 86_400_000, preset.days);
  }
  assert.equal(presetWindow("week", now).from, "2024-02-24");
  assert.equal(presetWindow("week", new Date("2026-01-01T00:15:00Z")).from, "2025-12-26");
});

it("zero-fills sparse usage charts but leaves missing duration averages as gaps, including zero-duration completions", () => {
  const window = { from: "2024-02-28", to: "2024-03-01" };
  const daily = dailySeries(window, [{ day: "2024-02-28", renders: 2, averageDurationMs: 1250 },
    { day: "2024-03-01", renders: 1, averageDurationMs: 0 }]);
  assert.deepEqual(daily.labels, ["2024-02-28", "2024-02-29", "2024-03-01"]);
  assert.deepEqual(daily.counts, [2, 0, 1]);
  assert.deepEqual(daily.averages, [1.25, null, 0]);
  const hourly = hourlySeries(window, [{ day: "2024-02-29", hour: 23, renders: 3 }]);
  assert.equal(hourly.labels.length, 72);
  assert.equal(hourly.labels[47], "2024-02-29 23:00");
  assert.equal(hourly.counts[47], 3);
  assert.equal(hourly.counts.reduce((sum, n) => sum + n, 0), 3);
  assert.equal(hourlySeries({ from: "2024-01-01", to: "2024-12-31" }, []).labels.length, 8784);
  assert.deepEqual(lineSegments([1, 0, null, 2, null], n => n, n => n),
    ["M0.00,1.00L1.00,0.00", "M3.00,2.00"]);
  assert.deepEqual(lineSegments([null, null], n => n, n => n), []);
});

it("denies wrong roles and cross-tenant insight requests before reading data, including dual-role cross-tenant access", async () => {
  let reads = 0;
  const insights = new Insights({ read: async () => { reads++; return []; } });
  await assert.rejects(insights.platform(user, range), { code: "PlatformAdminRequired" });
  for (const actor of [{ ...user, IsTenantAdmin: false }, { ...user, TenantId: null },
    { ...user, IsPlatformAdmin: true }])
    await assert.rejects(insights.tenant(actor, otherTenant, { ...range, userId }), { code: "TenantAdminRequired" });
  for (const filter of [{ userId }, { reportId }, { page: 1 }])
    await assert.rejects(insights.platform({ ...user, IsPlatformAdmin: true }, { ...range, ...filter }), { code: "AggregateInsightsOnly" });
  assert.equal(reads, 0);
});

it("returns platform aggregates without querying user/report identities or calling tenant infrastructure", async () => {
  const queries: string[] = [];
  const reader = { read: async <T>(text: string, params?: Params) => {
    queries.push(text);
    assert.doesNotMatch(text, /DisplayName|ReportName|ContentId|ObjectId|DirectoryId|DurationMs|ReportRequests/);
    if (text.includes("@start")) {
      assert.equal((params?.start as Date).toISOString(), "2026-11-01T00:00:00.000Z");
      assert.equal((params?.until as Date).toISOString(), "2026-11-24T00:00:00.000Z");
    }
    if (text.includes("AS tenants")) return [{ tenants: 2, users: 8, reports: 5 }] as T[];
    if (text.includes("FROM app.Tenants t")) return [{ tenantId, name: "Tenant", users: 3, reports: 2, renders: 9 }] as T[];
    return [{ tenantId, day: "2026-11-01", renders: 9 }] as T[];
  } };
  const result = await new Insights(reader).platform({ ...user, IsPlatformAdmin: true }, range) as unknown as PlatformInsights;
  assert.equal(result.totals.users, 8);
  assert.equal(result.tenants[0]!.renders, 9);
  assert.equal(result.daily[0]!.renders, 9);
  assert.equal(queries.length, 3);
});

it("scopes tenant summaries, historical report details and paginated user usage to the authorized tenant", async () => {
  const queries: string[] = [];
  const reader = { read: async <T>(text: string, params?: Params) => {
    queries.push(text);
    assert.equal(params?.tenantId, tenantId);
    if (text.includes("SELECT Name AS name FROM app.Tenants")) return [{ name: "Tenant" }] as T[];
    if (text.includes("TOP(1) name")) return [{ name: "Historical record" }] as T[];
    if (text.includes("AS users,")) return [{ users: 2, reports: 3, renders: 4 }] as T[];
    if (text.includes("FETCH NEXT")) {
      assert.equal(params?.userId, userId); assert.equal(params?.offset, 50);
      assert.match(text, /q\.TenantId=@tenantId AND q\.UserId=@userId/);
      assert.match(text, /r\.TenantId=@tenantId AND r\.UserId=@userId/);
      assert.match(text, /NOT EXISTS/);
      return Array.from({ length: 51 }, (_, n) => ({ id: String(n), status: n ? "Failed" : "Rendered" })) as T[];
    }
    if (text.includes("AS reportId")) {
      assert.equal(params?.userId, userId);
      return [{ reportId, name: "Report", renders: 3, averageDurationMs: 2000 }] as T[];
    }
    if (text.includes("@reportId")) {
      assert.equal(params?.reportId, reportId);
      assert.match(text, /TenantId=@tenantId AND ContentId=@reportId/);
    }
    return [] as T[];
  } };
  const service = new Insights(reader);
  const summary = await service.tenant(user, tenantId, range) as unknown as TenantInsights;
  assert.equal(summary.totals.reports, 3);
  assert.equal(summary.directoryLimited, false);
  await service.tenant(user, tenantId, { ...range, reportId });
  const details = await service.tenant(user, tenantId, { ...range, userId, page: 1 }) as unknown as UserInsights;
  assert.equal(details.user.name, "Historical record");
  assert.equal(details.history.length, 50); assert.equal(details.hasMore, true);
  assert.equal(details.usage[0]!.renders, 3);
  assert.ok(queries.length > 10);
  await assert.rejects(new Insights({ read: async () => [] }).tenant(user, tenantId, { ...range, reportId }), { code: "NotFound" });
});

it("protects HTTP insight endpoints and allows dual-role own-tenant details without contacting Fabric or ARM", async context => {
  const actor = { ...user, IsPlatformAdmin: true, IsTenantAdmin: false };
  context.mock.method(AuthService.prototype, "callback", async req => {
    req.session.identity = { objectId: actor.ObjectId, directoryId: actor.DirectoryId, name: actor.DisplayName, username: "test@example.test" };
  });
  context.mock.method(Repository.prototype, "user", async () => actor);
  context.mock.method(FabricService.prototype, "sync", async () => { assert.fail("Insights must not synchronize Fabric"); });
  context.mock.method(AzureServices.prototype, "capacity", async () => { assert.fail("Insights must not query ARM"); });
  let reads = 0;
  context.mock.method(Database.prototype, "read", async (text, params) => {
    reads++;
    if (text.includes("AS tenants")) return [{ tenants: 1, users: 2, reports: 1 }];
    if (text.includes("SELECT Name AS name FROM app.Tenants")) {
      assert.equal(params?.tenantId, tenantId); return [{ name: "Own tenant" }];
    }
    if (text.includes("TOP(1) name")) { assert.equal(params?.userId, userId); return [{ name: "Own user" }]; }
    return [];
  });
  const { app, db } = await createApp({ ...config, DirectoryTenantId: "", WebClientId: "", SqlServer: "",
    SqlDatabase: "", BootstrapObjectId: "", KeyVaultUri: "", LocalSecretsPath: "" });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ["/api/admin/insights", `/api/tenants/${tenantId}/insights`])
      assert.equal((await fetch(base + path)).status, 401);
    const login = await fetch(`${base}/auth/callback`, { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const get = (path: string) => fetch(base + path, { headers: { Cookie: cookie } });
    const response = await get("/api/admin/insights");
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const before = reads;
    assert.equal((await get(`/api/tenants/${tenantId}/insights?userId=${userId}`)).status, 403);
    assert.equal((await get(`/api/admin/insights?userId=${userId}`)).status, 400);
    assert.equal(reads, before);
    actor.IsTenantAdmin = true;
    assert.equal((await get(`/api/tenants/${tenantId}/insights?userId=${userId}`)).status, 200);
    assert.equal((await get(`/api/tenants/${otherTenant}/insights?userId=${userId}`)).status, 403);
    actor.IsPlatformAdmin = false;
    assert.equal((await get("/api/admin/insights")).status, 403);
    actor.IsTenantAdmin = false;
    assert.equal((await get(`/api/tenants/${tenantId}/insights`)).status, 403);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); }
});
