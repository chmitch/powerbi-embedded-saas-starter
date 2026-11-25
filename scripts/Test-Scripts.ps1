#requires -Version 7.0
$ErrorActionPreference='Stop'
$failed=$false
foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.ps1) {
    $tokens=$null; $errors=$null
    $null=[Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)
    if ($errors.Count) { $failed=$true; $errors | ForEach-Object { Write-Output "$($file.Name): $($_.Message)" } }
}
if ($failed) { throw 'PowerShell parsing failed.' }
. "$PSScriptRoot\Common.ps1"
. "$PSScriptRoot\KeyVault-Network.ps1"
foreach ($prefixes in @(@(),@('0.0.0.0/0'),@('10.0.0.1/32'),@('127.0.0.1/32'),@('::1/128'),@('203.0.113.1'))) {
    $rejected=$false
    try { Assert-PerimeterAddressPrefixes $prefixes } catch { $rejected=$true }
    if (-not $rejected) { throw 'Unsafe or implicit perimeter source addresses were accepted.' }
}
$rejected=$false
try { $null=Assert-ExternalConfigurationPath (Join-Path $script:RepositoryRoot 'configuration.local.json') }
catch { $rejected=$true }
if (-not $rejected) { throw 'Repository-local configuration was not rejected.' }
$whatIfConfig=Join-Path ([IO.Path]::GetTempPath()) "pbi-whatif-$([Guid]::NewGuid().ToString('N')).json"
& "$PSScriptRoot\Initialize-Local.ps1" -NamePrefix pbitest -ConfigurationPath $whatIfConfig -WhatIf
& "$PSScriptRoot\Initialize-Local.ps1" -NamePrefix pbitest -ConfigurationPath $whatIfConfig -UseLocalSecrets -EnableCapacityAutoResume -WhatIf
& "$PSScriptRoot\Initialize-Local.ps1" -NamePrefix pbitest -ConfigurationPath $whatIfConfig -UseKeyVaultPerimeter -DeferSecrets -WhatIf
& "$PSScriptRoot\Deploy.ps1" -NamePrefix pbitest -ConfigurationPath $whatIfConfig -EnableCapacityAutoResume -WhatIf
& "$PSScriptRoot\Initialize-FabricDatabase.ps1" -NamePrefix pbitest -ConfigurationPath $whatIfConfig -WhatIf
& "$PSScriptRoot\Initialize-Analytics.ps1" -ConfigurationPath $whatIfConfig -WhatIf
if (Test-Path -LiteralPath $whatIfConfig) { throw 'WhatIf wrote deployment configuration.' }
Write-Output 'PowerShell parsing, configuration path guard, and no-provision WhatIf checks passed.'

$names=Get-DeploymentNames -NamePrefix cgm
if ($names.ResourceGroup -ne 'cgm-pbiembedded-rg' -or $names.SqlDatabaseName -ne 'cgm-pbiembedded-configdb' -or $names.VaultName -ne 'cgm-pbiembedded-kv') {
    throw 'The requested prefix-solution-resource naming model was not applied.'
}
$custom=Get-DeploymentNames -NamePrefix cgm -SolutionName portal
if ($custom.WebAppName -ne 'cgm-portal-web' -or $custom.WebClientSecretName -notlike 'cgm-portal-*') { throw 'SolutionName was not applied to dependent resource names.' }
foreach ($prefix in @('CGM','cgm--dev','cgm-','toolongpre')) {
    $rejected=$false
    try { $null=Get-DeploymentNames -NamePrefix $prefix } catch { $rejected=$true }
    if (-not $rejected) { throw 'An invalid or overlong resource namespace was not rejected.' }
}
$rejected=$false
try { $null=Get-DeploymentNames -NamePrefix cgm -ResourceGroup rg-unrelated } catch { $rejected=$true }
if (-not $rejected) { throw 'An unrelated resource-group override was accepted.' }

