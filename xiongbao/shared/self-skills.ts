/**
 * 员工自己写技能（期 2 · Task 2.4）：两个工具的名字、字段上限，和只说给持有它们的员工的那段提示词。
 *
 * 工具在服务器上（`server/src/skills/save-tool.ts`）；与浏览器里那个请本人保存技能的 `save_skill` 分开，所以叫 `save_learned_skill`：`save_learned_skill` 把一件做成了的活的做法存成技能，`refine_skill`
 * 在之后用到这条技能时按结果修正它，或者只带 id 读出全文。生效规则：只给自己用的（`scope: "self"`）立刻生效，
 * 授予写它的这位员工；想共享给别的员工或团队的（`scope: "shared"`）进本人的待审列表，批准前不生效。
 *
 * 技能本身不增加任何能力：它只能请员工去用已经授予它的工具，每一次调用照旧过授权、审批和审计。
 */

export const SAVE_SKILL_TOOL = "save_learned_skill";
export const REFINE_SKILL_TOOL = "refine_skill";
/**
 * 按 id 读出自己写的一条技能全文，只读、不排在检索后面：员工手上有自己写的技能时，每一步的工具定义里都有它
 * （参数只有一个 id，定义很小）。读出的全文连同快路径的做法提示留在对话历史里。
 */
export const READ_SKILL_TOOL = "read_skill";

/** 一条技能写给谁用。 */
export const SKILL_SCOPES = ["self", "shared"] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];

/** 每位员工自己写下的技能最多多少条（`XIONGBAO_SKILLS_PER_EMPLOYEE` 可调）。 */
export const SKILLS_PER_EMPLOYEE_DEFAULT = 50;
/** 技能最近这么多天没被用过，挑选时降权。 */
export const SKILL_STALE_DAYS = 30;
/** 做完一轮、调用工具达到这个步数，就复盘一次（`XIONGBAO_RETRO_MIN_STEPS` 可调）。 */
export const RETRO_MIN_STEPS_DEFAULT = 15;

/** 技能各字段的长度上限，工具的参数说明里照这个说。 */
export const SKILL_FIELD_LIMITS = {
  name: 40,
  when: 300,
  steps: 30,
  step: 400,
  pitfalls: 20,
  pitfall: 300,
  verify: 400,
  /** 快路径：能直接复用的最终脚本或命令（一段），要放得进技能简短形式的 1400 字里。 */
  fastPath: 900,
  fastPathNeeds: 200,
  fastPathCheck: 240,
  change: 300,
  /** 一条技能的修正记录最多保留几条，更早的丢掉。 */
  revisions: 8,
} as const;

/** 技能正文里「快路径」一段的标题字样，和校验命令那一行的开头；存的时候写、读的时候认，两边用同一个。 */
export const FAST_PATH_HEADING = "快路径";
export const FAST_PATH_CHECK_LABEL = "快路径校验命令：";

/** 排在技能名前、让人一眼认出是员工自己写的：`/auto-…` 命令。 */
export const SELF_SKILL_SLUG_PREFIX = "auto-";

/**
 * 做完一件多步的活后，怎么把做法存成技能、之后怎么用和修正；技能里什么不许写。中文，和计划那段一样。
 */
export const SELF_SKILL_GUIDANCE = `做完一件步骤多、做法是你摸索出来的活（十几步以上，或踩过坑才做成的），把可以照着再做一遍的做法用 ${SAVE_SKILL_TOOL} 存成技能：name 是技能名，when 写什么情况下用，steps 一步一条、用祈使句，pitfalls 写踩过的坑，verify 写怎么确认做对了。scope 默认 "self"：只你自己用，存下就生效；要让别的员工或团队也用才写 "shared"，那要本人批准，批准前不生效。
技能里不要写密钥、令牌、密码、邮箱、手机号、证件号和银行卡号，不要写具体的人名、账号和文件内容（写成「对方」「这份文件」），也不要写绕过审批、忽略规则或瞒着本人的步骤；写了会被拒绝。一次性的事、常识，不要存。
你自己写的技能会出现在你手上的技能清单里。遇到同类任务，先调用 ${REFINE_SKILL_TOOL} 只带 id 读出它的全文，照着做；做的时候发现它有错或缺漏，再调用 ${REFINE_SKILL_TOOL} 带上 id 和 change，用一两句话写明哪里要改。`;

/** 只说给持有 `save_learned_skill` 的员工：工具权限里关掉的员工不教它用。 */
export function selfSkillGuidance(
  toolNames: readonly string[],
): string | undefined {
  return toolNames.includes(SAVE_SKILL_TOOL) ? SELF_SKILL_GUIDANCE : undefined;
}
