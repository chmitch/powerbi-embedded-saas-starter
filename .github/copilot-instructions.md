# Project instructions

## Session startup and durable design continuity

- At the start of a new session, read `README.md` and `ARCHITECTURE.md` at the
  repository root before planning or implementing changes. Do not rely on access
  to earlier chat, personal memory, or session-state artifacts.
- Treat `README.md` as the project entry point and setup guide,
  `ARCHITECTURE.md` as the detailed design record, and this file as implementation
  guardrails and documentation-maintenance instructions.
- Keep `docs\administration.md` aligned with actual platform/tenant duties,
  provisioning order, admin appointments, and user/content permission workflows.
  Distinguish application roles from human Fabric/Azure rights and tenant service
  principals; do not describe deferred portal uploads as implemented.
- New-tenant setup and the own-tenant admin **Add sample report** action use the fixed backend asset
  `samples\Store Sales.pbix`. Import with the tenant principal into its resolved
  workspace, checkpoint the import ID, synchronize metadata/navigation and publish
  only the returned sample report/model. Keep publication/checkpoint atomic and
  preserve later tenant-admin edits on retry. General-purpose uploads remain
  deferred; seeding does not grant platform admins tenant content access.
  Standalone sample operations reuse SQL checkpoints/leases, enforce current
  own-tenant admin status and a pinned workspace, and never run infrastructure
  steps or change grants/readiness. Recognize initial/manual seeding to prevent
  duplicate uploads; tenant endpoints must not resume platform setup operations.
  An older failed setup may stop blocking sample addition only after a later
  setup succeeds and the original sample step is still pending with no upload
  intent, import ID, publication or recovery uncertainty. Preserve the original
  operation; never bypass attempted or ambiguous imports.
  Reject retries of that superseded initial request before launching its worker.
- Distinguish confirmed user requirements from recommended defaults, working
  assumptions, future goals, and unresolved decisions. Do not silently promote a
  recommendation to an accepted decision or describe planned behavior as working.
- Inspect the current code and tests, if present, to establish implementation
  reality. If code and documented requirements differ, record the discrepancy;
  do not silently redefine the intended design to match the code.
- When a request changes architecture, scope, security, workflows, or technology
  decisions, update the relevant Markdown documents in the same change before
  reporting completion, including documentation-only design discussions.
- Keep detailed behavior and rationale in `ARCHITECTURE.md`, capabilities and
  setup instructions in `README.md`, and mandatory guardrails here
  consistent. Replace superseded statements rather than leaving contradictory
  alternatives presented as current requirements.
- Persist accepted decisions, relevant rationale, rejected alternatives that
  explain the design, scope boundaries, open questions, and material unresolved
  implementation gaps. A new session must not need the conversation to recover
  these facts.
- When implementation begins or changes, document implemented versus planned
  capabilities and development/deployment procedures as appropriate.
  Keep Markdown focused on what the solution does, how it works, and how to
  deploy/operate it. Do not add deployment-success narratives, operator sign-in
  confirmations, test-result inventories, or verification-status journals.
  Retain useful health-check commands, security checks, and product limitations.
  Do not invent commands or infrastructure that does not exist.
- Before finishing, check that the documents reflect the latest user decisions
  and that local documentation links resolve. Do not create a separate session
  journal or duplicate handoff file when these documents can hold the durable
  context.
- Never persist credentials, tokens, private keys, or sensitive customer data in
  design documentation. Documentation maintenance does not authorize committing
  or pushing changes.

## Purpose

Build **Power BI Embedded SaaS Starter**, a multitenant application that provides a complete wrapper experience
around Power BI reports and semantic models in Microsoft Fabric workspaces.
The application must be deployable to Azure App Service.

An application tenant represents a customer organization. It is not the same
thing as a Microsoft Entra directory tenant, a Fabric workspace, or a capacity.
The initial architecture assumes the application creates or explicitly adopts
customer workspaces in the operator's Fabric environment, rather than accessing
customer-owned Fabric tenants.

## Current implementation and local-development contract

- The selected backend is Node.js/TypeScript with Express, not ASP.NET Core.
  Do not introduce .NET projects or require a .NET SDK.
