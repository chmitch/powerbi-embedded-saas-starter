[CmdletBinding(SupportsShouldProcess)]
param([Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not [IO.Path]::IsPathFullyQualified($Destination)) { throw 'Use an absolute external sample directory.' }
$destinationPath = [IO.Path]::GetFullPath($Destination)
if ($destinationPath.TrimEnd('\') -eq $root -or $destinationPath.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Keep downloaded sample assets outside the checkout.'
}
if (-not $PSCmdlet.ShouldProcess($destinationPath, 'Download pinned Microsoft PBIX samples and their MIT license')) { return }
Push-Location $root
try {
    $catalogJson = node --input-type=module -e "import {demoSampleCatalog,demoSampleRevision} from './src/server/dist/demo-samples.js'; console.log(JSON.stringify({revision:demoSampleRevision,samples:demoSampleCatalog}));"
    if ($LASTEXITCODE -ne 0) { throw 'Build the server before downloading the sample catalog.' }
} finally { Pop-Location }
$catalog = $catalogJson | ConvertFrom-Json
New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
foreach ($sample in $catalog.samples) {
    $name = "$($sample.title).pbix"
    $file = Join-Path $destinationPath $name
    $url = "https://raw.githubusercontent.com/microsoft/powerbi-desktop-samples/$($catalog.revision)/new-power-bi-service-samples/$([Uri]::EscapeDataString($name))"
    Invoke-WebRequest -Uri $url -OutFile $file
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sample.sha256) {
        throw "Pinned sample hash mismatch: $name"
    }
}
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/microsoft/powerbi-desktop-samples/$($catalog.revision)/LICENSE" `
    -OutFile (Join-Path $destinationPath 'LICENSE')
Write-Host 'Pinned Microsoft samples and their license downloaded. No Fabric or SQL changes were made.'
