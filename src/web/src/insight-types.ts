export interface InsightWindow { from: string; to: string }
export interface DailyRenders { day: string; renders: number }
export interface InsightTotals { users: number; reports: number; renders: number }
export interface PlatformInsights {
  window: InsightWindow;
  totals: { tenants: number; users: number; reports: number };
  tenants: { tenantId: string; name: string; users: number; reports: number; renders: number }[];
  daily: (DailyRenders & { tenantId: string })[];
}
export interface TenantInsights {
  window: InsightWindow; name: string; totals: InsightTotals; daily: DailyRenders[];
  users: { id: string; name: string }[]; reports: { id: string; name: string }[]; directoryLimited: boolean;
}
export interface ReportInsights {
  window: InsightWindow; report: { name: string };
  hourly: (DailyRenders & { hour: number })[];
  daily: (DailyRenders & { averageDurationMs: number })[];
}
export interface UserInsights {
  window: InsightWindow; user: { name: string };
  usage: { reportId: string; name: string; renders: number; averageDurationMs: number }[];
  usageLimited: boolean; hasMore: boolean; page: number;
  history: { id: string; reportId: string; reportName: string; requestedAt: string; receivedAt: string;
    mode: string; status: "Requested" | "Authorized" | "Failed" | "Rendered"; durationMs: number | null }[];
}