- Use React/TypeScript for the frontend and SQL Database in Microsoft Fabric for
  local development and deployment. This replaces the earlier Azure SQL hosting
  choice. Retain the SQL driver/schema; never substitute a Warehouse, read-only
  SQL analytics endpoint, SQLite, or Cosmos.
- Root npm workspaces are `src\server` and `src\web`. Use the existing package
  scripts for build, type-checking, tests, migration, and startup.
- The backend serves the compiled frontend on the same origin. Local development
  defaults to `http://localhost:3000`, bound to loopback; production requires
  HTTPS and separate configured runtime/provisioning managed identities.
- Entra user login is a backend-for-frontend flow with PKCE and server-side
  encrypted SQL sessions. Delegated administration tokens do not go to React.
- Local Azure access uses the Azure CLI identity. The explicitly selected
  `-UseLocalSecrets` option stores application/tenant credentials in a private
  external file; Key Vault remains the default alternative and is mandatory
  in production. Non-secret
  configuration defaults to an external per-user `PBIEmbeddedAOD` directory or
  `PBIEMBEDDED_CONFIG`, never a secret-bearing repo-local environment file.
- `scripts\Initialize-FabricDatabase.ps1` provisions the dedicated management
  capacity/workspace/SQL Database and saves external `fabric-database.json`.
  `scripts\Initialize-Local.ps1` reuses it and provisions Entra plus the selected
  secret store;
  `scripts\Start-Local.ps1` builds/migrates/runs locally.
  `scripts\Deploy.ps1` provisions and deploys this initial implementation.
- Accepted first-release hosting is a single Linux App Service B1 instance and
  Key Vault with an enforced Network Security Perimeter, not VNets/private
  endpoints. Keep Fabric/model networking unchanged. `KeyVault-Network.ps1`
  uses supported ARM APIs and current/possible App Service outbound `/32` rules. Verify
  `SecuredByPerimeter` readback and fail closed; never set exemption tags or
  switch to unrestricted public access to make deployment pass.
- Production deployment must not read/write Key Vault secrets or generate their
  values locally. Use infrastructure setup's `-DeferSecrets`, grant the provisioner
  ownership of the sign-in registration, and run idempotent Azure-side credential
  initialization before portal startup. Keep the session key stable, fail closed
  on non-missing/unhealthy secrets, and never retry password generation blindly.
  Remove the obsolete script-managed deployment-source NSP rule; do not grant the
  local operator vault data access. Local development secret-store modes remain
  separate. Serialize this B1 bootstrap; scale-out locking is not implemented.
- Do not silently deploy an existing local-file secret environment to Azure.
  Require a separate production namespace/configuration or an explicitly
  approved migration of all existing tenant credentials. Keep the runtime and
  provisioner identities distinct, and production credentials in Key Vault.
- The editable Azure-icon diagram is `docs\architecture.drawio`; the Markdown
  conceptual overview is `docs\architecture.svg`; resource placement is
  `docs\architecture-deployment.svg`. Regenerate all views from
  `scripts\Export-Architecture.mjs` and keep current versus deferred components
  accurate. There is no deployed queue or independent worker service.
- All new infrastructure targets West US 3 (`westus3`), including App Service,
  vault/NSP, managed identities, resource group and the management Fabric
  capacity/workspace/SQL. Existing configurations remain pinned;
  never implicitly relocate them or substitute a split-region design.
  Check SKU/regional usage counters and run ARM Provider validation of the actual
  Linux plan before buying infrastructure. Positive counters have contradicted
  actual provider quota enforcement; they do not prove deployability.
  An omitted SKU row may defer to provider validation; do not skip that validation
  or accept missing/ambiguous total regional counters.
  Do not create or delete Azure resources
  or directory objects without an explicit request. A prior deployment is not
  blanket authorization for other infrastructure changes.
- Derive deployment names through `Get-DeploymentNames` in `scripts\Common.ps1`:
  `<NamePrefix>-<SolutionName>-<resource>`, with solution `pbiembedded` by default
  and database suffix `configdb`. No implicit hashes or truncation. Validate
  Azure limits; derive the resource group instead of accepting unrelated names.
- External deployment configuration pins naming version 2 and resolved names.
  Fail before provisioning when it uses a legacy or changed namespace; require
  an explicitly planned migration/recreation and a separate external config.
  Keep existing tenant secret references authoritative. New Fabric capacities
  use the configured namespace without hyphens to meet resource-type rules.
