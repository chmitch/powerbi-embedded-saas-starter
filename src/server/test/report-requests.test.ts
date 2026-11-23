import { it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ReportRequests } from "../src/report-requests.js";
import { ReportRenders } from "../src/report-renders.js";
import type { Repository } from "../src/repository.js";
import type { Executor, Params } from "../src/db.js";
import type { User } from "../src/domain.js";

function fixture() {
  const user = { Id: randomUUID(), TenantId: randomUUID(), DirectoryId: randomUUID(), ObjectId: randomUUID(),
    DisplayName: "User" } as User;
  const report = { Id: randomUUID(), ExternalId: randomUUID(), Name: "Report", Kind: "Report" };
  const requests = new Map<string, Params>(), renders = new Map<string, Params>();
  const tx: Executor = { query: async <T>(text: string, params: Params = {}) => {
    const key = String(params.id);
    if (text.startsWith("SELECT") && text.includes("app.ReportRequests")) {
      const row = requests.get(key);
      return (row ? [{ UserId: row.userId, TenantId: row.tenantId, ContentId: row.contentId,
        Mode: row.mode, RequestedAt: row.requestedAt, ServerReceivedAt: row.receivedAt, RenderId: row.renderId }] : []) as T[];
    }
    if (text.startsWith("INSERT app.ReportRequests")) {
      assert.equal(requests.has(key), false);
      requests.set(key, { ...params, status: "Requested" }); return [];
    }
    if (text.startsWith("UPDATE app.ReportRequests")) {
      const row = requests.get(String(params.requestId ?? params.id));
      if (row && row.tenantId === params.tenantId && row.userId === params.userId) {
        if (params.renderId) { row.status = "Rendered"; row.renderId = params.renderId; }
        else if (row.status !== "Rendered") row.status = params.status;
      }
      return [];
    }
    if (text.startsWith("SELECT") && text.includes("app.ReportRenders")) {
      const row = renders.get(key);
      return (row ? [{ UserId: row.userId, TenantId: row.tenantId }] : []) as T[];
    }
    assert.ok(text.startsWith("INSERT app.ReportRenders"));
    renders.set(key, params); return [];
  } };
  let queue: Promise<unknown> = Promise.resolve();
  const workspaceId = randomUUID();
  const repo = { content: async () => [report], tenant: async () => ({ WorkspaceId: workspaceId }),
    db: { query: tx.query, transaction: <T>(work: (tx: Executor) => Promise<T>) => {
      const promise = queue.then(() => work(tx)); queue = promise.catch(() => undefined); return promise;
    } } } as unknown as Repository;
  const now = new Date();
  return { user, report, requests, renders, repo, now, service: new ReportRequests(repo),
    renderService: new ReportRenders(repo, "test-only-signing-key") };
}

it("keeps failed and unconfirmed attempts, binds identity/report context, and reuses the original request time/nonce across recovery", async () => {
  const f = fixture(), id = randomUUID(), at = f.now.toISOString();
  const start = () => f.service.start(f.user, id, f.report.Id, "view", at, f.now);
  const [first, duplicate] = await Promise.all([start(), start()]);
  assert.equal(first.renderId, duplicate.renderId); assert.equal(f.requests.size, 1);
  assert.equal(f.requests.get(id)!.status, "Requested");
  await f.service.outcome(f.user, id, "Failed");
  assert.equal(f.requests.get(id)!.status, "Failed");
  const recovery = await f.service.start(f.user, id, f.report.Id, "view", at, new Date(f.now.getTime() + 1000));
  assert.equal(recovery.receivedAt.getTime(), f.now.getTime()); assert.equal(recovery.renderId, first.renderId);
  await f.service.outcome(f.user, id, "Authorized");
  assert.equal(f.requests.get(id)!.status, "Authorized");
  for (const actor of [{ ...f.user, Id: randomUUID() }, { ...f.user, TenantId: randomUUID() }])
    await assert.rejects(f.service.start(actor, id, f.report.Id, "view", at, f.now), { code: "RequestContextChanged" });
  await assert.rejects(f.service.start(f.user, id, f.report.Id, "edit", at, f.now), { code: "RequestContextChanged" });
  await assert.rejects(f.service.start(f.user, randomUUID(), randomUUID(), "view", at, f.now), { code: "NotFound" });
  assert.equal(f.requests.size, 1);
});

it("links completion to the original attempt and prevents duplicate render rows even when an embed response was lost", async () => {
  const f = fixture(), id = randomUUID(), at = f.now.toISOString();
  const context = await f.service.start(f.user, id, f.report.Id, "view", at, f.now);
  const receipts = await Promise.all([1, 2].map(() => f.renderService.issue(f.user, f.report.Id, f.report.ExternalId,
    "view", at, context.receivedAt, undefined, id, context.renderId)));
  await f.renderService.record(f.user, receipts[0]!, 5000);
  await f.renderService.record(f.user, receipts[1]!, 9999);
  assert.equal(f.renders.size, 1); assert.equal(f.renders.get(context.renderId)!.durationMs, 5000);
  assert.equal(f.requests.get(id)!.status, "Rendered");
  await f.service.outcome(f.user, id, "Failed");
  assert.equal(f.requests.get(id)!.status, "Rendered");
});
