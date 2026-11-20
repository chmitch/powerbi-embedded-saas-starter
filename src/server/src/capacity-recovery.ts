import { AsyncLocalStorage } from "node:async_hooks";
import type { AzureServices } from "./azure.js";
import { AppError, requireCondition } from "./errors.js";

export const capacityDemand = new AsyncLocalStorage<boolean>();
const resourcePattern = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[^/?#]+\/providers\/Microsoft\.Fabric\/capacities\/[a-z][a-z0-9]{2,62}$/i;
interface Resource { id: string; name: string; properties: { state: string; provisioningState?: string } }

export function sqlCapacityUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; message?: unknown; originalError?: unknown; precedingErrors?: unknown[] };
  return ["ETIMEOUT", "ESOCKET", "ECONNCLOSED", "ECONNRESET", "ECONNREFUSED"].includes(value.code ?? "") ||
    (typeof value.message === "string" &&
    /SQL database has been disabled|(?:Fabric )?capacity (?:is (?:currently )?|has been )?(?:paused|suspended)/i.test(value.message)) ||
    (value.originalError !== error && sqlCapacityUnavailable(value.originalError)) ||
    Boolean(value.precedingErrors?.some(sqlCapacityUnavailable));
}

export class CapacityRecovery {
  private pending = new Map<string, Promise<boolean>>();
  private recent = new Map<string, { until: number; resumed: boolean }>();
  constructor(private azure: AzureServices, private timing = { interval: 2_000, timeout: 120_000 }) {}
  async resume(resourceId: string): Promise<boolean> {
    if (!this.azure.config.AutoResumeCapacities || !capacityDemand.getStore()) return false;
    requireCondition(resourcePattern.test(resourceId), 409, "CapacityMappingInvalid", "The configured Fabric capacity resource reference is invalid.");
    const key = resourceId.toLowerCase();
    const pending = this.pending.get(key);
    if (pending) return pending;
    const recent = this.recent.get(key);
    if (recent && recent.until > Date.now()) return recent.resumed;
    const operation = this.resumeResource(resourceId).then(resumed => {
      this.recent.set(key, { until: Date.now() + 10_000, resumed });
      return resumed;
    }).catch(error => {
      this.recent.set(key, { until: Date.now() + 10_000, resumed: false });
      if (error instanceof AppError && ["CapacityStarting", "CapacityUnavailable", "CapacityMappingInvalid"].includes(error.code)) throw error;
      throw new AppError(503, "CapacityResumeUnavailable",
        "The capacity could not be resumed. Check Azure read/resume permissions and capacity status, then retry.");
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, operation);
    return operation;
  }
  private async resumeResource(resourceId: string) {
    let resource = await this.azure.capacityResource<Resource>(resourceId);
    requireCondition(resource.id?.toLowerCase() === resourceId.toLowerCase(), 409, "CapacityMappingInvalid", "Azure returned a different capacity.");
    if (resource.properties.state === "Active" && resource.properties.provisioningState === "Succeeded") return false;
    const paused = ["Paused", "Suspended"].includes(resource.properties.state);
    const starting = ["Resuming", "Suspending", "Pausing", "Updating"].includes(resource.properties.state) ||
      ["Resuming", "Suspending", "Pausing", "Updating"].includes(resource.properties.provisioningState ?? "");
    if (!paused && !starting) return false;
    let requested = false;
    const deadline = Date.now() + this.timing.timeout;
    while (Date.now() < deadline) {
      const state = resource.properties.state;
      const provisioning = resource.properties.provisioningState;
      if (state === "Active" && (!provisioning || provisioning === "Succeeded")) return true;
      requireCondition(!["Failed", "Canceled", "Deleting", "Disabled"].includes(state) &&
        !["Failed", "Canceled", "Deleting"].includes(provisioning ?? ""), 503, "CapacityUnavailable",
      "The capacity is not resumable. An Azure/Fabric administrator must inspect it.");
      if (["Paused", "Suspended"].includes(state) && (!provisioning || provisioning === "Succeeded") && !requested) {
        requested = true;
        console.info(JSON.stringify({ code: "CapacityAutoResumeRequested", resourceId }));
        try { await this.azure.capacityResource(resourceId, "POST"); }
        catch (error) {
          if (!(error instanceof AppError) || error.code !== "Upstream409") throw error;
        }
      }
      await new Promise(resolve => setTimeout(resolve, this.timing.interval));
      resource = await this.azure.capacityResource<Resource>(resourceId);
      requireCondition(resource.id?.toLowerCase() === resourceId.toLowerCase(), 409, "CapacityMappingInvalid", "Azure returned a different capacity.");
    }
    throw new AppError(503, "CapacityStarting", "Capacity startup has not completed yet. Wait briefly and retry.");
  }
}

export async function waitForCapacityData<T>(operation: () => Promise<T>, retryable: (error: unknown) => boolean,
  timing = { interval: 2_000, timeout: 45_000 }): Promise<T> {
  const deadline = Date.now() + timing.timeout;
  for (;;) {
    try { return await operation(); }
    catch (error) {
      if (!retryable(error)) throw error;
      if (Date.now() >= deadline) throw new AppError(503, "CapacityStarting", "The capacity is running but its data services are still warming up. Retry shortly.");
      await new Promise(resolve => setTimeout(resolve, timing.interval));
    }
  }
}
