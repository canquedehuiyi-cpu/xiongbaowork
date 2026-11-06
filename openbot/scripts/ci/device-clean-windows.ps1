#Requires -Version 7.0
# The device app's NSIS installer on a fresh Windows machine, from checksum to uninstall (F2 stage 3,
# HUMAN-STEPS 12.6), as far as one can go without a server there (no pgvector PostgreSQL on
# windows-latest). The one Windows implementation: device-release.yml's clean-windows job runs it on
# the installer the release will publish, and ci.yml's device-clean-windows job on every pull
# request's unsigned installer. Each workflow step runs one -Phase, in this order:
#
#   sums        the installer is the one <Dist>/SHA256SUMS names (Get-FileHash); this also starts
#               the evidence file with the machine's details;
#   signature   Get-AuthenticodeSignature: Valid from exactly -ExpectedPublisher when -ExpectedSigned
#               is true, NotSigned when it is false;
#   install     silent install (NSIS /S), the uninstall entry, the installed files and their version;
#               the install directory goes to $env:GITHUB_ENV as INSTALL_DIR for the later phases;
#   selfcheck   the installed runner's own one-shot commands, with no network;
#   app         the installed app starts the installed runner, and no openbot-runner outlives it;
#   uninstall   silent uninstall (/S) removes the files, the uninstall entry and every process;
#   result      no FAIL line in the evidence, then `RESULT: PASS` as its last line.
#
#   device-clean-windows.ps1 -Phase sums [-Dist DIR] [-Version X.Y.Z] [-Evidence FILE] [-Tag T] [-Commit SHA]
#   device-clean-windows.ps1 -Phase signature -ExpectedSigned true|false [-ExpectedPublisher CN]
#
# -Dist, -Version, -Evidence, -Product and -InstallDir default to $env:DIST, $env:VERSION,
# $env:EVIDENCE, $env:PRODUCT (else 熊宝数字员工 设备端) and $env:INSTALL_DIR.
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('sums', 'signature', 'install', 'selfcheck', 'app', 'uninstall', 'result')]
    [string]$Phase,
    [string]$Dist = $env:DIST,
    [string]$Version = $env:VERSION,
    [string]$Evidence = $env:EVIDENCE,
    [string]$Product = $(if ($env:PRODUCT) { $env:PRODUCT } else { '熊宝数字员工 设备端' }),
    [string]$InstallDir = $env:INSTALL_DIR,
    [string]$ExpectedSigned,
    [string]$ExpectedPublisher,
    [string]$Tag,
    [string]$Commit
)

$ErrorActionPreference = 'Stop'

function Assert-Value([string]$Name, [string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw "-$Name is required for -Phase $Phase." }
}

function Add-Evidence([string[]]$Lines) {
    $Lines | Add-Content -LiteralPath $Evidence -Encoding utf8NoBOM
}

function Get-InstallerPath {
    Assert-Value 'Dist' $Dist
    Assert-Value 'Version' $Version
    Join-Path $Dist "xiongbao-device_$($Version)_x64-setup.exe"
}

# Tauri's NSIS installer registers itself under ...\Uninstall with DisplayName = productName;
# the default installMode is currentUser (HKCU, %LOCALAPPDATA%\<productName>).
$UninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)

function Invoke-Sums {
    $path = Get-InstallerPath
    $installer = Split-Path -Leaf $path
    New-Item -ItemType Directory -Path (Split-Path $Evidence) -Force | Out-Null
    $os = Get-CimInstance Win32_OperatingSystem
    $build = if ($Tag) { "标签 $Tag，提交 $Commit" } else { "CI 构建的未签名安装包（不发布），提交 $Commit" }
    @(
        "熊宝数字员工 设备端 $($Version)：全新 Windows 机器检查（HUMAN-STEPS 12.6）"
        $build
        "系统：$($os.Caption) $($os.Version)（build $($os.BuildNumber)），$($os.OSArchitecture)，托管镜像 $($env:ImageOS) $($env:ImageVersion)"
    ) | Set-Content -LiteralPath $Evidence -Encoding utf8NoBOM
    $listed = @(Get-Content -LiteralPath (Join-Path $Dist 'SHA256SUMS') | ForEach-Object {
            $hash, $name = $_ -split '  ', 2
            if ($name -ceq $installer) { $hash }
        })
    if ($listed.Count -ne 1 -or $listed[0] -notmatch '^[0-9a-f]{64}$') { throw "SHA256SUMS does not list $installer exactly once." }
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $listed[0]) { throw "SHA256 mismatch for ${installer}: $actual, SHA256SUMS says $($listed[0])." }
    Add-Evidence @(
        "安装包：$installer"
        "SHA256：$actual"
        "PASS Get-FileHash 与 SHA256SUMS 一致"
    )
}

