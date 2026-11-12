#!/usr/bin/env bash
# 仅 spike 分支：抓取 agent-desktop v1.2.0 的锁定值与样本（Task 1）。不合入 main。
set +e
VER=1.2.0
BASE="https://github.com/vercel-labs/agent-desktop/releases/download/v$VER"
OUT="$PWD/capture-out"; mkdir -p "$OUT/dl" "$OUT/ex" "$OUT/samples"
SUM="$OUT/summary.txt"; : > "$SUM"
note() { echo "$*" | tee -a "$SUM"; }
tmo() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else local t=$1; shift; perl -e 'alarm shift; exec @ARGV' "$t" "$@"; fi; }
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

cat > "$OUT/pick.js" <<'EOJ'
// node pick.js <file> <regex>：在 list-windows 输出里找标题或程序名匹配的窗口，打印 "id<TAB>pid"
const fs = require('fs');
const [, , file, re] = process.argv;
const raw = fs.readFileSync(file, 'utf8');
let j = null; try { j = JSON.parse(raw); } catch { const i = raw.indexOf('{'); try { j = JSON.parse(raw.slice(i)); } catch {} }
const rx = new RegExp(re, 'i'); const hits = [];
(function w(o) { if (Array.isArray(o)) return o.forEach(w); if (o && typeof o === 'object') { if ('id' in o && (rx.test(String(o.title || '')) || rx.test(String(o.app_name || '')))) hits.push(o); Object.values(o).forEach(w); } })(j);
if (hits[0]) console.log(String(hits[0].id) + '\t' + String(hits[0].pid ?? ''));
EOJ
cat > "$OUT/ref.js" <<'EOJ'
// node ref.js <file> <roleRegex> [nameRegex]：在快照里找第一个角色匹配的控件，打印其 ref
const fs = require('fs');
const [, , file, roleRe, nameRe] = process.argv;
const raw = fs.readFileSync(file, 'utf8');
let j = null; try { j = JSON.parse(raw); } catch {}
const rr = new RegExp(roleRe, 'i'), nr = nameRe ? new RegExp(nameRe, 'i') : null; let hit = null;
(function w(o) { if (hit) return; if (Array.isArray(o)) return o.forEach(w); if (o && typeof o === 'object') {
  const ref = o.ref ?? o.ref_id ?? o.id; const role = String(o.role ?? o.control_type ?? '');
  if (typeof ref === 'string' && ref.includes(':') && rr.test(role) && (!nr || nr.test(String(o.name ?? '')))) { hit = ref; return; }
  Object.values(o).forEach(w); } })(j);
if (hit) console.log(hit);
EOJ

# ---- 1. 六个目标的压缩包与条目 SHA-256 ----
TRIPLES="aarch64-apple-darwin x86_64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-pc-windows-msvc aarch64-pc-windows-msvc"
curl -fsSL -o "$OUT/dl/checksums.txt" "$BASE/checksums.txt"; note "checksums.txt rc=$?"
note "== checksums.txt =="; cat "$OUT/dl/checksums.txt" | tee -a "$SUM"
for t in $TRIPLES; do
  a="agent-desktop-v$VER-$t.tar.gz"
  curl -fsSL -o "$OUT/dl/$a" "$BASE/$a"; rc=$?
  note "ARCHIVE $t rc=$rc sha256=$(sha "$OUT/dl/$a") checksums_line=$(grep -F "$a" "$OUT/dl/checksums.txt" | tr -s ' ')"
  note "ENTRIES $t: $(tar -tzvf "$OUT/dl/$a" | tr '\n' '|')"
  mkdir -p "$OUT/ex/$t"; tar -xzf "$OUT/dl/$a" -C "$OUT/ex/$t"
  find "$OUT/ex/$t" -type f | sort | while read -r f; do note "ENTRY_SHA $t ${f#$OUT/ex/$t/} $(sha "$f")"; done
done
[ "$HASH_ONLY" = 1 ] && exit 0

