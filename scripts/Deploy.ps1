#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ResourceGroup,
    [Parameter(Mandatory)][Alias('Prefix')][string]$NamePrefix,
    [string]$SolutionName='pbiembedded',
    [string]$Location='westus3',
    [ValidateSet('F2','F4','F8','F16','F32','F64','F128')][string]$ManagementCapacitySku='F2',
    [string]$ConfigurationPath,
    [string]$AppServiceSku='B1',
    [switch]$GrantGraphPermissions,
    [switch]$GrantAdminConsent,
    [switch]$EnableCapacityAutoResume,
    [string]$ServicePrincipalGroupId
)
. "$PSScriptRoot\Common.ps1"
. "$PSScriptRoot\KeyVault-Network.ps1"
$names=Get-DeploymentNames -NamePrefix $NamePrefix -SolutionName $SolutionName -ResourceGroup $ResourceGroup
$ResourceGroup=$names.ResourceGroup
if (-not $ConfigurationPath) { $ConfigurationPath=Get-DefaultConfigurationPath }
$ConfigurationPath=Assert-ExternalConfigurationPath $ConfigurationPath
if (-not $PSCmdlet.ShouldProcess("$ResourceGroup in $Location", 'Provision/update Azure and Entra resources and deploy the Node application (billable resources)')) { return }
if (@(Get-ChildItem Env: | Where-Object Name -like 'App__*').Count) {
    throw 'Clear App__ environment overrides before deployment so migrations and grants use the pinned deployment configuration.'
}
foreach ($command in @('az','node','npm')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Install $command before deployment." }
}
if (-not (Test-Path -LiteralPath (Join-Path $script:RepositoryRoot 'samples\Store Sales.pbix') -PathType Leaf)) {
    throw 'Restore samples\Store Sales.pbix before packaging the application.'
}
if (Test-Path -LiteralPath $ConfigurationPath) {
    $previous=Get-Content -LiteralPath $ConfigurationPath -Raw | ConvertFrom-Json -AsHashtable
    Assert-DeploymentConfiguration $previous $names
    if ($previous.App['LocalSecretsPath']) {
        throw 'Deployment cannot convert a local secret-file environment. Use a separate production namespace/configuration or explicitly migrate every existing tenant credential first.'
    }
}
Push-Location $script:RepositoryRoot
try {
    foreach ($arguments in @(@('ci','--include=dev','--no-fund','--no-audit'),@('run','check'),@('run','build'),@('test'))) {
        & npm @arguments
        if ($LASTEXITCODE -ne 0) { throw 'Dependency restore/build/validation failed before cloud provisioning.' }
    }
    $lock=Get-Content -LiteralPath 'package-lock.json' -Raw | ConvertFrom-Json -AsHashtable
    foreach ($entry in $lock.packages.GetEnumerator()) {
        if (-not $entry.Value['dev'] -and $entry.Value['hasInstallScript']) {
            throw 'A production dependency needs an install hook. Build production dependencies on Linux before using this portable ZIP routine.'
        }
    }
} finally { Pop-Location }
$available=Invoke-AzJson @('webapp','list-runtimes','--os','linux')
$runtimes=@($available | ForEach-Object { if ($_ -is [string]) { $_ } elseif ($_ -is [System.Collections.IDictionary]) { $_['config'] } })
if (-not @($runtimes | Where-Object { $_ -match '^NODE[:|]22(?:-lts)?$' }).Count) { throw 'Node 22 LTS is unavailable in the current App Service runtime catalog. Select a supported LTS runtime before deploying.' }
$account=Invoke-AzJson @('account','show')
$null=Invoke-AzJson @('provider','register','--namespace','Microsoft.Web','--wait')
Assert-AppServiceQuota $account.id $Location $AppServiceSku
$null=Invoke-AzJson @('group','create','--name',$ResourceGroup,'--location',$Location)
Assert-AppServicePlanDeployment $ResourceGroup $names.AppServicePlanName $Location $AppServiceSku
$initialize=@{ ResourceGroup=$ResourceGroup; NamePrefix=$NamePrefix; SolutionName=$SolutionName; ManagementCapacitySku=$ManagementCapacitySku; Location=$Location; ConfigurationPath=$ConfigurationPath; UseKeyVaultPerimeter=$true; DeferSecrets=$true }
if ($ServicePrincipalGroupId) { $initialize.ServicePrincipalGroupId=$ServicePrincipalGroupId }
if ($GrantAdminConsent) { $initialize.GrantAdminConsent=$true }
if ($EnableCapacityAutoResume) { $initialize.EnableCapacityAutoResume=$true }
& "$PSScriptRoot\Initialize-Local.ps1" @initialize
$configuration=Get-Content -LiteralPath $ConfigurationPath -Raw | ConvertFrom-Json -AsHashtable
$appConfig=$configuration.App
$deployment=$configuration.Deployment
$account=Invoke-AzJson @('account','show')
foreach ($provider in @('Microsoft.ManagedIdentity','Microsoft.Fabric')) {
    $null=Invoke-AzJson @('provider','register','--namespace',$provider,'--wait')
}
$subscription=$account.id
$webName=$deployment.WebAppName
$planName=$deployment.AppServicePlanName
$runtimeName=$deployment.RuntimeIdentityName
$provisionerName=$deployment.ProvisioningIdentityName
$runtime=Invoke-AzJson @('identity','create','--resource-group',$ResourceGroup,'--name',$runtimeName,'--location',$Location)
$provisioner=Invoke-AzJson @('identity','create','--resource-group',$ResourceGroup,'--name',$provisionerName,'--location',$Location)
Ensure-RoleAssignment $runtime.principalId 'Key Vault Secrets User' $deployment.VaultId
Ensure-RoleAssignment $provisioner.principalId 'Key Vault Secrets Officer' $deployment.VaultId
$owner=Invoke-Graph "/applications/$($deployment.WebApplicationObjectId)/owners/$($provisioner.principalId)" -AllowNotFound
if (-not $owner) {
    $null=Invoke-Graph "/applications/$($deployment.WebApplicationObjectId)/owners/`$ref" POST @{
        '@odata.id'="https://graph.microsoft.com/v1.0/directoryObjects/$($provisioner.principalId)"
    }
}
$graph=Invoke-Graph "/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'"
$requiredRoles=@('Application.ReadWrite.OwnedBy','User.Read.All')
if ($appConfig.ServicePrincipalGroupId) { $requiredRoles += 'GroupMember.ReadWrite.All' }
$assigned=Invoke-Graph "/servicePrincipals/$($provisioner.principalId)/appRoleAssignments"
foreach ($roleName in $requiredRoles) {
    $role=@($graph.value[0].appRoles | Where-Object { $_.value -eq $roleName -and $_.allowedMemberTypes -contains 'Application' }) | Select-Object -First 1
    if (-not $role) { throw "Required Microsoft Graph application permission unavailable: $roleName" }
    if (-not @($assigned.value | Where-Object { $_.appRoleId -eq $role.id -and $_.resourceId -eq $graph.value[0].id }).Count) {
        if (-not $GrantGraphPermissions) {
            throw "Provisioning identity needs Microsoft Graph $roleName. An authorized Entra administrator must rerun with -GrantGraphPermissions or grant this permission explicitly. Deployment is not complete."
        }
        $null=Invoke-Graph "/servicePrincipals/$($provisioner.principalId)/appRoleAssignments" POST @{
            principalId=$provisioner.principalId; resourceId=$graph.value[0].id; appRoleId=$role.id
        }
    }
}
$scope="/subscriptions/$subscription/resourceGroups/$ResourceGroup"
$roleName=$deployment.CapacityRoleName
$roles=Invoke-AzJson @('role','definition','list','--name',$roleName)
if (-not @($roles).Count) {
    $roleFile=Join-Path ([IO.Path]::GetTempPath()) "pbi-capacity-role-$([Guid]::NewGuid().ToString('N')).json"
    try {
        @{ Name=$roleName; IsCustom=$true; Description='Manage Fabric capacity resources in this application resource group only.';
            Actions=@('Microsoft.Fabric/capacities/*'); NotActions=@(); DataActions=@(); NotDataActions=@(); AssignableScopes=@($scope) } |
            ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $roleFile -Encoding utf8
        $null=Invoke-AzJson @('role','definition','create','--role-definition',$roleFile)
    } finally { Remove-Item -LiteralPath $roleFile -ErrorAction SilentlyContinue }
}
Ensure-RoleAssignment $provisioner.principalId $roleName $scope
$null=Invoke-AzJson @('appservice','plan','create','--resource-group',$ResourceGroup,'--name',$planName,'--location',$Location,'--is-linux','--sku',$AppServiceSku,'--number-of-workers','1')
$null=Invoke-AzJson @('webapp','create','--resource-group',$ResourceGroup,'--plan',$planName,'--name',$webName,'--runtime','NODE:22-lts','--https-only','true','--basic-auth','Disabled')
$null=Invoke-AzJson @('webapp','identity','assign','--resource-group',$ResourceGroup,'--name',$webName,'--identities',$runtime.id,$provisioner.id)
$applicationObjectId=[Guid]::Parse($deployment.WebApplicationObjectId).ToString()
$startup="node src/server/dist/index.js --initialize-secrets $applicationObjectId && node src/server/dist/index.js"
$null=Invoke-AzJson @('webapp','config','set','--resource-group',$ResourceGroup,'--name',$webName,'--startup-file',$startup,'--always-on','true','--min-tls-version','1.2','--ftps-state','Disabled')
$web=Invoke-AzJson @('webapp','show','--resource-group',$ResourceGroup,'--name',$webName)
if ($web.defaultHostName -notmatch '^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.azurewebsites\.net$') {
    throw 'App Service returned an unexpected public-cloud hostname. Review the deployment origin before proceeding.'
}
$origin="https://$($web.defaultHostName)"
$outbound=@(("$($web.outboundIpAddresses),$($web.possibleOutboundIpAddresses)").Split(',') |
    Where-Object { $_.Trim() } | ForEach-Object { "$($_.Trim())/32" } | Sort-Object -Unique)
