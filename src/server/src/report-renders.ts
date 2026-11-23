import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sameId, tenantMembership, type User } from "./domain.js";
import { AppError, requireCondition } from "./errors.js";
import type { Repository } from "./repository.js";

const day = 86_400_000;
const contextSchema = z.object({
  version: z.literal(1), id: z.uuid(), tenantId: z.uuid(), userId: z.uuid(),
  directoryId: z.uuid(), objectId: z.uuid(), displayName: z.string().max(200),
  contentId: z.uuid(), reportId: z.uuid(), reportName: z.string().max(200), workspaceId: z.uuid(),
  mode: z.enum(["view", "edit", "copy"]), requestedAt: z.string().datetime().max(40),
  serverReceivedAt: z.string().datetime(), issuedAt: z.string().datetime(),
  requestId: z.uuid().optional(),
}).strict();
type RenderContext = z.infer<typeof contextSchema>;

export class ReportRenders {
  constructor(private repo: Repository, private signingKey: string, private now = () => new Date()) {}

  private signature(payload: string) {
    return createHmac("sha256", this.signingKey).update("ReportRender:v1:").update(payload).digest();
  }
  private verify(receipt: string, user: User): RenderContext {
    let context: RenderContext;
    try {
      const parts = receipt.split(".");
      requireCondition(parts.length === 2 && /^[A-Za-z0-9_-]+$/.test(parts[0]!) &&
        /^[A-Za-z0-9_-]{43}$/.test(parts[1]!), 403, "InvalidRenderReceipt", "Invalid render receipt.");
      const signature = Buffer.from(parts[1]!, "base64url");
      requireCondition(timingSafeEqual(signature, this.signature(parts[0]!)), 403, "InvalidRenderReceipt", "Invalid render receipt.");
      context = contextSchema.parse(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")));
    } catch { throw new AppError(403, "InvalidRenderReceipt", "The render receipt could not be verified."); }
    requireCondition(sameId(context.userId, user.Id) && sameId(context.tenantId, tenantMembership(user)) &&
      sameId(context.directoryId, user.DirectoryId) && sameId(context.objectId, user.ObjectId),
    403, "RenderReceiptForbidden", "This render receipt does not belong to your current identity and tenant.");
    const age = this.now().getTime() - Date.parse(context.issuedAt);
    requireCondition(age >= -300_000 && age <= day, 409, "RenderReceiptExpired", "The render receipt has expired.");
    return context;
  }

  async issue(user: User, contentId: string, reportId: string, mode: "view" | "edit" | "copy",
    requestedAt: string, serverReceivedAt: Date, previous?: string, requestId?: string, renderId?: string) {
    const tenantId = tenantMembership(user);
    const tenant = await this.repo.tenant(tenantId);
    const report = (await this.repo.content(tenantId)).find(item =>
      sameId(item.Id, contentId) && item.Kind === "Report" && sameId(item.ExternalId, reportId));
    requireCondition(tenant.WorkspaceId && report, 409, "RenderContextUnavailable", "The authorized report context could not be recorded.");
    if (previous) {
      const context = this.verify(previous, user);
      requireCondition(sameId(context.contentId, contentId) && sameId(context.reportId, reportId) &&
        sameId(context.workspaceId, tenant.WorkspaceId) && context.mode === mode && context.requestedAt === requestedAt &&
        context.requestId === requestId && (!renderId || sameId(context.id, renderId)),
      409, "RenderContextChanged", "The original render context changed.");
      return previous;
    }
    requireCondition(Math.abs(Date.parse(requestedAt) - serverReceivedAt.getTime()) <= day,
      400, "InvalidRenderTime", "The client request timestamp is outside the supported clock range.");
    const context = contextSchema.parse({
      version: 1, id: renderId ?? randomUUID(), tenantId, userId: user.Id, directoryId: user.DirectoryId,
      objectId: user.ObjectId, displayName: user.DisplayName, contentId, reportId, reportName: report.Name,
      workspaceId: tenant.WorkspaceId, mode, requestedAt, serverReceivedAt: serverReceivedAt.toISOString(),
      issuedAt: this.now().toISOString(),
      ...(requestId ? { requestId } : {}),
    });
    const payload = Buffer.from(JSON.stringify(context)).toString("base64url");
    return `${payload}.${this.signature(payload).toString("base64url")}`;
  }

  async record(user: User, receipt: string, durationMs: number) {
    requireCondition(Number.isInteger(durationMs) && durationMs >= 0 && durationMs <= day,
      400, "InvalidRenderDuration", "Render duration must be between zero and 24 hours in milliseconds.");
    const context = this.verify(receipt, user);
    return this.repo.db.transaction(async tx => {
      const [existing] = await tx.query<{ UserId: string; TenantId: string }>(
        "SELECT UserId,TenantId FROM app.ReportRenders WITH (UPDLOCK,HOLDLOCK) WHERE Id=@id", { id: context.id });
      if (existing) {
        requireCondition(sameId(existing.UserId, user.Id) && sameId(existing.TenantId, user.TenantId),
          403, "RenderReceiptForbidden", "The render record is unavailable.");
        return { recorded: true, duplicate: true };
      }
      await tx.query(`INSERT app.ReportRenders
        (Id,TenantId,UserId,DirectoryId,ObjectId,UserDisplayName,ContentId,ReportId,ReportName,WorkspaceId,Mode,
         RequestedAt,ServerReceivedAt,RenderedAt,DurationMs)
        VALUES(@id,@tenantId,@userId,@directoryId,@objectId,@displayName,@contentId,@reportId,@reportName,@workspaceId,@mode,
         @requestedAt,@serverReceivedAt,@renderedAt,@durationMs)`, {
        id: context.id, tenantId: context.tenantId, userId: context.userId, directoryId: context.directoryId,
        objectId: context.objectId, displayName: context.displayName, contentId: context.contentId, reportId: context.reportId,
        reportName: context.reportName, workspaceId: context.workspaceId, mode: context.mode,
        requestedAt: new Date(context.requestedAt), serverReceivedAt: new Date(context.serverReceivedAt),
        renderedAt: new Date(Date.parse(context.requestedAt) + durationMs), durationMs,
      });
      if (context.requestId) await tx.query(`UPDATE app.ReportRequests SET Status='Rendered',RenderId=@renderId
        WHERE Id=@requestId AND TenantId=@tenantId AND UserId=@userId AND ContentId=@contentId`,
      { requestId: context.requestId, tenantId: context.tenantId, userId: context.userId,
        contentId: context.contentId, renderId: context.id });
      return { recorded: true, duplicate: false };
    });
  }
}
