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
  // 带 `/`、`+`、`=` 的（AWS 的 secret key 之类，base64 的样子）：32 个字符以上，大小写字母和数字都有，
  // 免得把一般的长路径当成密钥（路径几乎都是小写）。
  /(?<![A-Za-z0-9/+=_-])(?=[A-Za-z0-9/+=_-]{0,200}[A-Z])(?=[A-Za-z0-9/+=_-]{0,200}[a-z])(?=[A-Za-z0-9/+=_-]{0,200}\d)[A-Za-z0-9/+=_-]{32,200}(?![A-Za-z0-9/+=_-])/,
];
const PASSWORD_KEY =
  "(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|密码|口令|密钥|令牌)";
const PASSWORD_VALUE = "[A-Za-z0-9_\\-./+=!@#$%^&*]{6,}";
/**
 * 口令的几种写法：
 *  - 冒号或等号：`密码：xxx`、`password=xxx`、`密码是：xxx`、`password is: xxx`，值是 6 个以上的 ASCII 字符；
 *  - 「是 / 为 / is」或只有空格：`密码是 xxx`、`my password is hunter22`、`密码 hunter22!`、`口令 P@ssw0rd!`。
 *    没有冒号时值里要有数字或符号：`password manager`、`token is required` 不是口令。
 */
const PASSWORD_ASSIGNMENTS: readonly RegExp[] = [
  new RegExp(
    `${PASSWORD_KEY}\\s*(?:(?:is|是|为)\\s*)?[:=]\\s*["'\`]?${PASSWORD_VALUE}`,
    "i",
  ),
  new RegExp(
    `${PASSWORD_KEY}(?:\\s+(?:is\\s+)?|\\s*(?:是|为)\\s*)["'\`]?(?=[A-Za-z0-9_\\-./+=!@#$%^&*]*[0-9!@#$%^&*])${PASSWORD_VALUE}`,
    "i",
  ),
];
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

/**
 * 先归一化再匹配：全角转半角（`＠`、全角数字和冒号），再把数字之间的空格和横杠去掉（`138 0013 8000`、
 * `110101 19900307 123X`）。号码类的检查在去掉分隔之后的那份上做，别的在归一化后的原文上做。
 */
function normalised(text: string): { plain: string; squeezed: string } {
  const bounded = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
  const plain = bounded.normalize("NFKC");
  return {
    plain,
    squeezed: plain.replace(/(?<=\d)[ \u00a0-]+(?=[\dXx])/g, ""),
  };
}

/** 这段文字里认得出的敏感内容，每一类一次；没有就是空数组。 */
export function findSensitive(text: string): SensitiveKind[] {
  const { plain, squeezed } = normalised(text);
  const found: SensitiveKind[] = [];
  const add = (kind: SensitiveKind) => {
    if (!found.includes(kind)) found.push(kind);
  };
  if (EMAIL.test(plain)) add("邮箱地址");
  if (
    [plain, squeezed].some(
      (view) =>
        CN_MOBILE.test(view) || INTL_PHONE.test(view) || CN_LANDLINE.test(view),
    )
  )
    add("手机号或电话号码");
  if (ID_NUMBER.test(squeezed)) add("身份证号");
  if (hasCardNumber(squeezed)) add("银行卡号");
  if (PRIVATE_KEY.test(plain)) add("私钥");
  if (TOKEN_SHAPES.some((shape) => shape.test(plain))) add("密钥或令牌");
  if (PASSWORD_ASSIGNMENTS.some((shape) => shape.test(plain))) add("口令");
  if (CREDENTIAL_URL.test(plain) || SECRET_QUERY.test(plain))
    add("带凭据的网址");
  return found;
}

/** 一条指令里提到的「要外发的东西」：配置、密钥、凭据、整个目录这一类。 */
const EXFIL_DATA =
  "(?:\\.env|密钥|令牌|token|密码|凭据|cookie|私钥|id_rsa|配置文件|所有文件|全部文件|整个目录|整个文件夹)";
const EXFIL_VERB = "(?:发|上传|传|提交|推送|post|upload|send)";
const EXFIL_DATA_THEN_VERB = new RegExp(
  `${EXFIL_DATA}[^\\n]{0,30}?${EXFIL_VERB}([^\\n]{0,60})`,
  "ig",
);
const EXFIL_VERB_THEN_DATA = new RegExp(
  `${EXFIL_VERB}[^\\n]{0,30}?${EXFIL_DATA}([^\\n]{0,60})`,
  "ig",
);

