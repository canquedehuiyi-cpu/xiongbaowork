# Windows 命令、Stop 与超时验收

本记录为局部候选证据，不签署完整 QoderWake 仿制交付。

## 问题与改动

独立审计在 18fe511 / 1ef3dc3 的 Windows 原生 Bun 1.3.14 上发现：
文件读写可用，但 exec 硬编码 /bin/bash，返回 exitCode=-1、空输出且没有实际效果。
原有 Unix 负 PID 进程组信号也不能终止 Windows 的后代进程。

Windows 现在使用系统 PowerShell，禁用 profile，命令以 UTF-16LE EncodedCommand 传递，
输出为 UTF-8；保留原始命令及非零退出码。启动失败返回明确错误。
子进程仍使用环境白名单，保留必要 Windows 系统变量，敏感父环境不会默认继承。
Stop 和超时使用实际启动进程的 PID，通过 taskkill /T /F 终止进程树。
停止失败明确拒绝并结束等待，不因父进程退出就宣称后代均已停止。
Unix 继续使用无 profile 的 bash 和独立进程组。

服务端的取消与截止时间发送相同持久动作 key 的 cancel 帧。Runner dispatcher 将它
映射到原动作的 AbortController，穿过本地持久去重日志传给执行器和 shell；重连沿用
同一个 dispatcher。取消不会生成第二次执行或新动作编号。

官方依据：[PowerShell 参数](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1)、
[taskkill 进程树终止](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)。

## 原生复跑

脚本 `scripts/ci/windows-runner-probe.ts` 从候选实际源码导入执行器、shell、日志与 dispatcher。
使用 Bun 1.3.14 编译为 Windows x64 baseline，在 Windows 宿主直接执行，测试目录含中文与空格。
每次必须使用全新测试目录，脚本会拒绝已使用目录，防止旧 PID 或完成回执造成假通过。

```powershell
# 在可用 Bun 环境编译；无需安装全局 CLI。
bun build scripts/ci/windows-runner-probe.ts --compile --target=bun-windows-x64-baseline --outfile=windows-probe.exe
& .\windows-probe.exe 'D:\disposable\Windows 熊宝 unique-run' 'C:\Program Files\nodejs\node.exe'
```

实际本机记录：`C:/Users/canqu/.codex/tmp/wp35-022d/windows-final-build.log`、
`windows-final-native.log`。原生运行打印 Bun 1.3.14 / win32，最后 WINDOWS_PROBE_PASS、exit 0。

- marker 命令实际产生输出，中文输出正确，exit 7 保留。
- 工作区文件写入/读取通过，../ 越界写入被拒。
- 合成父环境密钥未透传，不可用 shell 路径明确失败。
- Stop、超时、协议 cancel 各启动自己的真实 Node 子进程与孙进程；先等待并读取各自 PID，
  完成后通过 Windows Get-Process 逐一证明六个后代均消失。
- Stop 与超时分别标记，取消帧实际到达执行器。

## 回归与边界

`windows-final-linux.log`：shell 29 pass / 0 fail，90 断言。
`windows-final-device.log`：通道、设备安全和离线队列 17 pass / 0 fail，92 断言。
测试使用自己创建的普通应用角色与一次性库 openbot_windows_final，不读取真实账户或模型 key。

固定 SHA 全量、正式镜像及独立 Windows CLI 扩展验收另行记录。
本脚本验证直接执行器与协议 dispatcher；不把它写成完整真实服务器配对验收。
Runner 浏览器动作仍缺完整实现；WakerFlow、触发器、逐工具权限与最终 main CI 尚未完成。
