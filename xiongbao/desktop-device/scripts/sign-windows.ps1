#Requires -Version 7.0
# Authenticode-signs one file for the device app (F2 stage 3). Tauri calls this once per binary and
# once per installer through tauri.windows-signing.conf.json's signCommand; the release workflow also
# calls it for the runner sidecar before bundling.
#
#   pwsh -File sign-windows.ps1 <path>
#
# The mode comes from DEVICE_WINDOWS_SIGNING and must be one of:
#   azure-key-vault   AzureSignTool against a certificate in Azure Key Vault (OV/EV certificate the
#                     organisation bought). Needs DEVICE_AZURE_KEY_VAULT_URL and
#                     DEVICE_AZURE_KEY_VAULT_CERTIFICATE, and an `az login` session (OIDC).
#   trusted-signing   signtool with the Azure Artifact Signing (Trusted Signing) dlib. Needs
#                     DEVICE_TRUSTED_SIGNING_ENDPOINT, DEVICE_TRUSTED_SIGNING_ACCOUNT,
#                     DEVICE_TRUSTED_SIGNING_PROFILE, DEVICE_TRUSTED_SIGNING_DLIB (the dlib's path)
#                     and an `az login` session (OIDC).
#   test-certificate  signtool with a throwaway certificate from the current user's store, named by
#                     DEVICE_TEST_SIGNING_THUMBPRINT. CI's signing rehearsal only: device-release.yml
#                     refuses this mode, and its signatures are trusted on no machine but that runner.
# No mode, or any other value, is an error: an unsigned build simply does not call this script.
# This script never prints, stores or exports a credential.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Path)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Require-Configuration([string[]]$Names) {
    foreach ($name in $Names) {
        if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
            throw "Missing required signing configuration: $name"
        }
    }
}

function Find-SignTool {
    $command = Get-Command signtool.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { return $command[0].Source }
    $sdkTools = @(Get-ChildItem -Path "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/signtool.exe" -File -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending)
    if ($sdkTools.Count -eq 0) { throw 'Windows SDK signtool.exe was not found.' }
    return $sdkTools[0].FullName
}

$mode = $env:DEVICE_WINDOWS_SIGNING
if ($mode -notin @('azure-key-vault', 'trusted-signing', 'test-certificate')) {
    throw "DEVICE_WINDOWS_SIGNING must be azure-key-vault, trusted-signing or test-certificate (got '$mode')."
}
if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Signing input does not exist: $Path"
}
$file = (Resolve-Path -LiteralPath $Path).Path

# The description users see in the UAC prompt: the product name, read from the app's own config so
# it cannot drift from what the installer is called.
$config = Get-Content -LiteralPath "$PSScriptRoot/../src-tauri/tauri.conf.json" -Raw -Encoding utf8 | ConvertFrom-Json
$description = [string]$config.productName
if ([string]::IsNullOrWhiteSpace($description)) { throw 'tauri.conf.json has no productName.' }

switch ($mode) {
    'azure-key-vault' {
        Require-Configuration @('DEVICE_AZURE_KEY_VAULT_URL', 'DEVICE_AZURE_KEY_VAULT_CERTIFICATE')
        Get-Command az, AzureSignTool.exe -ErrorAction Stop | Out-Null
        # Requested per file: Tauri may spend a long time building before it signs. Never put this
        # token in GITHUB_ENV, outputs, a transcript, or a file; AzureSignTool takes it through -kva.
        try {
            $env:DEVICE_AZURE_ACCESS_TOKEN = az account get-access-token --resource https://vault.azure.net --query accessToken --output tsv --only-show-errors
            if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($env:DEVICE_AZURE_ACCESS_TOKEN)) {
                throw 'Could not obtain an Azure Key Vault access token.'
            }
            Write-Host "::add-mask::$env:DEVICE_AZURE_ACCESS_TOKEN"
            & AzureSignTool.exe sign -fd sha256 -tr http://timestamp.digicert.com -td sha256 `
                -kvu $env:DEVICE_AZURE_KEY_VAULT_URL -kvc $env:DEVICE_AZURE_KEY_VAULT_CERTIFICATE `
                -kva $env:DEVICE_AZURE_ACCESS_TOKEN -d $description $file
            if ($LASTEXITCODE -ne 0) { throw "AzureSignTool failed for $file (exit $LASTEXITCODE)." }
        } finally {
            Remove-Item Env:DEVICE_AZURE_ACCESS_TOKEN -ErrorAction SilentlyContinue
        }
    }
    'trusted-signing' {
        Require-Configuration @('DEVICE_TRUSTED_SIGNING_ENDPOINT', 'DEVICE_TRUSTED_SIGNING_ACCOUNT', 'DEVICE_TRUSTED_SIGNING_PROFILE', 'DEVICE_TRUSTED_SIGNING_DLIB')
        if (-not (Test-Path -LiteralPath $env:DEVICE_TRUSTED_SIGNING_DLIB -PathType Leaf)) {
            throw "Trusted Signing dlib is missing: $env:DEVICE_TRUSTED_SIGNING_DLIB"
        }
        # Identifiers only, no credential: the dlib authenticates through the `az login` session.
        $metadata = Join-Path ([System.IO.Path]::GetTempPath()) "device-trusted-signing-$([Guid]::NewGuid()).json"
        try {
            [ordered]@{
                Endpoint = $env:DEVICE_TRUSTED_SIGNING_ENDPOINT
                CodeSigningAccountName = $env:DEVICE_TRUSTED_SIGNING_ACCOUNT
                CertificateProfileName = $env:DEVICE_TRUSTED_SIGNING_PROFILE
                ExcludeCredentials = @(
                    'EnvironmentCredential', 'WorkloadIdentityCredential', 'ManagedIdentityCredential',
                    'SharedTokenCacheCredential', 'VisualStudioCredential', 'VisualStudioCodeCredential',
                    'AzurePowerShellCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential'
                )
            } | ConvertTo-Json | Set-Content -LiteralPath $metadata -Encoding utf8
            & (Find-SignTool) sign /v /fd sha256 /tr http://timestamp.acs.microsoft.com /td sha256 `
                /dlib $env:DEVICE_TRUSTED_SIGNING_DLIB /dmdf $metadata /d $description $file
            if ($LASTEXITCODE -ne 0) { throw "signtool (Trusted Signing) failed for $file (exit $LASTEXITCODE)." }
        } finally {
            Remove-Item -LiteralPath $metadata -ErrorAction SilentlyContinue
        }
    }
    'test-certificate' {
        Require-Configuration @('DEVICE_TEST_SIGNING_THUMBPRINT')
        & (Find-SignTool) sign /fd sha256 /sha1 $env:DEVICE_TEST_SIGNING_THUMBPRINT /s My `
            /tr http://timestamp.digicert.com /td sha256 /d $description $file
        if ($LASTEXITCODE -ne 0) { throw "signtool (test certificate) failed for $file (exit $LASTEXITCODE)." }
    }
}
Write-Host "Signed ($mode): $file"