function Test-MockedLocalProvisioning {
    $state=@{ AzureCalls=0; ForbidVault=$false; Capacity=$null; CapacityCreations=0; Workspace=$null; WorkspaceCreations=0; Database=$null; DatabaseCreations=0; Vault=@{}; VaultResource=$null; VaultCreations=0; App=$null; Principal=$null; Group=$null; CredentialCreations=0; Secret='unit-test-only-not-a-real-credential'
        Network=@{}; BlockPerimeter=$false; RuntimeMember=$false; Roles=@(); RuntimeRole=$false; Settings=@(); Deployments=0; NpmFailure=$false; NodeCommands=@(); Healthy=$true; LegacyRuntimeCatalog=$false
        ForbidVaultData=$false; WebAppOwner=$false; Startup=''; HealthCheckPath=''; ConsentFailures=0; ConsentAttempts=0; ConsentGrants=@(); PlanQuotaFailure=$false
        SkuQuota=10; RegionalQuota=10; OmitSkuQuota=$false; PlanLocation=''; ProviderQuotaFailure=$false; PlanValidations=0; ValidationFiles=@() }
    $azMock={
        $arguments=@($args)
        $state.AzureCalls++
        if (($arguments -join ' ').Contains($state.Secret)) { throw 'A secret was passed to Azure CLI arguments.' }
        $global:LASTEXITCODE=0
        $command=$arguments[0..([Math]::Min(2,$arguments.Count-1))] -join ' '
        if ($state.ForbidVault -and $arguments[0] -eq 'keyvault') { throw 'Local-file setup must not access Key Vault.' }
        if ($state.ForbidVaultData -and $command -eq 'role assignment create' -and
            $arguments -contains 'User' -and $arguments -contains 'Key Vault Secrets Officer') {
            throw 'Azure deployment must not grant the local operator vault data-plane access.'
        }
        if ($arguments[0] -eq 'sql') { throw 'Fabric provisioning must not call Azure SQL or firewall APIs.' }
        if ($command -eq 'role assignment list' -and $arguments -contains '--scope' -and $arguments -contains '--all') {
            throw 'Azure CLI does not allow scoped role-assignment listing with --all.'
        }
        $result=switch -Wildcard ($command) {
            'account show*' { @{ id='11111111-1111-4111-8111-111111111111'; tenantId='22222222-2222-4222-8222-222222222222' }; break }
            'ad signed-in-user show' { @{ id='33333333-3333-4333-8333-333333333333'; userPrincipalName='operator@example.invalid' }; break }
            'ad app permission' {
                $state.ConsentAttempts++
                if ($state.ConsentFailures -gt 0) { $state.ConsentFailures--; $global:LASTEXITCODE=1; break }
                $state.ConsentGrants=@(@{ id='test-consent'; consentType='AllPrincipals'; resourceId='powerbi'; scope='Workspace.ReadWrite.All Report.ReadWrite.All Dataset.ReadWrite.All Capacity.ReadWrite.All' })
                @{}; break
            }
            'keyvault list*' { ,@(if ($state.VaultResource) { $state.VaultResource }); break }
            'keyvault show*' { $state.VaultResource; break }
            'keyvault create*' {
                if ($state.VaultResource) { throw 'An existing Key Vault cannot be created again.' }
                $state.VaultCreations++
                $state.VaultResource=@{ name=$arguments[[Array]::IndexOf($arguments,'--name')+1]; id='/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/pbitest-pbiembedded-rg/providers/Microsoft.KeyVault/vaults/pbitest-pbiembedded-kv'; properties=@{ vaultUri='https://unit-test.vault.azure.net/'; enableRbacAuthorization=$true; enablePurgeProtection=$true; publicNetworkAccess='Disabled' } }
                $state.VaultResource
                break
            }
            'account get-access-token*' { @{ accessToken='unit-test-access-token' }; break }
            'role assignment list' { ,@(); break }
            'identity create*' {
                $name=$arguments[[Array]::IndexOf($arguments,'--name')+1]
                $id=if ($name -like '*runtime-mi') { 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } else { 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }
                $clientId=if ($name -like '*runtime-mi') { '12121212-1212-4212-8212-121212121212' } else { '34343434-3434-4434-8434-343434343434' }
                @{ id="/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/pbitest-pbiembedded-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$name"; principalId=$id; clientId=$clientId }; break
            }
            'webapp list-runtimes*' { if ($state.LegacyRuntimeCatalog) { ,@('NODE|22-lts') } else { ,@(@{ config='NODE:22-lts'; runtime='Node' }) }; break }
            'deployment group validate' {
                $templateFile=$arguments[[Array]::IndexOf($arguments,'--template-file')+1]
                $state.ValidationFiles+=,$templateFile
                $template=Get-Content -LiteralPath $templateFile -Raw | ConvertFrom-Json
                $plan=$template.resources[0]
                if ($template.resources.Count -ne 1 -or $plan.type -ne 'Microsoft.Web/serverfarms' -or
                    $plan.kind -ne 'linux' -or -not $plan.properties.reserved -or
                    $plan.name -ne 'pbitest-pbiembedded-plan' -or $plan.location -ne 'westus3' -or
                    $plan.sku.name -ne 'B1' -or $plan.sku.capacity -ne 1 -or
                    $arguments[[Array]::IndexOf($arguments,'--validation-level')+1] -ne 'Provider') {
                    throw 'App Service preflight did not validate the actual Linux deployment through the provider.'
                }
                $state.PlanValidations++
                if ($state.ProviderQuotaFailure) {
                    $global:LASTEXITCODE=1
                    Write-Error 'InternalSubscriptionIsOverQuotaForSku: Operation cannot be completed without additional quota.' -ErrorAction Continue
                    break
                }
                @{}; break
            }
            'appservice plan create' {
                $state.PlanLocation=$arguments[[Array]::IndexOf($arguments,'--location')+1]
                if ($state.PlanQuotaFailure) {
                    $global:LASTEXITCODE=1
                    Write-Error 'Operation cannot be completed without additional quota.' -ErrorAction Continue
                    break
                }
                @{}; break
            }
            'webapp show*' { @{ defaultHostName='pbitest-pbiembedded-web-unit.westus3-01.azurewebsites.net'; outboundIpAddresses='203.0.113.10'; possibleOutboundIpAddresses='203.0.113.10,203.0.113.11' }; break }
            'webapp config appsettings' { $state.Settings=@($arguments); @{}; break }
            'webapp config set' {
                if ($arguments -contains '--startup-file') { $state.Startup=$arguments[[Array]::IndexOf($arguments,'--startup-file')+1] }
                if ($arguments -contains '--generic-configurations') {
                    $generic=$arguments[[Array]::IndexOf($arguments,'--generic-configurations')+1]
                    if ($generic.StartsWith('{')) { throw 'Inline JSON loses quotes when passed through az.cmd on Windows.' }
                    $key,$value=$generic.Split('=',2)
                    if ($key -ne 'healthCheckPath') { throw 'Unexpected site configuration.' }
                    $state.HealthCheckPath=$value
                }
                @{}; break
            }
            'webapp deploy*' {
                if ($arguments[[Array]::IndexOf($arguments,'--async')+1] -ne 'false' -or
                    $arguments[[Array]::IndexOf($arguments,'--track-status')+1] -ne 'false') {
                    throw 'Wait for artifact deployment, then use the explicit runtime health gate rather than CLI startup tracking.'
                }
                $zipPath=$arguments[[Array]::IndexOf($arguments,'--src-path')+1]
                $zip=[IO.Compression.ZipFile]::OpenRead($zipPath)
                try {
                    $entries=@($zip.Entries.FullName)
                    foreach ($required in @('src/server/dist/index.js','src/server/dist/deployment-secrets.js','src/web/dist/index.html','node_modules/fixture/index.js','samples/Store Sales.pbix')) {
                        if ($entries -notcontains $required) { throw "Production ZIP missing $required." }
                    }
                    if (@($entries | Where-Object { $_ -match '(configuration|secrets)\.json|(^|/)\.env$' }).Count) { throw 'Local configuration entered the ZIP.' }
                } finally { $zip.Dispose() }
                $state.Deployments++; @{}; break
            }
            default { @{} }
        }
        $result | ConvertTo-Json -Depth 20 -Compress
    }.GetNewClosure()
    Set-Item Function:az $azMock
    $restMock={
        param([string]$Uri,[string]$Method,[hashtable]$Headers,[string]$Body,[string]$ContentType,[string]$ErrorAction)
        if ($Uri -like 'https://management.azure.com/*/providers/Microsoft.Network/networkSecurityPerimeters/*') {
            $id=([uri]$Uri).AbsolutePath
            if ($Method -eq 'PUT') {
                $payload=$Body | ConvertFrom-Json -AsHashtable
                if ($id -notmatch '/profiles/[^/]+(?:/accessRules/[^/]+)?$') { $payload.properties.provisioningState='Succeeded' }
                $state.Network[$id]=$payload
            }
            if ($Method -eq 'DELETE') { $state.Network.Remove($id); return $null }
            if ($state.Network.ContainsKey($id)) { return $state.Network[$id] }
            $response=[Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::NotFound)
            throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Mock resource missing',$response)
        }
        if ($Uri -like 'https://management.azure.com/*/providers/Microsoft.KeyVault/vaults/*') {
            if ($Method -eq 'PATCH' -and -not $state.BlockPerimeter) { $state.VaultResource.properties.publicNetworkAccess='SecuredByPerimeter' }
            return $state.VaultResource
        }
        if ($Uri -like 'https://pbitest-pbiembedded-web-unit.westus3-01.azurewebsites.net/health/*') {
            return @{ status=$(if (-not $state.Healthy) { 'unavailable' } elseif ($Uri.EndsWith('/live')) { 'live' } else { 'ready' }) }
        }
        if ($Uri -like 'https://api.fabric.microsoft.com/v1/workspaces/*/roleAssignments') {
            if ($Method -eq 'POST') { $state.RuntimeRole=$true; return @{} }
            return @{ value=@(if ($state.RuntimeRole) { @{ principal=@{ id='dddddddd-dddd-4ddd-8ddd-dddddddddddd' }; role='Viewer' } }) }
        }
        if ($Uri -like '*servicePrincipals?*00000003*') {
            return @{ value=@(@{ id='graph'; appRoles=@(
                @{ id='owned'; value='Application.ReadWrite.OwnedBy'; allowedMemberTypes=@('Application') },
                @{ id='users'; value='User.Read.All'; allowedMemberTypes=@('Application') },
                @{ id='groups'; value='GroupMember.ReadWrite.All'; allowedMemberTypes=@('Application') }) }) }
        }
        if ($Uri -like '*/servicePrincipals/*/appRoleAssignments') {
            if ($Method -eq 'POST') { $state.Roles+=($Body | ConvertFrom-Json); return @{} }
            return @{ value=$state.Roles }
        }
        if ($Uri -like '*/groups/*/members/*') {
            if ($Method -eq 'POST') { $state.RuntimeMember=$true; return @{} }
            if ($state.RuntimeMember) { return @{ id='dddddddd-dddd-4ddd-8ddd-dddddddddddd' } }
            $response=[Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::NotFound)
            throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Mock member missing',$response)
        }
        if ($Uri -like 'https://management.azure.com/*/providers/Microsoft.Web/locations/*/usages?*') {
            return @{ value=@(
                if (-not $state.OmitSkuQuota) { @{ name=@{ value='B1' }; unit='Instances'; currentValue=0; limit=$state.SkuQuota } }
                @{ name=@{ value='*' }; unit='Instances'; currentValue=0; limit=$state.RegionalQuota }
            ) }
        }
        if ($Uri -like 'https://management.azure.com/*/providers/Microsoft.Fabric/capacities/*') {
            if ($Method -eq 'PUT') {
                if ($state.Capacity) { throw 'An existing management capacity must not be updated implicitly.' }
                $payload=$Body | ConvertFrom-Json
                $state.CapacityCreations++
                $state.Capacity=[pscustomobject]@{ location=$payload.location; sku=$payload.sku; properties=[pscustomobject]@{ state='Active'; provisioningState='Succeeded' } }
            }
            if (-not $state.Capacity) {
                $response=[Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::NotFound)
                throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Mock resource missing',$response)
            }
            return $state.Capacity
        }
        if ($Uri -eq 'https://api.fabric.microsoft.com/v1/capacities') {
            return [pscustomobject]@{ value=@(); continuationUri='https://api.fabric.microsoft.com/v1/capacities?continuationToken=next' }
        }
        if ($Uri -eq 'https://api.fabric.microsoft.com/v1/capacities?continuationToken=next') {
            return [pscustomobject]@{ value=@([pscustomobject]@{ id='88888888-8888-4888-8888-888888888888'; displayName='pbitestpbiembeddedmgmt'; state='Active' }) }
        }
        if ($Uri -eq 'https://api.fabric.microsoft.com/v1/workspaces') {
            if ($Method -eq 'POST') {
                $payload=$Body | ConvertFrom-Json
                $state.WorkspaceCreations++
                $state.Workspace=[pscustomobject]@{ id='99999999-9999-4999-8999-999999999999'; displayName=$payload.displayName; capacityId=$payload.capacityId; description=$payload.description }
                return $state.Workspace
            }
            return [pscustomobject]@{ value=@(if($state.Workspace){$state.Workspace}) }
        }
        if ($Uri -eq 'https://api.fabric.microsoft.com/v1/workspaces/99999999-9999-4999-8999-999999999999/items') {
            return [pscustomobject]@{ value=@(if($state.Database){
                [pscustomobject]@{ id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'; displayName=$state.Database.displayName; type='SQLEndpoint' }
                $state.Database
            }) }
        }
        if ($Uri -like 'https://api.fabric.microsoft.com/v1/workspaces/*/sqlDatabases') {
            if ($Method -ne 'POST') { throw 'Unexpected Fabric database operation.' }
            $payload=$Body | ConvertFrom-Json
            $state.DatabaseCreations++
            $state.Database=[pscustomobject]@{
                id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; displayName=$payload.displayName; type='SQLDatabase'
                properties=[pscustomobject]@{ serverFqdn='unit-test.database.fabric.microsoft.com,1433'; databaseName="$($payload.displayName)-fabric-catalog" }
            }
            return $null
        }
        if ($Uri -like 'https://api.fabric.microsoft.com/v1/workspaces/*/sqlDatabases/*') { return $state.Database }
        if ($Uri -like 'https://unit-test.vault.azure.net/*') {
            if ($state.ForbidVault -or $state.ForbidVaultData) { throw 'This deployment mode must not access Key Vault data locally.' }
            $secretName=([Uri]$Uri).AbsolutePath.Split('/')[-1]
            if ($Method -eq 'PUT') { $state.Vault[$secretName]=($Body | ConvertFrom-Json).value; return @{ id=$Uri } }
            if ($state.Vault.ContainsKey($secretName)) { return @{ value=$state.Vault[$secretName] } }
            return $null
        }
        if ($Uri -like 'https://graph.microsoft.com/v1.0/oauth2PermissionGrants?*') { return @{ value=$state.ConsentGrants } }
        if ($Uri -like '*oauth2Permission*') { throw 'Unexpected permission endpoint.' }
        if ($Uri -like '*servicePrincipals?*00000009*') {
            return @{ value=@(@{ id='powerbi'; appId='00000009-0000-0000-c000-000000000000'; oauth2PermissionScopes=@(
                @{ id='scope-workspace'; value='Workspace.ReadWrite.All' },@{ id='scope-report'; value='Report.ReadWrite.All' },
                @{ id='scope-dataset'; value='Dataset.ReadWrite.All' },@{ id='scope-capacity'; value='Capacity.ReadWrite.All' }) }) }
        }
        if ($Uri.Contains('/applications?')) { return @{ value=@(if ($state.App) { $state.App }) } }
        if ($Uri -like '*/applications/*/addPassword') {
            if ($state.ForbidVaultData) { throw 'Azure deployment must not generate the web credential locally.' }
            $state.CredentialCreations++; return @{ keyId='test-key'; secretText=$state.Secret }
        }
        if ($Uri -eq 'https://graph.microsoft.com/v1.0/applications' -and $Method -eq 'POST') {
            $state.App=@{ id='44444444-4444-4444-8444-444444444444'; appId='55555555-5555-4555-8555-555555555555'; displayName=($Body | ConvertFrom-Json).displayName; web=@{ redirectUris=@('http://localhost:3000/auth/callback') } }
            return $state.App
        }
        if ($Uri -like '*/applications/*/owners/*') {
            if ($Method -eq 'POST') { $state.WebAppOwner=$true; return @{} }
            if ($state.WebAppOwner) { return @{ id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } }
            $response=[Net.Http.HttpResponseMessage]::new([Net.HttpStatusCode]::NotFound)
            throw [Microsoft.PowerShell.Commands.HttpResponseException]::new('Mock owner missing',$response)
        }
        if ($Uri -like '*/applications/*') {
            if ($Method -eq 'PATCH') { $payload=$Body | ConvertFrom-Json -AsHashtable; if ($payload['web']) { $state.App.web=$payload.web } }
            return $state.App
        }
        if ($Uri.Contains('/servicePrincipals?')) { return @{ value=@(if ($state.Principal) { $state.Principal }) } }
        if ($Uri -eq 'https://graph.microsoft.com/v1.0/servicePrincipals') { $state.Principal=@{ id='66666666-6666-4666-8666-666666666666' }; return $state.Principal }
        if ($Uri.Contains('/groups?')) { return @{ value=@(if ($state.Group) { $state.Group }) } }
        if ($Uri -eq 'https://graph.microsoft.com/v1.0/groups') { $state.Group=@{ id='77777777-7777-4777-8777-777777777777' }; return $state.Group }
        throw 'Unexpected mocked service call.'
    }.GetNewClosure()
    Set-Item Function:Invoke-RestMethod $restMock
    $directory=Join-Path ([IO.Path]::GetTempPath()) "pbi-script-test-$([Guid]::NewGuid().ToString('N'))"
    $file=Join-Path $directory 'configuration.json'
    $fabricFile=Join-Path $directory 'fabric-database.json'
    $secretDirectory=Join-Path $directory 'secrets'
    $secretFile=Join-Path $secretDirectory 'secrets.json'
    try {
        $parameters=@{ NamePrefix='pbitest'; ConfigurationPath=$file; CreateServicePrincipalGroup=$true }
        $null=& "$PSScriptRoot\Initialize-Local.ps1" @parameters 6>&1
        $null=& "$PSScriptRoot\Initialize-Local.ps1" @parameters 6>&1
        $null=& "$PSScriptRoot\Initialize-Local.ps1" @parameters 6>&1
        $configText=Get-Content -LiteralPath $file -Raw
        if ($configText.Contains($state.Secret) -or $configText.Contains('unit-test-access-token')) { throw 'A credential leaked into configuration.' }
        if ($state.CredentialCreations -ne 1) { throw 'Repeat provisioning unnecessarily created a new credential.' }
        if ($state.VaultCreations -ne 1) { throw 'Repeat provisioning did not reuse the existing Key Vault.' }
        if ($state.CapacityCreations -ne 1 -or $state.WorkspaceCreations -ne 1 -or $state.DatabaseCreations -ne 1) {
            throw 'Repeated Fabric provisioning did not reuse the existing capacity/workspace/database.'
        }
        $config=$configText | ConvertFrom-Json -AsHashtable
        if (-not $config.App.WebClientId -or $config.App.PublicOrigin -ne 'http://localhost:3000' -or
            $config.App.AzureLocation -ne 'westus3' -or $state.Capacity.location -ne 'westus3') { throw 'Expected West US 3 local configuration was not written.' }
        if (-not $state.Vault.ContainsKey($config.App.WebClientSecretName) -or -not $state.Vault.ContainsKey($config.App.SessionSecretName)) { throw 'Required namespaced secrets were not sent to the vault.' }
        if ($config.App.ResourceGroup -ne 'pbitest-pbiembedded-rg' -or $state.Database.displayName -ne 'pbitest-pbiembedded-configdb' -or
            $config.App.SqlServer -ne 'unit-test.database.fabric.microsoft.com' -or $config.App.SqlDatabase -ne 'pbitest-pbiembedded-configdb-fabric-catalog' -or
            $config.App.ManagementWorkspaceId -ne $state.Workspace.id -or $config.Deployment.DatabaseProvider -ne 'FabricSql' -or
            $state.App.displayName -ne 'pbitest-pbiembedded-auth' -or
            $config.App.ResourceNamePrefix -ne 'pbitest-pbiembedded' -or $config.Deployment.NamingVersion -ne 2) { throw 'Provisioning did not use the generated namespace consistently.' }
        Save-SafeConfiguration $file @{ App=@{}; Deployment=@{ Suffix='legacy'; NamePrefix='pbitest' } }
        $calls=$state.AzureCalls
        $legacyRejected=$false
        try { $null=& "$PSScriptRoot\Initialize-Local.ps1" @parameters 6>&1 }
        catch { if ($_.Exception.Message -notlike 'Existing configuration uses a different or legacy naming scheme*') { throw }; $legacyRejected=$true }
        if (-not $legacyRejected -or $state.AzureCalls -ne $calls) { throw 'Legacy configuration was not rejected before Azure operations.' }
        Save-SafeConfiguration $file $config
        $changedRejected=$false
        $changed=@{} + $parameters
        $changed.NamePrefix='another'
        try { $null=& "$PSScriptRoot\Initialize-Local.ps1" @changed 6>&1 }
        catch { if ($_.Exception.Message -notlike 'Existing configuration uses a different or legacy naming scheme*') { throw }; $changedRejected=$true }
        if (-not $changedRejected -or $state.AzureCalls -ne $calls) { throw 'A namespace change was not rejected before Azure operations.' }
        $state.Capacity.location='westus2'
        $regionRejected=$false
        try { $null=& "$PSScriptRoot\Initialize-Local.ps1" @parameters 6>&1 }
        catch {
            if ($_.Exception.Message -notlike 'Existing management capacity has a different region or SKU*') { throw }
            $regionRejected=$true
        }
        if (-not $regionRejected) { throw 'Provisioning implicitly moved an existing management capacity.' }
        $state.Capacity.location='West US 3'
        $state.Workspace.description='Unrelated existing workspace'
        $adoptionRejected=$false
        try { $null=& "$PSScriptRoot\Initialize-Local.ps1" @parameters 6>&1 }
        catch {
            if ($_.Exception.Message -notlike 'The matching workspace is not marked*') { throw }
            $adoptionRejected=$true
        }
        if (-not $adoptionRejected) { throw 'An unrelated management workspace was adopted implicitly.' }
        $state.Workspace.description='Management database for pbitest-pbiembedded; not a customer tenant workspace.'
        $metadata=Get-Content -LiteralPath $fabricFile -Raw | ConvertFrom-Json -AsHashtable
        $metadata.Deployment.ManagementDatabaseId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        Save-SafeConfiguration $fabricFile $metadata
        $databaseRejected=$false
        try { $null=& "$PSScriptRoot\Initialize-Local.ps1" @parameters 6>&1 }
        catch {
            if ($_.Exception.Message -notlike 'The SQL database ID changed*') { throw }
            $databaseRejected=$true
        }
        if (-not $databaseRejected) { throw 'The application database ID changed without explicit recovery.' }
        $legacy=@{ App=@{} + $config.App; Deployment=@{} + $config.Deployment }
        $legacy.Deployment.Remove('DatabaseProvider')
        Save-SafeConfiguration $file $legacy
        $calls=$state.AzureCalls
        $providerRejected=$false
        try { $null=& "$PSScriptRoot\Initialize-Local.ps1" @parameters 6>&1 }
        catch {
            if ($_.Exception.Message -notlike 'Existing configuration targets a legacy database provider*') { throw }
            $providerRejected=$true
        }
        if (-not $providerRejected -or $state.AzureCalls -ne $calls) { throw 'An Azure SQL configuration was repointed without explicit migration.' }
        Save-SafeConfiguration $file $config
        $calls=$state.AzureCalls
        foreach ($invalid in @(@{ DeferSecrets=$true },@{ DeferSecrets=$true; UseKeyVaultPerimeter=$true; DeploymentAddressPrefixes=@('198.51.100.10/32') })) {
            $rejected=$false
            try { $null=& "$PSScriptRoot\Initialize-Local.ps1" -NamePrefix pbitest -ConfigurationPath $file @invalid 6>&1 } catch { $rejected=$true }
            if (-not $rejected -or $state.AzureCalls -ne $calls) { throw 'Deferred secret setup accepted an unsafe mode or reached Azure before rejecting it.' }
        }
        $fixture=Join-Path $directory 'deployment-fixture'
        $null=New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts'),(Join-Path $fixture 'src\server\dist'),(Join-Path $fixture 'src\web\dist') -Force
        Copy-Item -Path (Join-Path $PSScriptRoot '*.ps1') -Destination (Join-Path $fixture 'scripts')
        foreach ($manifest in @('package.json','package-lock.json','src\server\package.json','src\web\package.json')) {
            Copy-Item -LiteralPath (Join-Path $script:RepositoryRoot $manifest) -Destination (Join-Path $fixture $manifest)
        }
        Set-Content -LiteralPath (Join-Path $fixture 'src\server\dist\index.js') -Value '// test fixture'
        Set-Content -LiteralPath (Join-Path $fixture 'src\server\dist\deployment-secrets.js') -Value '// test fixture'
        Set-Content -LiteralPath (Join-Path $fixture 'src\web\dist\index.html') -Value '<!doctype html>'
        $null=New-Item -ItemType Directory -Path (Join-Path $fixture 'samples')
        Set-Content -LiteralPath (Join-Path $fixture 'samples\Store Sales.pbix') -Value 'test-only sample packaging fixture'
        $npmMock={
            $global:LASTEXITCODE=if ($state.NpmFailure) { 1 } else { 0 }
            if ($args -contains '--omit=dev') {
                if ($args -notcontains '--os=linux' -or $args -notcontains '--ignore-scripts') { throw 'Production restore lost its portability constraints.' }
                $null=New-Item -ItemType Directory -Path 'node_modules\fixture' -Force
                Set-Content -LiteralPath 'node_modules\fixture\index.js' -Value '// test fixture'
            }
        }.GetNewClosure()
        $nodeMock={ $state.NodeCommands+=,@($args); $global:LASTEXITCODE=0 }.GetNewClosure()
        Set-Item Function:npm $npmMock
        Set-Item Function:node $nodeMock
        Set-Item Function:Start-Sleep { param($Seconds) }
        $oldConfig=$env:PBIEMBEDDED_CONFIG
        $oldNodeEnv=$env:NODE_ENV
        try {
            Remove-Item -LiteralPath $file,$fabricFile
            foreach ($key in @('Capacity','Workspace','Database','VaultResource','App','Principal')) { $state[$key]=$null }
            foreach ($key in @('CapacityCreations','WorkspaceCreations','DatabaseCreations','VaultCreations','CredentialCreations')) { $state[$key]=0 }
            $state.Vault=@{}
            $state.ForbidVaultData=$true
            $state.ConsentFailures=1
            $obsoleteRule='/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/pbitest-pbiembedded-rg/providers/Microsoft.Network/networkSecurityPerimeters/pbitest-pbiembedded-nsp/profiles/application/accessRules/deployment'
            $state.Network[$obsoleteRule]=@{ properties=@{ addressPrefixes=@('198.51.100.10/32') } }
            $deploy=@{ NamePrefix='pbitest'; ConfigurationPath=$file; GrantGraphPermissions=$true; GrantAdminConsent=$true; ServicePrincipalGroupId='77777777-7777-4777-8777-777777777777' }
            $entry=Join-Path $fixture 'scripts\Deploy.ps1'
            foreach ($counter in @('SkuQuota','RegionalQuota')) {
                $state[$counter]=0
                $rejected=$false
                try { $null=& $entry @deploy 6>&1 } catch { $rejected=$_.Exception.Message -like 'Insufficient App Service quota*' }
                $state[$counter]=10
                if (-not $rejected -or $state.CapacityCreations -ne 0 -or $state.VaultCreations -ne 0) {
                    throw 'Quota preflight did not reject missing SKU/regional headroom before provisioning billable infrastructure.'
                }
            }
            $state.ProviderQuotaFailure=$true
            $rejected=$false
            try { $null=& $entry @deploy 6>&1 } catch { $rejected=$_.Exception.Message -like 'App Service quota is insufficient*' }
            $state.ProviderQuotaFailure=$false
            if (-not $rejected -or $state.PlanValidations -ne 1 -or $state.CapacityCreations -ne 0 -or
                $state.VaultCreations -ne 0 -or $state.PlanLocation -or (Test-Path -LiteralPath $file)) {
                throw 'Positive usage counters bypassed provider rejection or provisioned billable resources.'
            }
            $state.OmitSkuQuota=$true
            $state.ProviderQuotaFailure=$true
            $rejected=$false
            try { $null=& $entry @deploy 6>&1 } catch { $rejected=$_.Exception.Message -like 'App Service quota is insufficient*' }
            $state.ProviderQuotaFailure=$false
            if (-not $rejected -or $state.PlanValidations -ne 2 -or $state.CapacityCreations -ne 0 -or
                $state.VaultCreations -ne 0 -or (Test-Path -LiteralPath $file)) {
                throw 'An omitted SKU counter bypassed provider validation or reached billable provisioning after rejection.'
            }
            $null=& $entry @deploy 6>&1
            $state.OmitSkuQuota=$false
            $state.LegacyRuntimeCatalog=$true
            $null=& $entry @deploy 6>&1
            $state.LegacyRuntimeCatalog=$false
            if ($state.PlanLocation -ne 'westus3' -or $state.Capacity.location -ne 'westus3' -or $state.PlanValidations -ne 4) {
                throw 'Deployment did not colocate App Service and the management capacity in West US 3.'
            }
            if (@($state.ValidationFiles | Where-Object { Test-Path -LiteralPath $_ }).Count) {
                throw 'Provider preflight left temporary deployment templates behind.'
            }
            if ($state.ConsentAttempts -ne 2) { throw 'Consent did not recover from a transient failure or was needlessly repeated after verification.' }
            if ($state.Deployments -ne 2 -or $state.CredentialCreations -ne 0 -or $state.Vault.Count -ne 0 -or $state.CapacityCreations -ne 1 -or
                -not $state.WebAppOwner -or -not $state.RuntimeMember -or -not $state.RuntimeRole -or $state.Roles.Count -ne 3) { throw 'Deployment/rerun did not retain resources and required identity grants without local secret access.' }
            if ($state.Network.ContainsKey($obsoleteRule) -or
                $state.Startup -ne 'node src/server/dist/index.js --initialize-secrets 44444444-4444-4444-8444-444444444444 && node src/server/dist/index.js') {
                throw 'Deployment retained local vault network access or omitted Azure-side initialization before portal startup.'
            }
            if ($state.Settings -notcontains 'NODE_ENV=production' -or $state.Settings -notcontains 'App__LocalSecretsPath=' -or
                $state.Settings -notcontains 'App__PublicOrigin=https://pbitest-pbiembedded-web-unit.westus3-01.azurewebsites.net' -or
                $state.App.web.redirectUris -notcontains 'https://pbitest-pbiembedded-web-unit.westus3-01.azurewebsites.net/auth/callback' -or
                $state.Settings -notcontains 'App__RuntimeManagedIdentityClientId=12121212-1212-4212-8212-121212121212' -or
                $state.Settings -notcontains 'App__ProvisioningManagedIdentityClientId=34343434-3434-4434-8434-343434343434') { throw 'Production settings lost identity/secret-store separation.' }
            $applicationRule=@($state.Network.Keys | Where-Object { $_ -like '*/accessRules/application' })[0]
            if ($state.Network[$applicationRule].properties.addressPrefixes.Count -ne 2 -or
                $state.VaultResource.properties.publicNetworkAccess -ne 'SecuredByPerimeter' -or $state.NodeCommands.Count -ne 4 -or
                $state.HealthCheckPath -ne '/health/ready') {
                throw 'Deployment missed app network access, enforcement, migrations, or SQL runtime grants.'
            }
            if ($state.NodeCommands[1] -notcontains '12121212-1212-4212-8212-121212121212') { throw 'SQL grants did not use the runtime client ID.' }
            if ($env:PBIEMBEDDED_CONFIG -ne $oldConfig -or $env:NODE_ENV -ne $oldNodeEnv) { throw 'Deployment changed the caller environment.' }
            $calls=$state.AzureCalls
            $oldSqlOverride=$env:App__SqlDatabase
            try {
                $env:App__SqlDatabase='unexpected-database'
                $rejected=$false
                try { $null=& $entry @deploy 6>&1 } catch { $rejected=$_.Exception.Message -like 'Clear App__ environment overrides*' }
                if (-not $rejected -or $state.AzureCalls -ne $calls) { throw 'An environment override could redirect deployment SQL operations.' }
            } finally { $env:App__SqlDatabase=$oldSqlOverride }
            $state.NpmFailure=$true
            $rejected=$false
            try { $null=& $entry @deploy 6>&1 } catch { $rejected=$_.Exception.Message -like '*before cloud provisioning*' }
            $state.NpmFailure=$false
            if (-not $rejected -or $state.AzureCalls -ne $calls) { throw 'A failed build reached cloud provisioning.' }
            $savedRoles=$state.Roles
            $state.Roles=@()
            $withoutConsent=@{} + $deploy
            $withoutConsent.GrantGraphPermissions=$false
            $rejected=$false
            try { $null=& $entry @withoutConsent 6>&1 } catch { $rejected=$_.Exception.Message -like 'Provisioning identity needs Microsoft Graph*' }
            if (-not $rejected -or $state.Roles.Count -ne 0) { throw 'Missing Graph grants were silently elevated.' }
            $state.Roles=$savedRoles
            $state.BlockPerimeter=$true
            $state.VaultResource.properties.publicNetworkAccess='Disabled'
            $rejected=$false
            try { $null=& $entry @deploy 6>&1 } catch { $rejected=$_.Exception.Message -like 'Key Vault did not retain SecuredByPerimeter*' }
            $state.BlockPerimeter=$false
            if (-not $rejected -or $state.Deployments -ne 2) { throw 'Deployment continued after policy rejected perimeter access.' }
            $savedGrants=$state.ConsentGrants
            $state.ConsentGrants=@()
            $state.ConsentFailures=100
            $attempts=$state.ConsentAttempts
            $rejected=$false
            try { $null=& $entry @deploy 6>&1 } catch { $rejected=$_.Exception.Message -like 'Sign-in app admin consent could not be granted and verified*' }
            $state.ConsentGrants=$savedGrants
            $state.ConsentFailures=0
            if (-not $rejected -or $state.ConsentAttempts - $attempts -ne 18 -or $state.Deployments -ne 2) {
                throw 'Permanent consent failure was not bounded or deployment continued without verified consent.'
            }
            $state.PlanQuotaFailure=$true
            $rejected=$false
            try { $null=& $entry @deploy 6>&1 } catch { $rejected=$_.Exception.Message -like 'App Service quota is insufficient*' }
            $state.PlanQuotaFailure=$false
            if (-not $rejected -or $state.Deployments -ne 2) { throw 'Quota failure did not provide safe, actionable guidance or stopped being fail-closed.' }
            $state.Healthy=$false
            $rejected=$false
            try { $null=& $entry @deploy 6>&1 } catch { $rejected=$_.Exception.Message -like 'Deployment did not pass runtime health checks*' }
            $state.Healthy=$true
            if (-not $rejected -or $env:PBIEMBEDDED_CONFIG -ne $oldConfig -or $env:NODE_ENV -ne $oldNodeEnv) {
                throw 'An unhealthy deployment was reported as complete or changed the caller environment.'
            }
        } finally {
            $state.ForbidVaultData=$false
            Remove-Item Function:npm,Function:node,Function:Start-Sleep
            $env:PBIEMBEDDED_CONFIG=$oldConfig
            $env:NODE_ENV=$oldNodeEnv
            Remove-Item -LiteralPath $fixture -Recurse -Force
        }
        Save-SafeConfiguration $file $config
        $metadata.Deployment.ManagementDatabaseId=$state.Database.id
        Save-SafeConfiguration $fabricFile $metadata
        $state.ForbidVault=$true
        $localParameters=@{} + $parameters
        $localParameters.UseLocalSecrets=$true
        $null=& "$PSScriptRoot\Initialize-Local.ps1" @localParameters 6>&1
        $null=& "$PSScriptRoot\Initialize-Local.ps1" @localParameters 6>&1
        $localConfig=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json -AsHashtable
        $secrets=Read-LocalSecretFile $secretFile
        if ($localConfig.App.KeyVaultUri -or $localConfig.App.LocalSecretsPath -ne $secretFile -or
            $secrets.secrets[$localConfig.App.WebClientSecretName].value -ne $state.Secret -or
            -not $secrets.secrets.ContainsKey($localConfig.App.SessionSecretName)) {
            throw 'The explicit local secret-file option did not persist credentials outside application configuration.'
        }
        if ((Get-Content -LiteralPath $file -Raw).Contains($state.Secret) -or $state.CredentialCreations -ne 1) {
            throw 'Local provisioning leaked or unnecessarily rotated credentials.'
        }
        $acl=Get-Acl -LiteralPath $secretDirectory
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        if (-not $acl.AreAccessRulesProtected -or @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid }).Count) {
            throw 'The local secret directory was not restricted to the current Windows identity.'
        }
    } finally {
        Remove-Item -LiteralPath $file,$fabricFile,$secretFile -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $secretDirectory) { Remove-Item -LiteralPath $secretDirectory -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -ErrorAction SilentlyContinue }
    }
}
Test-MockedLocalProvisioning
Write-Output 'Mocked clean-start deployment, reruns, Azure-only secret bootstrap, obsolete local-IP rule removal, NSP enforcement, grants, packaging, health failures, and Fabric SQL/local-secret checks passed; no Azure requests were made.'

