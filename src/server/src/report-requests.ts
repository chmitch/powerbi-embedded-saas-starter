import type { Repository } from "./repository.js";
import { sameId, tenantMembership, type User } from "./domain.js";
import { requireCondition } from "./errors.js";

export class ReportRequests {
  constructor(private repo: Repository) {}

  async start(user: User, id: string, contentId: string, mode: string, requestedAt: string, receivedAt: Date) {
    const tenantId = tenantMembership(user);
    requireCondition(Math.abs(Date.parse(requestedAt) - receivedAt.getTime()) <= 86_400_000,
      400, "InvalidRenderTime", "The client request timestamp is outside the supported clock range.");
    const report = (await this.repo.content(tenantId)).find(c => sameId(c.Id, contentId) && c.Kind === "Report");
    requireCondition(report, 404, "NotFound", "Report not found.");
    return this.repo.db.transaction(async tx => {
      const [existing] = await tx.query<{ UserId: string; TenantId: string; ContentId: string; Mode: string; RequestedAt: Date;
        ServerReceivedAt: Date; RenderId: string }>(
        "SELECT UserId,TenantId,ContentId,Mode,RequestedAt,ServerReceivedAt,RenderId FROM app.ReportRequests WITH (UPDLOCK,HOLDLOCK) WHERE Id=@id", { id });
      if (existing) {
        requireCondition(sameId(existing.UserId, user.Id) && sameId(existing.TenantId, tenantId) &&
          sameId(existing.ContentId, contentId) && existing.Mode === mode &&
          new Date(existing.RequestedAt).getTime() === Date.parse(requestedAt),
        409, "RequestContextChanged", "The original report request context changed.");
        return { renderId: existing.RenderId, receivedAt: new Date(existing.ServerReceivedAt) };
      }
      const renderId = randomUUID();
      await tx.query(`INSERT app.ReportRequests
        (Id,TenantId,UserId,ContentId,ReportName,UserDisplayName,Mode,RequestedAt,ServerReceivedAt,Status,RenderId)
        VALUES(@id,@tenantId,@userId,@contentId,@reportName,@userName,@mode,@requestedAt,@receivedAt,'Requested',@renderId)`,
      { id, tenantId, userId: user.Id, contentId, reportName: report.Name, userName: user.DisplayName,
        mode, requestedAt: new Date(requestedAt), receivedAt, renderId });
      return { renderId, receivedAt };
    });
  }

  async outcome(user: User, id: string, status: "Authorized" | "Failed") {
    await this.repo.db.query(`UPDATE app.ReportRequests SET Status=@status
      WHERE Id=@id AND TenantId=@tenantId AND UserId=@userId AND Status<>'Rendered'`,
    { id, tenantId: tenantMembership(user), userId: user.Id, status });
  }
}

import { randomUUID } from "node:crypto";
