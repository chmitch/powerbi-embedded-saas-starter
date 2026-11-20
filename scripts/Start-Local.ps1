#requires -Version 7.0
[CmdletBinding()]
param([string]$ConfigurationPath, [switch]$SkipBuild)
. "$PSScriptRoot\Common.ps1"
if ($ConfigurationPath) { $env:PBIEMBEDDED_CONFIG=Assert-ExternalConfigurationPath $ConfigurationPath }
$env:NODE_ENV='development'
Push-Location $script:RepositoryRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $script:RepositoryRoot 'node_modules'))) {
        & npm ci --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    }
    if (-not $SkipBuild) {
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    }
    $configuration = if ($env:PBIEMBEDDED_CONFIG) { $env:PBIEMBEDDED_CONFIG } else { Get-DefaultConfigurationPath }
    if (Test-Path -LiteralPath $configuration) { Invoke-NodeCommand @('src/server/dist/index.js','--migrate') }
    & node 'src/server/dist/index.js'
    if ($LASTEXITCODE -ne 0) { throw 'Local server stopped with an error.' }
} finally { Pop-Location }
