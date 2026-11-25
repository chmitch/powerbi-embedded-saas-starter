Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:RepositoryRoot = Split-Path $PSScriptRoot -Parent

function Get-DeploymentNames {
    param([Parameter(Mandatory)][string]$NamePrefix, [string]$SolutionName='pbiembedded', [string]$ResourceGroup)
    foreach ($part in @($NamePrefix,$SolutionName)) {
        if ($part -cnotmatch '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$') {
            throw 'NamePrefix and SolutionName must start with a lowercase letter and contain lowercase letters, digits, or single internal hyphens.'
        }
    }
    $base="$NamePrefix-$SolutionName"
    if ($base.Length -gt 21) { throw 'The combined prefix-solution name must be at most 21 characters so the Key Vault name fits its 24-character limit. Names are never truncated.' }
    $group="$base-rg"
    if ($ResourceGroup -and $ResourceGroup -cne $group) { throw "ResourceGroup must be $group for this namespace. Existing resource groups are not renamed automatically." }
    return @{
        NamingVersion=2; NamePrefix=$NamePrefix; SolutionName=$SolutionName; BaseName=$base; ResourceGroup=$group
        VaultName="$base-kv"; SqlDatabaseName="$base-configdb"; PerimeterName="$base-nsp"
        ManagementWorkspaceName="$base-mgmt"; ManagementCapacityName="$($base.Replace('-',''))mgmt"
        AgentWorkspaceName="$base-agents"; AnalyticsReaderGroupName="$base-analytics-readers"
        WebAppName="$base-web"; AppServicePlanName="$base-plan"
        RuntimeIdentityName="$base-runtime-mi"; ProvisioningIdentityName="$base-provision-mi"
        WebApplicationName="$base-auth"; EmbeddingGroupName="$base-embedding"
        CapacityRoleName="$base-capacity-operator"
        WebClientSecretName="$base-web-client-secret"; SessionSecretName="$base-session-key"
    }
}

function Assert-DeploymentConfiguration {
    param([Parameter(Mandatory)][hashtable]$Configuration,[Parameter(Mandatory)][hashtable]$Names)
    if (($Configuration.App.Count -gt 0 -or $Configuration.Deployment.Count -gt 0) -and
        ($Configuration.Deployment['NamingVersion'] -ne $Names.NamingVersion -or
         $Configuration.Deployment['BaseName'] -cne $Names.BaseName)) {
        throw 'Existing configuration uses a different or legacy naming scheme. Use a separate external ConfigurationPath for the new namespace. Resources, secrets, and data are not renamed or migrated automatically.'
    }
    foreach ($key in $Names.Keys) {
        if ($Configuration.Deployment.ContainsKey($key) -and $Configuration.Deployment[$key] -cne $Names[$key]) {
            throw "Existing deployment configuration has a different $key. Use a separate external configuration path."
        }
    }
    if ($Configuration.App['SqlServer'] -and $Configuration.Deployment['DatabaseProvider'] -ne 'FabricSql') {
        throw 'Existing configuration targets a legacy database provider. Use a separate external configuration path and explicitly plan data migration; databases are not moved automatically.'
    }
    foreach ($entry in @{ ResourceGroup=$Names.ResourceGroup; ResourceNamePrefix=$Names.BaseName; WebClientSecretName=$Names.WebClientSecretName; SessionSecretName=$Names.SessionSecretName }.GetEnumerator()) {
        if ($Configuration.App[$entry.Key] -and $Configuration.App[$entry.Key] -cne $entry.Value) {
            throw "Existing application configuration has a different $($entry.Key). Use a separate external configuration path."
        }
    }
}

function Invoke-Fabric {
    param([Parameter(Mandatory)][string]$Path, [string]$Method='GET', [object]$Body, [switch]$AllowNotFound)
    if (-not $Path.StartsWith('/') -or $Path.StartsWith('//')) { throw 'Fabric paths must be relative to the Fabric v1 API.' }
    Invoke-PrivateRest -Uri "https://api.fabric.microsoft.com/v1$Path" -Token (Get-ServiceToken 'https://api.fabric.microsoft.com') -Method $Method -Body $Body -AllowNotFound:$AllowNotFound
}

