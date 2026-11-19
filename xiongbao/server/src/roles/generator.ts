import { generateText, type LanguageModel } from "ai";
import {
  ROLE_LIMITS,
  type RoleProfile,
  validateRoleProfile,
} from "../../../shared/role-profile";
import { shortName } from "../brand";
import {
  type FlowGenerateCall,
  firstJsonObject,
} from "../wakerflows/generator";

/**
 * Smart generation of a role profile (story ROLE1, spec §3.5).
 *
 * One sentence in, one call to a model from the person's own library (D7: never a platform model),
 * one profile out — or a typed reason why not. The answer is only a proposal: it is parsed, checked
 * against the same rules every saved template meets, and handed to the editor, which the person
 * saves or discards. Nothing here writes a template or a coworker.
 *
 * Nothing the provider says reaches the person: every failure leaves as one of three classes with a
 * fixed Chinese message, because a provider's error text can carry request ids, account names and,
 * from some gateways, the key it was handed. The shape follows `wakerflows/generator.ts`.
 */

export const ROLE_FORMAT_MESSAGE = "生成的格式无效，请重试。";

/** The answer was not a usable profile. The call is complete, so a retry is a new, safe call. */
export class RoleProfileFormatError extends Error {
  readonly retryable = true;
  constructor() {
    super(ROLE_FORMAT_MESSAGE);
    this.name = "RoleProfileFormatError";
  }
}

/** The provider answered and refused: nothing was produced. */
export class RoleGenerationRefusedError extends Error {
  constructor() {
    super("模型拒绝了这次生成，请检查模型配置后重试。");
    this.name = "RoleGenerationRefusedError";
  }
}

/** The line dropped or the clock ran out: the provider may or may not have done the work. */
export class RoleGenerationUncertainError extends Error {
  constructor() {
    super("无法确认模型是否完成了这次生成，请发起新的生成。");
    this.name = "RoleGenerationUncertainError";
  }
}

// A function, not a constant: the brand is set after this module loads.
const system = () =>
  [
    `你是${shortName()}的角色设计助手。根据用户的一句话描述，为一位数字员工写出可复用的角色档案。`,
    "只输出一个 JSON 对象，不要输出任何其他文字。对象字段：",
    '{"identity": {"title": 头衔, "roleDescription": 职责}, "persona": {"tone": 性格语气, "principles": 工作守则, "habits": 口头约束}, "bible": 工作手册}',
    `规则：title 一行，不超过 ${ROLE_LIMITS.title} 字；roleDescription 不超过 ${ROLE_LIMITS.roleDescription} 字；`,
    `tone、principles、habits 各不超过 ${ROLE_LIMITS.personaPart} 字；bible 是 Markdown，不超过 ${ROLE_LIMITS.bible} 字，写背景知识、工作流程或术语表。`,
    "所有内容用中文，除非描述里要求其他语言。",
  ].join("\n");

/** The plain prompt, exported so a test can see exactly what the model is given. */
export function roleGenerationPrompt(description: string): string {
  return `用户的描述：${description}`;
}

/** Duck-typed so a RetryError's last error and a bare APICallError read the same. */
function providerStatus(error: unknown): number | null {
  for (const candidate of [
    error,
    (error as { lastError?: unknown } | null)?.lastError,
  ]) {
    const status = (candidate as { statusCode?: unknown } | null)?.statusCode;
    if (typeof status === "number") return status;
  }
  return null;
}

export type RoleGenerator = ReturnType<typeof createRoleGenerator>;

export function createRoleGenerator(
  options: { generate?: FlowGenerateCall; timeoutMs?: number } = {},
) {
  const call: FlowGenerateCall =
    options.generate ??
    ((input) =>
      generateText({
        model: input.model,
        system: input.system,
        prompt: input.prompt,
        abortSignal: input.abortSignal,
        // One request means one request: a retry after an uncertain failure is a second charge.
        maxRetries: 0,
      }));
  // Inside the request's 60-second lease, so a call never outlives the row that says it is running.
  const timeoutMs = options.timeoutMs ?? 55_000;

  return {
    async generate(input: {
      model: LanguageModel;
      description: string;
    }): Promise<RoleProfile> {
      const timeout = AbortSignal.timeout(timeoutMs);
      let text: string;
      try {
        const answer = await call({
          model: input.model,
          system: system(),
          prompt: roleGenerationPrompt(input.description),
          abortSignal: timeout,
        });
        text = answer.text;
      } catch (error) {
        if (timeout.aborted) throw new RoleGenerationUncertainError();
        // A 4xx is a definite "no"; a 5xx, a 408 or no answer says nothing about the work.
        const status = providerStatus(error);
        if (status !== null && status >= 400 && status < 500 && status !== 408)
          throw new RoleGenerationRefusedError();
        throw new RoleGenerationUncertainError();
      }
      const result = validateRoleProfile(firstJsonObject(text));
      // A profile with no title is not an answer to "who is this", however valid its shape.
      if (!result.ok || !result.profile.identity.title) {
        throw new RoleProfileFormatError();
      }
      return result.profile;
    },
  };
}
