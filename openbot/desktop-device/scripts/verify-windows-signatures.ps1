#Requires -Version 7.0
# Checks the device app's NSIS installer (F2 stage 3, acceptance 1) and what it installs.
#
#   verify-windows-signatures.ps1 -ExpectedPublisher '<certificate subject CN>' [-ExpectedVersion X.Y.Z]
#   verify-windows-signatures.ps1 -Unsigned [-ExpectedVersion X.Y.Z]
#
# Always: exactly one *-setup.exe; its payload carries the app (mainBinaryName.exe) and the runner
# sidecar (openbot-runner.exe); the installer and the app carry tauri.conf.json's productName and the
# version tauri.conf.json resolves (and -ExpectedVersion, when given).
# Signed: the installer, the app and the sidecar each have a Valid Authenticode signature from
# exactly -ExpectedPublisher, with a timestamp, and pass `signtool verify /pa /all /v /tw`.
# -Unsigned: each of the three is NotSigned, so a build labelled unsigned is never secretly signed by
# someone else and a signed release can never fall back to this mode without saying so.
# Evidence (signatures.json, signtool output) goes to -EvidenceDirectory.
[CmdletBinding(DefaultParameterSetName = 'Signed')]
param(
    [Parameter(ParameterSetName = 'Signed', Mandatory)][string]$ExpectedPublisher,
    [Parameter(ParameterSetName = 'Unsigned', Mandatory)][switch]$Unsigned,
    [string]$InstallerDirectory = "$PSScriptRoot/../src-tauri/target/release/bundle/nsis",
    [string]$EvidenceDirectory = (Join-Path ([System.IO.Path]::GetTempPath()) 'device-signing-evidence'),
    [string]$ExpectedVersion,
    [string]$SignToolPath,
    [string]$SourceSha = $env:SIGNING_SOURCE_SHA
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$tauri = "$PSScriptRoot/../src-tauri"
$config = Get-Content -LiteralPath "$tauri/tauri.conf.json" -Raw -Encoding utf8 | ConvertFrom-Json
$productName = [string]$config.productName
$mainBinary = "$([string]$config.mainBinaryName).exe"
# tauri.conf.json's version is a path to the package.json Tauri reads it from.
$configVersion = [string]$config.version
if ($configVersion -like '*.json') {
    $configVersion = [string](Get-Content -LiteralPath (Join-Path $tauri $configVersion) -Raw -Encoding utf8 | ConvertFrom-Json).version
}
if ([string]::IsNullOrWhiteSpace($productName) -or [string]::IsNullOrWhiteSpace($configVersion) -or $mainBinary -eq '.exe') {
    throw 'tauri.conf.json must name productName, mainBinaryName and version.'
}
if ($ExpectedVersion -and $ExpectedVersion -cne $configVersion) {
    throw "Expected version $ExpectedVersion, but tauri.conf.json builds $configVersion."
}

$installers = @(Get-ChildItem -LiteralPath $InstallerDirectory -Filter '*-setup.exe' -File)
if ($installers.Count -ne 1) {
    throw "Expected exactly one NSIS installer in $InstallerDirectory, found $($installers.Count)."
}
$installer = $installers[0]

# The files the installer will put on the machine, taken out of the installer itself: Tauri restores
# the unsigned build output after bundling, so target/release is not what users receive.
$payload = Join-Path ([System.IO.Path]::GetTempPath()) "device-payload-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Path $payload -Force | Out-Null
& 7z e $installer.FullName "-o$payload" -r -y $mainBinary 'openbot-runner.exe' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not extract $mainBinary and openbot-runner.exe from $($installer.Name)." }
$app = Join-Path $payload $mainBinary
$sidecar = Join-Path $payload 'openbot-runner.exe'
foreach ($required in @($app, $sidecar)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "The installer does not carry $([System.IO.Path]::GetFileName($required))."
    }
}