function Get-FabricCollection {
    param([Parameter(Mandatory)][string]$Path)
    $uri="https://api.fabric.microsoft.com/v1$Path"
    $items=@()
    for ($pageNumber=0; $pageNumber -lt 100; $pageNumber++) {
        if (-not $uri.StartsWith('https://api.fabric.microsoft.com/v1/',[StringComparison]::Ordinal)) {
            throw 'Unexpected Fabric continuation URL. Credentials were not forwarded.'
        }
        $page=Invoke-PrivateRest -Uri $uri -Token (Get-ServiceToken 'https://api.fabric.microsoft.com')
        $items+=@($page.value)
        $next=$page.PSObject.Properties['continuationUri']
        if (-not $next -or -not $next.Value) { return $items }
        $uri=[string]$next.Value
    }
    throw 'Fabric enumeration exceeded the supported pagination limit.'
}

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $diagnostics=[Collections.Generic.List[string]]::new()
    $result = & az @Arguments --only-show-errors --output json 2>&1 | ForEach-Object {
        if ($_ -is [Management.Automation.ErrorRecord]) { $diagnostics.Add([string]$_) } else { $_ }
    }
    if ($LASTEXITCODE -ne 0) {
        if (($Arguments[0..([Math]::Min(2,$Arguments.Length-1))] -join ' ') -in @('appservice plan create','deployment group validate') -and
            (($diagnostics.ToArray() + @($result)) -join "`n") -match 'cannot be completed without additional quota') {
            throw 'App Service quota is insufficient according to deployment validation. At least one Linux instance of the selected SKU/region is required. Check https://aka.ms/azure-quota (provider: App Service); if portal/API counters already show headroom, ask Azure Support to reconcile the effective quota. No alternate SKU/region or quota bypass was applied.'
        }
        throw "Azure CLI operation failed ($($Arguments[0..([Math]::Min(2,$Arguments.Length-1))] -join ' ')). Check permissions and prerequisites. No credentials were printed."
    }
    if ($result) { return ($result -join "`n" | ConvertFrom-Json -AsHashtable) }
}

function Invoke-PrivateRest {
    param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$Token,
        [string]$Method = 'GET', [object]$Body, [switch]$AllowNotFound)
    try {
        $arguments = @{ Uri=$Uri; Method=$Method; Headers=@{ Authorization="Bearer $Token" }; ErrorAction='Stop' }
        if ($null -ne $Body) { $arguments.ContentType='application/json'; $arguments.Body=($Body | ConvertTo-Json -Depth 30 -Compress) }
        return Invoke-RestMethod @arguments
    } catch {
        $responseProperty = $_.Exception.PSObject.Properties['Response']
        $status = if ($responseProperty -and $null -ne $responseProperty.Value) { [int]$responseProperty.Value.StatusCode } else { 0 }
        if ($AllowNotFound -and $status -eq 404) { return $null }
        throw "Authenticated service operation failed (HTTP $status). Verify permissions, consent, RBAC propagation, and resource state. Sensitive request/response data was suppressed."
    }
}

function Get-ServiceToken {
    param([Parameter(Mandatory)][string]$Resource)
    $token = Invoke-AzJson @('account','get-access-token','--resource',$Resource)
    return $token.accessToken
}

