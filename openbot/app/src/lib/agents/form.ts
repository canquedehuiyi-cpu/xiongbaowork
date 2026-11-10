import { z } from "zod";
import type { Persona } from "../../../../shared/persona";
import type { AgentProfile } from "./queries";

/** What the server accepts as an avatar seed (`routes.ts`). Kept in step by hand, like the limits. */
export const AVATAR_SEED_PATTERN = /^[\w:.-]{1,64}$/;

/**
 * A fresh avatar seed for the 换一个 button.
 *
 * `getRandomValues`, not `randomUUID`: the latter exists only in a secure context, and a deployment
 * reached over plain http would lose the button. 16 hex characters is far more faces than anybody
 * will reroll through, and always matches `AVATAR_SEED_PATTERN`.
 */
export function randomAvatarSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Browser-side coworker form contract. Limits match the server parser so validation errors can be
 * shown next to fields before submit.
 */
export const agentFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "名字为必填项。")
    .max(80, "名字不能超过 80 个字符。"),
  title: z.string().trim().max(120, "头衔不能超过 120 个字符。"),
  roleDescription: z
    .string()
    .trim()
    .min(1, "角色说明为必填项。")
    .max(1000, "角色说明不能超过 1000 个字符。"),
  visibility: z.enum(["public", "private"]),
  /**
   * The AG-UI endpoint this coworker runs on. Empty means the Bot in the box.
   *
   * Only URL shape is checked here; deployment allow/deny rules are server-side.
   */
  endpoint: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || /^https?:\/\/\S+$/.test(value),
      "Enter a web address starting with http:// or https://.",
    ),
  /**
   * A key the agent sits behind. WRITE-ONLY: it is never sent back from the server, so this field is
   * always empty when editing, and leaving it empty keeps whatever key is already set.
   */
  authValue: z.string(),
  /**
   * Which model in this person's library the coworker answers on.
   *
   * Absent leaves the binding where it is and `null` returns the coworker to the deployment's model —
   * the same three-way the key above uses, because one form writes several fields at once.
   */
  modelRef: z.string().uuid().nullable().optional(),
  /**
   * The seed the coworker's abstract avatar is drawn from.
   *
   * Optional, like the server's: absent on a create means the server uses the new id, and absent on an
   * edit leaves the stored face alone. Same shape the server accepts, so a bad one is caught here.
   */
  avatarSeed: z
    .string()
    .regex(AVATAR_SEED_PATTERN, "头像种子只能是 1 到 64 个字母、数字或 _ - : .")
    .optional(),
  /**
   * A computer of its own. Optional because only the New Bot sheet and the Setup row ask it: every
   * other form leaves it out, and the server reads absent as "leave it as it is".
   */
  isolated: z.boolean().optional(),
  /**
   * The starter Bot's instructions, which only its Setup page sends. Absent leaves them as they are.
   */
  instructions: z
    .string()
    .trim()
    .min(1, "指令为必填项。")
    .max(1000, "指令不能超过 1000 个字符。")
    .optional(),
});

export type AgentFormValues = z.infer<typeof agentFormSchema>;

/**
 * What an in-place edit sends: the form's own fields, plus the persona.
 *
 * The persona is not in the zod schema because it is not validated as text-in-a-box — the server
 * bounds each part and decides what an empty one means, and a second set of limits here would be a
 * second answer to the same question.
 */
export type AgentFormPatch = AgentFormValues & { persona?: Persona };

export const emptyAgentForm: AgentFormValues = {
  name: "",
  title: "",
  roleDescription: "",
  visibility: "private",
  endpoint: "",
  authValue: "",
};

/** Convert form values to API input; omit an empty key so editing preserves the current credential. */
export function agentInputFrom(values: AgentFormPatch) {
  return {
    name: values.name,
    title: values.title,
    roleDescription: values.roleDescription,
    visibility: values.visibility,
    endpoint: values.endpoint,
    ...(values.authValue.trim()
      ? { auth: { header: "Authorization", value: values.authValue.trim() } }
      : {}),
    // Sent only when this screen knows the person's choice, so a save that never touched the model
    // field leaves the binding alone instead of clearing it.
    ...(values.modelRef === undefined ? {} : { modelRef: values.modelRef }),
    ...(values.persona === undefined ? {} : { persona: values.persona }),
    // Only when this screen chose one, so an edit that never showed the avatar cannot redraw it.
    ...(values.avatarSeed === undefined
      ? {}
      : { avatarSeed: values.avatarSeed }),
    ...(values.isolated === undefined ? {} : { isolated: values.isolated }),
    ...(values.instructions === undefined
      ? {}
      : { instructions: values.instructions }),
  };
}

/**
 * The full update body for changing one or two fields of a coworker (upstream's Setup rows; here the
 * detail page's 运行方式 section).
 *
 * The update endpoint takes the whole profile, so unchanged fields ride along as stored. Not a
 * built-in coworker's endpoint: that is the managed Bot's own address, which nobody typed, and the
 * route checks any endpoint it is sent as one somebody did. Empty leaves the stored one where it is,
 * and the empty key keeps the current one. The model binding, persona and avatar are left out, which
 * the server reads as "leave them as they are".
 */
export function profileUpdateInput(
  profile: Pick<
    AgentProfile,
    "name" | "title" | "roleDescription" | "visibility" | "builtIn" | "endpoint"
  >,
  patch: Partial<AgentFormValues>,
) {
  return agentInputFrom({
    name: profile.name,
    title: profile.title,
    roleDescription: profile.roleDescription,
    visibility: profile.visibility,
    endpoint: profile.builtIn ? "" : (profile.endpoint ?? ""),
    authValue: "",
    ...patch,
  });
}