- Respect inherited Azure Policy. When governance modifies SQL public access to
  Disabled, stop and require the organization's approved exception or compliant
  connectivity process. Never silently add exclusion tags, change assignments,
  or broaden IP ranges to make provisioning pass.
- The user explicitly requested a dedicated management capacity, now in West US 3
  for new deployments; preserve the pinned resources of existing environments.
  Use the centrally derived hyphen-free name with `mgmt` suffix and F2 by default;
  this is billable infrastructure, not a trial or customer-report capacity.
  Do not resize other capacities or delete old Azure SQL resources. Automatic
  resume has separately been approved only for the configured management
  capacity and the signed-in user's authorized tenant capacity, through the
  explicit AutoResumeCapacities opt-in.
- Keep the management workspace/capacity separate from application tenants.
  Reject their adoption, customer capacity assignment, and in-app capacity
  mutation outside the approved automatic resume path, and fail closed for
  management-workspace runtime embedding.
  Never grant tenant embedding identities management-workspace access.
- Capacity startup is failure-driven, with no healthy-path preflight or daily
  schedule. Keep the management ARM reference in external deployment config,
  independent of SQL. Only foreground SQL connection/read failures may trigger
  its recovery before session authentication; this permits reachable anonymous
  app visits to restart management billing. Document that selected policy.
  Static assets, health probes, and background reconciliation must not wake it.
- Resolve tenant recovery from authorized tenant/workspace records and verified
  SQL WorkspaceCapacity bindings, refreshed by guided assignment/admin settings.
  Recheck current workspace assignment, reject ambiguous/stale/out-of-scope
  bindings, and never trust a client-selected capacity or resource URL.
  Resume only confirmed paused/suspended resources, coalesce concurrent starts,
  bound readiness waits, and reauthorize after startup. Never replay submitted
  writes, transactions, provisioning, saves, or interactive editing sessions.
  An initial still-inert report/editor may retry once after confirmed resume.
- Use Fabric-returned transactional SQL connection metadata, not display-name
  guesses or the same-named `SQLEndpoint` companion item. Pin resource IDs, reject
  implicit replacement/repointing, and preserve partial provisioning metadata.
  Compare region identifiers with display-name whitespace normalized.
- Fabric SQL connection requires Fabric item Read permission as well as SQL
  authorization. The current deployment uses Viewer on the dedicated management
  workspace and schema-scoped DML grants. SQL service-principal SIDs use client
  IDs; Fabric role assignments use object IDs. Tenant settings must allow the
  runtime service principal/managed identity to use Fabric APIs.
- `scripts\Test-Scripts.ps1` validates parsing, path guards, and `-WhatIf`
  behavior without provisioning. Do not confuse these checks with live testing.
- Read the architecture's limitations and future-work section before resuming.
  Preserve the distinction between implemented capabilities and deferred features.

## Confirmed architecture

- Implement distinct frontend and backend API layers. They may initially share
  an App Service origin, but frontend code must not perform privileged Fabric,
  Power BI, or Azure management operations.
- Use Power BI's App Owns Data embedding model for every embedded session,
  including viewing, editing, report creation, and Save As. Do not implement
  User Owns Data embedding or a delegated-user embedding fallback.
- Entra user sign-in authenticates access to this application, not Power BI
  embedding. Use backend-generated embed tokens as the SDK embedding credential,
  never a user's Entra access token.
- Generate embed tokens exclusively in the backend. Do not rely on browser calls
  to Power BI token-generation APIs or attempt to work around their CORS limits.
- Keep service-principal credentials and service-to-service API access tokens
  server-side. The browser receives only the short-lived embed token and the
  configuration needed for the authorized embedding operation.
- Default to Microsoft Entra authentication. Keep authentication separate from
  application authorization so third-party federation and consumer email
  identities can be supported later.
- Maintain application-owned tenant, user, content, navigation, and permission
  records in a persistent database.

## Tenant isolation: mandatory invariants

- Ordinary tenant users belong to exactly one tenant. Platform-only admins may
  have no tenant membership; a dual-role admin still has at most one. Enforce in
  SQL that null membership requires platform status, no tenant-admin flag, and
  zero default permissions. Do not implement multiple memberships or switching.
