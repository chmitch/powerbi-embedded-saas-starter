function Invoke-PerimeterArm {
    param([Parameter(Mandatory)][string]$ResourceId, [string]$Method='GET', [object]$Body, [switch]$AllowNotFound)
    if ($ResourceId -notmatch '^/subscriptions/[a-fA-F0-9-]+/resourceGroups/[^/]+/providers/Microsoft\.(Network|KeyVault)/') {
        throw 'Unexpected network resource ID.'
    }
    $version=if ($ResourceId -match '/providers/Microsoft.KeyVault/') { '2024-11-01' } else { '2024-07-01' }
    Invoke-PrivateRest -Uri "https://management.azure.com${ResourceId}?api-version=$version" `
        -Token (Get-ServiceToken 'https://management.azure.com/') -Method $Method -Body $Body -AllowNotFound:$AllowNotFound
}

function Assert-PerimeterAddressPrefixes {
    param([string[]]$AddressPrefixes)
    if (-not $AddressPrefixes -or $AddressPrefixes.Count -gt 200) { throw 'Supply 1-200 explicit public IPv4 prefixes for perimeter access.' }
    foreach ($prefix in $AddressPrefixes) {
        $parts=$prefix.Split('/')
        $ip=$null
        if ($parts.Count -ne 2 -or $parts[1] -notmatch '^(2[4-9]|3[0-2])$' -or
            -not [Net.IPAddress]::TryParse($parts[0],[ref]$ip) -or
            $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
            throw 'Perimeter rules require explicit IPv4 /24 through /32 prefixes; unrestricted ranges are not accepted.'
        }
        $bytes=$ip.GetAddressBytes()
        if ($bytes[0] -in @(0,10,127) -or $bytes[0] -ge 224 -or
            ($bytes[0] -eq 169 -and $bytes[1] -eq 254) -or
            ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
            ($bytes[0] -eq 192 -and $bytes[1] -eq 168)) {
            throw 'Perimeter rules require public IPv4 addresses, not private or local addresses.'
        }
    }
}

function Wait-PerimeterResource {
    param([Parameter(Mandatory)][string]$ResourceId)
    for ($attempt=0; $attempt -lt 60; $attempt++) {
        $resource=Invoke-PerimeterArm $ResourceId -AllowNotFound
        if (-not $resource) { Start-Sleep -Seconds 5; continue }
        $state=if ($resource.properties -is [System.Collections.IDictionary]) { $resource.properties['provisioningState'] } else {
            $property=$resource.properties.PSObject.Properties['provisioningState']
            if ($property) { $property.Value }
        }
        if (-not $state -and $ResourceId -match '/profiles/[^/]+(?:/accessRules/[^/]+)?$') { return $resource }
        if ($state -eq 'Succeeded') { return $resource }
        if ($state -in @('Failed','Canceled')) { throw 'Network security perimeter provisioning failed. Deployment is not complete.' }
        Start-Sleep -Seconds 5
    }
    throw 'Timed out waiting for network security perimeter enforcement. Deployment is not complete.'
}

function Set-PerimeterAccessRule {
    param([Parameter(Mandatory)][string]$PerimeterId, [ValidateSet('deployment','application')][string]$RuleName, [string[]]$AddressPrefixes)
    Assert-PerimeterAddressPrefixes $AddressPrefixes
    $id="$PerimeterId/profiles/application/accessRules/$RuleName"
    $null=Invoke-PerimeterArm $id PUT @{ properties=@{ direction='Inbound'; addressPrefixes=@($AddressPrefixes | Sort-Object -Unique) } }
    $rule=Wait-PerimeterResource $id
    if ($rule.properties.direction -ne 'Inbound' -or
        (Compare-Object @($AddressPrefixes | Sort-Object -Unique) @($rule.properties.addressPrefixes | Sort-Object -Unique))) {
        throw 'Perimeter access-rule verification failed.'
    }
}

function Initialize-KeyVaultPerimeter {
    param([Parameter(Mandatory)][string]$VaultId, [Parameter(Mandatory)][string]$PerimeterId,
        [Parameter(Mandatory)][string]$Location, [string[]]$DeploymentAddressPrefixes, [switch]$ApplicationOnly)
    if ($ApplicationOnly -and $DeploymentAddressPrefixes) { throw 'Application-only perimeter setup does not allow deployment-source addresses.' }
    if (-not $ApplicationOnly) { Assert-PerimeterAddressPrefixes $DeploymentAddressPrefixes }
    $null=Invoke-AzJson @('provider','register','--namespace','Microsoft.Network','--wait')
    $existing=Invoke-PerimeterArm $PerimeterId -AllowNotFound
    if ($existing -and $existing.location.Replace(' ','') -ine $Location.Replace(' ','')) {
        throw 'The existing network security perimeter is in another region. Review the namespace before deployment.'
    }
    if (-not $existing) { $null=Invoke-PerimeterArm $PerimeterId PUT @{ location=$Location; properties=@{} } }
    $null=Wait-PerimeterResource $PerimeterId
    $profileId="$PerimeterId/profiles/application"
    $null=Invoke-PerimeterArm $profileId PUT @{ properties=@{} }
    $null=Wait-PerimeterResource $profileId
    if ($ApplicationOnly) {
        $deploymentRuleId="$profileId/accessRules/deployment"
        if (Invoke-PerimeterArm $deploymentRuleId -AllowNotFound) {
            $null=Invoke-PerimeterArm $deploymentRuleId DELETE
            for ($attempt=0; $attempt -lt 60; $attempt++) {
                if (-not (Invoke-PerimeterArm $deploymentRuleId -AllowNotFound)) { break }
                if ($attempt -eq 59) { throw 'The obsolete deployment-source perimeter rule was not removed. Deployment is not complete.' }
                Start-Sleep -Seconds 5
            }
        }
    } else { Set-PerimeterAccessRule $PerimeterId deployment $DeploymentAddressPrefixes }
    $associationId="$PerimeterId/resourceAssociations/keyvault"
    $existing=Invoke-PerimeterArm $associationId -AllowNotFound
    if ($existing -and ($existing.properties.privateLinkResource.id -ne $VaultId -or $existing.properties.profile.id -ne $profileId)) {
        throw 'The existing perimeter association targets another resource. Review it explicitly before deployment.'
    }
    $null=Invoke-PerimeterArm $associationId PUT @{
        properties=@{ privateLinkResource=@{ id=$VaultId }; profile=@{ id=$profileId }; accessMode='Enforced' }
    }
    $association=Wait-PerimeterResource $associationId
    if ($association.properties.accessMode -ne 'Enforced') { throw 'The Key Vault perimeter is not enforced.' }
    $null=Invoke-PerimeterArm $VaultId PATCH @{ properties=@{ publicNetworkAccess='SecuredByPerimeter' } }
    $vault=Invoke-PerimeterArm $VaultId
    if ($vault.properties.publicNetworkAccess -ne 'SecuredByPerimeter') {
        throw 'Key Vault did not retain SecuredByPerimeter. Check organizational policy; no exclusion or public-access fallback was applied.'
    }
}
