# Development guide

This is the task-oriented starting point for a new contributor or Copilot
session. It describes the checkout, not the state of a previous conversation or
Azure deployment.

[Project overview and setup](../README.md) |
[Architecture and decisions](../ARCHITECTURE.md) |
[Administrator guide](administration.md) |
[Operations](operations.md)

## Recover context efficiently

1. Read the README overview and `.github\copilot-instructions.md` guardrails.
2. Inspect `git status --short`, manifests and the source/tests relevant to the
   request. Preserve unrelated worktree changes.
3. Use the architecture component map and the reading map below to load only
   relevant details. Source defines current implementation; architecture records
   accepted intent. Record discrepancies instead of silently changing the design.
4. Read [limitations and future work](../ARCHITECTURE.md#limitations-and-future-work)
   before extending scope. A listed future feature is not implementation approval.

| Work | Canonical context |
| --- | --- |
| Identity/roles/membership | Architecture: authentication, administrator operating model, tenant isolation |
| Tokens, permissions, report lifecycle | Architecture: backend embed-token contract, navigation/publication |
| SQL and usage charts | Architecture: persistence, report render history and administrator insights |
| Setup/sample/capacity workflows | Architecture: provisioning/capacity sections; administration guide |
| Connected local setup | README: connected local development and configuration |
| Existing Azure deployment | Operations: application-only update and migration |

Copilot CLI reads `.github\copilot-instructions.md` as custom instructions;
ordinary linked Markdown is task context to read when needed, not a promise that
every linked file is automatically loaded. Use `/instructions` or
`copilot instruction list` to inspect discovered instructions. Do not add another
automatically loaded file merely to repeat these guardrails.

## Toolchain and repository layout

Use Node.js 22 LTS/npm. Connected setup and scripts require PowerShell 7 and
Azure CLI. Windows filesystem examples use backslashes; service URLs and Markdown
links use normal URL separators. There is no .NET SDK, local SQL substitute,
configured linter, or CI workflow.

| Path | Responsibility |
| --- | --- |
| `src\server\src` | Express APIs, auth, SQL, authorization, Fabric/Graph/ARM, provisioning and usage |
| `src\server\test` | Backend, HTTP boundaries, SQL query contracts and browser embedding helpers |
| `src\web\src` | React report experience, platform/tenant administration and native insights |
| `scripts` | Initialization, full Azure provisioning/deployment, mocked regressions, diagrams |
| `samples\Store Sales.pbix` | Fixed backend-only sample for setup/tenant-admin import |
| `docs` | Developer/operator/admin guides, generated diagrams and icon attribution |

The [architecture component map](../ARCHITECTURE.md#code-and-component-map)
identifies canonical modules. Do not create duplicate authorization, provisioning,
or telemetry implementations in the frontend.

## Local development

On a fresh checkout, restore the root lockfile with `npm ci`. For an existing
checkout, restore after dependency changes or a command reports missing packages.
Use the existing root/workspace scripts:

```powershell
npm run check
npm test
npm run build
npm start
```

Without external configuration, startup shows only the setup screen; there is no
mock authentication or database bypass. Open `http://localhost:3000`.

For connected development, follow the
[README setup](../README.md#connected-local-development). Reuse the approved
external configuration; do not provision a replacement environment simply to run
the app.

```powershell
$env:PBIEMBEDDED_CONFIG = '<absolute-external-configuration-path>'
$env:NODE_ENV = 'development'
npm run dev
```

`npm run dev` watches backend TypeScript only. Build frontend changes with
`npm run build --workspace @pbi/web`; the backend serves compiled frontend assets.
`scripts\Start-Local.ps1 -ConfigurationPath <path>` builds, applies migrations
when configuration exists, and starts the app: it is not read-only validation.
Set the external config before direct npm startup/migration commands. Clear stale
`App__*` overrides so they do not accidentally change database/identity targets.

Local HTTP must remain loopback-bound. Stop the foreground server with `Ctrl+C`;
do not terminate other processes by executable name in a shared environment.

## Validation by change

Use the smallest existing test selection covering the changed behavior. The root
`npm test` runs the complete server suite; it is not a file-selector wrapper.
Selected files can be run directly from the repository root:

```powershell
node --import tsx --test .\src\server\test\authorization.test.ts .\src\server\test\embedding-contract.test.ts
```

| Change | Checks to select |
| --- | --- |
| Tenant/item authorization and token shape | `authorization`, `embedding-contract`, applicable `http` tests |
| Membership/admin/UPN registration | `tenant-users`, `directory`, `setup-http`, applicable authorization tests |
| Report lifecycle helpers | `embedding-contract`, types/build, real-browser checks for SDK behavior |
| Request/render tracking or insight charts | `report-requests`, `report-renders`, `insights`, types/build |
| Provisioning/sample imports | `provisioning`, `sample`, `tenant-sample-http`, `setup-http` |
| Capacity/policy/repair | `capacity-management`, `capacity-http`, `capacity-policy`, `capacity-recovery`, `tenant-remediation` |
| Script/config/network/package behavior | `scripts\Test-Scripts.ps1`; application tests if contracts also change |
| Documentation only | Local link/anchor checks; parse changed command examples without executing cloud writes |

Test names above are files under `src\server\test` with `.test.ts` suffix.
Run `npm run check` and build when source/bundle behavior changes. Tests use
fixtures/mocks; the PowerShell suite exercises parsing, path guards, dry runs,
packaging, consent/NSP failures and health gates **without provisioning Azure**.
Neither proves live identity grants, customer embedding or production readiness.
Real-browser validation must cover the actual SDK/UI contract when mocks cannot.
Use explicit authorization and the operations guide for production checks.

## High-risk implementation details

Detailed contracts live in architecture and administration rather than the
automatically loaded instructions. When touching these areas:

Verify current Microsoft documentation for identity/API support, licensing and
capacity behavior before depending on new capabilities. SQL and Fabric operations
do not share an atomic transaction; design idempotent reconciliation rather than
claiming cross-service rollback.

- **Embedding:** use named SDK Read/ReadWrite/All enums, not application ACL bits
  or `ReadWrite | Copy`. Validate with the real SDK validator. Standard full-URL
  `embed` waits for `rendered`; new `createReport` waits for `loaded`. Ignore
  disposed-instance events/authorization and preserve unsaved edits across Focus,
  token renewal and Save As. Never log token-bearing configuration.
- **Report shell:** retain compact combined chrome, no persistent footer, an
  anchored/collapsible Reports popover with bounded scrolling, Escape/outside-click
  dismissal, viewport containment, trigger focus and auto-close on permitted
  selection. Keep secondary actions under More. Focus is explicit/default-off,
  resizes the same iframe and resets when leaving reports. Do not add fixed canvas
  minimum heights or bypass unsaved-edit guards.
- **Identity/ACLs:** key users by immutable directory/object IDs. Exact UPN lookup
  is backend-only and authorized before Graph access; never accept mixed manual/
  lookup fields or ambiguous email aliases. Additional admin appointments do not
  grant content access. Navigation structure and user inheritance controls remain
  separate; hide the implicit root in tenant navigation selectors and use
  "Top level" for root placement.
- **Provisioning:** accepted work survives navigation. Heartbeats renew leases,
  never progress or terminal state; delegated tokens remain in memory. Sample
  retry rules include superseded failed setup and ambiguous uploads: read the
  full [sample contract](../ARCHITECTURE.md#optional-demo-sample-seeding) before
  changing them. Do not republish artifacts edited after completion.
- **Readiness:** checks inspect saved settings, not unsaved form drafts. Unknown
  diagnostics and generic 403s are not proof of a missing workspace role. Verify
  the actual tenant principal; targeted repairs inspect existing membership and
  observe accepted compute changes before rechecking, without write replay.
- **Capacity:** bulk selection uses current registered assignments, not cached
  recovery bindings. Target shared capacity once and stop submissions when audit
  storage fails. Saved auto-resume policy/revision in the external credential
  store overrides defaults; invalid/unreadable records fail closed.
- **SQL:** use Fabric-returned transactional connection metadata and pin IDs,
  not display names or the companion `SQLEndpoint`. Runtime needs Fabric item
  Read plus SQL schema DML. SQL SIDs use client IDs; Fabric roles use object IDs.
  Failed inventory listing must not be interpreted as deletion.
- **Usage:** `app.ReportRequests` stores attempts and `app.ReportRenders`
  completed initial renders; `app.Audit` remains operational audit. Preserve
  stable request context and atomic completion linkage. Unconfirmed is not failed.
  Counts zero-fill; missing averages remain gaps. Platform APIs must not expose
  user/report detail merely because the caller also has platform authority.

## Dependencies and generated assets

Commit the root and both workspace manifests plus the root `package-lock.json`.
Update the owning manifest and lockfile together. npm owns transitive dependencies;
do not copy/delete them manually. Never commit `node_modules` or `dist`.

| Scope | Packages |
| --- | --- |
| Backend identity/auth | `@azure/identity`, `@azure/keyvault-secrets`, `@azure/msal-node` |
| Backend HTTP/validation/SQL | `express`, `express-session`, `helmet`, `zod`, `mssql` |
| Frontend | `react`, `react-dom`, `powerbi-client` |
| Tooling/testing | `typescript`, `tsx`, `vite`, `powerbi-models`, relevant `@types/*` |

Use manifests/lockfile for exact versions and `npm ls --depth=0` for installed
direct dependencies. Linux deployment packages are restored separately from local
Windows development dependencies; see operations.

Regenerate `docs\architecture.drawio`, `docs\architecture.svg`, and
`docs\architecture-deployment.svg` from `scripts\Export-Architecture.mjs`:

```powershell
node .\scripts\Export-Architecture.mjs
```

Keep diagrams accurate about current versus deferred components and retain icon
attribution. Do not manually change generated views independently.

## Keep knowledge durable

Use one canonical home per topic: README for setup, architecture for decisions/
contracts/scope, administration for human workflows, this guide for development,
operations for release/recovery. Update affected documents with the change.
Validate local links and distinguish implemented behavior from proposals.
Do not maintain duplicate session handoffs or historical success/test journals.

Configuration, secret files, deployment artifacts and cloud logs stay outside
the checkout, including ignored paths. Never include real tokens, credentials,
private keys, configuration exports or sensitive usage data in examples.
Review staged content before publication; no repository license or automated
secret-scanning pipeline is configured. Use an approved secret scanner before
publishing; absence of a configured pipeline is not a security guarantee.
Documentation work does not authorize deployment, infrastructure changes,
commit or push.