- Derive the user's tenant from the authenticated identity and trusted database
  records. Never treat a client-supplied tenant ID as authorization.
- Each onboarded tenant has its own assigned workspace. Permit pending tenants
  without a workspace or without embedding-ready configuration. Keep workspace
  mapping explicit so multiple workspaces per tenant can be added deliberately
  later; that must not imply multiple tenants per user.
- Multiple customer tenant workspaces may share one capacity. Never reserve a
  capacity for one tenant or hide it after assignment; reset assignment controls
  so it can be chosen for another tenant. Shared compute does not grant shared
  workspace/content access. The dedicated management capacity remains excluded.
- Resolve content through tenant-scoped database records and verify that the
  backing workspace belongs to the authenticated user's tenant.
- Reject cross-tenant workspace, report, and semantic-model references, including
  report dependencies. A valid external resource ID is not proof of access.
- Use tenant-aware constraints and foreign keys to prevent cross-tenant record
  associations. Scope queries, caches, background jobs, and operational records
  by tenant wherever applicable.
- Platform-wide administrative permissions must be explicit and separate from
  tenant permissions. They must not bypass tenant content/navigation/member/
  permission management or end-user embed authorization. Platform-only users
  must be rejected before tenant data or embedding identities are accessed.

## Embed-token authorization

For every embed-configuration request, the backend must:

1. Validate authentication and resolve the application user and their sole tenant.
2. Resolve the requested item and its workspace from trusted tenant-scoped records;
   new-report creation starts from an authorized semantic model, not an existing
   report ID.
3. Verify that the workspace and every required semantic model belong to that
   tenant and that the user has permission for the requested operation.
4. Select the tenant's embedding identity from trusted server-side configuration.
5. Generate a least-privilege token containing only the authorized report, when
   applicable, required semantic models, and any explicitly authorized target
   workspace needed for creation or Save As.

- Workspace ownership checks do not replace item-level permission checks.
- Do not issue broad tokens covering every item a service principal can access.
- Enable editing only when authorized. Include a target workspace only when
  required for an authorized create or Save As operation, and restrict it to the
  tenant's assigned workspace.
- Authorize semantic-model use for authoring separately from viewing or editing
  an existing report.
- Resolve any effective identities and semantic-model roles server-side.
- Hiding navigation entries or editing controls is not an authorization boundary.
- Power BI SDK Permissions is a validated enum, not the application's bitmask:
  use named Read/ReadWrite/All values. Do not combine ReadWrite with Copy (3 is
  rejected). Check configurations with the real SDK validator, not only mocks.
  Surface structured SDK error message fields without dumping configuration,
  tokens, or diagnostic payloads.
- Keep the report experience viewer-first: a compact, nonmodal Reports dropdown
  anchored below the trigger, with collapsible folders, bounded scrolling,
  outside-click/Escape dismissal, and auto-close on permitted selection.
  Preserve trigger/keyboard focus, viewport bounds, and unsaved-edit guards.
  Keep session View/Edit/Save/Save As controls, and a New
  report action opening an authorized semantic-model chooser.
- Compact the app chrome globally: a combined header/navigation/account bar,
  reduced page/form spacing, and no persistent footer. Opening a report keeps
  that shell visible. Full-viewport Focus/Exit focus is explicit and default off;
  resize the existing iframe without reauthorization, reload, or lost edits.
  Reset focus on close/leaving My reports. Keep secondary actions under More.
  Flex both normal/focused canvases without a fixed minimum height.
- Existing reports obtain backend authorization, then use standard service.embed
  at the full returned report URL. Phased embedding is disabled: do not call
  service.load/report.render or show phased fallback notices. Track loaded for
  progress and wait for rendered before enabling interaction. Keep initial
  capacity recovery separate and bounded; never broaden tokens or restart saves
  or already-interactive sessions.
  Invalidate old-instance callbacks and ignore disposed authorization/events.
  Keep new-report creation on createReport, ready on loaded.
- Reauthorize saves and mode changes through the backend. Save As must preserve
  the current editor/unsaved changes, use only its server-returned tenant
  `targetWorkspaceId`, and never accept a selectable destination workspace.
  Wait for SDK save confirmation before reconciliation/success, close newly
  created unpublished content, and warn before discarding an editing session.
