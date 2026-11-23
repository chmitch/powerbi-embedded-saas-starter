export type PlatformRoute = { screen: "fleet" } | { screen: "add" } | { screen: "insights" } | { screen: "details"; tenantId: string };

export function platformRoute(hash: string): PlatformRoute {
  if (hash === "#platform/insights") return { screen: "insights" };
  if (hash === "#platform/add-tenant") return { screen: "add" };
  const tenant = /^#platform\/tenants\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(hash);
  return tenant ? { screen: "details", tenantId: tenant[1]! } : { screen: "fleet" };
}
