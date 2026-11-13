# 电脑体检与优化 · 详细核验清单

> **开工前必读**：SKILL.md 正文的「§0.0 安全红线速览」凌驾于本清单一切内容之上，违反任何一条即任务失败。本文件是 SKILL.md 执行流程中第 1 步要求必读的详细展开。

## 0. 执行环境约束（先读，避免白耗步骤）

**PowerShell 工具（沙箱内）：**
- stdout 可能不回传：结论性输出用 `[IO.File]::WriteAllText()` 落盘后用 Read 读取。
- 不能直接执行 `.ps1` 文件（会被拦截），只以内联命令方式运行。
- 禁止全盘 `Get-ChildItem -Recurse`（大磁盘必超时），只扫目标目录；大目录体积可用分组、限量、分段采集。
- **禁止出现 `%VAR%` 写法**：安全策略会判定为 cmd 语法并直接拦截整条命令。一律用 `$env:VAR`（`$env:TEMP`、`$env:LOCALAPPDATA`、`$env:APPDATA`、`$env:USERPROFILE`）。
- **递归扫描会撞到沙箱保护目录**：扫到 `C:\Users\<用户>\AppData\Local\CodeBuddyExtension\Data\Public\auth` 会触发拒绝，导致**整条命令 failed、结果文件根本不落盘**，前面几分钟白跑。扫 AppData 时必须显式跳过保护目录：`CodeBuddyExtension`、`WorkBuddy`、`@genieworkbuddy-desktop-updater`（用 `if($skip -contains $d.Name){continue}`）。
- **别用 robocopy 统计目录体积**：非管理员权限下对受保护目录返回错误 5（拒绝访问），且拿不到 `Bytes :` 汇总行，解析出来全是 0。老实用 PowerShell 递归 + `Measure-Object -Property Length -Sum`。
- **沙箱内禁止用 .NET 直接读文件大小**：`[System.IO.Directory]::GetFileSystemEntries` / `[System.IO.File]::GetLength` 会被沙箱静默拦截（异常被 catch 吞掉），递归算出来的体积**全是 0**，且不会报错极易误判。必须用 `Get-ChildItem -LiteralPath <dir> -ErrorAction Stop` cmdlet 逐目录取 `$it.Length` 来累加。配合跳过保护目录（`CodeBuddyExtension`/`WorkBuddy`/`@genieworkbuddy-desktop-updater`）做 BFS 队列即可，既准又快。
- **大目录很慢，要分批 + 后台**：`C:\Windows` 全量递归约 6-10 分钟。按「用户个人文件夹 → AppData → Program Files/ProgramData → Windows」分批跑，每批单独落盘；用 `run_in_background` 并给足 timeout（420000-600000），不要在前台硬等。
- **PowerShell 5.1 不支持 `? :` 三元运算符**，写了整条命令直接失败（exit code 1）。条件判断一律用 `if/else`。

