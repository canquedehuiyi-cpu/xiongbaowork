#!/bin/sh
# 在只有回环网卡的独立网络命名空间里运行命令：外网一律不通，对比脚本抓本机测试页时不可能有任何数据出本机。
# 没有 `ip` 命令的机器上用 python3 把 lo 拉起来。用法：isolated.sh <命令> [参数...]
exec unshare --user --map-root-user --net python3 -c '
import fcntl, os, socket, struct, sys
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
request = struct.pack("16sH14s", b"lo", 0, b"")
flags = struct.unpack("16sH14s", fcntl.ioctl(sock, 0x8913, request))[1]  # SIOCGIFFLAGS
fcntl.ioctl(sock, 0x8914, struct.pack("16sH14s", b"lo", flags | 0x1, b""))  # SIOCSIFFLAGS: IFF_UP
os.execvp(sys.argv[1], sys.argv[1:])
' "$@"