function Invoke-Signature {
    $signature = Get-AuthenticodeSignature -LiteralPath (Get-InstallerPath)
    $status = [string]$signature.Status
    if ($ExpectedSigned -eq 'true') {
        if ($status -ne 'Valid') { throw "The release is signed, but the installer's Authenticode status is $status." }
        $publisher = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        if ($publisher -cne $ExpectedPublisher) { throw "Signed by '$publisher', expected '$ExpectedPublisher'." }
        $line = "签名：Valid，发布者 $publisher，证书指纹 $($signature.SignerCertificate.Thumbprint)"
    } elseif ($ExpectedSigned -eq 'false') {
        if ($status -ne 'NotSigned') { throw "The release is labelled unsigned, but the installer's Authenticode status is $status." }
        $line = '签名：NotSigned（未签名内测版，SmartScreen 会提示）'
    } else {
        throw "ExpectedSigned is '$ExpectedSigned', expected true or false."
    }
    Add-Evidence @($line, "PASS Get-AuthenticodeSignature：$status")
}

function Invoke-Install {
    $setup = Start-Process -FilePath (Get-InstallerPath) -ArgumentList '/S' -Wait -PassThru
    if ($setup.ExitCode -ne 0) { throw "The installer exited $($setup.ExitCode)." }
    $all = @(Get-ItemProperty -Path $UninstallRoots -ErrorAction SilentlyContinue)
    $entries = @($all | Where-Object { $_.DisplayName -ceq $Product })
    if ($entries.Count -eq 0) { $entries = @($all | Where-Object { [string]$_.DisplayIcon -like '*\xiongbao-device.exe*' }) }
    if ($entries.Count -ne 1) {
        $all | Where-Object { $_.DisplayName } | ForEach-Object { Write-Host "uninstall entry: $($_.PSChildName) = $($_.DisplayName)" }
        throw "Expected one uninstall entry for $Product, found $($entries.Count)."
    }
    $entry = $entries[0]
    if ($entry.DisplayVersion -cne $Version) { throw "Installed version $($entry.DisplayVersion), expected $Version." }
    $directory = ([string]$entry.InstallLocation).Trim().Trim('"').TrimEnd('\')
    if (-not $directory) { $directory = Split-Path -Parent ([string]$entry.UninstallString).Trim().Trim('"') }
    $uninstaller = Join-Path $directory 'uninstall.exe'
    $app = Join-Path $directory 'xiongbao-device.exe'
    $sidecar = Join-Path $directory 'openbot-runner.exe'
    foreach ($file in @($app, $sidecar, $uninstaller)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "$file is missing after the install." }
    }
    $info = (Get-Item -LiteralPath $app).VersionInfo
    if ($info.ProductName -cne $Product -or $info.ProductVersion -cne $Version) {
        throw "The installed app says $($info.ProductName) $($info.ProductVersion)."
    }
    $scope = if ($entry.PSPath -like '*HKEY_CURRENT_USER*') { '当前用户（HKCU）' } else { '本机所有用户（HKLM）' }
    $default = Join-Path $env:LOCALAPPDATA $Product
    if ($env:GITHUB_ENV) { "INSTALL_DIR=$directory" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8 }
    Add-Evidence @(
        "安装方式：$scope，安装目录 $directory$(if ($directory -eq $default) { '（Tauri 默认的 %LOCALAPPDATA%\<产品名>）' })"
        "已安装 xiongbao-device.exe，SHA256 $((Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash.ToLowerInvariant())，签名 $([string](Get-AuthenticodeSignature -LiteralPath $app).Status)"
        "已安装 openbot-runner.exe，SHA256 $((Get-FileHash -LiteralPath $sidecar -Algorithm SHA256).Hash.ToLowerInvariant())，签名 $([string](Get-AuthenticodeSignature -LiteralPath $sidecar).Status)"
        "PASS 静默安装（/S，退出码 0）：xiongbao-device.exe、openbot-runner.exe、uninstall.exe 都在安装目录，卸载项版本 $($entry.DisplayVersion)"
    )
}