**Bash / 命令行：**
- `wmic.exe`、`reg.exe`、`cmd` 可能被安全策略拦截，不要反复重试。
- 可靠可用的原生命令：`systeminfo`、`netsh advfirewall`、`ipconfig`、`ping`、`tasklist`。
- 注册表读取改用 PowerShell 的 `Get-ItemProperty` + PSDrive（`HKCU:\`、`HKLM:\`）。

## 0.5 环境探针与命令降级（先探测，再采集）

采集前先跑探针确定环境代数，再选命令集——不要假设目标机器是最新系统：

```powershell
$psv = $PSVersionTable.PSVersion.Major          # PowerShell 主版本
$osv = [Environment]::OSVersion.Version         # 6.1=Win7 6.3=Win8.1 10.0=Win10/11/Server2016+
$arch = $env:PROCESSOR_ARCHITECTURE             # AMD64 / x86 / ARM64
$hasCim = [bool](Get-Command Get-CimInstance -ErrorAction SilentlyContinue)
```
（`[Environment]::OSVersion` 与 `$PSVersionTable` 从 PS2 起就有，探针本身不会失败。）

**降级对照表**（首选失败/不存在时用降级命令，并在报告中注明已降级）：

| 采集项 | 首选（Win8+/PS3+） | 降级（Win7/PS2） |
|---|---|---|
| 系统/CPU/内存/服务 | `Get-CimInstance Win32_*` | `Get-WmiObject Win32_*`（参数名相同） |
| 磁盘健康 | `Get-PhysicalDisk` | `Get-WmiObject Win32_DiskDrive` 的 Status 字段 |
| 卷容量 | `Get-Volume` | `Get-WmiObject Win32_LogicalDisk` |
| 计划任务 | `Get-ScheduledTask` | `schtasks /query /v /fo csv` 解析 |
| 性能计数器 | `Get-CimInstance Win32_PerfFormattedData_PerfOS_*`（语言无关） | `Get-WmiObject` 同名类（Win7） |
| 防火墙 | `netsh advfirewall show allprofiles`（Vista 起） | 同左，无需降级 |

**计数器红线**：`Get-Counter '\Memory\Committed Bytes'` 这类**英文计数器路径只在英文系统有效，中文/日文/德文等本地化 Windows 会直接报"找不到路径"**——而中文用户占多数。一律用 CIM 计数器类代替（语言无关、Win7 也支持）：内存提交量用 `Win32_PerfFormattedData_PerfOS_Memory`（`CommittedBytes` / `CommitLimit`），CPU 负载用 `Win32_PerfFormattedData_PerfOS_Processor`（`PercentProcessorTime`）。Get-Counter 英文路径仅可作英文系统的备选。

**架构注意事项：**
- 32 位系统没有 `HKLM:\SOFTWARE\WOW6432Node` 分支——所有路径先 `Test-Path` 再读，不存在就跳过而不是报错。
- ARM64 Windows 上 CIM/计数器/bat 命令集与 x64 完全一致，无需特殊处理；仅硬件升级建议需注意 ARM 笔记本内存全部板载。
- Server Core 无桌面体验：跳过"双击运行 bat"类指引，改为命令行直接执行。
- XP/2003 及更早：无 PowerShell、`netsh advfirewall` 不存在，直接告知用户不支持，不要硬做。

## 1. 数据采集清单（八项，全部实测）

1. **系统概览**：品牌型号、系统版本、开机运行时长（`Win32_OperatingSystem.LastBootUpTime`）
2. **CPU**：型号、核心/线程（`Win32_Processor`）、实时采样负载（`Win32_PerfFormattedData_PerfOS_Processor` 的 `PercentProcessorTime`；勿用 Get-Counter 英文路径，本地化系统会报错）
3. **内存**：总量/可用/占用率；逐条列出内存条（`Win32_PhysicalMemory`），并区分**板载焊接与插槽可拆**（板载常以 ChannelA-DIMM0 形式上报，需结合厂商规格确认）；查询空槽数（`Win32_PhysicalMemoryArray.MemoryDevices`）
4. **磁盘**：各分区总量/剩余/使用率；SSD SMART 健康（`Get-PhysicalDisk`）；C 盘一级大目录与常见缓存目录逐项体积
5. **网络**：网卡型号、IP/网关/DNS；分别测网关、公共 DNS、外网延迟（`Test-Connection` 或 `ping`）；公网出口
6. **启动项**（四处都要查）：注册表 Run（HKCU / HKLM 64 位 / WOW6432Node / RunOnce）、用户与公共启动文件夹、计划任务中"登录/开机"触发项（`Get-ScheduledTask` 过滤 Logon/Boot 触发器）、非微软自启服务
7. **安全**：防火墙三个配置文件状态（`netsh advfirewall show allprofiles`）；是否多套杀软并存、有无厂商残留服务
8. **可清理项**：用户/系统临时文件、浏览器缓存、缩略图缓存、回收站，逐项实测体积。**注意：页面文件（pagefile.sys）与休眠文件（hiberfil.sys）不是可清理项**，只是体积观测项——实测体积写入报告供用户知情即可，处理建议一律走 SKILL.md §0.0 红线与本清单 §2 前置条件，不满足时报告里只写「保持现状，不动」。**Windows 更新缓存（SoftwareDistribution\Download）只观测不自动清**：删除前需先停 wuauserv 服务，与 bat 红线「不停用服务」冲突——只实测报告体积，提示用户用系统自带「磁盘清理 / 存储感知」处理，不纳入 bat 自动清理清单。
   - **`pagefile.sys` 用 `Get-Item` 扫不到**（系统保护文件，权限拒绝），必须用 `Get-CimInstance Win32_PageFileUsage` 读 `AllocatedBaseSize`（实际分配 MB）与 `PeakUsage`；注册表 `HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management` 的 `PagingFiles` 是设定值，可能与实测分配值不一致，**以 WMI 实测为准**。
   - **`hiberfil.sys` 同理**：先用 `Test-Path -LiteralPath 'C:\hiberfil.sys'`，再查 `HKLM:\SYSTEM\CurrentControlSet\Control\Power` 的 `HibernateEnabled`。注册表为 1 但文件不存在是常见状态（已关休眠），此时**不要**按"休眠文件占 X GB"给建议。
   - **AppX/UWP 应用缓存**在 `%LOCALAPPDATA%\Packages\<包名>\LocalCache`，常以 GB 计（如音乐/视频类应用）。包名是一串哈希，用 `Get-StartApps | Where-Object {$_.AppID -like '*<包名特征>*'}` 反查应用真实名称再写进建议，别让用户猜。
   - **厂商预装备份与更新器残留**：品牌机常有 `C:\eSupport`（华硕出厂驱动备份，1GB+ 级；驱动已装好即可删，官网可重下，求稳先剪切到 D 盘）；桌面应用更新器目录（如 `%LOCALAPPDATA%\*@*updater*`）常残留**已应用完毕的完整安装包 installer.exe**（几百 MB，纯缓存）。这两类可清，但不算严格意义的"缓存"，应让用户单独确认后删，不要混进自动清理项。
9. **开发工具缓存**（仅当检测到机器装有开发环境时采集，否则跳过）：逐项实测体积后列入报告
   - 包管理器缓存：`%LocalAppData%\npm-cache`、`%LocalAppData%\pip\Cache`、`%LocalAppData%\Yarn\Cache`、`%LocalAppData%\pnpm-cache`、`%USERPROFILE%\.nuget\packages`、`%USERPROFILE%\.cargo\registry`、`%USERPROFILE%\go\pkg\mod`
   - 构建工具缓存：`%USERPROFILE%\.m2\repository`（Maven）、`%USERPROFILE%\.gradle\caches`（Gradle）
   - IDE 缓存：`%LocalAppData%\JetBrains\*`（caches/index 目录）、VS Code 的 `%APPDATA%\Code\CachedData` 与 `Cache`
   - 容器/虚拟机：Docker Desktop 的 WSL2 虚拟磁盘（`%LocalAppData%\Docker\wsl`，常以数 GB 计，体积用文件大小报告；收缩须走 `wsl --shutdown` + 磁盘压缩，不直接删文件）
   - **红线**：上述缓存删除是安全的（会按需重新下载/重建），但一律"先测体积、列清单、用户确认后再删"；**项目目录内的 `node_modules`、`.venv` 等属于个人工作区，严禁纳入清理清单**，只可在报告中提示用户自行用 `npm clean-install` 等标准流程处理。

## 2. 出建议前的实测义务（防想当然）

- **虚拟内存**：先记住默认答案——**「保持系统管理的大小，不动」**。只有翻过 SKILL.md §0.0 第 1 条的三道门槛（实测提交量 / 新上限 > 提交量 + 2GB / 三段式），才允许给自定义数值；翻不过就写默认答案，这不是敷衍，是正确结论。小内存机器（≤4GB）几乎必然翻不过门槛：先降内存压力（卸载冗余杀软、禁用启动项、加装内存），等提交峰值下降后再评估。**再次点名：「初始 2048 / 最大 4096」是已被禁止的真实事故答案，任何机器都不得作为通用建议输出。**
  - **"页面文件搬家到其他分区"同样受此硬规则约束**，且多一个隐蔽陷阱：把源盘设小 + 目标盘设"系统管理的大小"时，目标盘分到多少**不可控**（Windows 可能只按内存大小给 4-5GB），总提交上限可能不升反降 → 蓝屏。目标盘必须给**明确数字**（如初始 8192 / 最大 16384），并在建议中写死。
  - 此类建议**必须包含三段**：① 动手前的前提条件（逐条可核验）；② 改完后的验证步骤（重启后看任务管理器"已提交"分母 ≥ 原值）；③ 回滚方法（勾回"自动管理"）。缺任何一段就不要把该操作写进报告——宁可不建议，不给无前提的危险操作。
- **内存/硬盘升级**：以厂商官方规格或内存厂商适配库（如金士顿 configurator）为准，查完注明来源；明确"能否加、上限多少、买什么规格、别买错什么"（如笔记本 SO-DIMM 260 针 vs 台式机 288 针）。禁止"同规格加装"这类含糊表述。
- **清理建议**：每个目录先实测体积再列清单；只建议清理可再生缓存；回收站清理前必须提示用户确认。
- **数值类建议**（启动项、服务、电源计划等）一律附三要素：不处理会怎样 / 处理后收益 / 风险与前提条件。

## 2.1 把游戏栏录屏路径改到 D 盘（省 C 空间，非清理项）

游戏栏（Xbox Game Bar）录屏默认落在 `C:\Users\<用户>\Videos\Captures`，长时间录制会涨 C 盘。最稳的改法是把该 `Captures` 子目录做成指向 D 盘的 **junction**（只重定向录屏目录，不搬整个 Videos 库，不动系统文件）：

1. 探测：`$g = Get-AppxPackage -Name '*XboxGamingOverlay*'` 确认已装；`[Environment]::GetFolderPath('MyVideos')` 拿到 Videos 路径。
2. 建目标：`New-Item -ItemType Directory -Path 'D:\Videos\Captures' -Force`。
3. **改名挪开旧文件夹再建 junction（关键坑）**：若 `Captures` 已存在真实文件夹，直接 `Remove-Item` 可能因占用静默失败，紧接着 `New-Item -ItemType Junction` 会返回原真实文件夹而非 junction。正确顺序：先 `Rename-Item Captures Captures.bak` → 再 `New-Item -ItemType Junction -Path Captures -Target 'D:\Videos\Captures'` → 最后删 `Captures.bak`。
4. 验证：往 `C:\Users\<用户>\Videos\Captures` 写一个测试文件，确认它出现在 `D:\Videos\Captures`（穿透测试）；`(Get-Item Captures).LinkType` 应为 `Junction`。
- 前提是 D 盘有空间；若 C / D 同属一块 SSD（如 128GB 盘分两区），跨分区搬家无性能损失。这是「重定向」不是「清理」，安全性高，可作为 C 盘空间紧张时的标准缓解项。

## 3. bat 编写硬规则（Windows 批处理）

**方案选择：bat 外壳 + PowerShell 内核的混合模式是最优解。** 纯 bat 适合菜单与简单清理；复杂逻辑（体积统计、注册表遍历、HTML 报告生成）交给 bat 内嵌调用的 PowerShell（`powershell -NoProfile -ExecutionPolicy Bypass -Command ...`）。原因：bat 双击即可运行（.ps1 双击默认用编辑器打开且受执行策略拦截），PowerShell 有真正的错误处理与 Unicode 支持。双层分工：bat 负责入口、菜单、提权、简单删除；PowerShell 负责一切需要"算"的部分。

- **换行必须 CRLF**：纯 LF 的 bat 会解析错乱、窗口闪退（goto 与括号块必坏）。生成后必须自检：跑 `scripts/check_bat.py <文件>`（检查 CRLF / BOM / chcp / 括号配对 / 通配守卫 / goto 标签 / 危险命令，不合格即报错并列出原因）；加 `--fix` 可自动规范化 CRLF 与去 BOM。**交付前这一步是硬要求，不能跳。**
- **内嵌 PowerShell 命令必须实跑验证**：bat 里 `powershell -Command "..."` 的引号转义极易写出语法错误，而用户双击时一闪而过看不出问题。交付前跑 `scripts/test_bat_ps.py <文件.bat>`，它会抽出所有内嵌 PS 命令在真实 PowerShell 里执行一遍（默认跳过 Clear-RecycleBin 等危险命令），确认语法正确、中文不乱码、数字对得上。命令里输出中文前要加 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`，否则 chcp 65001 下中文乱码。
- **通配守卫的正则要覆盖两种形态**：`%VAR%\*` 和 `%VAR%\子路径\*`（如 `%SystemRoot%\SoftwareDistribution\Download\*`）。只匹配前一种会漏掉后者——变量为空时都会退化成 `\*` 打到盘根目录。
- **编码方案二选一**：UTF-8 无 BOM + 首行 `@echo off`、第二行 `chcp 65001 >nul`；或整体 ANSI/GBK。交付前 `head -c 3 | od -An -tx1` 确认无 BOM（不应为 ef bb bf）。
- **路径一律加双引号**：用户名可能含中文/空格，bat 中所有路径变量展开必须写成 `"%TEMP%"`、`"%~f0"`，否则解析断裂。
- **LF→CRLF 转换**（PowerShell）：`[IO.File]::WriteAllText($p, $txt.Replace("`r`n","`n").Replace("`n","`r`n"), (New-Object System.Text.UTF8Encoding($false)))`
- **提权块**用 `if errorlevel 1`（运行时求值），不要在括号块内用 `%errorlevel%`（解析期展开）；提权失败路径必须 `pause`，防窗口闪退：
  ```bat
  >nul 2>&1 net session
  if errorlevel 1 (
      powershell -NoProfile -Command "try{Start-Process -FilePath '%~f0' -Verb RunAs}catch{exit 1}" >nul 2>&1
      if errorlevel 1 (
          echo [失败] 未获得管理员权限, 已按普通权限继续。
          pause
      ) else (
          exit /b
      )
  )
  ```
