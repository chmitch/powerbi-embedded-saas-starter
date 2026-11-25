import { z } from "zod";
import type { Database } from "./db.js";
import { sameId, type User } from "./domain.js";
import { requireCondition } from "./errors.js";
import type { TenantAnalytics } from "./analytics-security.js";

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
  constructor(private db: Pick<Database, "read">, private analytics?: Pick<TenantAnalytics, "withTenant">) {}

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
    const w = insightWindow(input), params = { start: w.start, until: w.until,
      reportId: w.reportId ?? null, userId: w.userId ?? null, offset: w.page * 50 };
    requireCondition(this.analytics, 409, "AnalyticsNotConfigured",
      "Tenant Insights requires the tenant-principal analytics connection; shared database reads are not a fallback.");
    return this.analytics.withTenant(tenantId, async reader => {
      const tenants = await reader.read<{ tenantId: string; name: string }>(
        "SELECT TenantId AS tenantId,Name AS name FROM analytics.Tenants");
      requireCondition(tenants.length > 0, 503, "AnalyticsReplicationPending",
        "Own tenant is not visible in analytics yet. Check RLS and replication.");
      requireCondition(tenants.length === 1 && sameId(tenants[0]!.tenantId, tenantId), 409, "AnalyticsIsolationFailed",
        "The analytics connection exposed an unexpected tenant.");
      if (w.reportId) return this.report(reader, w, params);
      if (w.userId) return this.user(reader, w, params);
      const [totals, daily, users, reports] = await Promise.all([
        reader.read(`SELECT
          (SELECT COUNT(*) FROM analytics.Users) AS users,
          (SELECT COUNT(*) FROM analytics.Reports WHERE Deleted=0) AS reports,
          (SELECT COUNT(*) FROM analytics.Renders WHERE ServerReceivedAt>=@start AND ServerReceivedAt<@until) AS renders`, params),
        reader.read(`SELECT CONVERT(char(10),ServerReceivedAt,23) AS day,COUNT(*) AS renders
          FROM analytics.Renders WHERE ServerReceivedAt>=@start AND ServerReceivedAt<@until
          GROUP BY CONVERT(char(10),ServerReceivedAt,23) ORDER BY day`, params),
        reader.read(`SELECT TOP(501) s.Id AS id,COALESCE(MAX(u.DisplayName),MAX(s.Name)) AS name FROM (
          SELECT UserId AS Id,DisplayName AS Name FROM analytics.Users
          UNION ALL SELECT UserId,UserDisplayName FROM analytics.Renders
            WHERE ServerReceivedAt>=@start AND ServerReceivedAt<@until
          UNION ALL SELECT UserId,UserDisplayName FROM analytics.Requests
            WHERE ServerReceivedAt>=@start AND ServerReceivedAt<@until
          ) s LEFT JOIN analytics.Users u ON u.UserId=s.Id GROUP BY s.Id ORDER BY name,s.Id`, params),
        reader.read(`SELECT TOP(501) s.Id AS id,COALESCE(MAX(c.Name),MAX(s.Name)) AS name FROM (
          SELECT ReportId AS Id,Name FROM analytics.Reports WHERE Deleted=0
          UNION ALL SELECT ReportId,ReportName FROM analytics.Renders
            WHERE ServerReceivedAt>=@start AND ServerReceivedAt<@until
          UNION ALL SELECT ReportId,ReportName FROM analytics.Requests
            WHERE ServerReceivedAt>=@start AND ServerReceivedAt<@until
          ) s LEFT JOIN analytics.Reports c ON c.ReportId=s.Id GROUP BY s.Id ORDER BY name,s.Id`, params),
      ]);
      return { window: windowDto(w), name: tenants[0]!.name, totals: totals[0], daily,
        users: users.slice(0, 500), reports: reports.slice(0, 500), directoryLimited: users.length > 500 || reports.length > 500 };
    });
  }

  private async report(reader: Pick<Database, "read">, w: Window, params: { reportId: string | null; start: Date; until: Date }) {
    const [report] = await reader.read(`SELECT TOP(1) name FROM (
      SELECT Name AS name,0 AS priority FROM analytics.Reports WHERE ReportId=@reportId
      UNION ALL SELECT ReportName,1 FROM analytics.Renders WHERE ReportId=@reportId
      UNION ALL SELECT ReportName,1 FROM analytics.Requests WHERE ReportId=@reportId
      ) s ORDER BY priority,name`, params);
    requireCondition(report, 404, "NotFound", "Report not found in this tenant.");
    const [hourly, daily] = await Promise.all([
      reader.read(`SELECT CONVERT(char(10),ServerReceivedAt,23) AS day,DATEPART(hour,ServerReceivedAt) AS hour,
        COUNT(*) AS renders FROM analytics.Renders
        WHERE ReportId=@reportId AND ServerReceivedAt>=@start AND ServerReceivedAt<@until
        GROUP BY CONVERT(char(10),ServerReceivedAt,23),DATEPART(hour,ServerReceivedAt) ORDER BY day,hour`, params),
      reader.read(`SELECT CONVERT(char(10),ServerReceivedAt,23) AS day,COUNT(*) AS renders,
        AVG(CONVERT(float,DurationMs)) AS averageDurationMs FROM analytics.Renders
        WHERE ReportId=@reportId AND ServerReceivedAt>=@start AND ServerReceivedAt<@until
        GROUP BY CONVERT(char(10),ServerReceivedAt,23) ORDER BY day`, params),
    ]);
    return { window: windowDto(w), report, hourly, daily };
  }

  private async user(reader: Pick<Database, "read">, w: Window, params: { userId: string | null; start: Date; until: Date; offset: number }) {
    const [user] = await reader.read(`SELECT TOP(1) name FROM (
      SELECT DisplayName AS name,0 AS priority FROM analytics.Users WHERE UserId=@userId
      UNION ALL SELECT UserDisplayName,1 FROM analytics.Renders WHERE UserId=@userId
      UNION ALL SELECT UserDisplayName,1 FROM analytics.Requests WHERE UserId=@userId
      ) s ORDER BY priority,name`, params);
    requireCondition(user, 404, "NotFound", "User not found in this tenant.");
    const [usage, history] = await Promise.all([
      reader.read(`SELECT TOP(501) ReportId AS reportId,MAX(ReportName) AS name,COUNT(*) AS renders,
        AVG(CONVERT(float,DurationMs)) AS averageDurationMs FROM analytics.Renders
        WHERE UserId=@userId AND ServerReceivedAt>=@start AND ServerReceivedAt<@until
        GROUP BY ReportId ORDER BY renders DESC,ReportId`, params),
      reader.read(`SELECT * FROM (
        SELECT q.RequestId AS id,q.ReportId AS reportId,q.ReportName AS reportName,q.RequestedAt AS requestedAt,
          q.ServerReceivedAt AS receivedAt,q.Mode AS mode,q.Status AS status,r.DurationMs AS durationMs
        FROM analytics.Requests q LEFT JOIN analytics.Renders r
          ON r.RenderId=q.RenderId AND r.UserId=q.UserId AND r.ReportId=q.ReportId
        WHERE q.UserId=@userId AND q.ServerReceivedAt>=@start AND q.ServerReceivedAt<@until
        UNION ALL
        SELECT r.RenderId,r.ReportId,r.ReportName,r.RequestedAt,r.ServerReceivedAt,r.Mode,'Rendered',r.DurationMs
        FROM analytics.Renders r WHERE r.UserId=@userId
          AND r.ServerReceivedAt>=@start AND r.ServerReceivedAt<@until
          AND NOT EXISTS(SELECT 1 FROM analytics.Requests q WHERE q.RenderId=r.RenderId AND q.UserId=r.UserId)
        ) h ORDER BY receivedAt DESC,id DESC OFFSET @offset ROWS FETCH NEXT 51 ROWS ONLY`, params),
    ]);
    return { window: windowDto(w), user, usage: usage.slice(0, 500), usageLimited: usage.length > 500,
      history: history.slice(0, 50), hasMore: history.length > 50, page: w.page };
  }
}
