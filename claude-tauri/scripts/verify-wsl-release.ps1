[CmdletBinding()]
param(
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$manifestPath = Join-Path $PSScriptRoot '../src-tauri/src/bootstrap/wsl-release.json'
$asset = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (-not $OutputPath) { $OutputPath = Join-Path $env:TEMP $asset.asset_name }
$expectedSize = [int64]$asset.size_bytes
$expectedSha256 = $asset.sha256
$assetUrl = $asset.url
$partialPath = "$OutputPath.$([Guid]::NewGuid()).part.msi"

try {
    Invoke-WebRequest -Uri $assetUrl -OutFile $partialPath -TimeoutSec 1800
    $file = Get-Item -LiteralPath $partialPath
    if ($file.Length -ne $expectedSize) {
        throw "Size mismatch: expected $expectedSize bytes; got $($file.Length)."
    }
    $hash = (Get-FileHash -LiteralPath $partialPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $expectedSha256) {
        throw "SHA-256 mismatch: $hash"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $partialPath
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw "Authenticode verification failed: $($signature.Status); $($signature.SignerCertificate.Subject)"
    }
    Move-Item -LiteralPath $partialPath -Destination $OutputPath -Force
    [pscustomobject]@{
        Asset = $asset.asset_name
        SizeBytes = $file.Length
        SHA256 = $hash
        SignatureStatus = $signature.Status.ToString()
        Signer = $signature.SignerCertificate.Subject
        OutputPath = $OutputPath
        Installed = $false
    } | ConvertTo-Json -Compress
}
catch {
    Remove-Item -LiteralPath $partialPath -Force -ErrorAction SilentlyContinue
    throw
}