function Assert-AppServiceQuota {
    param([string]$SubscriptionId, [string]$Location, [string]$Sku)
    $region=[Uri]::EscapeDataString($Location)
    $usage=Invoke-PrivateRest -Uri "https://management.azure.com/subscriptions/$SubscriptionId/providers/Microsoft.Web/locations/$region/usages?api-version=2024-11-01" `
        -Token (Get-ServiceToken 'https://management.azure.com/')
    foreach ($name in @($Sku,'*')) {
        $rows=@($usage.value | Where-Object { $_.name.value -ieq $name })
        if ($name -eq $Sku -and $rows.Count -eq 0) {
            Write-Warning "App Service usage API omitted $Sku in $Location. ARM Provider validation must succeed before billable provisioning."
            continue
        }
        if ($rows.Count -ne 1 -or $rows[0].unit -ne 'Instances') {
            throw "App Service quota for $Sku in $Location could not be verified. No billable infrastructure was provisioned by this run."
        }
        if ($rows[0].currentValue -ge $rows[0].limit) {
            throw "Insufficient App Service quota for $Sku in $Location (counter: $name). Request SKU and total regional headroom before retrying. No billable infrastructure was provisioned by this run."
        }
    }
}

function Assert-AppServicePlanDeployment {
    param([string]$ResourceGroup, [string]$PlanName, [string]$Location, [string]$Sku)
    $templateFile=Join-Path ([IO.Path]::GetTempPath()) "pbi-plan-validation-$([Guid]::NewGuid().ToString('N')).json"
    try {
        @{
            '$schema'='https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#'
            contentVersion='1.0.0.0'
            resources=@(@{
                type='Microsoft.Web/serverfarms'; apiVersion='2024-11-01'
                name=$PlanName; location=$Location; kind='linux'
                sku=@{ name=$Sku; capacity=1 }; properties=@{ reserved=$true }
            })
        } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $templateFile -Encoding utf8
        # Usage counters can show headroom while provider validation rejects Linux quota.
        $null=Invoke-AzJson @('deployment','group','validate','--resource-group',$ResourceGroup,
            '--name',"$PlanName-preflight",'--template-file',$templateFile,'--validation-level','Provider')
    } finally { Remove-Item -LiteralPath $templateFile -ErrorAction SilentlyContinue }
}

function Invoke-Graph {
    param([Parameter(Mandatory)][string]$Path, [string]$Method='GET', [object]$Body, [switch]$AllowNotFound)
    Invoke-PrivateRest -Uri "https://graph.microsoft.com/v1.0$Path" -Token (Get-ServiceToken 'https://graph.microsoft.com') -Method $Method -Body $Body -AllowNotFound:$AllowNotFound
}

function Ensure-DelegatedAdminConsent {
    param([string]$ApplicationClientId, [string]$ServicePrincipalObjectId,
        [string]$ResourceServicePrincipalObjectId, [string[]]$Scopes)
    for ($attempt=0; $attempt -lt 18; $attempt++) {
        try {
            $grants=Invoke-Graph "/oauth2PermissionGrants?`$filter=clientId eq '$ServicePrincipalObjectId'"
            $matching=@($grants.value | Where-Object {
                $_.consentType -eq 'AllPrincipals' -and $_.resourceId -eq $ResourceServicePrincipalObjectId
            })
            if ($matching.Count -eq 1) {
                $granted=@($matching[0].scope -split '\s+')
                if (-not @($Scopes | Where-Object { $_ -notin $granted }).Count) { return }
            }
            $null=Invoke-AzJson @('ad','app','permission','admin-consent','--id',$ApplicationClientId)
        } catch {
            if ($attempt -eq 17) { throw 'Sign-in app admin consent could not be granted and verified. Check authorized Entra administrator permissions and retry with the same configuration.' }
        }
        if ($attempt -lt 17) { Start-Sleep -Seconds 5 }
    }
    throw 'Sign-in app admin consent did not become verifiable. Deployment is not complete.'
}

function Assert-ExternalConfigurationPath {
    param([Parameter(Mandatory)][string]$Path)
    $fullPath = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetFullPath($script:RepositoryRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($fullPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Configuration must be outside the repository. Never write secrets or local state into the checkout.' }
    return $fullPath
}

function Get-DefaultConfigurationPath {
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME '.config' }
    return Join-Path $base 'PBIEmbeddedAOD\configuration.json'
}

function Protect-LocalSecretPath {
    param([Parameter(Mandatory)][string]$Path,[switch]$Directory)
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $principal="*$sid"
    $grant=if ($Directory) { "${principal}:(OI)(CI)F" } else { "${principal}:F" }
    # Change only the DACL, without requesting ownership or audit-policy privileges.
    $null=& icacls.exe $Path /grant:r $grant /inheritance:r 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the local secret path to the current Windows identity.' }
    foreach ($rule in @((Get-Acl -LiteralPath $Path).Access)) {
        $identity=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($identity -ne $sid -or $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) {
            $operation=if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) { '/remove:d' } else { '/remove:g' }
            $null=& icacls.exe $Path $operation "*$identity" 2>&1
            if ($LASTEXITCODE -ne 0) { throw 'Could not remove an unexpected local secret path access rule.' }
        }
    }
}

