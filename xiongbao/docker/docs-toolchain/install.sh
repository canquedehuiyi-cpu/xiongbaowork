#!/bin/sh
# 员工电脑里生成与读取文档用的 Python 库，两个镜像共用（Dockerfile、agent-computer/Dockerfile）。
#
# 用法：install.sh <requirements.txt>，以 root 在镜像构建时运行一次。
#
# 装进一个独立的 venv（/opt/xiongbao-docs），再用一行 .pth 让系统的 python3 也能 import 到：
# 员工写的 `python3 -c "import docx"`、`python3 make_ppt.py` 直接可用，PATH 不变，系统 python3
# 还是系统的；员工自己 `python3 -m venv .venv` 建的环境看不到这些库，互不干扰。venv 归 root，
# 别的用户只读，员工改不了这里的代码。
#
# Ubuntu 的系统 Python 按 PEP 668 不让往系统目录 pip install，所以不去强行越过这条限制。
set -eu

requirements=${1:?"用法：install.sh <requirements.txt>"}
venv=/opt/xiongbao-docs

python3 -m venv "$venv"
"$venv/bin/pip" install --no-cache-dir --disable-pip-version-check --no-input -r "$requirements"

site=$("$venv/bin/python3" -c 'import sysconfig; print(sysconfig.get_path("purelib"))')

# 运行时用不到的东西：pandas、numpy 自带的测试集（约 60 MB），以及 venv 里的 pip 本身。
rm -rf "$site/pandas/tests"
find "$site/numpy" -depth -type d -name tests -exec rm -rf {} +
"$venv/bin/pip" uninstall -y --disable-pip-version-check pip >/dev/null

dist=$(python3 -c 'import sys; print("/usr/local/lib/python%d.%d/dist-packages" % sys.version_info[:2])')
mkdir -p "$dist"
printf '%s\n' "$site" > "$dist/xiongbao-docs.pth"
ln -sf "$venv/bin/markitdown" /usr/local/bin/markitdown

# 系统 python3 真的 import 得到，markitdown 命令真的在 PATH 上。
python3 -c 'import docx, openpyxl, pptx, reportlab, weasyprint, pypdf, pdfplumber, PIL, pandas, markitdown'
markitdown --help >/dev/null