function Invoke-Selfcheck {
    Assert-Value 'InstallDir' $InstallDir
    $sidecar = Join-Path $InstallDir 'openbot-runner.exe'
    $temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
    $scratch = Join-Path $temp 'runner-selfcheck'
    New-Item -ItemType Directory -Path (Join-Path $scratch 'folder') -Force | Out-Null
    $help = Start-Process -FilePath $sidecar -ArgumentList '--help' -Wait -PassThru -NoNewWindow `
        -RedirectStandardOutput (Join-Path $scratch 'help.out') -RedirectStandardError (Join-Path $scratch 'help.err')
    $usage = (Get-Content -Raw (Join-Path $scratch 'help.out')) + (Get-Content -Raw (Join-Path $scratch 'help.err'))
    if ($help.ExitCode -ne 2 -or $usage -notmatch '--pair CODE') { throw "--help exited $($help.ExitCode) without the usage." }
    $data = Join-Path $scratch 'data'
    $added = & $sidecar --data-dir $data --add-root "selfcheck=$(Join-Path $scratch 'folder')" | ConvertFrom-Json
    if (-not $added.ok -or @($added.roots).Count -ne 1) { throw "--add-root: $($added | ConvertTo-Json -Compress)" }
    $listed = & $sidecar --data-dir $data --list-roots | ConvertFrom-Json
    if (-not $listed.ok -or $listed.roots[0].name -cne 'selfcheck') { throw "--list-roots: $($listed | ConvertTo-Json -Compress)" }
    $removed = & $sidecar --data-dir $data --remove-root selfcheck | ConvertFrom-Json
    if (-not $removed.ok -or @($removed.roots).Count -ne 0) { throw "--remove-root: $($removed | ConvertTo-Json -Compress)" }
    if (Get-Process -Name openbot-runner -ErrorAction SilentlyContinue) { throw 'openbot-runner is still running after the one-shot commands.' }
    Remove-Item -LiteralPath $scratch -Recurse -Force
    Add-Evidence 'PASS 已安装的 openbot-runner.exe 自检：--help 退出码 2 并打印用法；--add-root / --list-roots / --remove-root 正常；之后没有残留进程'
}

# No server on this machine, so the app is given a pairing that cannot connect: the runner it
# starts keeps retrying, which is enough to see whose child it is and that it dies with the app.
function Invoke-App {
    Assert-Value 'InstallDir' $InstallDir
    $sidecar = Join-Path $InstallDir 'openbot-runner.exe'
    $data = Join-Path $env:APPDATA 'com.xiongbao.device'
    if (Test-Path -LiteralPath $data) { throw "$data already exists: this is not a clean machine." }
    New-Item -ItemType Directory -Path (Join-Path $data 'runner') -Force | Out-Null
    '{"server": "http://127.0.0.1:9", "name": "clean-windows"}' | Set-Content -LiteralPath (Join-Path $data 'device.json') -Encoding utf8NoBOM
    '{"deviceId": "clean-windows", "token": "not-a-device-token", "server": "http://127.0.0.1:9"}' |
        Set-Content -LiteralPath (Join-Path $data 'runner/runner-state.json') -Encoding utf8NoBOM
    if (Get-Process -Name openbot-runner -ErrorAction SilentlyContinue) { throw 'An openbot-runner is already running.' }
    $app = Start-Process -FilePath (Join-Path $InstallDir 'xiongbao-device.exe') -PassThru
    $child = $null
    foreach ($second in 1..60) {
        # The supervised runner, not a one-shot --list-roots the window may ask for (roots.rs).
        $child = Get-CimInstance Win32_Process -Filter "Name = 'openbot-runner.exe' AND ParentProcessId = $($app.Id)" |
            Where-Object { $_.CommandLine -notlike '*--list-roots*' } | Select-Object -First 1
        if ($child) { break }
        if ($app.HasExited) { throw "The app exited $($app.ExitCode) before starting the runner." }
        Start-Sleep -Seconds 1
    }
    if (-not $child) { throw 'The app did not start openbot-runner within 60s.' }
    if ($child.ExecutablePath -ne $sidecar) { throw "The app started $($child.ExecutablePath), not the installed $sidecar." }
    if ($child.CommandLine -match '--pair') { throw 'The app passed --pair without a pairing code.' }
    Start-Sleep -Seconds 5
    if (-not (Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue)) { throw 'The runner did not keep running.' }
    # The hardest way out: the app is killed outright, and the job object it holds
    # (process_tree.rs, KILL_ON_JOB_CLOSE) has to take the runner with it.
    Stop-Process -Id $app.Id -Force
    $app.WaitForExit(30000) | Out-Null
    $left = $null
    foreach ($second in 1..15) {
        $left = Get-Process -Name openbot-runner -ErrorAction SilentlyContinue
        if (-not $left) { break }
        Start-Sleep -Seconds 1
    }
    if ($left) { throw "openbot-runner is still running after the app ended: $($left.Id -join ', ')" }
    Remove-Item -LiteralPath $data -Recurse -Force
    Add-Evidence @(
        "PASS 启动已安装的 xiongbao-device.exe：它拉起安装目录里的 openbot-runner.exe（PID $($child.ProcessId)，命令行不带 --pair）"
        'PASS 结束应用进程（Stop-Process -Force，比托盘「退出」更粗暴）后 15 秒内没有任何 openbot-runner 进程（Get-Process）'
    )
}

function Invoke-Uninstall {
    Assert-Value 'InstallDir' $InstallDir
    $uninstaller = Join-Path $InstallDir 'uninstall.exe'
    $run = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
    if ($run.ExitCode -ne 0) { throw "The uninstaller exited $($run.ExitCode)." }
    # An NSIS uninstaller copies itself to %TEMP% and finishes from there.
    $files = @('xiongbao-device.exe', 'openbot-runner.exe', 'uninstall.exe') | ForEach-Object { Join-Path $InstallDir $_ }
    $remaining = @()
    foreach ($second in 1..60) {
        $remaining = @($files | Where-Object { Test-Path -LiteralPath $_ })
        if ($remaining.Count -eq 0) { break }
        Start-Sleep -Seconds 1
    }
    if ($remaining.Count -ne 0) { throw "Still there after uninstall: $($remaining -join ', ')" }
    if (@(Get-ItemProperty -Path $UninstallRoots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -ceq $Product }).Count -ne 0) {
        throw 'The uninstall entry is still registered.'
    }
    if (Get-Process -Name openbot-runner, xiongbao-device -ErrorAction SilentlyContinue) { throw 'A device process is still running after uninstall.' }
    $folder = if (Test-Path -LiteralPath $InstallDir) { '安装目录仍在（只剩空目录或非安装文件）' } else { '安装目录已删除' }
    Add-Evidence "PASS 静默卸载（uninstall.exe /S）：xiongbao-device.exe、openbot-runner.exe、uninstall.exe 与卸载项都已删除，$folder，没有残留进程"
}

# RESULT: PASS only when every check before it wrote its PASS and none wrote FAIL.
function Invoke-Result {
    if (-not (Test-Path -LiteralPath $Evidence -PathType Leaf)) { throw "There is no evidence file at $Evidence." }
    if (Select-String -LiteralPath $Evidence -Pattern '^FAIL ' -Quiet) { throw 'A check failed.' }
    'RESULT: PASS' | Add-Content -LiteralPath $Evidence -Encoding utf8NoBOM
    Get-Content -LiteralPath $Evidence -Encoding utf8
}

Assert-Value 'Evidence' $Evidence
switch ($Phase) {
    'sums' { Invoke-Sums }
    'signature' { Invoke-Signature }
    'install' { Invoke-Install }
    'selfcheck' { Invoke-Selfcheck }
    'app' { Invoke-App }
    'uninstall' { Invoke-Uninstall }
    'result' { Invoke-Result }
}