$perimeterId="/subscriptions/$subscription/resourceGroups/$ResourceGroup/providers/Microsoft.Network/networkSecurityPerimeters/$($names.PerimeterName)"
Set-PerimeterAccessRule $perimeterId application $outbound
if ($appConfig.ServicePrincipalGroupId) {
    $member=Invoke-Graph "/groups/$($appConfig.ServicePrincipalGroupId)/members/$($runtime.principalId)" -AllowNotFound
    if (-not $member) {
        $null=Invoke-Graph "/groups/$($appConfig.ServicePrincipalGroupId)/members/`$ref" POST @{
            '@odata.id'="https://graph.microsoft.com/v1.0/directoryObjects/$($runtime.principalId)"
        }
    }
}
$roleAssignments=@(Get-FabricCollection "/workspaces/$($appConfig.ManagementWorkspaceId)/roleAssignments")
$runtimeRole=@($roleAssignments | Where-Object { $_.principal.id -eq $runtime.principalId })
if ($runtimeRole.Count -gt 1 -or ($runtimeRole.Count -eq 1 -and $runtimeRole[0].role -ne 'Viewer')) {
    throw 'The runtime identity has unexpected management-workspace permissions. Review least privilege explicitly before deployment.'
}
if (-not $runtimeRole.Count) {
    $null=Invoke-Fabric "/workspaces/$($appConfig.ManagementWorkspaceId)/roleAssignments" POST @{
        principal=@{ id=$runtime.principalId; type='ServicePrincipal' }; role='Viewer'
    }
}
$application=Invoke-Graph "/applications/$($deployment.WebApplicationObjectId)"
$redirects=@(@($application.web.redirectUris) + "$origin/auth/callback" | Select-Object -Unique)
$null=Invoke-Graph "/applications/$($deployment.WebApplicationObjectId)" PATCH @{ web=@{ redirectUris=$redirects } }
$cloudConfig=@{} + $appConfig
$cloudConfig.RuntimeManagedIdentityClientId=$runtime.clientId
$cloudConfig.ProvisioningManagedIdentityClientId=$provisioner.clientId
$cloudConfig.PublicOrigin=$origin
$cloudConfig.LocalSecretsPath=''
$settings=@('NODE_ENV=production','SCM_DO_BUILD_DURING_DEPLOYMENT=false','WEBSITES_ENABLE_APP_SERVICE_STORAGE=true','WEBSITE_HEALTHCHECK_MAXPINGFAILURES=3')
foreach ($key in $cloudConfig.Keys) { $settings += "App__$key=$($cloudConfig[$key])" }
$null=Invoke-AzJson (@('webapp','config','appsettings','set','--resource-group',$ResourceGroup,'--name',$webName,'--settings') + $settings)
$null=Invoke-AzJson @('webapp','config','set','--resource-group',$ResourceGroup,'--name',$webName,'--generic-configurations','healthCheckPath=/health/ready')
$previousConfig=$env:PBIEMBEDDED_CONFIG
$previousNodeEnv=$env:NODE_ENV
$artifactDirectory=Join-Path ([IO.Path]::GetTempPath()) "PBIEmbeddedAOD-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $artifactDirectory | Out-Null
Push-Location $script:RepositoryRoot
try {
    $env:PBIEMBEDDED_CONFIG=$ConfigurationPath
    $env:NODE_ENV='development'
    Invoke-NodeCommand @('src/server/dist/index.js','--migrate')
    Invoke-NodeCommand @('src/server/dist/index.js','--grant-database-principal',$runtime.clientId,$runtimeName)
    $package=Join-Path $artifactDirectory 'package'
    New-Item -ItemType Directory -Path (Join-Path $package 'src\server'),(Join-Path $package 'src\web') -Force | Out-Null
    Copy-Item -LiteralPath 'package.json','package-lock.json' -Destination $package
    Copy-Item -LiteralPath 'src\server\package.json' -Destination (Join-Path $package 'src\server')
    Copy-Item -LiteralPath 'src\web\package.json' -Destination (Join-Path $package 'src\web')
    Copy-Item -LiteralPath 'src\server\dist' -Destination (Join-Path $package 'src\server') -Recurse
    Copy-Item -LiteralPath 'src\web\dist' -Destination (Join-Path $package 'src\web') -Recurse
    New-Item -ItemType Directory -Path (Join-Path $package 'samples') | Out-Null
    Copy-Item -LiteralPath 'samples\Store Sales.pbix' -Destination (Join-Path $package 'samples')
    Push-Location $package
    try {
        & npm ci --omit=dev --ignore-scripts --os=linux --cpu=x64 --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'Production dependency packaging failed.' }
    } finally { Pop-Location }
    $zip=Join-Path $artifactDirectory 'application.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($package,$zip)
    $null=Invoke-AzJson @('webapp','deploy','--resource-group',$ResourceGroup,'--name',$webName,'--src-path',$zip,'--type','zip','--clean','true','--restart','true','--async','false','--track-status','false','--timeout','600000')
    $healthy=$false
    for ($attempt=0; $attempt -lt 36; $attempt++) {
        try {
            $live=Invoke-RestMethod "$origin/health/live" -TimeoutSec 20
            $ready=Invoke-RestMethod "$origin/health/ready" -TimeoutSec 20
            if ($live.status -eq 'live' -and $ready.status -eq 'ready') { $healthy=$true; break }
        } catch {}
        if ($attempt -lt 35) { Start-Sleep -Seconds 10 }
    }
    if (-not $healthy) { throw 'Deployment did not pass runtime health checks. Inspect managed-identity Key Vault/SQL access and application diagnostics. Deployment is not complete.' }
    Write-Host "Deployed and healthy: $origin"
    Write-Host 'No customer workspace was adopted. Complete bootstrap in the browser, then onboard tenants.'
    Write-Host 'Fabric service-principal tenant settings and user consent must allow the intended identities before actual embedding.'
} finally {
    Pop-Location
    $env:PBIEMBEDDED_CONFIG=$previousConfig
    $env:NODE_ENV=$previousNodeEnv
    if (Test-Path -LiteralPath $artifactDirectory) { Remove-Item -LiteralPath $artifactDirectory -Recurse -Force }
}