# ---- 2. 本平台运行 ----
BIN=$(find "$OUT/ex/$TRIPLE" -type f \( -name agent-desktop -o -name agent-desktop.exe \) | head -1)
chmod +x "$OUT/ex/$TRIPLE"/* 2>/dev/null
note "BIN=$BIN"
export AGENT_DESKTOP_HOME="$OUT/ad-home"; mkdir -p "$AGENT_DESKTOP_HOME"; chmod 700 "$AGENT_DESKTOP_HOME"
if [ "$OS_NAME" = windows ]; then
  WH=$(cygpath -w "$AGENT_DESKTOP_HOME")
  note "== Windows 状态目录 DACL（改之前）=="; icacls "$WH" | tee -a "$SUM"
  # 先用默认 DACL 跑一次，记录错误（第 1 轮见到 INTERNAL: private file DACL grants an untrusted principal）
  tmo 30 "$OUT/ex/$TRIPLE/agent-desktop.exe" list-windows > "$OUT/dacl-default.json" 2>&1; note "DACL_DEFAULT_LIST_WINDOWS $(head -c 400 "$OUT/dacl-default.json")"
  powershell -NoProfile -Command "\$p='$WH'; \$a=New-Object System.Security.AccessControl.DirectorySecurity; \$a.SetAccessRuleProtection(\$true,\$false); \$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; \$a.SetOwner(\$u); \$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(\$u,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); Set-Acl -Path \$p -AclObject \$a"
  note "== Windows 状态目录 DACL（只留本人之后）=="; icacls "$WH" | tee -a "$SUM"
fi
S="$OUT/samples"; P="$OS_NAME"
# run NAME args... ：存 S/NAME.json，打印到日志
run() { local n=$1; shift; tmo 60 "$BIN" "$@" > "$S/$n.json" 2> "$S/$n.stderr"; local rc=$?; note "RUN $n rc=$rc :: $*"; echo "----- $n -----"; head -c 6000 "$S/$n.json"; echo; head -c 1000 "$S/$n.stderr"; echo "----- end $n -----"; return $rc; }
runin() { local n=$1 txt=$2; shift 2; printf '%s' "$txt" | tmo 60 "$BIN" "$@" > "$S/$n.json" 2> "$S/$n.stderr"; local rc=$?; note "RUN $n rc=$rc :: $* (stdin)"; echo "----- $n -----"; head -c 4000 "$S/$n.json"; echo; echo "----- end $n -----"; return $rc; }

if [ "$P" = linux ]; then
  note "== (k) AT-SPI 没开时的 status =="
  REAL_BUS="$DBUS_SESSION_BUS_ADDRESS"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=/nonexistent-bus"
  run $P-status-no-atspi status
  run $P-permissions-no-atspi permissions
  run $P-list-windows-no-atspi list-windows
  export DBUS_SESSION_BUS_ADDRESS="$REAL_BUS"
  export GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0 GNOME_ACCESSIBILITY=1
  gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>&1 | head -3
  (/usr/libexec/at-spi-bus-launcher --launch-immediately >"$OUT/atspi-bus.log" 2>&1 &)
  (openbox >"$OUT/openbox.log" 2>&1 &)
  sleep 3
fi

run $P-version version
run $P-version-flag --version
run $P-permissions permissions
run $P-status status
run $P-list-displays list-displays
run $P-help-press press --help
run $P-help-screenshot screenshot --help
run $P-help-focus-window focus-window --help
run $P-help-list-windows list-windows --help
run $P-help-snapshot snapshot --help
run $P-help-launch launch --help
run $P-help-clipboard-set clipboard-set --help

note "== 打开样本窗口 =="
case "$P" in
  windows)
    cat > "$OUT/form.ps1" <<'EOP'
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form; $f.Text = 'XB Sample Form'; $f.Width = 520; $f.Height = 360
$a = New-Object Windows.Forms.TextBox; $a.Name = 'single'; $a.AccessibleName = 'Single line'; $a.Top = 10; $a.Left = 10; $a.Width = 300
$b = New-Object Windows.Forms.TextBox; $b.Name = 'pw'; $b.AccessibleName = 'Password'; $b.UseSystemPasswordChar = $true; $b.Text = 'secret123'; $b.Top = 40; $b.Left = 10; $b.Width = 300
$c = New-Object Windows.Forms.TextBox; $c.Name = 'multi'; $c.AccessibleName = 'Multi line'; $c.Multiline = $true; $c.Top = 70; $c.Left = 10; $c.Width = 300; $c.Height = 100
$d = New-Object Windows.Forms.Button; $d.Text = 'Disabled button'; $d.Enabled = $false; $d.Top = 180; $d.Left = 10; $d.Width = 200
$e = New-Object Windows.Forms.Button; $e.Text = 'Send'; $e.Top = 220; $e.Left = 10; $e.Width = 200
$f.Controls.AddRange(@($a, $b, $c, $d, $e))
[Windows.Forms.Application]::Run($f)
EOP
    powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile','-STA','-File','$(cygpath -w "$OUT/form.ps1")'"
    WIN_RE='XB Sample Form' ;;
  macos)
    swiftc -o "$OUT/xbform" .github/spike/form.swift 2>&1 | tail -5
    ("$OUT/xbform" >"$OUT/xbform.log" 2>&1 &)
    sleep 5
    printf 'hello\n' > "$OUT/sample.txt"; open -a TextEdit "$OUT/sample.txt"
    WIN_RE='XB Sample Form' ;;
  linux)
    (zenity --password --title "XB Password Dialog" >/dev/null 2>&1 &)
    (zenity --entry --title "XB Entry Dialog" --text "single" >/dev/null 2>&1 &)
    printf 'hello\n' > "$OUT/sample.txt"; (gedit "$OUT/sample.txt" >"$OUT/gedit.log" 2>&1 &)
    WIN_RE='XB Password Dialog' ;;
esac
sleep 10
run $P-list-windows list-windows

note "== (a)(b)(c) 密码框、单行、多行、禁用 =="
read -r WID WPID < <(node "$OUT/pick.js" "$S/$P-list-windows.json" "$WIN_RE")
note "SAMPLE_WINDOW id=$WID pid=$WPID"
run $P-snapshot-password snapshot --window-id "$WID" --timeout-ms 10000
run $P-snapshot-password-i snapshot --window-id "$WID" --timeout-ms 10000 -i
note "HAS_SECRET_IN_SNAPSHOT=$(grep -c 'secret123' "$S/$P-snapshot-password.json")"
note "DISABLED_MENTIONS=$(grep -o '"[a-z_]*disabled[a-z_]*"' "$S/$P-snapshot-password.json" | sort | uniq -c | tr '\n' ' ')"
note "STATES_SEEN=$(grep -o '"states":\[[^]]*\]' "$S/$P-snapshot-password.json" | sort -u | head -20 | tr '\n' ' ')"
note "ROLES_SEEN=$(grep -o '"role":"[^"]*"' "$S/$P-snapshot-password.json" | sort | uniq -c | tr '\n' ' ')"
case "$P" in
  macos)
    read -r EID EPID < <(node "$OUT/pick.js" "$S/$P-list-windows.json" 'TextEdit|sample')
    run $P-snapshot-editor snapshot --window-id "$EID" --timeout-ms 10000
    note "EDITOR_ROLES=$(grep -o '"role":"[^"]*"' "$S/$P-snapshot-editor.json" | sort | uniq -c | tr '\n' ' ')" ;;
  linux)
    read -r EID EPID < <(node "$OUT/pick.js" "$S/$P-list-windows.json" 'XB Entry Dialog')
    run $P-snapshot-entry snapshot --window-id "$EID" --timeout-ms 10000
    note "ENTRY_ROLES=$(grep -o '"role":"[^"]*"' "$S/$P-snapshot-entry.json" | sort | uniq -c | tr '\n' ' ')"
    read -r EID EPID < <(node "$OUT/pick.js" "$S/$P-list-windows.json" 'gedit|sample')
    run $P-snapshot-editor snapshot --window-id "$EID" --timeout-ms 10000
    note "EDITOR_ROLES=$(grep -o '"role":"[^"]*"' "$S/$P-snapshot-editor.json" | sort | uniq -c | tr '\n' ' ')" ;;
  windows) EID=$WID ;;
esac
run $P-snapshot snapshot --window-id "$EID" --timeout-ms 10000 -i --compact

note "== (j) list-windows 能否用 window-id + pid 唯一定位 =="
node -e '
const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const ws=[];
(function w(o){if(Array.isArray(o))return o.forEach(w);if(o&&typeof o==="object"){if("id"in o&&"pid"in o)ws.push(o);Object.values(o).forEach(w)}})(j);
const ids=ws.map(x=>x.id),keys=ws.map(x=>x.id+"|"+x.pid);
console.log("WINDOWS="+ws.length+" UNIQUE_IDS="+new Set(ids).size+" UNIQUE_ID_PID="+new Set(keys).size+" ID_SHAPES="+JSON.stringify(ids.slice(0,8)));' "$S/$P-list-windows.json" | tee -a "$SUM"

note "== (e) screenshot 不给路径 =="
run $P-screenshot screenshot --window-id "$EID"
node -e 'const r=require("fs").readFileSync(process.argv[1],"utf8");try{const j=JSON.parse(r);const d=j.data||{};console.log("SCREENSHOT_KEYS="+JSON.stringify(Object.keys(d))+" ENVELOPE_KEYS="+JSON.stringify(Object.keys(j)));for(const[k,v]of Object.entries(d))console.log("  "+k+": "+(typeof v==="string"?v.slice(0,40)+"… len="+v.length:JSON.stringify(v)))}catch(e){console.log("SCREENSHOT_PARSE_FAIL "+e)}' "$S/$P-screenshot.json" | tee -a "$SUM"

note "== (d) focus-window 无头 =="
run $P-focus-window focus-window --window-id "$EID"
run $P-focus-window-headed --headed focus-window --window-id "$EID"

note "== 错误样本 =="
run $P-err-window-not-found snapshot --window-id w-999999 --timeout-ms 5000
run $P-err-snapshot-not-found click "@s0000000000zz:e1"
if [ "$P" = linux ]; then read -r EID EPID < <(node "$OUT/pick.js" "$S/$P-list-windows.json" 'XB Entry Dialog'); run $P-snapshot snapshot --window-id "$EID" --timeout-ms 10000 -i --compact; fi
if [ "$P" = windows ]; then REF=$(node "$OUT/ref.js" "$S/$P-snapshot.json" 'text|edit' 'single'); else REF=$(node "$OUT/ref.js" "$S/$P-snapshot.json" 'text|edit|entry|document'); fi
note "REF=$REF"
if [ -n "$REF" ]; then
  runin $P-type-headless "熊宝员工 测试" type "$REF" --stdin
  runin $P-set-value "熊宝员工" set-value "$REF" --stdin
  run $P-snapshot-after snapshot --window-id "$EID" --timeout-ms 10000 -i --compact
  run $P-err-stale-ref click "$REF"
  REF2=$(node "$OUT/ref.js" "$S/$P-snapshot-after.json" 'text|edit|entry|document')
fi
run $P-err-ambiguous click "@e1"
case "$P" in
  windows) run $P-err-policy-press-altf4 press alt+f4 ;;
  macos) run $P-err-policy-press-cmdq press cmd+q ;;
  linux) run $P-err-policy-press-altf4 press alt+f4 ;;
esac

note "== (h) 状态目录内容（未建会话）=="
find "$AGENT_DESKTOP_HOME" -print | tee -a "$SUM"
note "TRACE_DIR=$(find "$AGENT_DESKTOP_HOME" -type d -iname '*trace*' | wc -l | tr -d ' ')"
note "STATE_HAS_CONTROL_NAMES=$(grep -rl 'Password\|Single line\|Send\|XB' "$AGENT_DESKTOP_HOME" 2>/dev/null | wc -l | tr -d ' ')"
for f in $(find "$AGENT_DESKTOP_HOME" -type f | head -5); do echo "--- $f"; head -c 1500 "$f"; echo; done

note "== (i) 关窗之后用旧编号写 =="
case "$P" in
  windows) powershell -NoProfile -Command "Get-Process powershell | Where-Object { \$_.MainWindowTitle -eq 'XB Sample Form' } | Stop-Process -Force" ;;
  macos) pkill TextEdit; pkill xbform ;;
  linux) pkill gedit; pkill zenity ;;
esac
sleep 3
[ -n "$REF2" ] && runin $P-err-after-close-type "x" type "$REF2" --stdin
[ -n "$REF2" ] && run $P-err-after-close-click click "$REF2"
run $P-err-after-close-focus focus-window --window-id "$EID"
run $P-err-after-close-snapshot snapshot --window-id "$EID" --timeout-ms 5000

note "== 错误码汇总 =="
for f in "$S"/*.json; do c=$(grep -o '"code":"[A-Z_]*"' "$f" | head -1); [ -n "$c" ] && note "ERRCODE $(basename "$f" .json) $c $(grep -o '"disposition":{[^}]*}' "$f" | head -1)"; done
{ echo "## $P"; echo '```'; cat "$SUM"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
exit 0