function Initialize-LocalSecretFile {
    param([Parameter(Mandatory)][string]$Path)
    if (-not $IsWindows) { throw 'Local-file provisioning currently requires Windows to apply owner-only directory and file ACLs.' }
    $fullPath=Assert-ExternalConfigurationPath $Path
    $parent=Split-Path $fullPath -Parent
    $null=New-Item -ItemType Directory -Path $parent -Force
    & node --input-type=module -e 'import fs from "node:fs"; import path from "node:path"; const dir=fs.realpathSync(process.argv[1]); const root=fs.realpathSync(process.argv[2]); const relative=path.relative(root,dir); if(!relative || (!relative.startsWith(".."+path.sep) && !path.isAbsolute(relative))) process.exit(1);' $parent $script:RepositoryRoot
    if ($LASTEXITCODE -ne 0) { throw 'Local secrets must resolve outside the repository, including through directory links.' }
    if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Use a private local secret directory, not a directory link.' }
    Protect-LocalSecretPath $parent -Directory
    if (Test-Path -LiteralPath $fullPath) {
        if ((Get-Item -LiteralPath $fullPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The local secret file cannot be a file link.' }
        Protect-LocalSecretPath $fullPath
    } else {
        @{ version=1; secrets=@{} } | ConvertTo-Json | Set-Content -LiteralPath $fullPath -Encoding utf8NoBOM
    }
    return $fullPath
}

function Read-LocalSecretFile {
    param([Parameter(Mandatory)][string]$Path)
    try {
        $store=Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
        if ($store['version'] -ne 1 -or $store['secrets'] -isnot [System.Collections.IDictionary]) { throw 'Invalid secret store' }
        return $store
    } catch { throw 'The external local secret file is invalid or inaccessible. Its contents were not printed.' }
}

function Set-LocalSecretSecurely {
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Name,[Parameter(Mandatory)][string]$Value,[DateTime]$ExpiresOn)
    $Path=Assert-ExternalConfigurationPath $Path
    $store=Read-LocalSecretFile $Path
    $entry=@{ value=$Value }
    if ($PSBoundParameters.ContainsKey('ExpiresOn')) { $entry.expiresOn=$ExpiresOn.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
    $store.secrets[$Name]=$entry
    $temporary="$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $store | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temporary -Encoding utf8NoBOM
        [IO.File]::Move($temporary,$Path,$true)
    } catch { throw 'Could not save the credential in the private local secret file. No credential was printed.' }
    finally { Remove-Item -LiteralPath $temporary -ErrorAction SilentlyContinue }
}

function Save-SafeConfiguration {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][hashtable]$Configuration)
    $fullPath = Assert-ExternalConfigurationPath $Path
    $parent = Split-Path $fullPath -Parent
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $Configuration | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $fullPath -Encoding utf8
}

function Set-VaultSecretSecurely {
    param([Parameter(Mandatory)][string]$VaultUri, [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Value)
    $token = Get-ServiceToken 'https://vault.azure.net'
    for ($attempt=0; $attempt -lt 18; $attempt++) {
        try {
            $null = Invoke-PrivateRest -Uri "$($VaultUri.TrimEnd('/'))/secrets/$($Name)?api-version=7.4" -Token $token -Method PUT -Body @{ value=$Value }
            return
        } catch {
            if ($attempt -eq 17) { throw 'Could not store a secret in Key Vault. Check Secret Officer permissions and vault access. No secret was written to disk or printed.' }
            Start-Sleep -Seconds 5
        }
    }
}

function Test-VaultSecret {
    param([Parameter(Mandatory)][string]$VaultUri, [Parameter(Mandatory)][string]$Name)
    $token = Get-ServiceToken 'https://vault.azure.net'
    for ($attempt=0; $attempt -lt 18; $attempt++) {
        try {
            $secret = Invoke-PrivateRest -Uri "$($VaultUri.TrimEnd('/'))/secrets/$($Name)?api-version=7.4" -Token $token -AllowNotFound
            return ($null -ne $secret)
        } catch {
            if ($attempt -eq 17) { throw 'Cannot inspect Key Vault secrets. Verify data-plane role assignment and wait for propagation.' }
            Start-Sleep -Seconds 5
        }
    }
}

function Ensure-RoleAssignment {
    param([string]$PrincipalId, [string]$Role, [string]$Scope, [string]$PrincipalType='ServicePrincipal')
    $existing = Invoke-AzJson @('role','assignment','list','--scope',$Scope)
    if (-not @($existing | Where-Object { $_.principalId -eq $PrincipalId -and $_.roleDefinitionName -eq $Role }).Count) {
        $null = Invoke-AzJson @('role','assignment','create','--assignee-object-id',$PrincipalId,'--assignee-principal-type',$PrincipalType,'--role',$Role,'--scope',$Scope)
    }
}

function Invoke-NodeCommand {
    param([Parameter(Mandatory)][string[]]$Arguments)
    & node @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'The Node application command failed. Verify Fabric SQL configuration, migrations, item permissions, SQL grants, and Azure identity.' }
}
