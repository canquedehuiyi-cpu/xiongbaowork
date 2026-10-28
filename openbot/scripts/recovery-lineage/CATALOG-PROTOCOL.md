# 全局 catalog 协议 v2：PG17 membership options

本协议标识为 `recovery-catalog-v2`，由现有 `preflight.ts` 的唯一 `CATALOG_SQL`、`readPgEvidence`、`catalogDigest`、`assessEvidence` 实现。本次不改变 lineage、target contract、baseline tree、frozen input、原163文件/81 SQL或manifest/bundle，不创建真实catalog期望值或Root release。`ROOT_RELEASE`仍null，`authorization`仍NONE、ready仍false。

## 版本与身份

SQL固定输出一条 `catalog-protocol/global` 事实，definition.protocolVersion 必须为上述版本；adapter拒绝缺失、重复或旧哨兵。PgEvidence和PrefixContract均记录protocolVersion，比较双方均须v2，否则在摘要比较前拒绝。摘要仍由原归一化函数产生：规范对象键、按kind/identity排序、拒绝重复；本次把protocolVersion和facts一起作为同一个摘要的版本域。旧摘要不可直接重命名成v2；无membership的库也必须重新提供经Root核实的v2 expected合同。没有自动升级/忽略旧协议路径。

每条pg_auth_members身份为JSON数组 `[granted_role, member, grantor]`，三个元素是pg_get_userbyid解析的角色名。以grantor区分同一授予角色/member的不同授予来源，不用可能与角色名冲突的斜线串，不采用不稳定原始OID。definition保留相同三身份，以及admin、inherit_option、set_option；三option直接来自PG17的admin_option、inherit_option、set_option，必须全部为boolean。NULL、缺值、数字和文本布尔均拒绝，未知额外事实/字段仍留在摘要中，绝不整体丢弃。身份三元组必须与definition一致。JSON身份解析容许PG JSON文本中的空格，不把它当不同角色；SQL固定序列化形式仍进入现有摘要。

PG17官方定义：inherit_option控制自动继承授予角色的权限，set_option控制SET ROLE，admin_option控制向别人授予membership；pg_auth_members是cluster共享目录。来源：https://www.postgresql.org/docs/17/catalog-pg-auth-members.html 。本包只读过官方定义，未向PG17解析/执行SQL，未证明实际授权或继承效果。

## 比较与安全边界

相同membership身份仅改变inherit/set/admin任何一项，都会改变摘要并拒绝原expected；grantor/member/granted-role变化同样可见。字段验证是最窄membership边界，不把整个CatalogFact.definition改为臆测全库schema。原trigger/rewrite/default ACL等投影与原r2测试语义保留，不过滤非membership事实。

此全局v2不是C2 continuation-target-store的既有局部catalogDigest；两种已有摘要不能互换，不新增第三套同义协议或ACL授权器。v2事实比较不等于feature权限已核、NULL默认ACL已解释、owner/RLS实际有效或可信release加载完成。非public schema的有效授权覆盖、隐式/PUBLIC/预定义角色可达性及SECURITY DEFINER/参数权限等缺项仍需后续有限合同审查；本包不授予任何真实权限、不改auth角色业务。

## 验证范围

CPU使用实际collector查询入口与独立fixture事实验证转换/摘要/合同拒绝，保留全部原30case（含r2 internal trigger/rewrite负控）；SQL文本检查只是补充投影证据，绝不作为真实PG采集通过。strict/Biome仅本包必要范围。原preload、最小环境、no.env和已核网络deny保留，不启动服务/连接DB/探测环境；不改超时/断言以过门。Root release冻结和真实PG执行继续待验，AP effects继续关闭。
