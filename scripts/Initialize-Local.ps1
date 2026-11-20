#requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ResourceGroup,
    [Parameter(Mandatory)][Alias('Prefix')][string]$NamePrefix,
    [string]$SolutionName='pbiembedded',
    [string]$Location='westus3',
    [ValidateSet('F2','F4','F8','F16','F32','F64','F128')][string]$ManagementCapacitySku='F2',
    [string]$ConfigurationPath,
    [string]$ServicePrincipalGroupId,
    [switch]$CreateServicePrincipalGroup,
    [switch]$GrantAdminConsent,
    [switch]$RotateWebSecret,
    [switch]$EnableCapacityAutoResume,
    [switch]$UseLocalSecrets,
    [switch]$UseKeyVaultPerimeter,
    [switch]$DeferSecrets,
    [string[]]$DeploymentAddressPrefixes
)
. "$PSScriptRoot\Common.ps1"
. "$PSScriptRoot\KeyVault-Network.ps1"
$names=Get-DeploymentNames -NamePrefix $NamePrefix -SolutionName $SolutionName -ResourceGroup $ResourceGroup
$ResourceGroup=$names.ResourceGroup
if (-not $ConfigurationPath) { $ConfigurationPath = Get-DefaultConfigurationPath }
$ConfigurationPath = Assert-ExternalConfigurationPath $ConfigurationPath
$configuration = if (Test-Path -LiteralPath $ConfigurationPath) { Get-Content -LiteralPath $ConfigurationPath -Raw | ConvertFrom-Json -AsHashtable } else { @{ App=@{}; Deployment=@{} } }
if (-not $configuration.ContainsKey('App')) { $configuration.App=@{} }
if (-not $configuration.ContainsKey('Deployment')) { $configuration.Deployment=@{} }
Assert-DeploymentConfiguration $configuration $names
$secretStoreDescription=if ($UseLocalSecrets) { 'private external local secret file (development only)' } else { "Key Vault $($names.VaultName)" }
if (-not $PSCmdlet.ShouldProcess("$ResourceGroup in $Location; $secretStoreDescription; management workspace $($names.ManagementWorkspaceName)", "Provision dedicated billable Fabric $ManagementCapacitySku capacity and SQL Database, credential store, and Entra sign-in application; no App Service or customer workspace")) { return }
if ($UseKeyVaultPerimeter -and $UseLocalSecrets) { throw 'Choose local development secrets or a Key Vault perimeter, not both.' }
if ($DeferSecrets -and (-not $UseKeyVaultPerimeter -or $UseLocalSecrets -or $RotateWebSecret -or $DeploymentAddressPrefixes)) {
    throw 'Deferred Azure secret initialization requires a Key Vault perimeter, no deployment-source rule, and no local secrets or local credential rotation.'
}
if ($UseKeyVaultPerimeter -and -not $DeferSecrets) { Assert-PerimeterAddressPrefixes $DeploymentAddressPrefixes }
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Install Azure CLI and sign in with az login first.' }
$account = Invoke-AzJson @('account','show')
if ($configuration.App['DirectoryTenantId'] -and $configuration.App['DirectoryTenantId'] -ne $account.tenantId) { throw 'Existing configuration belongs to a different Entra directory. Use a separate external configuration path.' }
if ($configuration.App['SubscriptionId'] -and $configuration.App['SubscriptionId'] -ne $account.id) { throw 'Existing configuration targets another subscription. Use a separate external configuration path.' }
if ($configuration.App['AzureLocation'] -and $configuration.App['AzureLocation'] -ne $Location) { throw 'Existing configuration targets another region. Use a different namespace and external configuration path; resources are not moved automatically.' }
$providers=if ($UseLocalSecrets) { @() } else { @('Microsoft.KeyVault') }
foreach ($provider in $providers) {
    $null=Invoke-AzJson @('provider','register','--namespace',$provider,'--wait')
}
$operator = Invoke-AzJson @('ad','signed-in-user','show')
if (-not $operator.id -or -not $operator.userPrincipalName) { throw 'Local initialization requires a signed-in workforce user with Azure provisioning, role-assignment, and Entra application-creation permissions.' }
if ($configuration.App['ResourceGroup'] -and $configuration.App['ResourceGroup'] -ne $ResourceGroup) { throw 'Existing configuration targets another resource group. Use a separate external configuration path.' }
$vaultName=$names.VaultName
$null = Invoke-AzJson @('group','create','--name',$ResourceGroup,'--location',$Location)
$vault=$null
$localSecretsPath=''
if ($UseLocalSecrets) {
    $localSecretsPath=Initialize-LocalSecretFile (Join-Path (Split-Path $ConfigurationPath -Parent) 'secrets\secrets.json')
} else {
    $vaults = Invoke-AzJson @('keyvault','list','--resource-group',$ResourceGroup)
    if (@($vaults | Where-Object name -eq $vaultName).Count) {
        $vault = Invoke-AzJson @('keyvault','show','--name',$vaultName,'--resource-group',$ResourceGroup)
        if (-not $vault.properties.enableRbacAuthorization -or -not $vault.properties.enablePurgeProtection) {
            throw 'The existing Key Vault must have RBAC authorization and purge protection enabled before reuse.'
        }
    } else {
        $vaultArguments=@('keyvault','create','--name',$vaultName,'--resource-group',$ResourceGroup,'--location',$Location,'--enable-rbac-authorization','true','--enable-purge-protection','true','--retention-days','7')
        if ($UseKeyVaultPerimeter) { $vaultArguments+=@('--public-network-access','Disabled') }
        $vault = Invoke-AzJson $vaultArguments
    }
    if (-not $DeferSecrets) { Ensure-RoleAssignment -PrincipalId $operator.id -PrincipalType User -Role 'Key Vault Secrets Officer' -Scope $vault.id }
    if ($UseKeyVaultPerimeter) {
        $perimeterId="/subscriptions/$($account.id)/resourceGroups/$ResourceGroup/providers/Microsoft.Network/networkSecurityPerimeters/$($names.PerimeterName)"
        Initialize-KeyVaultPerimeter $vault.id $perimeterId $Location $DeploymentAddressPrefixes -ApplicationOnly:$DeferSecrets
    }
}
$fabricConfigurationPath=Join-Path (Split-Path $ConfigurationPath -Parent) 'fabric-database.json'
if ($fabricConfigurationPath -eq $ConfigurationPath) { throw 'The application ConfigurationPath must differ from the Fabric database metadata path.' }
$fabric=& "$PSScriptRoot\Initialize-FabricDatabase.ps1" -NamePrefix $NamePrefix -SolutionName $SolutionName `
    -Location $Location -ManagementCapacitySku $ManagementCapacitySku -ConfigurationPath $fabricConfigurationPath -PassThru
foreach ($key in @('SqlServer','SqlDatabase','ManagementWorkspaceId','ManagementCapacityId','ManagementCapacityResourceId')) {
    if ($configuration.App[$key] -and $configuration.App[$key] -ne $fabric.App[$key]) {
        throw "The recorded $key differs from the provisioned Fabric database. Review recovery/migration explicitly."
    }
}
$displayName=$names.WebApplicationName
$applications = Invoke-Graph "/applications?`$filter=displayName eq '$displayName'"
if (@($applications.value).Count -gt 1) { throw 'Multiple matching app registrations exist; resolve the ambiguity before retrying.' }
$application = @($applications.value) | Select-Object -First 1
$resource = Invoke-Graph "/servicePrincipals?`$filter=appId eq '00000009-0000-0000-c000-000000000000'"
if (-not @($resource.value).Count) { throw 'Power BI service principal was not found in this directory. A Fabric administrator must initialize/enable Power BI first.' }
$resourceAccess = @()
$delegatedScopes=@('Workspace.ReadWrite.All','Report.ReadWrite.All','Dataset.ReadWrite.All','Capacity.ReadWrite.All')
foreach ($scope in $delegatedScopes) {
    $permission = @($resource.value[0].oauth2PermissionScopes | Where-Object value -eq $scope) | Select-Object -First 1
    if (-not $permission) { throw "The Power BI delegated permission $scope is unavailable." }
    $resourceAccess += @{ id=$permission.id; type='Scope' }
}
$web = @{ redirectUris=@('http://localhost:3000/auth/callback'); implicitGrantSettings=@{ enableIdTokenIssuance=$false; enableAccessTokenIssuance=$false } }
if ($application) {
    $existingApplication = Invoke-Graph "/applications/$($application.id)"
    $web.redirectUris = @(@($existingApplication.web.redirectUris) + $web.redirectUris | Select-Object -Unique)
    $null = Invoke-Graph "/applications/$($application.id)" PATCH @{ web=$web; requiredResourceAccess=@(@{ resourceAppId=$resource.value[0].appId; resourceAccess=$resourceAccess }) }
} else {
    $application = Invoke-Graph '/applications' POST @{ displayName=$displayName; signInAudience='AzureADMyOrg'; web=$web; requiredResourceAccess=@(@{ resourceAppId=$resource.value[0].appId; resourceAccess=$resourceAccess }) }
}
$principals = Invoke-Graph "/servicePrincipals?`$filter=appId eq '$($application.appId)'"
$principal = @($principals.value) | Select-Object -First 1
if (-not $principal) { $principal = Invoke-Graph '/servicePrincipals' POST @{ appId=$application.appId } }
$vaultUri=if ($vault) { $vault.properties.vaultUri } else { '' }
if (-not $DeferSecrets) {
    $hasWebSecret=if ($UseLocalSecrets) { (Read-LocalSecretFile $localSecretsPath).secrets.ContainsKey($names.WebClientSecretName) } else { Test-VaultSecret $vaultUri $names.WebClientSecretName }
    if ($RotateWebSecret -or -not $hasWebSecret) {
        $expiresOn=[DateTime]::UtcNow.AddMonths(6)
        $password = Invoke-Graph "/applications/$($application.id)/addPassword" POST @{ passwordCredential=@{ displayName=$(if ($UseLocalSecrets) { 'Local development portal credential' } else { 'Key Vault portal credential' }); endDateTime=$expiresOn.ToString('o') } }
        try {
            if ($UseLocalSecrets) { Set-LocalSecretSecurely $localSecretsPath $names.WebClientSecretName $password.secretText -ExpiresOn $expiresOn }
            else { Set-VaultSecretSecurely $vaultUri $names.WebClientSecretName $password.secretText }
        }
        catch {
            $null = Invoke-Graph "/applications/$($application.id)/removePassword" POST @{ keyId=$password.keyId }
            throw 'Failed to persist the new web credential in the selected store. It was revoked; no credential was printed.'
        } finally { $password=$null }
    }
    $hasSessionSecret=if ($UseLocalSecrets) { (Read-LocalSecretFile $localSecretsPath).secrets.ContainsKey($names.SessionSecretName) } else { Test-VaultSecret $vaultUri $names.SessionSecretName }
    if (-not $hasSessionSecret) {
        $value=[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
        if ($UseLocalSecrets) { Set-LocalSecretSecurely $localSecretsPath $names.SessionSecretName $value }
        else { Set-VaultSecretSecurely $vaultUri $names.SessionSecretName $value }
        $value=$null
    }
}
if ($CreateServicePrincipalGroup -and -not $ServicePrincipalGroupId) {
    $groupName=$names.EmbeddingGroupName
    $groups=Invoke-Graph "/groups?`$filter=displayName eq '$groupName'"
    if (@($groups.value).Count -gt 1) { throw 'Multiple matching embedding groups exist; specify ServicePrincipalGroupId explicitly.' }
    $group=@($groups.value) | Select-Object -First 1
    if (-not $group) {
        $group=Invoke-Graph '/groups' POST @{ displayName=$groupName; mailEnabled=$false; mailNickname=$groupName; securityEnabled=$true;
            'owners@odata.bind'=@("https://graph.microsoft.com/v1.0/users/$($operator.id)") }
    }
    $ServicePrincipalGroupId=$group.id
}
if ($GrantAdminConsent) {
    Ensure-DelegatedAdminConsent $application.appId $principal.id $resource.value[0].id $delegatedScopes
}
$configuration.App=@{
    DirectoryTenantId=$account.tenantId; WebClientId=$application.appId; WebClientSecretName=$names.WebClientSecretName;
    SessionSecretName=$names.SessionSecretName; KeyVaultUri=$vaultUri; LocalSecretsPath=$localSecretsPath; BootstrapObjectId=$operator.id; ResourceNamePrefix=$names.BaseName;
    SubscriptionId=$account.id; ResourceGroup=$ResourceGroup; AzureLocation=$Location; SqlServer=$fabric.App.SqlServer;
    SqlDatabase=$fabric.App.SqlDatabase; PublicOrigin='http://localhost:3000'; Port=3000;
    ManagementWorkspaceId=$fabric.App.ManagementWorkspaceId; ManagementCapacityId=$fabric.App.ManagementCapacityId;
    ManagementCapacityResourceId=$fabric.App.ManagementCapacityResourceId;
    AutoResumeCapacities=($EnableCapacityAutoResume.IsPresent -or $configuration.App['AutoResumeCapacities'] -eq $true);
    RuntimeManagedIdentityClientId=''; ProvisioningManagedIdentityClientId='';
    ServicePrincipalGroupId=$(if ($ServicePrincipalGroupId) { $ServicePrincipalGroupId } elseif ($configuration.App['ServicePrincipalGroupId']) { $configuration.App['ServicePrincipalGroupId'] } else { '' })
}
$configuration.Deployment=@{} + $fabric.Deployment
if ($vault) { $configuration.Deployment.VaultId=$vault.id }
$configuration.Deployment.WebApplicationObjectId=$application.id
$configuration.Deployment.WebServicePrincipalObjectId=$principal.id
Save-SafeConfiguration $ConfigurationPath $configuration
Write-Host "Resources configured. Non-secret configuration: $ConfigurationPath"
if ($UseLocalSecrets) { Write-Host "Development credentials are in the owner-restricted external file: $localSecretsPath. This file contains plaintext secrets; never sync, print, or commit it." }
Write-Host 'The dedicated management capacity, Fabric SQL database, and any selected Key Vault can incur charges. No customer workspace or App Service was created.'
Write-Host 'A Fabric administrator must enable service-principal API access and embedding for the intended group. Consent may also require an Entra administrator.'
if ($DeferSecrets) {
    Write-Host 'Secrets were not accessed or generated locally. Complete Deploy.ps1; App Service initializes missing credentials using its provisioning managed identity before portal startup.'
} else {
    Write-Host 'Run npm run build, npm run migrate, then npm start. Use PBIEMBEDDED_CONFIG for a non-default configuration path.'
}
