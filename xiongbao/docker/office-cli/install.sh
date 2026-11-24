#!/bin/sh
# 员工电脑里的 LibreOffice 命令行工具（试点，默认不装）。只在构建参数 XIONGBAO_PILOT_OFFICE_CLI=on 时由
# agent-computer/Dockerfile 调用，以 root 在镜像构建时运行一次。
#
# 装法：真工具装进独立的 venv（/opt/xiongbao-office-cli/venv），它的命令不放进 PATH；员工只能从 PATH 上的
# `xb-office-cli` 调它，这个启动器先过路径检查（guard.ts：路径必须在员工自己的工作区内）再启动真工具。
# 启动器和 venv 都归 root、别的用户只读。guard.ts 由 Dockerfile 事先拷到 /opt/xiongbao-office-cli。
set -eu

home=/opt/xiongbao-office-cli
requirements=${1:?"用法：install.sh <requirements.txt>"}

python3 -m venv "$home/venv"
"$home/venv/bin/pip" install --no-cache-dir --disable-pip-version-check --no-input \
  --require-hashes -r "$requirements"
"$home/venv/bin/pip" uninstall -y --disable-pip-version-check pip >/dev/null

cat > /usr/local/bin/xb-office-cli <<'LAUNCHER'
#!/bin/sh
exec bun /opt/xiongbao-office-cli/guard.ts "$@"
LAUNCHER
chmod 0755 /usr/local/bin/xb-office-cli

# 真工具能起来、LibreOffice 真能转换：生成一份文档再导出 docx，读不到就构建失败。
check=$(mktemp -d)
(
  cd "$check"
  HOME="$check" xb-office-cli document new -o check.json >/dev/null
  printf 'writer add-heading -t Check\nexport render check.docx --preset docx\nexit\n' \
    | HOME="$check" xb-office-cli repl --project check.json >/dev/null
  test -s check.docx
  # 工作区外的路径被拒绝（退出码 2），并且没有写出文件。
  if HOME="$check" xb-office-cli document new -o /tmp/xb-office-cli-escape.json >/dev/null 2>&1; then
    echo "xb-office-cli 没有拒绝工作区外的路径" >&2
    exit 1
  fi
  test ! -e /tmp/xb-office-cli-escape.json
)
rm -rf "$check"
