#!/bin/sh
# 员工电脑里的 LibreOffice 命令行工具（试点，默认不装）。只由叠加 Dockerfile（docker/office-cli/Dockerfile）
# 调用，以 root 在构建时运行一次；默认的电脑镜像不涉及它。
#
# 装法：真工具装进独立的 venv（/opt/xiongbao-office-cli/venv），它的命令不放进 PATH；员工从 PATH 上的
# `xb-office-cli` 调它，这个启动器先过路径检查（guard.ts）再启动真工具。这是防误操作和防明显越界的辅助检查，
# 不是沙箱：员工用完整路径仍能直接调真工具，边界是审批和每个员工各自的系统用户。
# 启动器、守卫、空 bunfig 和 venv 都归 root、别的用户只读。guard.ts 由 Dockerfile 事先拷到 /opt/xiongbao-office-cli。
set -eu

home=/opt/xiongbao-office-cli
requirements=${1:?"用法：install.sh <requirements.txt> <xb-office-cli 启动器>"}
launcher=${2:?"用法：install.sh <requirements.txt> <xb-office-cli 启动器>"}

python3 -m venv "$home/venv"
# requirements 已列全依赖：只装轮子（构建时不跑任何 sdist 的构建脚本），不再解析依赖。
"$home/venv/bin/pip" install --no-cache-dir --disable-pip-version-check --no-input \
  --require-hashes --only-binary :all: --no-deps -r "$requirements"
"$home/venv/bin/pip" uninstall -y --disable-pip-version-check pip >/dev/null

: > "$home/bunfig.toml"
chmod 0644 "$home/bunfig.toml"
install -m 0755 "$launcher" /usr/local/bin/xb-office-cli

# 真工具能起来、LibreOffice 真能转换：生成一份文档再导出 docx，读不到就构建失败。自检在 /workspace 里做
# （守卫的工作区根就是那里），用完删掉。
check=$(mktemp -d /workspace/.xb-office-cli-check.XXXXXX)
trap 'rm -rf "$check"' EXIT
cd "$check"
xb-office-cli document new -o check.json >/dev/null
printf 'writer add-heading -t Check\nexport render check.docx --preset docx\nexit\n' \
  | xb-office-cli repl --project check.json >/dev/null
test -s check.docx
# 工作区外的路径被拒绝（退出码 2），并且没有写出文件。
if xb-office-cli document new -o /tmp/xb-office-cli-escape.json >/dev/null 2>&1; then
  echo "xb-office-cli 没有拒绝工作区外的路径" >&2
  exit 1
fi
test ! -e /tmp/xb-office-cli-escape.json
# REPL 里一个制表符也不能把路径拼过界。
if printf 'document save .\t./xb-office-cli-escape.json\nexit\n' \
  | xb-office-cli repl --project check.json >/dev/null 2>&1; then
  echo "xb-office-cli 没有拒绝带制表符的 REPL 输入" >&2
  exit 1
fi
test ! -e "$check/../xb-office-cli-escape.json"
