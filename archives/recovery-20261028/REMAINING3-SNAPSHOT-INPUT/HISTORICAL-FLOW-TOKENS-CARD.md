# ROOT-REMAINING5-INPUT78：导入提议/主动运行/token事实

READONLY_INPUT_ONLY。固定原0121 whole583049/c382dcdb7b39a9bc7fe47394478a51dd3d25df8dcd803c6e172b9c17f27cb48f与已批V52/0104。三目标原完整对象保字段序/JSON类型/数组/未知字段，indent2LF派生非substring；0104均缺。历史42/51余9，不因105四表作者Source或本批5对象准备而扣减。

| public表 | bytes | SHA256 | Gitblob |
|---|---:|---|---|
| flow_import_proposals |4155|737b0c1d304777b472d835f606364c005e00f9765470fa77659887a78a795546|c4597bd9675fadf9c215137bfe9457e31110cf1e|
| proactive_runs |7851|d3711f2d7d533f84555ee739ca2f456dd169a350b77001ef6dbceb43b2e0f226|afe147fb22b53315e03d4e581cd60610c99fdb19|
| model_token_calls |9256|dbefab6c72124576aa7ff0a911fb4bddbe34c46ed8e4bee91550b16ae1c4f7cf|bf2f99f295afcc4433e7cef675e6604ab9a492fc|

合58列/2inlinePK+1compositePK/0普通UNIQUE/4index(2unique)/0FK/22CHECK/12policy/3ENABLE；所有索引无WHERE/非expression/非concurrent/with{}。历史三表原ORM/SQL全文SOURCE_BODY_MISSING，本次不造原body。

## 所有列/default/null/键

T=text/U=uuid/J=jsonb/Z=timestamptz/B=bigint/I=integer；未写NULL者NN，未写default者无default，不把字段名推成FK。

- proposals14：tenant_id:T=current_setting('app.tenant_id', true)；id:U inlinePK（不随机默认）；request_id:U；revision:I=0；fingerprint:T、token:T、digest:T；owner_revision:T NULL；choices:J、preview:J；status:T='prepared'；import_request_id:U NULL；expires_at:Z；created_at:Z=now()。flow_import_proposals_request_idx(tenant_id,request_id)是unique btree/ASC NULLS LAST，不是普通UNIQUE。
- proactive16：tenant_id:T（无default）、id:T inlinePK、request_key:T、owner_user_id:T、actor_user_id:T NULL、agent_id:T、setting_id:T、source:T、status:T='queued'、created_at:Z=now()；started_at/finished_at/lease_expires_at:Z NULL、lease_owner/error:T NULL、result:J NULL。proactive_runs_request_idx(tenant_id,request_key)unique ASC；proactive_runs_history_idx(tenant_id ASC,owner_user_id ASC,setting_id ASC,created_at DESC,id DESC)，各NULLS LAST。
- model28：tenant_id:T、call_id:U、run_id:T、thread_id:T、agent_id:T、execution_epoch:B、model_ref:U、provider:T、model_name:T、credential_id:U、credential_digest:T、original_model_fingerprint:T、sdk_provider:T、sdk_model_id:T、original_text:T、original_digest:T、outcome:T='pending'、usage_status:T='unknown'；input_tokens/output_tokens/total_tokens/reasoning_tokens/cached_input_tokens/cache_write_tokens:B NULL；receipt_text/receipt_digest:T NULL；started_at:Z NN/no default、observed_at:Z NULL。PK model_token_calls_tenant_id_call_id_pk(tenant_id,call_id)。model_token_calls_time_idx(tenant_id ASC,started_at DESC,call_id DESC)，NULLS LAST。

0FK：没有agent/user/settings/model_registry/credentials/thread/run/导入request的声明外键，也无组内FK父。不能为了“闭合”补FK/owner或拿model_ref/credential_id UUID当实际模型/凭据许可。运行调用顺序/具体业务resolver不由这些对象证明。

## 全CHECK及policy事实

proposals2：status仅prepared/imported，revision>=0；无token/hash形状、expiry/导入状态配对或choices/preview形状CHECK，不添加未有约束。四tenant_scope policy均tenant=GUC，UPDATE USING/WITH CHECK分槽，无owner条件。

proactive8：tenant=owner且tenant NOT IN system/platform；source schedule/run_now/legacy；actor当run_now必须NN且等owner，schedule/legacy则NULL；status queued/running/succeeded/failed/cancelled/unknown。running要求started NN、lease_owner/lease_expires NN、finished NULL，非running要求两lease NULL；queued/running finished NULL，其余finished NN；error NULL或char_length<=500。result NULL或严格object只含readCount/suggestionCount两个键（?&及减去这两键='{}'::jsonb），各JSONnumber，readCount整数0..200、suggestionCount整数0..5，由numeric=trunc约束。完整8原文附caps，不省JSONB减法或NOT IN分支。四owner policy均tenant=GUC AND owner=tenant；未额外校验实际设置/agent权限。

