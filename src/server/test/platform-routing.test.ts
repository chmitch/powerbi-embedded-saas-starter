import { it } from "node:test";
import assert from "node:assert/strict";
import { platformRoute } from "../../web/src/platform-route.js";

it("opens bookmarkable tenant details and Add Tenant without turning unknown navigation into tenant access", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(platformRoute(`#platform/tenants/${id}`), { screen: "details", tenantId: id });
  assert.deepEqual(platformRoute("#platform/add-tenant"), { screen: "add" });
  for (const hash of ["", "#platform/fleet", "#platform/tenants/not-a-tenant", "#platform/tenants/../../admin",
    `#platform/tenants/${id}/content`, "#platform/tenants/https://example.test"])
    assert.deepEqual(platformRoute(hash), { screen: "fleet" });
});