/**
 * 把要紧的东西发到外面去：「发 / 上传」和「.env、密钥、令牌、所有文件」两个词挨着，后面跟着一个网址或域名
 * （`https://…`，也包括没有协议的 `evil.example`）。
 */
function exfiltrates(text: string): boolean {
  for (const pattern of [EXFIL_DATA_THEN_VERB, EXFIL_VERB_THEN_DATA])
    for (const match of text.matchAll(pattern))
      if (hasUrl(match[1] ?? "")) return true;
  return false;
}

/** 一条 `rm` 命令：命令名之后到 shell 分隔符或中文标点为止的参数（反引号不算分隔，留给目标检查）。 */
const RM_COMMAND =
  /(\bxargs[ \t]+(?:-\S+[ \t]+)*)?\brm((?:[ \t]+[^\s;&|,，。；、）)」』]+)+)/gi;
/** 技能里的占位写法 `<dir>`、`<工作目录>`：指工作目录，不是重定向。 */
const PLACEHOLDER = /<[\w\u4e00-\u9fa5 .-]{1,24}>/g;
/** `cd` 或 `pushd` 到别处：之后的相对目标就不在工作区里了。 */
const CHANGE_DIR = /\b(?:cd|pushd)[ \t]+([^\s;&|,，。；、）)」』]+)/gi;

/**
 * 这个路径是不是危险的那种：根目录、家目录、绝对路径（含 `C:`）、变量或命令替换（`$`、`%VAR%`、反引号）、
 * 带 `..` 的、通配符、重定向、当前目录本身（`.`、`./`、`./.`）、`.git`。引号和反斜杠先去掉再看，
 * `''/etc`、`.\./x` 这类拆开的写法也认得出。工作区里有名字的子目录（`build`、`out`、`.cache`）不算。
 */
