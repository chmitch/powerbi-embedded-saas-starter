import { it } from "node:test";
import assert from "node:assert/strict";
import * as models from "powerbi-models";
import { bindReportLifecycle, embedErrorMessage, reportEmbedPermissions } from "../../web/src/embedding.js";

const id = "11111111-1111-4111-8111-111111111111";
const base = { type: "report", id, embedUrl: "https://app.powerbi.com/reportEmbed",
  accessToken: "test-only", tokenType: models.TokenType.Embed,
  settings: { bars: { actionBar: { visible: false } }, useCustomSaveAsDialog: true } };

it("builds viewer, editor, copier and creator permissions accepted by the real SDK validator", () => {
  for (const capabilities of [
    { creating: false, editable: false, copyable: false },
    { creating: false, editable: true, copyable: false },
    { creating: false, editable: true, copyable: true },
    { creating: true, editable: true, copyable: true },
  ]) {
    const permissions = reportEmbedPermissions(capabilities, models.Permissions);
    if (capabilities.creating) {
      assert.equal(models.validateCreateReport({ ...base, type: "create", datasetId: id, permissions,
        viewMode: models.ViewMode.Edit }), undefined);
    } else {
      for (const viewMode of [models.ViewMode.View, ...(capabilities.editable ? [models.ViewMode.Edit] : [])]) {
        assert.equal(models.validateReportLoad({ ...base, permissions, viewMode }), undefined,
          `SDK rejected ${JSON.stringify({ capabilities, viewMode })}`);
      }
    }
    assert.equal(Boolean(permissions & models.Permissions.Copy), capabilities.copyable);
    assert.equal(Boolean(permissions & models.Permissions.ReadWrite), capabilities.editable);
  }
});

it("shows SDK validation arrays and message objects without exposing diagnostic payloads", () => {
  const invalid = models.validateReportLoad({ ...base,
    permissions: models.Permissions.ReadWrite | models.Permissions.Copy });
  assert.equal(embedErrorMessage(invalid, "fallback"), "permissions property is invalid");
  assert.equal(embedErrorMessage({ message: "Report unavailable", details: { accessToken: "private-fixture" },
    detailedMessage: "private-fixture" }, "fallback"), "Report unavailable");
  assert.equal(embedErrorMessage(new Error("Backend authorization failed"), "fallback"), "Backend authorization failed");
  assert.equal(embedErrorMessage({ accessToken: "private-fixture" }, "fallback"), "fallback");
  assert.equal(embedErrorMessage(null, "fallback"), "fallback");
});

function lifecycleFixture(creating = false) {
  const handlers = new Map<string, () => void>();
  const phases: string[] = [];
  let renders = 0;
  const report = {
    on: (event: string, handler: () => void) => { handlers.set(event, handler); },
    off: (event: string, handler: () => void) => { if (handlers.get(event) === handler) handlers.delete(event); },
    render: async () => { renders++; },
  };
  const stop = bindReportLifecycle(report, { creating,
    onRendering: () => { phases.push("rendering"); }, onReady: () => { phases.push("ready"); } });
  return { handlers, phases, stop, renders: () => renders, emit: (name: string) => handlers.get(name)?.() };
}

it("waits for standard embedding to render before enabling interaction, without manually rendering", async () => {
  const report = lifecycleFixture();
  report.emit("rendered");
  assert.deepEqual(report.phases, []);
  report.emit("loaded"); report.emit("loaded");
  await Promise.resolve();
  assert.equal(report.renders(), 0);
  assert.deepEqual(report.phases, ["rendering"]);
  report.emit("rendered"); report.emit("rendered");
  assert.deepEqual(report.phases, ["rendering", "ready"]);
  report.stop();
});

it("enables a new-report editor on loaded without waiting for rendered or manually rendering", async () => {
  const editor = lifecycleFixture(true);
  editor.emit("rendered");
  assert.deepEqual(editor.phases, []);
  editor.emit("loaded");
  editor.emit("loaded"); editor.emit("rendered");
  await Promise.resolve();
  assert.equal(editor.renders(), 0);
  assert.deepEqual(editor.phases, ["ready"]);
  editor.stop();
});

it("detaches lifecycle handlers and ignores queued events after a session closes", () => {
  for (const creating of [false, true]) for (const loaded of [false, true]) {
    const report = lifecycleFixture(creating);
    if (loaded) report.emit("loaded");
    const phases = [...report.phases];
    const staleLoaded = report.handlers.get("loaded")!;
    const staleRendered = report.handlers.get("rendered")!;
    report.stop(); staleLoaded(); staleRendered();
    assert.deepEqual(report.phases, phases);
    assert.equal(report.renders(), 0);
    assert.equal(report.handlers.size, 0);
  }
});
