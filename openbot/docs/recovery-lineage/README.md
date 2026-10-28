# recovery-20261018-v1：L0 候选（PG_VALIDATION_PENDING）

本包仅保全真实冻结的 idx0..80，不是已激活的新数据库版本，不是历史81..121的恢复。
原SQL、journal与81个snapshot原字节进入专用JSON bundle（base64无损载荷）。
固定输入摘要来自已核冻结树a81cd048…，163件文件；编译内固定摘要拒绝重算哈希后的篡改。
`bundleSHA256`是规范manifest正文的摘要（排除自己的摘要字段），覆盖每件载荷身份、原when、idx/tag、snapshot id/prevId与未满足门；最终bundle文件SHA256另列发布回执，避免自引用。

## 隔离与入口

- `buildBaselineBundle`只按原journal的精确0..80路径读取，不扫描历史档案/缺文/0121参考；输入父路径的别名与非普通文件拒绝，输出以wx禁止覆盖，禁止写进冻结drizzle。
- `verifyBundle`重新从静态原字节构建manifest并对比，不执行SQL或历史JS。
- 不改现有migrate.ts、index.ts、schema、journal；当前没有CLI或启动接线。
- `exactPrefix`逐条比对id/SQL SHA256/原when；不是maxwhen。未知、重复、乱序、缺前缀、旧81..121都拒绝。
- `readPgEvidence`接标准query接口，只发固定只读SQL，读取迁移表、lineage marker与pg_catalog实际事实。SQL/权限异常向上失败，不当空库，不自动补journal。
- catalog覆盖关系/列/默认值/约束/索引/触发器/策略/例程/类型/角色/成员/ACL；完整期望须Root从真实固定PG环境按每个允许前缀冻结。snapshot无法证明权限、触发器、业务约束，不能用99表计数代替实际catalog。
- `assessEvidence`仅纯证据比较，永远返回authorization NONE与ready_for_migration false。调用者自造contract/registry/hash无授权效果。
- 运行入口`preflight`只信编译内Root发布绑定与固定`/opt/xiongbao/releases/recovery-20261018-v1/bundle.json`；无repo-root/env/caller hash覆盖。当前绑定为null，在访问PG之前拒绝。候选工件不能自签即执行。

## 后续受控连接合同（尚未实施迁移执行）

PgAdapter.transaction必须独占一条保留连接并在同连接BEGIN → transaction advisory lock(20261018,1) → 精确历史、marker、catalog预检 → 执行Root发布SQL → 精确记账/marker → COMMIT。任一步失败ROLLBACK；提交未知不补成功、不重放，需恢复核查。
当前模块只有预检骨架，尚无DDL executor/记账/提交实现；接口注释不是PG原子性证明。
普通应用角色不能取得迁移写权；旧writer必须由部署角色权限和最低兼容版本门隔离，否则advisory lock不能约束绕门writer。启动校验与旧writer fencing待单独授权接线。
Root冻结绑定、真实catalog合同、L1/L2与PG验收缺一不可；即使未来绑定存在，当前代码仍在target prerequisites门拒绝，不能迁移。

## 完整目标，不缩减为单列修补

L1须完整闭合99→150的51新增表，及audit_events.subject_tenant_id、plugin_grants.assembly_binding、tasks.trigger_source、waker_flows.active_source_version_id/definition_mode（4表5字段）；APstore额外结构另登记。当前未生成DDL。
未来idx81起必须新recovery名称、新snapshot id、真实生成时间，首prevId接真实0080；不得借0121 id或旧时间伪历史。
L2角色/RLS、L3持久claim/fence与真实PG双连接负控、L4原18包全能力、L5七门/Windows/计量/安装均未由L0通过。
保留原数据与PK/FK；旧NULL/未知不猜owner、Flow模式或continuation结果。非空备份还原演练后才升级，失败不补成功journal，不删状态/receipt回退。

## CPU证据边界

测试使用真实冻结输入与真实临时bundle；PG为fake query边界，未连接或启动数据库/服务，不执行DDL。
原前缀与合成的未来本谱系前缀测试只验证比较逻辑；合成身份不会写进候选bundle，也不授权迁移。
实际命令/退出码/日志在L0外部回执。当前状态始终PG_VALIDATION_PENDING。

## L0-r2：内部触发器与 rewrite rule 补门

普通用户 trigger 的既有事实保留；新增全部 internal trigger 的启用状态、约束与所属表、事件位掩码、函数 schema/name/identity arguments、关联表/支持索引/分区父表、延迟属性等。内部键用稳定schema/table/constraint/function/event身份，不投影OID或含OID的自动trigger名称，也不使用含自动名的pg_get_triggerdef作为内部定义；OID只用于catalog连接/反解析。缺失关联以NULL保留，不能伪成已知对象。

新增pg_rewrite经ev_class连接实际表/namespace，记录schema/table/rulename、pg_get_ruledef、ev_enabled、事件及INSTEAD属性；relation另记relhasrules。当前CPU假事实证明增加/移除、定义或启用状态变化会与冻结摘要不符；这不是执行SQL的证明。

Root冻结catalog合同前仍须真实PG17负控（本轮全部NOT_RUN）：对实际FK禁用/改为replica或always触发模式，确认即使constraint definition/validated未变也被拒；正常FK对应事实能匹配且自动trigger名/OID重分配不影响稳定键。对普通表增加ON DELETE DO INSTEAD NOTHING规则、更改定义、禁用/切换启用模式、移除规则分别拒绝。规则触发/外键拦截的实际业务效果也须真实数据库实证，不能以fakePG替代。其他catalog事实不宣称穷尽。

官方PG17依据（只读核对）：
- https://www.postgresql.org/docs/17/catalog-pg-trigger.html
- https://www.postgresql.org/docs/17/catalog-pg-rewrite.html
- https://www.postgresql.org/docs/17/sql-altertable.html

原163输入/81迁移bundle字节及manifest不变；ROOT_RELEASE仍null、ready_for_migration仍false。尚未接入migrator/index或任何DDL执行器。