- Do not log credentials or bearer tokens. Account for embed-token expiry and
  renewal, and do not assume issued tokens are immediately revoked by ACL changes.

## Future goal: effective-username row-level security

- Plan for RLS using an effective username when configured on a semantic model.
  Treat this as a future capability, not initial RLS authoring or model changes.
- Resolve the effective username, required RLS roles, and applicable model IDs
  server-side from trusted user and tenant/model configuration. Match the model's
  expected identity convention rather than assuming every username is an email.
- Never trust browser-supplied effective usernames or RLS roles.
- Keep RLS additive to tenant isolation and item authorization, and reauthorize
  effective identities when renewing embed tokens.
- Models without RLS use ordinary authorization. If a model requires an effective
  identity that is unsupported or cannot be safely resolved, fail closed; never
  omit it or retry with an unfiltered token.

## Administration and content management

- Provide a platform admin console for tenant provisioning, workspace creation,
  user assignment, and designation of tenant administrators.
- Provide one-time, authenticated first-run setup with an explicitly authorized
  operator who has sufficient workspace-creation permissions. Do not grant
  platform administration to the first arbitrary person to sign in.
- Keep bootstrap eligibility in trusted deployment configuration. Persist setup
  progress/completion, handle concurrent starts safely, and do not reopen setup
  on routine restarts or transient database failures.
- Establish new bootstrap administrators as platform-only, without a tenant,
  tenant-admin role, or report permissions. Preserve existing memberships and
  role flags on upgrade; never silently strip or expand them.
- Keep Platform admin and Tenant admin views separate, including for dual-role
  users. Never mount TenantManager inside platform screens.
- Report usage measures only the first completed existing-report render per
  open/reload. Keep the original monotonic start and signed receipt across
  capacity recovery; never count token refreshes, later SDK renders or unsaved
  new-report editor readiness. Bind receipts to backend-authorized user/tenant/
  report/workspace context, authenticate and CSRF-protect completion, and make
  storage idempotent. Do not persist tokens/report data or let tracking failures
  block report consumption. Schema migration 4 is required for render storage.
  Future admin insight reports require isolated tenant data and explicit admin
  access; their onboarding packaging is still deferred.
- Platform administration has separate Fleet Management, Tenant Details and
  Add Tenant screens. `platform.tsx` owns hash navigation; `tenant-details.tsx`
  owns the existing guided setup/admin/readiness workflow. Fleet lists every
  registered tenant, including unconfigured/unmapped ones, with associated
  capacity state and shared-impact confirmations. Keep fleet lifecycle/policy
  controls out of tenant details and creation forms. Accepted setup/adoption
  opens its details, never cancels work on navigation, and retains checkpoints.
  Configuration checks inspect saved state and must not overwrite unsaved fields.
  Targeted tenant repairs may resume only currently verified customer compute,
  with explicit billing/shared-impact confirmation, or restore confirmed configured
  principal workspace access. Inspect membership before add/update; observe
  accepted resume before readiness recheck. Replacement compute uses the existing
  durable setup form. Never replay repairs, recreate uncertain identities, or
  infer that a generic 403 proves a missing workspace role.
- Keep tenant onboarding as one guided form: workspace name, admin UPN, and
  existing/shared capacity or new capacity size with billing confirmation.
  Service-principal creation is implied; the backend orchestrates identity,
  optional capacity, workspace, access, capacity assignment, admin appointment,
  and actual runtime readiness. HTTP 202 is not completion.
- When guided provisioning creates a new tenant, explicitly grant its initial
  admin `allPermissions` as root defaults alongside the tenant-admin role.
  Persist the server-derived new-tenant context and commit permissions with
  primary-admin metadata; retries must not overwrite later permission edits.
  Do not retroactively elevate existing tenants or legacy operation records.
  This is not a role-based ACL, publication, RLS or tenant-isolation bypass.
- Persist setup operation IDs, step checkpoints, and worker leases in SQL.
  Heartbeats renew leases only, never overwrite progress or terminal status.
  Keep delegated tokens in memory, not operation JSON or browser storage.
  Preserve partial resources on failure; require original-operator resume after
  lease expiry, and manual reconciliation for unknown app/workspace creations.
