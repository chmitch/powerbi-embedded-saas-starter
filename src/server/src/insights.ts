import { z } from "zod";
import type { Database } from "./db.js";
import { sameId, type User } from "./domain.js";
import { requireCondition } from "./errors.js";

const day = 86_400_000;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, "Use a valid UTC date.");
const query = z.object({
  from: date.optional(), to: date.optional(),
  reportId: z.uuid().optional(), userId: z.uuid().optional(),
  page: z.coerce.number().int().min(0).max(1000).default(0),
}).strict();

export function insightWindow(input: unknown, now = new Date()) {
  const parsed = query.parse(input);
  const to = parsed.to ?? now.toISOString().slice(0, 10);
  const until = new Date(Date.parse(to) + day);
  const from = parsed.from ?? new Date(until.getTime() - 7 * day).toISOString().slice(0, 10);
  const start = new Date(from);
  requireCondition(until > start && until.getTime() - start.getTime() <= 366 * day,
    400, "InvalidInsightRange", "Select an inclusive UTC date range of 1 to 366 days.");
  requireCondition(!(parsed.reportId && parsed.userId), 400, "InvalidInsightFilter", "Select a report or a user, not both.");
  return { ...parsed, from, to, start, until };
}
type Window = ReturnType<typeof insightWindow>;
const windowDto = (w: Window) => ({ from: w.from, to: w.to });

export class Insights {
  constructor(private db: Pick<Database, "read">) {}

  async platform(user: User, input: unknown) {
    requireCondition(user.IsPlatformAdmin, 403, "PlatformAdminRequired", "Platform administrator permission is required.");
    const w = insightWindow(input);
    requireCondition(!w.reportId && !w.userId && w.page === 0, 400, "AggregateInsightsOnly",
      "Platform insights provide tenant aggregates only.");
    const params = { start: w.start, until: w.until };
    const [totals, tenants, daily] = await Promise.all([
      this.db.read(`SELECT (SELECT COUNT(*) FROM app.Tenants) AS tenants,
        (SELECT COUNT(*) FROM app.Users) AS users,
        (SELECT COUNT(*) FROM app.Content WHERE Kind='Report' AND Deleted=0) AS reports`),
      this.db.read(`SELECT t.Id AS tenantId,t.Name AS name,
        (SELECT COUNT(*) FROM app.Users u WHERE u.TenantId=t.Id) AS users,
        (SELECT COUNT(*) FROM app.Content c WHERE c.TenantId=t.Id AND c.Kind='Report' AND c.Deleted=0) AS reports,
        (SELECT COUNT(*) FROM app.ReportRenders r WHERE r.TenantId=t.Id AND r.ServerReceivedAt>=@start AND r.ServerReceivedAt<@until) AS renders
        FROM app.Tenants t ORDER BY t.Name,t.Id`, params),
      this.db.read(`SELECT TenantId AS tenantId,CONVERT(char(10),ServerReceivedAt,23) AS day,COUNT(*) AS renders
        FROM app.ReportRenders WHERE ServerReceivedAt>=@start AND ServerReceivedAt<@until
        GROUP BY TenantId,CONVERT(char(10),ServerReceivedAt,23) ORDER BY day,TenantId`, params),
    ]);
    return { window: windowDto(w), totals: totals[0], tenants, daily };
  }

  async tenant(user: User, tenantId: string, input: unknown) {
    requireCondition(user.IsTenantAdmin && sameId(user.TenantId, tenantId), 403, "TenantAdminRequired",
      "An explicit administrator role in this tenant is required. Platform administration grants no usage details.");
    const w = insightWindow(input), params = { tenantId, start: w.start, until: w.until,
      reportId: w.reportId ?? null, userId: w.userId ?? null, offset: w.page * 50 };
    const [tenant] = await this.db.read<{ name: string }>("SELECT Name AS name FROM app.Tenants WHERE Id=@tenantId", { tenantId });
    requireCondition(tenant, 404, "NotFound", "Tenant not found.");
    if (w.reportId) return this.report(w, params);
    if (w.userId) return this.user(w, params);
    const [totals, daily, users, reports] = await Promise.all([
      this.db.read(`SELECT
        (SELECT COUNT(*) FROM app.Users WHERE TenantId=@tenantId) AS users,
        (SELECT COUNT(*) FROM app.Content WHERE TenantId=@tenantId AND Kind='Report' AND Deleted=0) AS reports,
        (SELECT COUNT(*) FROM app.ReportRenders WHERE TenantId=@tenantId AND ServerReceivedAt>=@start AND ServerReceivedAt<@until) AS renders`, params),
      this.db.read(`SELECT CONVERT(char(10),ServerReceivedAt,23) AS day,COUNT(*) AS renders
        FROM app.ReportRenders WHERE TenantId=@tenantId AND ServerReceivedAt>=@start AND ServerReceivedAt<@until
        GROUP BY CONVERT(char(10),ServerReceivedAt,23) ORDER BY day`, params),
      this.db.read(`SELECT TOP(501) s.Id AS id,COALESCE(MAX(u.DisplayName),MAX(s.Name)) AS name FROM (
        SELECT Id,DisplayName AS Name FROM app.Users WHERE TenantId=@tenantId
        UNION ALL SELECT UserId,UserDisplayName FROM app.ReportRenders
          WHERE TenantId=@tenantId AND ServerReceivedAt>=@start AND ServerReceivedAt<@until
        UNION ALL SELECT UserId,UserDisplayName FROM app.ReportRequests
          WHERE TenantId=@tenantId AND ServerReceivedAt>=@start AND ServerReceivedAt<@until
        ) s LEFT JOIN app.Users u ON u.TenantId=@tenantId AND u.Id=s.Id GROUP BY s.Id ORDER BY name,s.Id`, params),
      this.db.read(`SELECT TOP(501) s.Id AS id,COALESCE(MAX(c.Name),MAX(s.Name)) AS name FROM (
        SELECT Id,Name FROM app.Content WHERE TenantId=@tenantId AND Kind='Report' AND Deleted=0
        UNION ALL SELECT ContentId,ReportName FROM app.ReportRenders
          WHERE TenantId=@tenantId AND ServerReceivedAt>=@start AND ServerReceivedAt<@until
        UNION ALL SELECT ContentId,ReportName FROM app.ReportRequests
          WHERE TenantId=@tenantId AND ServerReceivedAt>=@start AND ServerReceivedAt<@until
        ) s LEFT JOIN app.Content c ON c.TenantId=@tenantId AND c.Id=s.Id AND c.Kind='Report'
          GROUP BY s.Id ORDER BY name,s.Id`, params),
    ]);
    return { window: windowDto(w), name: tenant.name, totals: totals[0], daily,
      users: users.slice(0, 500), reports: reports.slice(0, 500), directoryLimited: users.length > 500 || reports.length > 500 };
  }

