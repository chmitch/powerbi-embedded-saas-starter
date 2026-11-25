# Operations and existing-environment updates

Use this guide to update an **existing** Azure application without rerunning
infrastructure provisioning. It is a procedure, not a record of the last
deployment. Discover the current checkout, schema and Azure state each time.

[New-environment setup](../README.md#deploy-to-azure) |
[Development](development.md) |
[Architecture](../ARCHITECTURE.md#deployment-and-secret-handling) |
[Administrator guide](administration.md)

## Choose the right operation

| Intent | Procedure |
| --- | --- |
| Create a new environment or explicitly change infrastructure/grants | README `scripts\Deploy.ps1` workflow |
| Change application code with existing infrastructure | Application-only ZIP update below |
| Apply a required database migration | Explicit migration step below, before code publication |
| Manage a customer tenant/capacity | Administrator guide; not environment deployment |

Full `Deploy.ps1` can provision/reconfigure resources, assign roles/consent,
initialize credentials, set app settings/startup and enable Always On. It is not
the routine code-update command. Do not run it merely because an old session did.
Deployment approval does not authorize unrelated infrastructure or Git changes.
Use the single Linux B1 target; there are no staging slots or HA guarantee, and
an in-place deployment/restart can interrupt service.

## Recover and verify environment pins

Use the original externally stored `configuration.json` and companion
`fabric-database.json`. The Windows runtime default is
`%LOCALAPPDATA%\PBIEmbeddedAOD\configuration.json`; explicitly selected environments
may instead use `%LOCALAPPDATA%\PBIEmbeddedAOD\<environment>\configuration.json`.
`PBIEMBEDDED_CONFIG` selects the runtime file. If the files are missing, recover
them through the approved environment owner/backup process; do not reconstruct
credentials, infer SQL endpoints from names, or provision replacement resources.

The external `App` section pins directory/client/bootstrap, subscription/resource
group, SQL endpoint/catalog, management IDs, vault reference and namespace.
`Deployment` holds resolved web app, identities and other provisioning references.
Use `scripts\Common.ps1` naming/configuration guards when explicitly provisioning.
Existing configurations are authoritative; changed defaults do not relocate them.

Use a dedicated operator PowerShell 7 session from the repository root. Keep the
variables from these examples in that same session and set the target from the
existing file:

```powershell
$ErrorActionPreference = 'Stop'
$configurationPath = '<absolute-external-configuration-path>'
$configuration = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
$subscription = $configuration.App.SubscriptionId
$resourceGroup = $configuration.App.ResourceGroup
$webName = $configuration.Deployment.WebAppName
if (-not $subscription -or -not $resourceGroup -or -not $webName) {
    throw 'Recover and verify the existing deployment configuration first.'
}
az account show --subscription $subscription --query '{subscriptionId:id,tenantId:tenantId}' --output json
if ($LASTEXITCODE -ne 0) { throw 'Azure account verification failed.' }
az webapp show --subscription $subscription --resource-group $resourceGroup --name $webName `
    --query '{id:id,host:defaultHostName,location:location,state:state,identities:identity}' --output json
if ($LASTEXITCODE -ne 0) { throw 'App Service target verification failed.' }
```

Before any writes, verify the actual app, directory/subscription, resource group,
management Fabric/SQL IDs and vault against the approved external configuration.
Resolve cloud managed identities against their pinned deployment resources.
Local `PublicOrigin` may intentionally be localhost and local managed-identity
settings may be empty for CLI access; do not copy these over cloud settings.
Use the actual returned HTTPS hostname for `$origin`, not a guessed name.

Read cloud settings/configuration using authorized tooling and retain comparison
fingerprints in memory for post-deployment checks. Compare settings, runtime,
startup command, health path and Always On. Do not print/export raw settings or
save secret-bearing responses. An app-only update must preserve existing values,
including **the observed Always On value**, even if the full provisioning script
would choose a different default.

Production startup remains the existing Azure-only credential initializer
followed by `node src/server/dist/index.js`. Do not regenerate session keys,
export vault values, grant the local operator vault data access, or change NSP/
RBAC as part of application-only deployment.

## Application-only ZIP update

### 1. Validate the intended source

Inspect branch/worktree and requested changes; deployment does not require a
commit and must not discard unrelated edits. Restore dependencies only after
manifest changes or a missing-package failure. Run the relevant tests and:

```powershell
npm run check
npm test
npm run build
```

Stop on failures. Run the PowerShell suite if scripts changed. For UI/embedding
behavior, perform appropriate real-browser checks; mocks/types are not sufficient.
See [development validation](development.md#validation-by-change).

### 2. Check schema compatibility

Compare `src\server\src\migrations.ts` with `app.SchemaVersions` in the actual
management SQL database. Initial render tracking needs migration 4; request
tracking/insights need migration 5. Check current source rather than assuming that
5 will always be latest. Analytics principal mapping requires migration 6.
Ordinary server startup and application-only ZIP
publication do **not** migrate SQL.

If migration is required, obtain explicit approval for that database write and
use the migration procedure below before publishing code. Do not change runtime
grants or fabricate rows to make verification pass. Preserve existing migration
history and use the maintained migration application lock.

### 3. Package a Linux production artifact

Run from the repository root after successful build. Keep artifacts outside the
checkout in a unique, explicitly resolved temporary directory. Include:

- Root `package.json` and `package-lock.json`, and both workspace manifests.
- Compiled `src\server\dist` and `src\web\dist`.
- Fixed backend asset `samples\Store Sales.pbix`.
- Lockfile-restored **Linux/x64 production dependencies**, not copied Windows modules.

The following builds the archive only; it performs no Azure deployment:

```powershell
$artifactDirectory = Join-Path ([IO.Path]::GetTempPath()) "PBIEmbeddedAOD-$([Guid]::NewGuid().ToString('N'))"
$package = Join-Path $artifactDirectory 'package'
$zip = Join-Path $artifactDirectory 'application.zip'
$lock = Get-Content -LiteralPath 'package-lock.json' -Raw | ConvertFrom-Json -AsHashtable
foreach ($entry in $lock.packages.GetEnumerator()) {
    if (-not $entry.Value['dev'] -and $entry.Value['hasInstallScript']) {
        throw 'Production install hooks require a reviewed Linux build; do not silently skip them.'
    }
}
New-Item -ItemType Directory -Path (Join-Path $package 'src\server'), (Join-Path $package 'src\web'), `
    (Join-Path $package 'samples') -Force | Out-Null
Copy-Item -LiteralPath 'package.json', 'package-lock.json' -Destination $package
Copy-Item -LiteralPath 'src\server\package.json' -Destination (Join-Path $package 'src\server')
Copy-Item -LiteralPath 'src\web\package.json' -Destination (Join-Path $package 'src\web')
Copy-Item -LiteralPath 'src\server\dist' -Destination (Join-Path $package 'src\server') -Recurse
Copy-Item -LiteralPath 'src\web\dist' -Destination (Join-Path $package 'src\web') -Recurse
Copy-Item -LiteralPath 'samples\Store Sales.pbix' -Destination (Join-Path $package 'samples')
Push-Location $package
try {
    npm ci --omit=dev --ignore-scripts --os=linux --cpu=x64 --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'Linux production dependency restore failed.' }
    node --input-type=module -e "await import('express'); await import('mssql'); await import('@azure/identity'); await import('@azure/keyvault-secrets');"
    if ($LASTEXITCODE -ne 0) { throw 'Production dependency import failed.' }
} finally { Pop-Location }
$applicationFiles = @(Get-Item -LiteralPath (Join-Path $package 'package.json'), (Join-Path $package 'package-lock.json')) +
    @(Get-ChildItem -LiteralPath (Join-Path $package 'src'), (Join-Path $package 'samples') -Recurse -File |
        Where-Object { $_.FullName -notmatch '\\node_modules\\' })
$expectedHashes = @{}
foreach ($file in $applicationFiles) {
    $expectedHashes[[IO.Path]::GetRelativePath($package, $file.FullName)] =
        (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
}
[IO.Compression.ZipFile]::CreateFromDirectory($package, $zip, [IO.Compression.CompressionLevel]::Fastest, $false)
```

Keep imports sequential; concurrent local module loading has produced loader
races unrelated to the running app. Fail on missing build/sample assets. Check
the archive layout, and record SHA256 hashes of application files for comparison
after publication (`$expectedHashes` stays in memory); do not include
configuration, credentials or cloud logs.

Archive creation may take several minutes. If an assistant shell call backgrounds
while waiting, read that original execution rather than launching a competing
archive build.

### 4. Publish once

After explicit deployment authorization and pin/schema checks:

```powershell
az webapp deploy --subscription $subscription --resource-group $resourceGroup --name $webName `
    --src-path $zip --type zip --clean true --restart true --async false `
    --track-status false --timeout 600000
if ($LASTEXITCODE -ne 0) {
    throw 'Inspect the submitted deployment before considering any retry.'
}
```

Retain the returned deployment ID. Azure/Kudu status **4** means deployment
succeeded; an accepted request or CLI timeout alone does not establish success or
failure. Inspect that same deployment using Azure/Kudu and its logs:

```powershell
az webapp log deployment show --subscription $subscription --resource-group $resourceGroup `
    --name $webName --deployment-id '<returned-deployment-id>' --output json
```

Deployment logs are diagnostic, not a substitute for terminal deployment status.
Do not resubmit an ambiguous accepted deployment. No appsettings/configuration,
Graph, role-assignment, capacity or vault changes are part of this step.

### 5. Verify the deployed result

```powershell
$origin = 'https://<actual-returned-app-hostname>'
if ((Invoke-RestMethod "$origin/health/live").status -ne 'live') { throw 'Liveness failed.' }
if ((Invoke-RestMethod "$origin/health/ready").status -ne 'ready') { throw 'Readiness failed.' }
```

Also verify:

- Published HTML/assets and backend/manifests/sample match the staged SHA256
  hashes, using approved authenticated Kudu VFS access for server-only files.
- Anonymous access remains denied on protected APIs, including administrator
  insights. Exercise changed UI/API behavior with the intended authenticated role.
- Cloud settings/startup/runtime/Always On/health configuration match the baseline.
- Actual read-only SQL queries needed by the change succeed under the runtime's
  permissions; for insights, check aggregate and own-tenant query shapes and ranges.

Readiness checks migrated SQL and required runtime credentials; it does not prove
tenant report embedding. Do not fabricate users/usage, broaden SQL grants, or
resume customer capacity just to validate metadata-backed insights. Kudu's command
runtime/identity environment can differ from the running application; an isolated
Kudu module probe is not authoritative proof that the application failed.

### 6. Clean up and report

Remove only the specific resolved archive, package directory and helper files
created for this release after verification. Never recursively delete a workspace,
session root or unrelated artifacts. Treat server logs as sensitive.
Report failures/limitations plainly; do not claim an authenticated browser test
was performed when only health/anonymous/read-only checks ran.
Keep deployment results in the operational system or conversation, not a growing
repository success journal. Commit/push only with separate explicit authorization.

## Explicit database migration

Use the approved external production target with an authorized workforce SQL
migration identity; the runtime has schema DML, not migration DDL rights.
Fabric item Read permission and SQL authorization are both required.
Do not use local production Key Vault reads or startup secret initialization.

In a dedicated operator shell, clear stale `App__*` overrides, select the external
file, disable recovery for this operation, and explicitly select CLI identity:

```powershell
$env:PBIEMBEDDED_CONFIG = $configurationPath
$env:NODE_ENV = 'development'
Get-ChildItem Env: | Where-Object Name -like 'App__*' | ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$env:App__RuntimeManagedIdentityClientId = ''
$env:App__ProvisioningManagedIdentityClientId = ''
$env:App__AutoResumeCapacities = 'false'
node .\src\server\dist\index.js --check-database
if ($LASTEXITCODE -ne 0) { throw 'Database target/connectivity verification failed.' }
node .\src\server\dist\index.js --migrate
if ($LASTEXITCODE -ne 0) { throw 'Database migration failed; do not publish incompatible code.' }
```

First verify the configured catalog/management resource IDs against the approved
environment; `--check-database` confirms connectivity/catalog, not authorization
to migrate. These command modes do not start the portal or run its initializer.
Close this dedicated shell afterward so overrides do not affect later work.
Recheck migration versions and runtime schema permissions with read-only queries.
Do not automatically call `--grant-database-principal` during app-only updates.

## Incremental tenant analytics setup

This opt-in procedure reuses the existing management capacity and tenant
embedding principals. It does not purchase compute, publish a data agent, add
chat, or create a platform-summary source. Service-principal agent authentication
is preview. Obtain separate approval for infrastructure/grants, database changes,
and application publication; do not run full Deploy for this existing-environment
change. Resuming paused management capacity requires explicit billing approval.

After tests/build, use the authoritative external configuration:

```powershell
.\scripts\Initialize-Analytics.ps1 -ConfigurationPath $configurationPath -WhatIf
# With explicit resource/directory-grant approval:
.\scripts\Initialize-Analytics.ps1 -ConfigurationPath $configurationPath `
    -ResourcesOnly -GrantGraphPermissions
```

The script creates/pins `<base>-agents` and `<base>-analytics-readers`, assigns the
existing management capacity, confirms existing principal IDs, adds reader-group
membership and agent-workspace Contributor, and grants the provisioning identity
Graph `GroupMember.ReadWrite.All` only when approved. Existing mismatched pins,
roles or unpinned name collisions stop setup, rather than implicit adoption or
replacement. A resources-only result does **not** install SQL security.

In Fabric, share the management SQL database to the new reader group with
**Read only; every additional permission checkbox unchecked**. Do not give
ReadData, ReadAll, Write or management-workspace membership. Review inherited
workspace/group and preexisting item/SQL access as well as direct assignments.
Sharing may take up to two hours to propagate.

With database-write approval, rerun without `-ResourcesOnly`:

```powershell
.\scripts\Initialize-Analytics.ps1 -ConfigurationPath $configurationPath
```

This applies migration 6 and trusted principal mappings on transactional SQL,
then independent RLS/view/grant setup on the pinned analytics endpoint.
If tables have not replicated, inspect the database's **Replication > Monitor
replication** and retry the same setup after propagation. Never substitute empty
tables or an unfiltered view. Existing changed/disabled predicates fail closed
and require explicit review rather than automatic policy replacement.

Tenant Insights requires the updated `analytics` views (including request/render
history fields and GUID casts) before code publication. In an environment whose
resources and mappings are already initialized, run the built server's
`--setup-analytics` mode with the external configuration and approved SQL setup
identity; no new migration is needed for this view update. The existing enabled
policy is validated, not replaced. Tenant queries then use the tenant principal
and database RLS, without tenant predicates or shared-identity fallback.
Replication lag can delay inventory/telemetry visibility. Platform aggregates
remain on transactional SQL.

Add only the six new `App__` settings from external `App` pins to the existing
App Service: `AgentWorkspaceId`, `AnalyticsReaderGroupId`,
`AnalyticsReaderGroupName`, `AnalyticsEndpointId`, `AnalyticsSqlServer`,
`AnalyticsSqlDatabase`. Preserve all existing settings, identities, startup,
NSP/Key Vault access and observed Always On. Publish tested application code
with the application-only procedure, with explicit approval.

Using an authenticated platform session and CSRF, existing/manual tenants can
POST `{}` to `/api/admin/tenants/<id>/analytics` to reconcile grants, then POST
`{}` to `/api/admin/tenants/<id>/analytics/verify`. Verification uses the existing
secret **inside the backend**, never an operator-exported credential. Require
success for every existing principal, including visible own data, no foreign data,
denied sensitive reads and no SQL security-altering privileges. Do not broaden
permissions or grant the local operator vault access if verification fails.

Only after those checks should an operator author/publish the tenant data agent
in the isolated workspace, selecting approved `analytics` views only. Treat
effective-access questions, chat integration and platform aggregate-only agent
setup as separate unfinished work, not capabilities supplied by this procedure.

## Recovery and operating constraints

- **Rollback:** redeploy a known-good source/lockfile artifact after confirming
  compatibility with the current schema. SQL rollback/restore is separate and
  requires an approved recovery plan; there is no automated down-migration.
  A Kudu application ZIP omits installed dependencies and is not a complete release.
- **SQL/sign-in unavailable:** inspect management compute, pinned connection
  metadata, migrations and actual runtime permissions. Health probes never resume
  compute. Saved disabled recovery policy overrides an environment default;
  an authorized Azure operator may need to restore management compute explicitly.
- **Key Vault denial:** verify actual runtime/provisioning identity RBAC and NSP
  egress separately. Never open the vault publicly or generate replacement secrets
  locally. The session key must remain stable.
- **Interrupted tenant setup/import:** reopen checkpoints and use the original
  authorized operator's explicit retry after lease expiry. Reconcile unknown
  resource/import outcomes; do not replay writes or delete partial resources.
- **Usage investigation:** management SQL `app.ReportRequests` contains initial
  attempts, `app.ReportRenders` completed initial render timings, and `app.Audit`
  operational audit. Tracking is best-effort, not CU/billing data; user-level
  insight access belongs only to that user's own tenant administration.
- **Teardown:** requires explicit approval and specific resource scope. Fabric/
  Entra objects are separate from ARM resource-group deletion; purge-protected
  vault names remain retained. Do not treat deployment approval as cleanup approval.

Backup/restore, retention/offboarding, unattended CI/CD and complete production
credential rotation remain operational gaps, not procedures supplied by this
runbook. See [future work](../ARCHITECTURE.md#limitations-and-future-work).
