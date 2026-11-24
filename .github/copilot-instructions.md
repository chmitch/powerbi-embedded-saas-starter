# Project instructions

## Start here

- Recover project context from this checkout, not prior chat, personal memory,
  session checkpoints, or assumptions about the last deployment.
- Read the README overview and the task-relevant documents below; do not load
  every document for every task. Inspect current source/tests before changing it.

| Task | Read |
| --- | --- |
| Developer orientation, commands, regression checks | `docs\development.md` |
| Architecture, identity, isolation, embedding, SQL | Relevant sections of `ARCHITECTURE.md` |
| Tenant/user/content administration | `docs\administration.md` and the corresponding architecture section |
| Local initialization or new Azure environment | Setup/deployment sections of `README.md` |
| Existing Azure update, migration, recovery | `docs\operations.md` |
| Scope or future features | Limitations and future work in `ARCHITECTURE.md` |

## Selected architecture

- React/TypeScript + Express/TypeScript, npm workspaces `src\server` and
  `src\web`, Node 22 LTS. No ASP.NET or .NET SDK requirement.
- One same-origin Linux App Service B1 instance serves compiled frontend/backend.
  Background work is in-process, not a queue or independent worker service.
- Use transactional SQL Database in Fabric for metadata, ACLs, encrypted
  sessions, audit/usage and operation state. Do not replace it with Cosmos,
  SQLite, Warehouse, Azure SQL hosting, or a read-only SQL analytics endpoint.
- Entra BFF login uses PKCE and encrypted server-side sessions. Authentication
  is separate from membership, application permissions, and embedding.
- App Owns Data only. All privileged Fabric/Power BI/Graph/ARM operations and
  token generation stay on the backend; no User Owns Data or delegated embedding
  fallback. Browser receives only the authorized short-lived embed configuration.

## Mandatory authorization boundaries

- Ordinary users have exactly one application tenant; platform-only admins may
  have none, with tenant-admin/default permissions cleared. No tenant switching,
  implicit membership moves, email-based identity linking, or sign-in enrollment.
- Derive identity/tenant/workspace from authenticated SQL records. Each tenant
  has one exclusive workspace and embedding principal; pending unmapped tenants
  remain manageable but cannot embed. Customer capacities may be shared.
- Platform status grants infrastructure/appointment authority, never tenant
  content, membership/ACL/navigation management, or embedding access. Dual-role
  users use explicit own-tenant authorization for tenant operations.
- Scope SQL, caches, jobs, associations and dependencies to the tenant. Verify
  publication, effective item/model permissions and live report dependencies.
  Reject cross-tenant, rebound, unsupported or ambiguous resources.
- Tokens cover only authorized reports/models and, for create/copy only, the
  server-resolved tenant target workspace. Reauthorize renewal/mode/save changes.
- Required effective-identity RLS is currently unsupported and must fail closed.
  Never omit identity/roles or retry with an unfiltered token.
- Management workspace/capacity are not customer resources: reject adoption,
  assignment, customer mutation and embedding; never grant tenant principals access.
- UI hiding is not authorization. Mutations require backend checks and CSRF.
  ACL bits and explicit admin flags are the implemented model, not custom roles.

## Preserve workflow safety

- Default-deny inherited grants, explicit inheritance breaks and one canonical
  security parent per item. Navigation aliases do not rename Fabric artifacts.
  Newly discovered content stays unpublished until own-tenant review.
- First-run bootstrap is deployment-authorized, persisted and one-time; never
  promote the first arbitrary sign-in or reopen enrollment on a failed SQL read.
- Only platform admins appoint tenant admins. Only guided creation of a new
  tenant grants its initial admin full root defaults; retries preserve later edits.
- Provisioning uses SQL checkpoints/leases and original-operator explicit retry.
  Preserve partial resources; reconcile ambiguous creation/import outcomes before
  retry. HTTP 202 means accepted, not complete.
- Fixed sample seeding uses `samples\Store Sales.pbix` with the tenant principal,
  pinned workspace/import ID and atomic publication checkpoint. Tenant sample
  operations must not replay platform setup or overwrite later admin edits.
- Capacity changes verify current assignments and shared impact, exclude protected
  management resources, audit results, and never automatically replay writes.
- Automatic resume is an explicit persisted billing opt-in, not a schedule.
  Only relevant foreground failures trigger recovery; health/static/background
  requests never wake compute. Anonymous foreground SQL recovery may wake
  management billing. Tenant recovery requires authorization and a verified binding.
- Preserve viewer-first standard SDK embedding and unsaved-editor lifecycle.
  No phased embedding, browser destination override, or save/write replay.
- Initial usage tracking is best-effort/idempotent, actor-bound and CSRF-protected;
  preserve the first timing/request nonce across recovery. Renewals, later SDK
  renders and unsaved editor readiness are not new report views.
- Insights are native SQL-backed pages, not embedded admin reports or CU/billing
  analytics. Platform usage is aggregate-only; tenant details require own-tenant
  admin status. Serving insights must not call Fabric/ARM or start tenant compute.
- Use charts except user request history; rolling UTC week default, 7/30/90/365
  presets, custom up to 366 inclusive days. Zero-fill counts, not missing averages.

## Configuration and deployment

- Keep real configuration, credentials, tokens, private keys and cloud logs outside
  the checkout, including ignored files. Examples contain placeholders only.
- Local Azure access uses CLI identity; external local-file secrets require
  explicit `-UseLocalSecrets`. Production uses Key Vault and distinct runtime/
  provisioning managed identities; no silent secret-store fallback.
- Production secrets are initialized inside Azure, never generated/exported by
  the local deployer. Preserve the session key and fail closed on unhealthy secrets.
- Enforced Key Vault NSP and RBAC are independent. Do not weaken networking,
  bypass inherited policy, add exemption tags, or broaden grants to make setup pass.
- `scripts\Common.ps1` owns deterministic naming/configuration guards. Reuse pinned
  IDs/namespace; never implicitly replace, relocate or repoint existing resources.
  New-environment region is West US 3; actual Linux-plan Provider validation is
  required before buying infrastructure, not just apparent quota/SKU availability.
- Use the application-only runbook for routine Azure updates. Full `Deploy.ps1`
  can provision resources, change grants/settings and enable Always On.
- Deployment, infrastructure changes, and Git publication require their own
  explicit authorization. Do not commit or push unless the user asks.

## Validation and durable documentation

- Use existing commands: `npm run check`, `npm test`, `npm run build`;
  `scripts\Test-Scripts.ps1` covers mocked script behavior, not live Azure.
  Run focused checks appropriate to the change; see `docs\development.md`.
- Restore dependencies after manifest changes or a missing-dependency failure,
  not reflexively. Preserve manifests and root lockfile; do not commit modules/dist.
- Keep accepted decisions/rationale in architecture, setup in README, human
  workflows in administration, engineering in development, operations in operations.
  Update affected documents with changes and verify local links.
- Distinguish implemented, requested-but-deferred, proposed, and unresolved.
  Preserve rejected alternatives when they explain a decision. Do not silently
  turn a recommendation into a requirement or redefine intent to match a bug.
- Do not add duplicate handoff/session journals, deployment-success narratives,
  historical test inventories, sign-in confirmations, or sensitive data.
- General portal PBIX/model uploads, effective-identity RLS and consumer/federated
  login remain deferred. Data-source credentials/connectivity, gateways and
  Fabric/model networking automation are out of scope without a new request.