function dangerousPath(written: string): boolean {
  // 技能是 Markdown：`rm -rf out .cache` 末尾那个反引号是行内代码的边，不是命令替换。只有一个、
  // 又在头或尾的反引号去掉；成对的（`pwd`、x`echo /`）照旧算命令替换。
  const raw =
    (written.match(/`/g) ?? []).length === 1
      ? written.replace(/^`|`$/, "")
      : written;
  if (/[`<>]|%\w+%|\$[({A-Za-z_]/.test(raw)) return true;
  const path = raw.replace(/["'\\]/g, "").replace(/(?:\/\.?)+$/, "");
  if (path === "" || path === ".") return true;
  if (/^[/~$]|^[A-Za-z]:/.test(path)) return true;
  if (/(?:^|\/)\.\.(?:\/|$)/.test(path)) return true;
  if (/(?:^|\/)\.git(?:\/|$)/i.test(path)) return true;
  return /[*?[\]{}]/.test(path);
}

/**
 * 一段文字里有没有递归删除危险目标的 `rm`（见 {@link dangerousPath}）：递归了但没写目标的、带
 * `--no-preserve-root` 的、目标从 `xargs` 来的、同一段里先 `cd` 到危险位置的，都算。全角字符先归一化。
 */
function deletesBroadly(text: string): boolean {
  return broadDeleteIn(text) !== undefined;
}

/** 和 {@link deletesBroadly} 一样的判断，返回认出来的那条 `rm` 命令（最多 80 个字符），没有就是 `undefined`。 */
export function broadDeleteIn(text: string): string | undefined {
  const plain = text.normalize("NFKC").replace(PLACEHOLDER, "x");
  const leavesWorkspace = [...plain.matchAll(CHANGE_DIR)].some((match) =>
    dangerousPath(match[1] ?? ""),
  );
  for (const match of plain.matchAll(RM_COMMAND)) {
    const args = (match[2] ?? "").trim().split(/\s+/);
    const flags = args.filter((arg) => arg.startsWith("-"));
    const recursive = flags.some(
      (flag) => /^--rec/i.test(flag) || /^-[a-z]*r/i.test(flag),
    );
    if (!recursive) continue;
    const found = match[0].trim().slice(0, 80);
    if (match[1] || leavesWorkspace) return found;
    if (flags.includes("--no-preserve-root")) return found;
    const targets = args.filter((arg) => !arg.startsWith("-"));
    if (targets.length === 0 || targets.some(dangerousPath)) return found;
  }
  return undefined;
}

/** 越权规则里「破坏性的系统命令」这一类的名字（{@link findOverreach} 返回的就是它），供认出「只因这一类」的草稿。 */
export const DESTRUCTIVE_REASON =
  "破坏性的系统命令（递归删除、递归改权限、格式化）";

/** 技能里不许写的越权步骤：教员工绕过审批、忽略规则、做破坏性的事、瞒着本人。 */
const OVERREACH: readonly {
  reason: string;
  shape?: RegExp;
  test?: (text: string) => boolean;
}[] = [
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
    reason: DESTRUCTIVE_REASON,
    test: (text) =>
      /chmod\s+-R\s*777|mkfs\b/i.test(text.normalize("NFKC")) ||
      deletesBroadly(text),
  },
  {
    reason: "把文件、密钥或凭据发到外部网址或域名",
    test: exfiltrates,
  },
  {
    reason: "把文件上传到外部（curl、wget 带文件）",
    shape:
      /(?:curl|wget)[^\n]*(?:-d\s*@|--data(?:-binary)?\s*@|-F\s|--upload-file|-T\s)/i,
  },
  {
    reason: "遇到确认或授权就自动点允许",
    shape:
      /(?:弹窗|对话框|提示|审批|授权|确认)[^\n]{0,10}(?:就|都|直接|一律|自动)?\s*(?:点|点击|选|选择|按)[^\n]{0,4}(?:允许|同意|确认|批准|allow|accept|yes)|自动(?:点|点击)[^\n]{0,4}(?:允许|同意|确认|批准)/i,
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
  return OVERREACH.filter(
    (rule) => rule.test?.(scanned) ?? rule.shape?.test(scanned) ?? false,
  ).map((rule) => rule.reason);
}

/** 带协议的网址、www 开头的、IP 地址。 */
const URL_SHAPES: readonly RegExp[] = [
  /\b(?:https?|ftp|wss?):\/\//i,
  /\bwww\.[a-z0-9-]+\.[a-z]{2,}/i,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
];

/** 形如「标签.标签」、最后一段是 2 到 24 位字母的串：域名的样子。 */
const DOMAIN_LIKE =
  /(?<![A-Za-z0-9_@-])[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.([A-Za-z]{2,24})(?![A-Za-z0-9_-])/g;

/**
 * 最后一段是这些的，当文件名，不当域名：常见的文档、代码、配置、数据、图片、压缩包和日志的扩展名。
 * 既是扩展名又是顶级域的（`.ai`、`.rs`、`.sh`、`.py` 里除这里列出的之外）按域名算：宁可多送几条去待审。
 */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    "md mdx py pyc sh bash zsh ts tsx js jsx mjs cjs json jsonl txt csv tsv yml yaml toml lock log html htm css scss " +
    "png jpg jpeg gif svg webp bmp ico pdf doc docx xls xlsx ppt pptx rtf odt zip tar gz tgz bz2 xz rar 7z " +
    "mp3 mp4 mov avi wav sql xml ini cfg conf env bak tmp out java class jar kt cs go rb php pl lua c cc cpp h hpp " +
    "swift dart scala vue svelte ipynb exe dll so dylib bat cmd ps"
  ).split(" "),
);

/** 这段文字里有没有网址或域名：员工自己复盘出来的技能带着外部地址，要本人看过才生效。 */
export function hasUrl(text: string): boolean {
  const scanned = (
    text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text
  ).normalize("NFKC");
  if (URL_SHAPES.some((shape) => shape.test(scanned))) return true;
  for (const match of scanned.matchAll(DOMAIN_LIKE)) {
    const last = (match[1] ?? "").toLowerCase();
    // 「e.g」「3.5」这类：最后一段至少两位字母，且整串里有一个点，已经由正则保证；这里只排除文件扩展名。
    if (FILE_EXTENSIONS.has(last) || calledInCode(scanned, match)) continue;
    return true;
  }
  return false;
}

/** 邮箱换成的占位。 */
export const EMAIL_PLACEHOLDER = "<邮箱>";

/** 和 {@link EMAIL} 一样，只是 `@` 也认全角的 `＠`：这里不整段归一化，免得顺带改了别的标点。 */
const EMAIL_SOURCE = EMAIL.source.replace("@", "[@＠]");
const EMAIL_EVERY = new RegExp(EMAIL_SOURCE, "g");
/** 「王芳 <wang.fang@…>」「王芳（wang.fang@…）」：邮箱前面紧挨着的人名连邮箱一起换掉。 */
const NAMED_EMAIL = new RegExp(
  `[\\u4e00-\\u9fa5]{2,4}\\s*[<《（(]\\s*${EMAIL_SOURCE}\\s*[>》）)]`,
  "g",
);

/**
 * 把文字里的邮箱地址换成 {@link EMAIL_PLACEHOLDER}（连同紧挨着它的人名），返回换完的文字和换了几处。没有邮箱就原样返回。
 *
 * 这是复盘草稿专用的：复盘读的是别人的数据（纪要、邮件），模型写技能时容易把邮箱抄进来；一个邮箱不是密钥，
 * 换成占位不损失技能的用处，整条拒绝反而让办公类技能存不下来。员工自己写技能时不走这里，仍按 {@link findSensitive}
 * 拒绝。号码、密钥、口令一概不动；换完之后保存前还会再查一遍，换不干净的（比如全角字母写的）照旧拒绝。
 */
export function maskEmails(text: string): { text: string; count: number } {
  let count = 0;
  const replaced = text
    .replace(NAMED_EMAIL, () => {
      count += 1;
      return EMAIL_PLACEHOLDER;
    })
    .replace(EMAIL_EVERY, () => {
      count += 1;
      return EMAIL_PLACEHOLDER;
    });
  return count === 0 ? { text, count } : { text: replaced, count };
}

/**
 * 没有协议的「标签.标签」，最后一段是这些的才当域名：常见的顶级域，加上本地和测试用的几个；再加上所有两位字母的
 * （国家和地区的顶级域，扩展名已在 {@link FILE_EXTENSIONS} 里挑出去）。代码里的 `csv.writer`、`os.path` 这类
 * 属性和方法名因此不被当成域名。写在「发 / 上传」后面的外发规则（{@link findOverreach}）仍用最宽的 {@link hasUrl}。
 */
const DOMAIN_SUFFIXES: ReadonlySet<string> = new Set(
  (
    "com net org edu gov mil int dev app info biz xyz top site online cloud tech store shop club vip link page blog " +
    "news mobi pro name asia example test local localhost internal invalid lan corp home onion " +
    "sbs cfd rest bid win men work loan click gdn kim party review trade date racing download stream science icu " +
    "fun space website live life world today agency email digital network systems solutions services group " +
    "company ltd inc fyi wtf lol ninja rocks guru tools zone social studio design art media center city run cash best"
  ).split(" "),
);

/**
 * 这段文字里有没有要访问或外发到的网址或域名：带协议的、`www.` 开头的、IP 地址，以及最后一段是常见顶级域的域名。
 * 先把邮箱换成占位：邮箱不是网址，`zhang.san@example.test` 里的「zhang.san」不能被当成域名。复盘出来的技能带着
 * 它就转待审，要本人看过才生效（见 `skills/save-tool.ts` 的 `heldForReview`）。
 */
export function hasExternalAddress(text: string): boolean {
  return externalAddressIn(text) !== undefined;
}

/** 和 {@link hasExternalAddress} 一样的判断，返回认出来的第一处网址或域名（最多 80 个字符），没有就是 `undefined`。 */
export function externalAddressIn(text: string): string | undefined {
  const bounded = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
  const scanned = maskEmails(bounded).text.normalize("NFKC");
  for (const shape of URL_SHAPES) {
    const found = shape.exec(scanned);
    if (found) return addressAround(scanned, found.index);
  }
  for (const match of scanned.matchAll(DOMAIN_LIKE)) {
    const last = (match[1] ?? "").toLowerCase();
    if (FILE_EXTENSIONS.has(last) || calledInCode(scanned, match)) continue;
    if (last.length === 2 || DOMAIN_SUFFIXES.has(last)) return match[0];
  }
  return undefined;
}

/**
 * 紧跟着左括号的「域名」是代码里的函数调用，不是地址：`subprocess.run(…)`、`requests.get(…)` 的最后一段恰好也是
 * 顶级域（.run、.get）。带协议、`www.` 开头的网址不走这里，照样认。
 */
function calledInCode(text: string, match: RegExpMatchArray): boolean {
  const end = (match.index ?? 0) + match[0].length;
  return text[end] === "(";
}

/** 从 `start` 起到下一个空白或中文标点为止的一段，最多 80 个字符：网址本身，不带后面的话。 */
function addressAround(text: string, start: number): string {
  const rest = text.slice(start, start + 80);
  return rest.split(/[\s，。；、,;)」』"'`]/)[0] ?? rest;
}