- Opening an existing tenant must load editable observed settings. Saving reuses
  its workspace and identity. Confirm primary-admin replacement, remove only the
  old primary's admin role, and preserve memberships, other admins, navigation,
  and report permissions. Capacity creation remains billable after later failure.
- Only platform admins appoint/revoke tenant admins through dedicated endpoints.
  Permit same-tenant promotion and attachment of an unassigned platform admin;
  reject implicit moves/second memberships. Preserve existing item permissions
  and give additional appointments no automatic report access. Tenant admins manage their
  own tenant's ordinary members, content, navigation, and item permissions,
  but may not set administrator flags through tenant user APIs.
- Tenant-admin appointment and tenant-user registration support exact UPN lookup
  through backend Microsoft Graph calls under the provisioning identity. Validate returned object ID and
  exact UPN, safely escape OData keys, and select only basic identity fields.
  Keep immutable object IDs as database/audit keys and retain manual-ID entry.
  Never accept mixed UPN/manual override fields or search by ambiguous email
  aliases. Production deployment checks provisioning Graph `User.Read.All`;
  granting it requires explicit authorized consent, never a lookup-time grant.
- Authorize ordinary user registration against the caller's explicit tenant-admin
  role before directory lookup. Accept selected permission masks but never admin
  role flags. Reject existing identities and second memberships; UPN lookup must
  not bypass the checks used by manual object-ID registration.
- Bootstrap must not require workspace adoption or creation. These are ongoing
  platform admin workflows, independent of successful initial setup.
- Verify setup capabilities independently: workspace creation does not imply
  administration of existing workspaces, directory provisioning, capacity control,
  or permission to change tenant settings.
- Any delegated operator API calls for setup remain backend-only and separate
  from App Owns Data embedding. Do not use the setup user's credentials as the
  normal runtime service identity.
- Let the platform admin screen enumerate discoverable workspaces, adopt an
  unmanaged workspace as a new application tenant, or create a new tenant and
  workspace from scratch. Discovery must not onboard or expose content.
- Enforce an exclusive application-tenant mapping per external workspace.
  Separate tenant registration from embedding readiness: allow adoption with
  missing capacity or runtime access and keep the tenant manageable but blocked
  from end-user embedding until required checks pass.
- Show per-workspace readiness checks, last-check time, and actionable findings
  for missing/ineligible/paused capacity, missing or insufficient service-principal
  access, identity/API configuration issues, and blocked content dependencies.
- Provide authorized backend actions to assign/change capacity, grant the
  configured service principal appropriate workspace access, and recheck readiness.
  Show required permissions or manual steps when automatic repair is unavailable.
- Validate runtime access using the actual tenant embedding identity, not merely
  the signed-in administrator. Distinguish confirmed misconfiguration from an
  unknown result caused by failed diagnostics; do not treat every 403 as proof
  of a missing workspace grant.
- Keep onboarding, readiness, and content-publication state separate. Recheck
  configuration periodically and after repairs; health status is not a substitute
  for per-request authorization or safe embed-token generation.
- Import adopted content as administrator-only and unreviewed. Preserve existing
  artifacts, capacity assignments, ownership, and permissions unless an explicit
  authorized operation requires a reviewed change.
- Use an explicit managed-workspace allowlist for ordinary synchronization,
  navigation, and token generation. Unselected workspaces remain unmanaged even
  if a service identity or administrator can access them.
- Provide platform administration of Fabric capacities: create, delete, resize,
  pause, resume, and assign capacities to tenant workspaces.
- `src\server\src\capacity-management.ts` owns protected ARM inventory, live tenant
  associations, state-aware changes and bulk pause/resume. The platform UI in
  `src\web\src\capacity-manager.tsx` shows fleet/shared tenant resources and
  observes accepted requests independently; never equate HTTP 202 with completion.
- Bulk capacity actions require exact confirmed resource names and current
  registered-workspace assignments. Target each shared capacity once within the
  configured subscription/resource group, exclude management/unassigned resources,
  and block on unverifiable/ambiguous mappings. Never substitute cached recovery
  bindings for current assignments or accept browser-supplied ARM scope/URLs.