model12：tenant NOT IN system/platform；execution_epoch 1..9007199254740991；outcome pending/completed/stopped/unknown；usage_status unknown/partial/reported：reported输入/输出均NN，partial恰一个NULL，unknown两者NULL。六counter各独立BETWEEN0..MAXSAFE（nullable通过SQL CHECK UNKNOWN，不强补NN；未约束total等于input+output）。digests CHECK credential_digest/original_model_fingerprint/original_digest各lower64，且original_digest=encode(sha256(convert_to(original_text,'UTF8')),'hex')。receipt CHECK：text/digest同时NULL且outcome非completed，或二者NN、digest lower64且重算等text、outcome completed、observed_at NN。没有其它observed时序或数字非零要求。四model policy仅tenant=GUC，不添owner列或模型调用权限。

均PERMISSIVE TO public/每表SELECT、INSERT、UPDATE双槽、DELETE，共12policy/15表达式槽；3ENABLE、无FORCE/GRANT/role/writer事实。无policy子查询外父依赖；不等APP角色、GUC、跨tenant/RLS或后台停止/replay正确。model receipt仅原文+SHA一致性，不是数字签名/可信provider成功；credential_digest是文本列，不读真实凭据。proactive/token计量均不授付费调用，本票0provider探测。

## Source/API与consumer差额

V52完整静读并FD核四schema：plugins39993/802dae12…、proactive3765/1f6261b2…、model2024/031db269…、admin5688/a1179ddf…。proactive只现settings/suggestions，无runs；model只有modelRegistry/providerTemplates；admin旧modelUsage不是model_token_calls，不能用现近似表替代。Source/metadata附caps。

Drizzle0.45.2 held index/PK/FK/policy/unique/getTableConfig/customJSONB正文完整复用；沿pg-core/index→columns/index→bigint真实export链新读bigint.d.ts：bigint(name,{mode:'number'})为PgBigInt53/data number；mode:'bigint'为PgBigInt64/data bigint，driverParam string。Root须冻结未来mode与DTO边界：snapshot bigint本身不记录JS模式；7个bigint列均由CHECK限制MAXSAFE（6可NULL），不等运行driver精度已测。若选bigint，JSON不能直接序列化BigInt，不能改旧codec或造默认为0。

完整旧security测试51536/f05977fb… tokenizer L126不含独立'-'，而proactive_runs_result有JSONB - ARRAY，原样消费会在合法CHECK失败；INDEX L471硬取ASC，而本组两索引有4个DESC列；metadata有asc读值但旧normalizer未覆盖其它未知语法。未来只在新test中新增'-' token和ASC/DESC精确记录/比较；NULLS LAST及flags不能统一强填。不能删减法/改DESC或写ALTER-only consumer求绿。::numeric、->/->>、?&、ARRAY及全函数/字符串可由既有token入口表达，但仍须独立完整expected对象比较，不执行parser来证明。

## 六叶候选与验收定义计划

三表无FK，六叶建议：NEW recovery/sql/<Root定tag>.sql；NEW recovery/meta/<Root定idx>_snapshot.json；MOD _journal.json仅append；NEW schema/import-proactive-token-foundations.ts（建议名）；MOD schema/index.ts一export；NEW tests/recovery-import-proactive-token-foundations.test.ts（建议名）。未分谱系/业务授权，拆包仍须每表完整。

新test需3完整原对象为独立oracle，SQL全语句/真实metadata/snapshot全字段对照；2unique index与普通UNIQUE区别、4DESC及列序/null排序/flags；22CHECK逐branch真实变异（actor/lease/finished、JSON减法/整数界、usage NULL XOR、6计数上界、原文SHA/receipt配对），15policy槽独立变异，先完整正控、不以别门短路称覆盖。bigint模式/API明确断言但真实driver/PG待验；

Root需另冻父版本、6leaf名称/谱系及保护集合。V52现已批，105作者及V53写者并行不能用各自projection盖中央；原knowledge103三表/95182test/212父保护不动，后续按实际Root基准扩展。0产品/SQL/ORM/mapper/parser/AST/import/compile/types/tests/native/resource/deps执行；0Windows/stagecommitpushdeploy，网页停止。ROOT_RELEASE=null/readyfalse/AP_DISABLED/NOT_SERVICE_WIRED/PG_PENDING/NOT_RUN_RESOURCE和预算保。
