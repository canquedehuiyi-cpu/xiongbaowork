# B3-DIA baseline 子包（docs/cloud-dev/b3-baseline.md）

## 范围
- 输入：Root 留存的两份 tsc stdout 日志（普通 .log/.txt），零进程生成（D1）。
- 比较：诊断按完整规范化键 (file, line, col, code, message) 做多重集比较（D2）。
  仅换行统一与行尾空白剥离；file 反斜杠→正斜杠；数字/错误码/消息不模糊。
  原文与 message_sha256 逐条保留；多重性按键计数（new/resolved/still_present）。
- 输出：new / resolved / still_present（D3）。resolved 仅差量展示，不改 failed 判定。
- D4 树 identity：本包不实现，恒为 unverified；既有 expected 仅声明，不比较。

## 复用与接缝（Root 51665136/51666024）
- 复用 Root 部署 verify：`load_registry` / `resolve_repo_root` /
  `InvalidPlan` / `InvalidArguments`（不复制正文、不自批授权）。
- 复用 Root 部署 reporting 1.1：`make_check` / `summarize` / `overall_status` /
  `compute_exit_code` / `build_report`（不新设状态等级、不改 reporting）。
- exit：fail=1 / incomplete=2 / pass=0 由 `compute_exit_code` 给出；
  参数/plan 错误（InvalidPlan/InvalidArguments，含 argparse 缺参/未知 flag/
  非法 format/非 dia-baseline 的 plan-name）为 CLI 独立 exit 3，不调用
  reporting 造 check 报告，JSON 输出与进程返回码同为 3（r2，Root 51667447）。
- 两个待 Root 部署 trust adapter 的明确位置：
  1. 日志信任适配器——registry 1.1 无日志路径授权字段，adapter 授予
     (root, relpath) 前不读任何日志正文（POSITION 1）；
  2. evidence 签发者信任适配器——自报 JSON 仅做结构校验；未读实际日志
     bytes 前不绑定（binding_performed=false，不以空字节伪造 observed），
     trusted 恒 False，不得因此升 passed（POSITION 2，r2）。
- 接缝未接期间 CLI：解析 registry/repo-root 失败→exit 3（无 check 报告）；
  root 合法则双 check blocked→exit 2 并给出具体缺口，零日志字节读取；
  --run-evidence 路径只记缺口、绝不打开（零未批正文读取，r2）。

## run-evidence 候选格式（仅数据校验，非授权）
JSON 字段：log_path/log_sha256/argv/cwd/dep_tree/started_at/ended_at/
exit_code/log_bytes；严格类型，bool 冒 int 拒绝；log_bytes 与 log_sha256
必须与实际读入日志 bytes 复算绑定，任一缺失/失配 → unverified；
未读日志前 CLI 只做结构校验、不提前绑定（r2）。

## 路径守卫（POSITION 1 adapter 的纵深防御，先验证路径再读）
- literal-first 逐组件 walk：绝对路径/盘符/`..` 拒；任意 symlink 组件拒（无特许）；
  秘密组件拒（.env/credentials/id_*/secrets、*.pem/*.key/*.p12/*.pfx；
  id_ 前缀按本声明在守卫内落实，不扩名单/授权）；
  仅 .log/.txt；必须位于已信任根内；超 8 MiB 拒。
- 首尾空白路径直接拒绝（r2）：不 trim 后另开原文；guard 与读取共用同一
  literal 目标组件（norm_log_path + literal_target），验证目标即打开目标。
- 诊断键 file 仅反斜杠→正斜杠、不剥离空白（r2）：" a.ts" 与 "a.ts" 是不同键，
  不合并。