- Continue after individual bulk failures and audit each result; stop further
  requests if audit storage is unavailable. Never replay capacity writes
  automatically or imply rollback. Closing the page stops browser polling, not
  submitted Azure work; backend submission is not a durable queue.
- `capacity-policy.ts` and the platform automatic-resume control manage a global
  persisted billing opt-in. Store its versioned revision in the existing external
  credential store, not SQL, and load it before SQL-backed sessions. Saved policy
  overrides the deployment default; denied/invalid/disabled/expired records fail
  closed, never silently revert to an enabled env flag. Use existing runtime
  reader/provisioning writer permissions, not broad App Service settings-write
  access. Require platform authority, CSRF, current revision, billing confirmation
  on enable, and global audit. Never automatically retry uncertain policy writes.
- Keep Azure capacity resource management separate from Fabric/Power BI workspace
  management. Apply the permissions required by each API independently.
- Use a separately scoped provisioning identity for privileged resource changes;
  ordinary embedding identities must not receive capacity-deletion privileges.
- Treat provisioning and capacity changes as asynchronous operations with audit
  history and safeguards for affected tenants. Provisioning uses durable SQL
  checkpoints; capacity controls currently observe ARM state in the browser,
  with explicit retries only after inspecting potentially submitted work.
- Tenant administrators manage users and permissions only within their tenant.
  Managing application users does not imply general Entra directory admin rights.
- Support distinct permissions for viewing, editing, creating, and copying reports,
  authoring against semantic models, deploying semantic models, managing content,
  managing navigation, managing permissions, and managing tenant users.
- Treat roles as permission bundles rather than hardcoding role-name checks.
- General-purpose PBIX upload remains deferred beyond the fixed bundled demo
  seed. When implemented, authorize
  effective `ManageContent` permission rather than requiring tenant-admin status
  solely for upload. Import server-side only into the authenticated user's tenant
  workspace and preserve existing item registration/publication/security checks.
- Enforce authorization in backend endpoints, including token generation,
  navigation changes, user administration, and content management.

## Navigation and permissions

- Default to a flat report list.
- Allow tenant administrators to create a hierarchical navigation structure and
  assign permissions at the tenant root, folder, and item levels.
- Store application navigation separately from physical workspace organization.
- Keep one shared navigation hierarchy per tenant, not per-user layouts. User
  grants filter report access/visibility within that shared hierarchy. Tenant
  context is implicit in Tenant admin: exclude the root from the navigation-item
  selector, use "Top level" for root placement, and separate structure editing
  from user access/inheritance controls.
- Support authorized changes to navigation labels without requiring the backing
  Power BI report to be renamed.
- Define inheritance behavior explicitly and evaluate effective permissions in a
  shared backend authorization component.
- Prefer default-deny, inherited grants, and explicit inheritance breaks for the
  initial implementation; do not introduce explicit-deny precedence casually.
- Prefer one canonical security parent per report initially. Additional navigation
  links must never bypass the report's canonical authorization policy.
- Treat moves and inheritance changes as permission changes and audit them.

## Content registration and reconciliation

- Track reports, semantic models, workspaces, and report-to-model dependencies by
  immutable external IDs rather than display names.
- Register successful application-controlled creations and deployments promptly.
  Verify browser-originated save notifications against backend API results.
- Reconcile workspace contents periodically and support an administrator-triggered
  synchronization to detect out-of-band creation, updates, and deletion.
- Do not assume Fabric workspace item events cover Power BI reports and semantic
  models. Verify current support before adopting an event-driven alternative.
- Put newly discovered out-of-band content in an administrator-only, unreviewed
  state until its permissions are configured.
- Make synchronization idempotent and tolerate throttling and partial failures.
  A failed workspace listing must not be interpreted as deletion of its contents.
- Use retryable workflows and an outbox where appropriate; do not assume SQL and
  Fabric operations can participate in one atomic transaction.

## Required deployment automation and secret hygiene

- A complete deployment entry-point script must ship with the implementation and
  remain current whenever code, infrastructure, configuration, or identity
  requirements change. Do not treat deployment as a later optional deliverable.
- The script must provision or explicitly reuse all resources needed by the
  selected environment, create required Entra application registrations and
  service principals, configure supported permissions, build/publish code, apply
  migrations, deploy all components, and verify application health.
