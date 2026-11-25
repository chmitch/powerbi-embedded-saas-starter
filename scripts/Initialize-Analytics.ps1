#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$ConfigurationPath,
    [switch]$GrantGraphPermissions,
    [switch]$ResourcesOnly
)
. "$PSScriptRoot\Common.ps1"
$ConfigurationPath=Assert-ExternalConfigurationPath $ConfigurationPath
if (-not $PSCmdlet.ShouldProcess($ConfigurationPath, 'Create/reuse isolated agent workspace and analytics-reader group, assign existing management capacity, grant tenant access, and configure analytics endpoint RLS')) { return }
$configuration=Get-Content -LiteralPath $ConfigurationPath -Raw | ConvertFrom-Json -AsHashtable
$names=Get-DeploymentNames -NamePrefix $configuration.Deployment.NamePrefix -SolutionName $configuration.Deployment.SolutionName
Assert-DeploymentConfiguration $configuration $names
$app=$configuration.App
foreach ($key in @('ManagementWorkspaceId','ManagementCapacityId','SqlServer','SqlDatabase','DirectoryTenantId','SubscriptionId')) {
    if (-not $app[$key]) { throw "Recover the existing $key pin before analytics setup." }
}
if (@(Get-ChildItem Env: | Where-Object Name -like 'App__*').Count) { throw 'Clear App__ overrides before analytics setup.' }
$account=Invoke-AzJson @('account','show')
if ($account.id -ne $app.SubscriptionId -or $account.tenantId -ne $app.DirectoryTenantId) {
    throw 'Azure CLI directory/subscription differs from the pinned environment.'
}
$workspace=Invoke-Fabric "/workspaces/$($app.ManagementWorkspaceId)"
if ($workspace.capacityId -ne $app.ManagementCapacityId) { throw 'Management workspace capacity changed; review the environment pins.' }
$capacities=@(Get-FabricCollection '/capacities' | Where-Object id -EQ $app.ManagementCapacityId)
if ($capacities.Count -ne 1 -or $capacities[0].state -ne 'Active') { throw 'Resume the existing management capacity explicitly before analytics setup.' }
$marker="Data agents for $($names.BaseName); no management database or customer reports."
if ($app['AgentWorkspaceId']) {
    $agent=Invoke-Fabric "/workspaces/$($app.AgentWorkspaceId)"
    if ($agent.id -eq $app.ManagementWorkspaceId -or $agent.displayName -cne $names.AgentWorkspaceName -or $agent.description -cne $marker) {
        throw 'Pinned agent workspace is missing, protected, renamed or not owned by this deployment.'
    }
} else {
    $matches=@(Get-FabricCollection '/workspaces' | Where-Object displayName -CEQ $names.AgentWorkspaceName)
    if ($matches.Count) { throw 'An unpinned matching agent workspace exists. Reconcile and pin it explicitly; it was not adopted or duplicated.' }
    $agent=Invoke-Fabric '/workspaces' POST @{
        displayName=$names.AgentWorkspaceName; description=$marker; capacityId=$app.ManagementCapacityId
    }
    $app.AgentWorkspaceId=[Guid]::Parse($agent.id).ToString()
    Save-SafeConfiguration $ConfigurationPath $configuration
}
if ($agent.capacityId -ne $app.ManagementCapacityId) { throw 'Agent workspace is on another capacity; it was not moved automatically.' }
$groupMarker="Tenant analytics connection permission for $($names.BaseName); share database Read only."
if ($app['AnalyticsReaderGroupId']) {
    $group=Invoke-Graph "/groups/$($app.AnalyticsReaderGroupId)?`$select=id,displayName,description,securityEnabled"
    if (-not $group.securityEnabled -or $group.displayName -cne $names.AnalyticsReaderGroupName -or $group.description -cne $groupMarker) {
        throw 'Pinned analytics group changed. Review membership and item sharing before retrying.'
    }
} else {
    $matches=Invoke-Graph "/groups?`$filter=displayName eq '$($names.AnalyticsReaderGroupName)'&`$select=id"
    if (@($matches.value).Count) { throw 'An unpinned matching analytics group exists. Reconcile and pin it explicitly before retrying.' }
    $group=Invoke-Graph '/groups' POST @{
        displayName=$names.AnalyticsReaderGroupName; description=$groupMarker
        mailEnabled=$false; mailNickname=$names.AnalyticsReaderGroupName; securityEnabled=$true
    }
    $app.AnalyticsReaderGroupId=[Guid]::Parse($group.id).ToString()
    $app.AnalyticsReaderGroupName=$names.AnalyticsReaderGroupName
    Save-SafeConfiguration $ConfigurationPath $configuration
}
if ($configuration.Deployment['ProvisioningIdentityName']) {
    $identity=Invoke-AzJson @('identity','show','--resource-group',$app.ResourceGroup,'--name',$configuration.Deployment.ProvisioningIdentityName)
    $graph=Invoke-Graph "/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'"
    $role=@($graph.value[0].appRoles | Where-Object { $_.value -eq 'GroupMember.ReadWrite.All' -and $_.allowedMemberTypes -contains 'Application' })
    if ($role.Count -ne 1) { throw 'Graph group-membership application permission could not be resolved.' }
    $assigned=Invoke-Graph "/servicePrincipals/$($identity.principalId)/appRoleAssignments"
    if (-not @($assigned.value | Where-Object { $_.resourceId -eq $graph.value[0].id -and $_.appRoleId -eq $role[0].id }).Count) {
        if (-not $GrantGraphPermissions) { throw 'Provisioning identity needs Graph GroupMember.ReadWrite.All; approve and rerun with -GrantGraphPermissions.' }
        $null=Invoke-Graph "/servicePrincipals/$($identity.principalId)/appRoleAssignments" POST @{
            principalId=$identity.principalId; resourceId=$graph.value[0].id; appRoleId=$role[0].id
        }
    }
}
$endpointId=$app['AnalyticsEndpointId']
if (-not $endpointId) {
    $items=@(Get-FabricCollection "/workspaces/$($app.ManagementWorkspaceId)/items" |
        Where-Object { $_.type -eq 'SQLEndpoint' -and $_.displayName -ceq $names.SqlDatabaseName })
    if ($items.Count -ne 1) { throw 'The management analytics endpoint cannot be uniquely identified; pin its verified ID explicitly.' }
    $endpointId=[Guid]::Parse($items[0].id).ToString()
}
$endpoint=Invoke-Fabric "/workspaces/$($app.ManagementWorkspaceId)/sqlEndpoints/$endpointId"
if ($endpoint.displayName -cne $names.SqlDatabaseName) { throw 'Pinned endpoint name differs from the management database.' }
$connection=Invoke-Fabric "/workspaces/$($app.ManagementWorkspaceId)/sqlEndpoints/$endpointId/connectionString"
if ($connection.connectionString -notmatch '^[a-zA-Z0-9.-]+\.datawarehouse\.fabric\.microsoft\.com$') { throw 'Fabric returned an unsupported analytics hostname.' }
foreach ($entry in @{
    AnalyticsEndpointId=$endpointId; AnalyticsSqlServer=$connection.connectionString; AnalyticsSqlDatabase=$endpoint.displayName
}.GetEnumerator()) {
    if ($app[$entry.Key] -and $app[$entry.Key] -cne $entry.Value) { throw "Existing $($entry.Key) differs; endpoint pins were not overwritten." }
    $app[$entry.Key]=$entry.Value
}
Save-SafeConfiguration $ConfigurationPath $configuration
$previousConfig=$env:PBIEMBEDDED_CONFIG; $previousNodeEnv=$env:NODE_ENV
Push-Location $script:RepositoryRoot
try {
    $env:PBIEMBEDDED_CONFIG=$ConfigurationPath; $env:NODE_ENV='development'
    $inventory=& node .\src\server\dist\index.js --analytics-inventory
    if ($LASTEXITCODE -ne 0) { throw 'Build current server source and verify pinned SQL connectivity before setup.' }
    $tenants=@(($inventory -join "`n") | ConvertFrom-Json)
    $managementRoles=@(Get-FabricCollection "/workspaces/$($app.ManagementWorkspaceId)/roleAssignments")
    foreach ($tenant in $tenants) {
        $id=[Guid]::Parse($tenant.EmbeddingObjectId).ToString()
        $principal=Invoke-Graph "/servicePrincipals/$($id)?`$select=id,appId"
        if ($principal.appId -ne $tenant.EmbeddingClientId) { throw 'Tenant principal/client identity mismatch; no grant was added.' }
        if (@($managementRoles | Where-Object { $_.principal.id -eq $id }).Count) {
            throw 'Tenant principal has management-workspace membership. Review it explicitly; no broad role was silently removed.'
        }
        foreach ($workspaceGroup in @($managementRoles | Where-Object { $_.principal.type -eq 'Group' })) {
            $path="/groups/$($workspaceGroup.principal.id)/transitiveMembers?`$select=id&`$top=999"
            for ($page=0; $path -and $page -lt 100; $page++) {
                $members=Invoke-Graph $path
                if (@($members.value | Where-Object id -EQ $id).Count) {
                    throw 'Tenant principal inherits management-workspace membership. Review group access before retrying.'
                }
                $next=$members.PSObject.Properties['@odata.nextLink']
                $path=$null
                if ($next -and $next.Value) {
                    if (-not $next.Value.StartsWith('https://graph.microsoft.com/v1.0/',[StringComparison]::Ordinal)) {
                        throw 'Unexpected Graph continuation URL; credentials were not forwarded.'
                    }
                    $path=$next.Value.Substring('https://graph.microsoft.com/v1.0'.Length)
                }
            }
            if ($path) { throw 'Management group membership enumeration exceeded its limit.' }
        }
        $member=Invoke-Graph "/groups/$($app.AnalyticsReaderGroupId)/members/$id" -AllowNotFound
        if (-not $member) {
            $null=Invoke-Graph "/groups/$($app.AnalyticsReaderGroupId)/members/`$ref" POST @{
                '@odata.id'="https://graph.microsoft.com/v1.0/directoryObjects/$id"
            }
        }
        $roles=@(Get-FabricCollection "/workspaces/$($app.AgentWorkspaceId)/roleAssignments" | Where-Object { $_.principal.id -eq $id })
        if ($roles.Count -gt 1 -or ($roles.Count -eq 1 -and $roles[0].role -ne 'Contributor')) {
            throw 'Unexpected agent-workspace role. Review explicitly instead of silently changing privileges.'
        }
        if (-not $roles.Count) {
            $null=Invoke-Fabric "/workspaces/$($app.AgentWorkspaceId)/roleAssignments" POST @{
                principal=@{id=$id;type='ServicePrincipal'};role='Contributor'
            }
        }
        $confirmed=@(Get-FabricCollection "/workspaces/$($app.AgentWorkspaceId)/roleAssignments" |
            Where-Object { $_.principal.id -eq $id })
        if ($confirmed.Count -ne 1 -or $confirmed[0].role -ne 'Contributor') {
            throw 'Agent-workspace grant is not confirmed. Retry after propagation; no grant was replayed.'
        }
        $confirmedMember=Invoke-Graph "/groups/$($app.AnalyticsReaderGroupId)/members/$id" -AllowNotFound
        if (-not $confirmedMember) { throw 'Reader-group membership is not confirmed. Retry after propagation.' }
    }
    if (-not $ResourcesOnly) {
        Invoke-NodeCommand @('src/server/dist/index.js','--migrate')
        Invoke-NodeCommand @('src/server/dist/index.js','--setup-analytics')
    }
} finally {
    Pop-Location
    $env:PBIEMBEDDED_CONFIG=$previousConfig; $env:NODE_ENV=$previousNodeEnv
}
Write-Host "Agent workspace: $($names.AgentWorkspaceName). Capacity reused; no capacity was created/resized."
Write-Host "Share the management SQL database to group $($names.AnalyticsReaderGroupName) with Read only in Fabric; leave all additional permission boxes unchecked."
Write-Host 'Item sharing requires a portal action and propagation can take two hours. SQL configuration is not proof of effective principal access.'
if ($ResourcesOnly) { Write-Host 'Resources-only setup: migrations and SQL endpoint RLS have NOT been applied by this invocation.' }
Write-Host 'Publish an agent using only the approved analytics views after real principal isolation checks pass. Chat and platform-summary agent setup are separate work.'
