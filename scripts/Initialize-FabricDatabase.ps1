#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][Alias('Prefix')][string]$NamePrefix,
    [string]$SolutionName='pbiembedded',
    [string]$Location='westus3',
    [ValidateSet('F2','F4','F8','F16','F32','F64','F128')][string]$ManagementCapacitySku='F2',
    [string]$ConfigurationPath,
    [switch]$PassThru
)
. "$PSScriptRoot\Common.ps1"
$names=Get-DeploymentNames -NamePrefix $NamePrefix -SolutionName $SolutionName
if (-not $ConfigurationPath) {
    $ConfigurationPath=Join-Path (Split-Path (Get-DefaultConfigurationPath) -Parent) "$($names.BaseName)\fabric-database.json"
}
$ConfigurationPath=Assert-ExternalConfigurationPath $ConfigurationPath
$configuration=if (Test-Path -LiteralPath $ConfigurationPath) { Get-Content -LiteralPath $ConfigurationPath -Raw | ConvertFrom-Json -AsHashtable } else { @{ App=@{}; Deployment=@{} } }
Assert-DeploymentConfiguration $configuration $names
if (-not $PSCmdlet.ShouldProcess("$($names.ManagementCapacityName) ($ManagementCapacitySku, $Location), $($names.ManagementWorkspaceName), $($names.SqlDatabaseName)", 'Create/reuse billable dedicated Fabric capacity, management workspace and transactional SQL Database; preserve all existing Azure SQL resources')) { return }
$account=Invoke-AzJson @('account','show')
$operator=Invoke-AzJson @('ad','signed-in-user','show')
if (-not $operator.id -or -not $operator.userPrincipalName) { throw 'Fabric database provisioning requires a signed-in workforce user.' }
foreach ($entry in @{ DirectoryTenantId=$account.tenantId; SubscriptionId=$account.id; AzureLocation=$Location }.GetEnumerator()) {
    if ($configuration.App[$entry.Key] -and $configuration.App[$entry.Key] -ne $entry.Value) {
        throw "Existing Fabric database configuration has a different $($entry.Key). Use a separate external configuration path."
    }
}
$null=Invoke-AzJson @('provider','register','--namespace','Microsoft.Fabric','--wait')
$null=Invoke-AzJson @('group','create','--name',$names.ResourceGroup,'--location',$Location)
$armToken=Get-ServiceToken 'https://management.azure.com/'
$capacityResourceId="/subscriptions/$($account.id)/resourceGroups/$($names.ResourceGroup)/providers/Microsoft.Fabric/capacities/$($names.ManagementCapacityName)"
$capacityUri="https://management.azure.com$($capacityResourceId)?api-version=2023-11-01"
$capacity=Invoke-PrivateRest -Uri $capacityUri -Token $armToken -AllowNotFound
if ($capacity) {
    if (($capacity.location -replace '\s','') -ne ($Location -replace '\s','') -or $capacity.sku.name -ne $ManagementCapacitySku) {
        throw 'Existing management capacity has a different region or SKU. This script never moves or resizes an existing capacity implicitly.'
    }
    if ($capacity.properties.state -in @('Paused','Pausing','Suspended','Suspending')) {
        throw 'The management capacity is paused. Resume it explicitly before provisioning; this script does not silently restart billing.'
    }
} else {
    Write-Host "Creating billable management capacity $($names.ManagementCapacityName) ($ManagementCapacitySku) in $Location."
    $null=Invoke-PrivateRest -Uri $capacityUri -Token $armToken -Method PUT -Body @{
        location=$Location; sku=@{ name=$ManagementCapacitySku; tier='Fabric' }
        properties=@{ administration=@{ members=@($operator.userPrincipalName) } }
    }
}
$ready=$false
for ($attempt=0; $attempt -lt 60; $attempt++) {
    $capacity=Invoke-PrivateRest -Uri $capacityUri -Token $armToken
    if ($capacity.properties.provisioningState -in @('Failed','Canceled') -or $capacity.properties.state -eq 'Failed') {
        throw 'Management capacity provisioning failed. Inspect its Azure Activity Log; no existing capacities were changed.'
    }
    if ($capacity.properties.state -eq 'Active' -and $capacity.properties.provisioningState -eq 'Succeeded') { $ready=$true; break }
    Start-Sleep -Seconds 10
}
if (-not $ready) { throw 'Management capacity did not become active within ten minutes. Inspect and rerun with the same configuration; do not create a replacement.' }
$fabricCapacity=$null
for ($attempt=0; $attempt -lt 60; $attempt++) {
    $matches=@(Get-FabricCollection '/capacities' | Where-Object { $_.displayName -ceq $names.ManagementCapacityName })
    if ($matches.Count -gt 1) { throw 'Multiple Fabric capacities match the management capacity name. Resolve the ambiguity before retrying.' }
    if ($matches.Count -eq 1 -and $matches[0].state -eq 'Active') { $fabricCapacity=$matches[0]; break }
    Start-Sleep -Seconds 10
}
if (-not $fabricCapacity) { throw 'The active Azure capacity is not yet visible through Fabric. Verify capacity permissions and rerun; no replacement was created.' }
if ($configuration.App['ManagementCapacityId'] -and $configuration.App['ManagementCapacityId'] -ne $fabricCapacity.id) {
    throw 'The management capacity ID changed. Review recovery explicitly rather than redirecting an existing deployment.'
}
foreach ($entry in @{
    DirectoryTenantId=$account.tenantId; SubscriptionId=$account.id; AzureLocation=$Location
    ResourceGroup=$names.ResourceGroup; ResourceNamePrefix=$names.BaseName
    ManagementCapacityId=$fabricCapacity.id; ManagementCapacityResourceId=$capacityResourceId
}.GetEnumerator()) { $configuration.App[$entry.Key]=$entry.Value }
$previousDatabaseId=$configuration.Deployment['ManagementDatabaseId']
$configuration.Deployment=@{} + $names
$configuration.Deployment.DatabaseProvider='FabricSql'
if ($previousDatabaseId) { $configuration.Deployment.ManagementDatabaseId=$previousDatabaseId }
Save-SafeConfiguration $ConfigurationPath $configuration
$matches=@(Get-FabricCollection '/workspaces' | Where-Object { $_.displayName -ceq $names.ManagementWorkspaceName })
if ($matches.Count -gt 1) { throw 'Multiple management workspaces match the namespace. Resolve the ambiguity before retrying.' }
$workspace=$matches | Select-Object -First 1
if ($workspace) {
    if ($workspace.capacityId -ne $fabricCapacity.id) { throw 'The management workspace is on a different capacity. It was not moved automatically.' }
    if ($workspace.description -cne "Management database for $($names.BaseName); not a customer tenant workspace.") {
        throw 'The matching workspace is not marked as this deployment management workspace. Existing workspaces are not adopted implicitly.'
    }
} else {
    if ($configuration.App['ManagementWorkspaceId']) { throw 'The recorded management workspace is missing. Review recovery explicitly before creating a replacement.' }
    $workspace=Invoke-Fabric '/workspaces' POST @{
        displayName=$names.ManagementWorkspaceName; capacityId=$fabricCapacity.id
        description="Management database for $($names.BaseName); not a customer tenant workspace."
    }
    if ($configuration.App['ManagementWorkspaceId'] -and $configuration.App['ManagementWorkspaceId'] -ne $workspace.id) {
        throw 'The management workspace ID changed. Review recovery explicitly before redirecting the database.'
    }
}
$configuration.App.ManagementWorkspaceId=$workspace.id
Save-SafeConfiguration $ConfigurationPath $configuration
$namedItems=@(Get-FabricCollection "/workspaces/$($workspace.id)/items" | Where-Object { $_.displayName -ceq $names.SqlDatabaseName })
$matches=@($namedItems | Where-Object { $_.type -eq 'SQLDatabase' })
if ($matches.Count -gt 1 -or ($matches.Count -eq 0 -and $namedItems.Count -gt 0)) {
    throw 'The database name is ambiguous or already belongs to a different Fabric item type.'
}
$database=$matches | Select-Object -First 1
if (-not $database) {
    if ($previousDatabaseId) { throw 'The recorded SQL database is missing. Review restore/recovery explicitly before creating a replacement.' }
    $created=Invoke-Fabric "/workspaces/$($workspace.id)/sqlDatabases" POST @{
        displayName=$names.SqlDatabaseName; description="Application management database for $($names.BaseName)."
    }
    if ($created -and $created.PSObject.Properties['id']) { $database=$created }
}
$ready=$false
for ($attempt=0; $attempt -lt 90; $attempt++) {
    if (-not $database) {
        $matches=@(Get-FabricCollection "/workspaces/$($workspace.id)/items" | Where-Object { $_.displayName -ceq $names.SqlDatabaseName -and $_.type -eq 'SQLDatabase' })
        if ($matches.Count -gt 1) { throw 'Multiple database items appeared during provisioning. Resolve the ambiguity before retrying.' }
        $database=$matches | Select-Object -First 1
    }
    if ($database) {
        $database=Invoke-Fabric "/workspaces/$($workspace.id)/sqlDatabases/$($database.id)" -AllowNotFound
        $properties=if ($database) { $database.PSObject.Properties['properties'] } else { $null }
        if ($properties -and $properties.Value.PSObject.Properties['serverFqdn'] -and $properties.Value.serverFqdn -and
            $properties.Value.PSObject.Properties['databaseName'] -and $properties.Value.databaseName) { $ready=$true; break }
    }
    Start-Sleep -Seconds 10
}
if (-not $ready) { throw 'Fabric SQL connection details are not ready. Rerun with the same configuration after inspecting the existing database; do not create a replacement.' }
if ($previousDatabaseId -and $previousDatabaseId -ne $database.id) { throw 'The SQL database ID changed. Review recovery explicitly before redirecting the application.' }
$server=([string]$database.properties.serverFqdn) -replace '^tcp:','' -replace ',1433$',''
if ($server -notmatch '^[a-zA-Z0-9.-]+\.(database\.windows\.net|database\.fabric\.microsoft\.com)$') {
    throw 'Fabric returned an unsupported transactional SQL hostname. No analytics endpoint was substituted.'
}
$configuration.App.SqlServer=$server
$configuration.App.SqlDatabase=$database.properties.databaseName
$configuration.Deployment.ManagementDatabaseId=$database.id
Save-SafeConfiguration $ConfigurationPath $configuration
Write-Host "Fabric management database provisioned. Non-secret connection metadata: $ConfigurationPath"
Write-Host 'Capacity and database storage can incur charges. Pausing this capacity affects application persistence and sign-in.'
Write-Host 'SQL data-plane connectivity and application migrations still require verification.'
if ($PassThru) { return $configuration }
