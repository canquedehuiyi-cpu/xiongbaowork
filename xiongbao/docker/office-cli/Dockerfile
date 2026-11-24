# 试点：在已经构建好的员工电脑镜像之上，叠一层 LibreOffice 和 CLI-Anything 的 LibreOffice 命令行工具。
# 默认的电脑镜像（agent-computer/Dockerfile）与这个文件无关，不装、不变。
#
# 在 xiongbao/ 下构建（上下文是仓库里的 xiongbao 目录）：
#   docker build -f agent-computer/Dockerfile -t xiongbao-computer .
#   docker build -f docker/office-cli/Dockerfile --build-arg BASE=xiongbao-computer -t xiongbao-computer-office .
# BASE 没有默认值：忘了传就构建失败，而不是悄悄叠在不知道哪个镜像上。
#
# 装完当场生成一份文档、导出 docx，并确认工作区外的路径、带制表符的 REPL 输入被拒绝，任何一步不对就构建失败。
# 依赖钉精确版本与哈希（requirements.txt）。
ARG BASE
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
  && rm -rf /var/lib/apt/lists/*
COPY agent-computer/office-cli/guard.ts /opt/xiongbao-office-cli/guard.ts
COPY docker/office-cli /opt/office-cli-install
RUN sh /opt/office-cli-install/install.sh /opt/office-cli-install/requirements.txt /opt/office-cli-install/xb-office-cli \
  && rm -rf /opt/office-cli-install /root/.cache /tmp/*