- Document tooling, Azure resource permissions, Entra/Graph permissions, consent,
  and required tenant settings as prerequisites. Automate supported steps and
  fail clearly when external administrator action is required.
- Enable or attach the runtime managed identity and grant it least-privilege
  Key Vault secret-read access to the credentials it actually needs. Keep
  provisioning/secret-write privileges separate from runtime read privileges.
- Prefer supported managed identity or federation. When a credential must be
  generated, capture it in memory and store it directly in Key Vault through
  supported secure APIs for production. The user explicitly authorized a
  local-development-only external secret file via `-UseLocalSecrets`; restrict
  its Windows DACL to the current account and do not sync it anywhere.
  Deploy only secret references and non-secret settings.
- `App.LocalSecretsPath` explicitly selects the local file; never silently fall
  back from Key Vault. Reject checkout paths and links into the checkout, and
  reject local-file credentials in production or App Service regardless of
  NODE_ENV. Missing/invalid/expired secrets fail closed without logging values.
  Store only the file path in application configuration. New locally provisioned
  tenant credentials use the same file. One local process per secret file.
- Never create or persist real secrets anywhere under the repository root,
  including gitignored files, `.env` files, local application settings, generated
  parameter files, credential exports, deployment state, and build artifacts.
- Never put secrets in documentation, examples, frontend bundles, command-line
  arguments exposed to process inspection, logs, transcripts, or deployment
  outputs. Example configuration must contain placeholders only.
- Do not assume `.gitignore` is a security control. Add appropriate prevention
  and secret-scanning checks when implementation and CI are introduced.
- Make provisioning repeatable without recreating identities or resetting
  credentials unnecessarily. Support explicit secret rotation without logging
  old or new values, and wait for permission propagation with bounded retries.
- Verify Key Vault reads under the actual runtime identity; the deployer's
  successful access is not sufficient. Check that the selected secret-delivery
  mechanism is supported by the hosting environment.
- Keep initial environment deployment separate from customer workspace adoption
  and embedding readiness. A deployable app must support an empty admin console.

## Selected stack and remaining implementation defaults

Preserve the selected stack. Recommendations for future components do not mean
those components are already deployed or implemented:

- React and TypeScript with the Power BI JavaScript SDK for the frontend.
- Node.js and TypeScript with Express and MSAL Node for the backend; Node.js 22
  LTS is the App Service target.
- SQL Database in Microsoft Fabric for relational tenant, user, authorization, navigation,
  content, and operational records, including local development. Cosmos DB and
  SQLite are not the selected implementation.
- A modular monolith with clear module boundaries rather than microservices.
- Dedicated service principals per tenant authorization boundary. Evaluate current
  API support before using service principal profiles; profiles are not supported
  by Fabric REST APIs.
- Managed identity and federated credentials where supported; otherwise protect
  credentials with Azure Key Vault and plan rotation.
- Five-minute in-process polling initially; durable processing using a worker or
  Azure Functions with Service Bus remains planned.
- Sanitized logs and health endpoints initially; Application Insights, Azure
  Monitor, and Fabric capacity metrics remain the richer operational direction.

Use an internal user ID and stable external identity identifiers such as issuer
and subject. Do not use email as the identity key or automatically link accounts
solely because email addresses match. A successful sign-in alone must not grant
tenant membership.

## Explicitly out of scope for now

- Semantic-model data-source connectivity and credential configuration.
- Gateway architecture, gateway deployment, and gateway management.
- VNet design and private networking configuration.

Assume semantic models have working data connections. Continue tracking semantic
models and dependencies for content discovery, tenant isolation, and token scope.
Do not expand provisioning into data-connectivity automation without an explicit
request.

## Engineering and validation

- Keep changes focused and follow established repository patterns as they emerge.
- Add focused tests for tenant isolation, permission inheritance, and token scope.
- Cover attempts to substitute another tenant's workspace, report, or model IDs,
  unauthorized authoring, unreviewed content access, and cross-tenant dependencies.
- Validate backend behavior, not just UI visibility.
- Verify current Microsoft documentation for identity support, licensing, API
  limitations, and capacity behavior before depending on those capabilities.
- Do not commit or push changes unless the user explicitly asks.