- **结构**：菜单式（只读体检 / 安全清理 / 优化建议 / 退出）；只读项与改动项严格分离。直接以 `templates/tuneup-template.bat` 为骨架填充（已内置提权块、菜单循环、混合模式示例，且已通过 check_bat.py 自检），不要从零手写。
- **安全红线**：只删可再生缓存（临时文件、浏览器缓存、DNS 缓存、缩略图、回收站）；不卸载程序、不改注册表、不停用服务、不碰系统文件与个人文件；清理前列清单并二次确认（输 Y 执行）；被占用文件自动跳过（错误重定向到 nul），不中断。**通配删除前必须守卫**：`del "%VAR%\*"` 类命令前加 `if defined VAR` / `if exist` 判断——变量为空时 `"%VAR%\*"` 会退化成 `"\*"`，通配符打到当前盘根目录。

## 4. 操作指引写法

- 系统设置类指引**必须给运行命令直达入口**（`Win+R` sysdm.cpl / ms-settings: 等），并注明"若右键菜单没有该项，用命令入口"——部分机器的右键菜单会被精简或定制。
- 分步指引每步一行；**易漏步骤单独强调**（如虚拟内存改完必须点"设置"再确定才生效）。
- 涉及硬件动手的操作（开盖加装等）给出：工具、静电注意事项、验证方法（装完后去哪里确认生效）。