  private async report(w: Window, params: { tenantId: string; reportId: string | null; start: Date; until: Date }) {
    const [report] = await this.db.read(`SELECT TOP(1) name FROM (
      SELECT Name AS name,0 AS priority FROM app.Content WHERE TenantId=@tenantId AND Id=@reportId AND Kind='Report'
      UNION ALL SELECT ReportName,1 FROM app.ReportRenders WHERE TenantId=@tenantId AND ContentId=@reportId
      UNION ALL SELECT ReportName,1 FROM app.ReportRequests WHERE TenantId=@tenantId AND ContentId=@reportId
      ) s ORDER BY priority,name`, params);
    requireCondition(report, 404, "NotFound", "Report not found in this tenant.");
    const [hourly, daily] = await Promise.all([
      this.db.read(`SELECT CONVERT(char(10),ServerReceivedAt,23) AS day,DATEPART(hour,ServerReceivedAt) AS hour,
        COUNT(*) AS renders FROM app.ReportRenders
        WHERE TenantId=@tenantId AND ContentId=@reportId AND ServerReceivedAt>=@start AND ServerReceivedAt<@until
        GROUP BY CONVERT(char(10),ServerReceivedAt,23),DATEPART(hour,ServerReceivedAt) ORDER BY day,hour`, params),
      this.db.read(`SELECT CONVERT(char(10),ServerReceivedAt,23) AS day,COUNT(*) AS renders,
        AVG(CONVERT(float,DurationMs)) AS averageDurationMs FROM app.ReportRenders
        WHERE TenantId=@tenantId AND ContentId=@reportId AND ServerReceivedAt>=@start AND ServerReceivedAt<@until
        GROUP BY CONVERT(char(10),ServerReceivedAt,23) ORDER BY day`, params),
    ]);
    return { window: windowDto(w), report, hourly, daily };
  }

  private async user(w: Window, params: { tenantId: string; userId: string | null; start: Date; until: Date; offset: number }) {
    const [user] = await this.db.read(`SELECT TOP(1) name FROM (
      SELECT DisplayName AS name,0 AS priority FROM app.Users WHERE TenantId=@tenantId AND Id=@userId
      UNION ALL SELECT UserDisplayName,1 FROM app.ReportRenders WHERE TenantId=@tenantId AND UserId=@userId
      UNION ALL SELECT UserDisplayName,1 FROM app.ReportRequests WHERE TenantId=@tenantId AND UserId=@userId
      ) s ORDER BY priority,name`, params);
    requireCondition(user, 404, "NotFound", "User not found in this tenant.");
    const [usage, history] = await Promise.all([
      this.db.read(`SELECT TOP(501) ContentId AS reportId,MAX(ReportName) AS name,COUNT(*) AS renders,
        AVG(CONVERT(float,DurationMs)) AS averageDurationMs FROM app.ReportRenders
        WHERE TenantId=@tenantId AND UserId=@userId AND ServerReceivedAt>=@start AND ServerReceivedAt<@until
        GROUP BY ContentId ORDER BY renders DESC,ContentId`, params),
      this.db.read(`SELECT * FROM (
        SELECT q.Id AS id,q.ContentId AS reportId,q.ReportName AS reportName,q.RequestedAt AS requestedAt,
          q.ServerReceivedAt AS receivedAt,q.Mode AS mode,q.Status AS status,r.DurationMs AS durationMs
        FROM app.ReportRequests q LEFT JOIN app.ReportRenders r
          ON r.Id=q.RenderId AND r.TenantId=q.TenantId AND r.UserId=q.UserId AND r.ContentId=q.ContentId
        WHERE q.TenantId=@tenantId AND q.UserId=@userId AND q.ServerReceivedAt>=@start AND q.ServerReceivedAt<@until
        UNION ALL
        SELECT r.Id,r.ContentId,r.ReportName,r.RequestedAt,r.ServerReceivedAt,r.Mode,'Rendered',r.DurationMs
        FROM app.ReportRenders r WHERE r.TenantId=@tenantId AND r.UserId=@userId
          AND r.ServerReceivedAt>=@start AND r.ServerReceivedAt<@until
          AND NOT EXISTS(SELECT 1 FROM app.ReportRequests q WHERE q.RenderId=r.Id AND q.TenantId=r.TenantId AND q.UserId=r.UserId)
        ) h ORDER BY receivedAt DESC,id DESC OFFSET @offset ROWS FETCH NEXT 51 ROWS ONLY`, params),
    ]);
    return { window: windowDto(w), user, usage: usage.slice(0, 500), usageLimited: usage.length > 500,
      history: history.slice(0, 50), hasMore: history.length > 50, page: w.page };
  }
}
