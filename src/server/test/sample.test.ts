import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import assert from "node:assert/strict";
import type { AzureServices } from "../src/azure.js";
import { config } from "../src/config.js";
import type { Tenant } from "../src/domain.js";
import { FabricService } from "../src/fabric.js";
import type { Repository } from "../src/repository.js";
import { sampleName } from "../src/sample.js";

it("uploads the fixed bundled PBIX as multipart data using only the resolved tenant workspace and principal", async context => {
  const tenant = { Id: randomUUID(), WorkspaceId: randomUUID() } as Tenant, importId = randomUUID();
  const repo = { tenant: async (id: string) => { assert.equal(id, tenant.Id); return tenant; } } as Repository;
  const fabric = new FabricService(repo, { config } as AzureServices);
  context.mock.method(fabric, "runtimeToken", async t => { assert.equal(t, tenant); return "tenant-only"; });
  let requests = 0;
  context.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.powerbi.com");
    assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer tenant-only");
    requests++;
    if (options?.method === "POST") {
      assert.equal(url.pathname, `/v1.0/myorg/groups/${tenant.WorkspaceId}/imports`);
      assert.equal(url.searchParams.get("nameConflict"), "Abort");
      assert.equal(url.searchParams.get("datasetDisplayName"), sampleName);
      assert.ok(options.body instanceof FormData);
      const request = new Request(url, options);
      assert.match(request.headers.get("content-type")!, /^multipart\/form-data; boundary=/);
      const file = (await request.formData()).get("file") as File;
      assert.equal(file.name, sampleName);
      const original = await readFile(new URL(`../../../samples/${sampleName}`, import.meta.url));
      const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
      assert.equal(hash(new Uint8Array(await file.arrayBuffer())), hash(original));
      return Response.json({ id: importId }, { status: 202 });
    }
    assert.equal(url.pathname, `/v1.0/myorg/groups/${tenant.WorkspaceId}/imports/${importId}`);
    return Response.json({ id: importId, importState: "Succeeded" });
  });
  assert.equal((await fabric.importSample(tenant.Id)).id, importId);
  assert.equal((await fabric.sampleImport(tenant.Id, importId)).importState, "Succeeded");
  assert.equal(requests, 2);
});

it("blocks management-workspace seeding before authentication or upload and does not replay a failed upload", async context => {
  const tenant = { Id: randomUUID(), WorkspaceId: randomUUID() } as Tenant;
  const fabric = new FabricService({ tenant: async () => tenant } as unknown as Repository,
    { config: { ...config, ManagementWorkspaceId: tenant.WorkspaceId } } as AzureServices);
  const request = context.mock.method(globalThis, "fetch", async () => Response.json({ error: "private-detail" }, { status: 403 }));
  await assert.rejects(fabric.importSample(tenant.Id), { code: "ProtectedManagementResource" });
  await assert.rejects(fabric.sampleImport(tenant.Id, randomUUID()), { code: "ProtectedManagementResource" });
  assert.equal(request.mock.callCount(), 0);
  tenant.WorkspaceId = randomUUID();
  context.mock.method(fabric, "runtimeToken", async () => "tenant-only");
  await assert.rejects(fabric.importSample(tenant.Id), error => error instanceof Error && !error.message.includes("private-detail"));
  assert.equal(request.mock.callCount(), 1);
});
