/**
 * 员工自己写下来的东西（自动记下的记忆、自己写的技能）保存之前过一遍的检查：里面不许有密钥、令牌、
 * 邮箱、手机号、证件号、银行卡号，技能里也不许有越权的步骤。
 *
 * 这是拒绝，不是替换：`local-learning/evidence.ts` 的 `mask` 是把送去模型的对话文字里的敏感串换成占位符，
 * 这里是对模型写出来、要存下来的文字，发现一处就整条不存，并说出是哪一类，让员工改了再试。宁可多拦：
 * 员工写的技能和记忆会被反复读进以后的每一轮，混进去一个令牌就是反复泄露一个令牌。
 *
 * 不是完备的：一眼能认出的形状。真正的边界仍是工具调用处的授权、审批和审计；这里只是不让明显的东西
 * 从这条路进库。
 */

/** 被拒绝的一类敏感内容，给员工看的名字。 */
export type SensitiveKind =
  | "邮箱地址"
  | "手机号或电话号码"
  | "身份证号"
  | "银行卡号"
  | "密钥或令牌"
  | "口令"
  | "带凭据的网址"
  | "私钥";

/** 再长的文字也只看前这么多：正则在很长、没有空格的串上是平方级的，不能让一条超长文字卡住事件循环。 */
const SCAN_LIMIT = 20_000;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const CN_MOBILE = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/;
const INTL_PHONE = /\+\d{1,3}[ -]?\d[\d -]{7,}\d/;
const CN_LANDLINE = /(?<!\d)0\d{2,3}[- ]\d{7,8}(?!\d)/;
const ID_NUMBER = /(?<!\d)\d{17}[\dXx](?!\d)/;
const DIGIT_RUN = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const TOKEN_SHAPES: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  // 又长又像随机的一串：含数字也含字母，32 个字符以上。
  /\b(?=[A-Za-z0-9_-]{0,200}\d)(?=[A-Za-z0-9_-]{0,200}[A-Za-z])[A-Za-z0-9_-]{32,200}\b/,
];
const PASSWORD_ASSIGNMENT =
  /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|密码|口令|密钥|令牌)\s*(?:[:=：]|是|为)\s*["'`]?[A-Za-z0-9_\-./+=!@#$%^&*]{6,}/i;
const CREDENTIAL_URL = /:\/\/[^\s/:@]+:[^\s/@]+@/;
const SECRET_QUERY =
  /[?&](?:token|key|apikey|api_key|access_token|secret|sig|signature|password)=[^&\s]{6,}/i;

/** 银行卡号校验位：长数字串多半是时间戳或订单号，只拦通得过校验的。 */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  for (const match of text.matchAll(DIGIT_RUN)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

/** 这段文字里认得出的敏感内容，每一类一次；没有就是空数组。 */
export function findSensitive(text: string): SensitiveKind[] {
  const scanned = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
  const found: SensitiveKind[] = [];
  const add = (kind: SensitiveKind) => {
    if (!found.includes(kind)) found.push(kind);
  };
  if (EMAIL.test(scanned)) add("邮箱地址");
  if (
    CN_MOBILE.test(scanned) ||
    INTL_PHONE.test(scanned) ||
    CN_LANDLINE.test(scanned)
  )
    add("手机号或电话号码");
  if (ID_NUMBER.test(scanned)) add("身份证号");
  if (hasCardNumber(scanned)) add("银行卡号");
  if (PRIVATE_KEY.test(scanned)) add("私钥");
  if (TOKEN_SHAPES.some((shape) => shape.test(scanned))) add("密钥或令牌");
  if (PASSWORD_ASSIGNMENT.test(scanned)) add("口令");
  if (CREDENTIAL_URL.test(scanned) || SECRET_QUERY.test(scanned))
    add("带凭据的网址");
  return found;
}

/** 技能里不许写的越权步骤：教员工绕过审批、忽略规则、做破坏性的事、瞒着本人。 */
const OVERREACH: readonly { reason: string; shape: RegExp }[] = [
  {
    reason: "让员工忽略指令或规则",
    shape:
      /(?:忽略|无视|不要遵守|不必遵守|覆盖).{0,6}(?:以上|之前|前面|所有|全部|系统).{0,6}(?:指令|规则|提示|限制|约束)|ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+(?:instructions|rules)/i,
  },
  {
    reason: "让员工绕过审批、确认或权限",
    shape:
      /(?:绕过|跳过|关闭|禁用|无需|不用|不必|不要等).{0,4}(?:审批|审核|批准|确认|权限|安全检查|二次确认)/,
  },
  {
    reason: "让员工自动同意审批",
    shape: /(?:自动|直接|默认)(?:同意|批准|通过).{0,4}(?:审批|请求|授权|权限)/,
  },
  {
    reason: "破坏性的系统命令",
    shape: /rm\s+-[a-z]*r[a-z]*f?\s+(?:\/|~|\$HOME)|chmod\s+-R\s*777|mkfs\b/i,
  },
  {
    reason: "把网上下载的脚本直接交给 shell 执行",
    shape: /(?:curl|wget)[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
  },
  {
    reason: "用管理员权限（sudo）执行",
    shape: /\bsudo\s+\S/,
  },
  {
    reason: "把密钥、令牌或密码发送、打印出去",
    shape:
      /(?:导出|打印|输出|发送|上传|回传).{0,8}(?:密钥|令牌|token|密码|凭据|cookie)|(?:密钥|令牌|token|密码|凭据|cookie).{0,6}(?:发送|发给|上传|回传|贴给)/i,
  },
  {
    reason: "让员工瞒着本人",
    shape:
      /(?:不要|别|无需|不必)(?:告诉|通知|提醒|让)(?:用户|对方|主人|本人|他|她)/,
  },
];

/** 这段技能文字里越权的地方，每一类一次；没有就是空数组。 */
export function findOverreach(text: string): string[] {
  const scanned = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
  return OVERREACH.filter((rule) => rule.shape.test(scanned)).map(
    (rule) => rule.reason,
  );
}
