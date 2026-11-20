import { it } from "node:test";
import assert from "node:assert/strict";
import { AzureServices } from "../src/azure.js";
import { config } from "../src/config.js";
import { AppError } from "../src/errors.js";

const objectId = "55555555-5555-4555-8555-555555555555";
function services() {
  return new AzureServices({ ...config, LocalSecretsPath: "", KeyVaultUri: "",
    RuntimeManagedIdentityClientId: "", ProvisioningManagedIdentityClientId: "" });
}

it("resolves exact UPNs through Graph, including guest hashes, leading dollars and escaped apostrophes", async context => {
  const azure = services();
  context.mock.method(azure.provisioner, "getToken", async () => ({ token: "test-only", expiresOnTimestamp: Date.now() + 60_000 }));
  let upn = "";
  context.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(String(input));
    const key = upn.replaceAll("'", "''");
    assert.equal(decodeURIComponent(url.pathname), `/v1.0/users('${key}')`);
    assert.equal(url.searchParams.get("$select"), "id,displayName,userPrincipalName");
    assert.equal(url.searchParams.size, 1);
    assert.equal(options?.headers && (options.headers as Record<string, string>).Authorization, "Bearer test-only");
    return Response.json({ id: objectId, displayName: "Directory display name", userPrincipalName: upn.toLowerCase() });
  });
  for (upn of ["Admin@contoso.com", "guest_contoso.com#EXT#@tenant.example", "$admin@contoso.com", "o'brien@contoso.com"]) {
    assert.deepEqual(await azure.resolveUserPrincipalName(` ${upn} `), { objectId, displayName: "Directory display name" });
  }
});

it("reports directory access/not-found/throttling failures without exposing Graph response data", async context => {
  const azure = services();
  context.mock.method(azure.provisioner, "getToken", async () => ({ token: "test-only", expiresOnTimestamp: Date.now() + 60_000 }));
  let status = 404;
  context.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "private-upstream-detail" } }, { status }));
  for (const [responseStatus, expectedStatus, code] of [
    [404, 404, "DirectoryUserNotFound"], [403, 503, "DirectoryLookupForbidden"],
    [429, 429, "Upstream429"], [500, 503, "DirectoryLookupUnavailable"],
  ] as const) {
    status = responseStatus;
    await assert.rejects(azure.resolveUserPrincipalName("admin@contoso.com"),
      error => error instanceof AppError && error.status === expectedStatus && error.code === code &&
        !error.message.includes("private-upstream-detail"));
  }
});

it("rejects malformed inputs before Graph access and refuses nonmatching or malformed directory identities", async context => {
  const azure = services();
  let tokenRequests = 0;
  context.mock.method(azure.provisioner, "getToken", async () => {
    tokenRequests++;
    return { token: "test-only", expiresOnTimestamp: Date.now() + 60_000 };
  });
  await assert.rejects(azure.resolveUserPrincipalName("not-a-upn"));
  await assert.rejects(azure.resolveUserPrincipalName("../users/admin@contoso.com"));
  assert.equal(tokenRequests, 0);
  let response = { id: objectId, userPrincipalName: "different@contoso.com" };
  context.mock.method(globalThis, "fetch", async () => Response.json(response));
  await assert.rejects(azure.resolveUserPrincipalName("admin@contoso.com"),
    error => error instanceof AppError && error.code === "DirectoryLookupInvalid");
  response = { id: "invalid-id", userPrincipalName: "admin@contoso.com" };
  await assert.rejects(azure.resolveUserPrincipalName("admin@contoso.com"),
    error => error instanceof AppError && error.code === "DirectoryLookupInvalid");
});