# Product name and version: both the installer and the app say what they are.
foreach ($file in @($installer.FullName, $app)) {
    $info = (Get-Item -LiteralPath $file).VersionInfo
    $name = [System.IO.Path]::GetFileName($file)
    if ($info.ProductName -cne $productName) {
        throw "Unexpected product name on ${name}: '$($info.ProductName)', expected '$productName'."
    }
    if ($info.ProductVersion -cne $configVersion -or $info.FileVersion -cne $configVersion) {
        throw "Unexpected embedded version on ${name}: product=$($info.ProductVersion), file=$($info.FileVersion), expected=$configVersion"
    }
}

if (-not $Unsigned) {
    if (-not $SignToolPath) {
        $command = Get-Command signtool.exe -CommandType Application -ErrorAction SilentlyContinue
        if ($command) {
            $SignToolPath = $command[0].Source
        } else {
            $sdkTools = @(Get-ChildItem -Path "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/signtool.exe" -File |
                Sort-Object FullName -Descending)
            if ($sdkTools.Count -eq 0) { throw 'Windows SDK signtool.exe was not found.' }
            $SignToolPath = $sdkTools[0].FullName
        }
    }
}

New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$records = @()
try {
    foreach ($file in @($installer.FullName, $app, $sidecar)) {
        $name = [System.IO.Path]::GetFileName($file)
        $info = (Get-Item -LiteralPath $file).VersionInfo
        $signature = Get-AuthenticodeSignature -LiteralPath $file
        $record = [ordered]@{
            file = $name
            productName = $info.ProductName
            productVersion = $info.ProductVersion
            fileVersion = $info.FileVersion
            sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
            status = [string]$signature.Status
        }
        if ($Unsigned) {
            if ($signature.Status -ne 'NotSigned') {
                throw "$name is labelled unsigned but its Authenticode status is $($signature.Status)."
            }
        } else {
            if ($signature.Status -ne 'Valid') {
                throw "Invalid Authenticode signature on ${name}: $($signature.Status)"
            }
            $publisher = $signature.SignerCertificate.GetNameInfo(
                [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
            if ($publisher -cne $ExpectedPublisher) {
                throw "Unexpected publisher on ${name}: '$publisher', expected '$ExpectedPublisher'."
            }
            if ($null -eq $signature.TimeStamperCertificate) {
                throw "Missing timestamp on $name."
            }
            # /pa applies Authenticode policy; /all checks every signature. /tw produces exit 2 when a
            # timestamp is absent, and warnings fail this gate too.
            $verification = & $SignToolPath verify /pa /all /v /tw $file 2>&1
            $verificationExit = $LASTEXITCODE
            $verification | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "$name.signtool.txt")
            $verification | Write-Output
            if ($verificationExit -ne 0) {
                throw "SignTool verification failed for $name (exit $verificationExit)."
            }
            $record.publisher = $publisher
            $record.signerSubject = $signature.SignerCertificate.Subject
            $record.signerThumbprint = $signature.SignerCertificate.Thumbprint
            $record.timestampSubject = $signature.TimeStamperCertificate.Subject
            $record.signtoolExitCode = $verificationExit
        }
        $records += $record
    }
} finally {
    Remove-Item -LiteralPath $payload -Recurse -Force -ErrorAction SilentlyContinue
}

[ordered]@{
    sourceSha = $SourceSha
    installer = $installer.Name
    productName = $productName
    version = $configVersion
    signed = -not $Unsigned
    expectedPublisher = if ($Unsigned) { $null } else { $ExpectedPublisher }
    verifiedAtUtc = [DateTime]::UtcNow.ToString('o')
    files = $records
} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'signatures.json') -Encoding utf8
$state = if ($Unsigned) { 'unsigned (NotSigned on all three)' } else { "signed by $ExpectedPublisher" }
Write-Host "Verified $($installer.Name), $mainBinary and openbot-runner.exe: $productName $configVersion, $state. Evidence: $EvidenceDirectory"