## 5. 交付前自检门禁（报告/bat 发出前逐项过一遍，任一项不过就改完再发）

1. **红线扫描**：产物里有没有页面文件/休眠文件的数值或操作建议？有 → 逐条对照 SKILL.md §0.0 第 1/2 条的三道门槛，缺任何一个实测数据就删掉该建议，改「保持现状」。这一步专门防"清理场景顺手给虚拟内存数值"的惯性错误。
2. **清理清单成分**：清单里是否只含可再生缓存？出现 pagefile/hiberfil/WinSxS/SoftwareDistribution/个人文件 → 移出清单。
3. **实测完整性**：每个体积数字是否来自实测？写「估计/约/通常占 X」的一律回去重测或删除。
4. **三要素**：每条数值类建议是否带「不处理后果 / 收益 / 风险与前提」？
5. **bat 双检**：check_bat.py 通过 + test_bat_ps.py 实跑通过，缺一个不交付。
6. **指引可达性**：操作步骤是否都有命令直达入口、易漏步骤是否单独强调？

## 6. 交付与纠错

- 交付物放用户指定的归档目录，并明确告知存放路径；同时保留工作区副本。
- 发现自己建议有误：①当场说明错在哪、为什么错；②同步修改所有已交付副本；③把结论沉淀进记忆/技能防复发。
- 用户确认后再执行有影响的操作，宁可多一步确认，不替用户做不可逆决定。
