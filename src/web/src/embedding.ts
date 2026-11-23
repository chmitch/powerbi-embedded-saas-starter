import type { models } from "powerbi-client";

export function reportEmbedPermissions(
  { creating, editable, copyable }: { creating: boolean; editable: boolean; copyable: boolean },
  sdk: typeof models.Permissions,
): models.Permissions {
  // The SDK validates named enum values, not arbitrary combinations of its bits.
  return creating || copyable ? sdk.All : editable ? sdk.ReadWrite : sdk.Read;
}

export function embedErrorMessage(error: unknown, fallback: string): string {
  const messages = (Array.isArray(error) ? error : [error]).flatMap(value => {
    const message = typeof value === "string" ? value :
      value && typeof value === "object" && "message" in value ? value.message : undefined;
    return typeof message === "string" && message.trim() ? [message.trim().slice(0, 500)] : [];
  }).slice(0, 3);
  return messages.length ? messages.join(" ") : fallback;
}

interface ReportEvents {
  on: (event: "loaded" | "rendered", handler: () => void) => void;
  off: (event: "loaded" | "rendered", handler: () => void) => void;
}

export function bindReportLifecycle(report: ReportEvents, options: {
  creating: boolean; onRendering: () => void; onReady: () => void; onRendered?: () => void;
}) {
  let active = true;
  let started = false;
  let ready = false;
  const loaded = () => {
    if (!active || started) return;
    started = true;
    if (options.creating) {
      ready = true; options.onReady();
    } else {
      options.onRendering();
    }
  };
  const rendered = () => {
    if (!active || !started || ready || options.creating) return;
    options.onRendered?.();
    ready = true; options.onReady();
  };
  report.on("loaded", loaded);
  report.on("rendered", rendered);
  return () => {
    active = false;
    report.off("loaded", loaded);
    report.off("rendered", rendered);
  };
}
