#!/bin/sh
# 把一份 env 文件里的旧前缀设置改成新前缀：OPENBOT_<X>=… → XIONGBAO_<X>=…
#
#   sh rewrite-env.sh <文件>
#
# 给已有部署用（如 /opt/xiongbao/.env.delivery、源码目录的 .env）。不改也能跑：服务器与容器照样认旧名，
# 只是启动时会点名提醒；改完提醒就没了。到 v0.2.17 旧名不再认，在那之前改掉。
#
# - 先把原文件复制成 <文件>.bak-<UTC 时间 YYYYMMDDTHHMMSSZ>（0600），再原地改写（保留原文件的权限与属主）。
# - 改写前后生效的值完全一样。值按 Compose 的 env_file 解析（交付走 Compose），规则与运行时相同：同名的行最后一行
#   生效；新名的值为空等于没设，旧值生效。
#   - 同名 XIONGBAO_<X> 最后一行的值非空：运行时新名赢，旧行不改名而是注释掉（加「# 」前缀，旧值留在文件里），
#     并在标准错误点名。
#   - 同名 XIONGBAO_<X> 最后一行是空值（等号后什么都没有或只有空白，或只有一对空引号、后面可跟空白与 # 注释，
#     各解析器都读成空）：运行时用的是旧值，所以把空的新行注释掉，再把旧行改名。
#   - 同名 XIONGBAO_<X> 最后一行的值以 # 开头（如 `XIONGBAO_X= # 说明`）：Compose 读成以 # 开头的值，bun 读成空，
#     各解析器结论不一。新旧两行都原样保留，只在标准错误点名，由运维自己处理。
#   - 没有新行：同一个旧名的每一行都改名，最后一行仍然生效。
# - OPENBOT_IMAGE / OPENBOT_TAG / OPENBOT_PORT（Compose 与 README 命令读的变量）同样处理。
# - OPENBOT_POOL_<X>（平台模型的密钥变量）同样改名：v0.2.16 的数据库迁移把模型池行里的名字一起改成 XIONGBAO_POOL_<X>。
# - 只认设置行：可带前导空白与 `export `；注释行、空行与其它行原样保留。
# - 任何输出都只有名字和路径，绝不打印值。
# - 没有要改的行时什么都不写，也不留备份。
#
# 退出码：0 成功（含无事可做）；1 文件不存在或不可读写；2 用法错误。
#
# legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，旧名在 v0.2.17 不再认，本脚本随之移走
set -eu

if [ $# -ne 1 ]; then
  echo "用法: sh rewrite-env.sh <env 文件>" >&2
  exit 2
fi
file=$1
if [ ! -f "$file" ] || [ ! -r "$file" ] || [ ! -w "$file" ]; then
  echo "rewrite-env: $file 不存在或不可读写" >&2
  exit 1
fi

# 第一遍记下已有的新名，第二遍按行改写。只输出改写后的文本到标准输出、名字清单到文件 3。
plan=$(mktemp)
out=$(mktemp)
trap 'rm -f "$plan" "$out"' EXIT

awk -v report="$plan" '
  function setting(line,   m) {
    # 设置行：可选前导空白、可选 export、名字、等号。返回名字，不是设置行返回空串。
    if (match(line, /^[ \t]*(export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*=/)) {
      m = substr(line, RSTART, RLENGTH - 1)
      sub(/^[ \t]*(export[ \t]+)?/, "", m)
      return m
    }
    return ""
  }
  function kind(line,   value) {
    # 设置行的值：Compose 与 bun 都读成空的返回 "blank"，两者读法不一（以 # 开头）的返回 "unclear"，其余 "filled"。
    value = substr(line, index(line, "=") + 1)
    sub(/\r$/, "", value)
    if (value ~ /^[ \t]*$/ || value ~ /^[ \t]*("|\047)("|\047)[ \t]*(#.*)?$/) return "blank"
    if (value ~ /^[ \t]*#/) return "unclear"
    return "filled"
  }
  NR == FNR {
    name = setting($0)
    # 同名的行最后一行生效：只记最后一行的值属于哪一类。
    if (name ~ /^XIONGBAO_./) state[name] = kind($0)
    else if (name ~ /^OPENBOT_./) old["XIONGBAO_" substr(name, 9)] = 1
    next
  }
  {
    name = setting($0)
    if (name ~ /^XIONGBAO_./ && (name in old) && state[name] == "blank") {
      # 只有空值的新行：运行时等于没设，生效的是旧值。注释掉它，旧行改名后接着生效。
      print "# " $0
      if (!(name in emptied)) { emptied[name] = 1; print "emptied " name > report }
      next
    }
    if (name !~ /^OPENBOT_./) { print; next }
    suffix = substr(name, 9)
    renamed = "XIONGBAO_" suffix
    if (state[renamed] == "unclear") {
      # 新行的值各解析器读法不一，改哪一行都可能改变生效值：两行都不动，点名交给运维。
      print
      if (!(name in unclear)) { unclear[name] = 1; print "unclear " name " " renamed > report }
      next
    }
    if (state[renamed] == "filled") {
      print "# " $0
      if (!(name in commented)) { commented[name] = 1; print "commented " name " " renamed > report }
      next
    }
    line = $0
    at = index(line, name)
    print substr(line, 1, at - 1) renamed substr(line, at + length(name))
    if (!(name in done)) { done[name] = 1; print "renamed " name " " renamed > report }
  }
' "$file" "$file" > "$out"

if ! grep -qE '^(renamed|commented) ' "$plan"; then
  while read -r what name new; do
    case $what in
      unclear) echo "rewrite-env: $name 与 $new 都原样保留：$new 的值以 # 开头，Compose 与 bun 读法不一，请自己决定留哪一行" >&2 ;;
    esac
  done < "$plan"
  echo "rewrite-env: $file 里没有要改的旧名，未改动" >&2
  exit 0
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=$file.bak-$stamp
(umask 077 && cp -p "$file" "$backup")
chmod 600 "$backup"
# 原地写回而不是替换文件：保留原文件的 inode、权限与属主（env 文件常是 0600）。
cat "$out" > "$file"

renamed=0
commented=0
compose=
while read -r what name new; do
  case $what in
    renamed)
      renamed=$((renamed + 1))
      echo "rewrite-env: $name → $new" >&2
      case $name in OPENBOT_IMAGE | OPENBOT_PORT) compose=1 ;; esac
      ;;
    commented) commented=$((commented + 1)); echo "rewrite-env: $name 已注释掉：文件里已有 $new，运行时本来就以它为准" >&2 ;;
    emptied) commented=$((commented + 1)); echo "rewrite-env: $name 只有空值（运行时等于没设），已注释掉，改名后的旧值接着生效" >&2 ;;
    unclear) echo "rewrite-env: $name 与 $new 都原样保留：$new 的值以 # 开头，Compose 与 bun 读法不一，请自己决定留哪一行" >&2 ;;
  esac
done < "$plan"
echo "rewrite-env: 改名 $renamed 个，注释 $commented 个；原文件备份在 $backup" >&2
if [ -n "$compose" ]; then
  echo "rewrite-env: 镜像或端口变量改了名：Compose 要用 v0.2.16 起的 docker/compose.delivery.yml（更早的只认旧名）" >&2
fi
