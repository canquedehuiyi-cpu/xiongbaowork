/*
 * The words for what always asks and for the "做任何改动前都先问我" switch, shared by
 * onboarding's Welcome and Settings → Approvals so the two never say different things.
 *
 * Each sentence is what server/src/approvals/policy.ts does:
 * - Deleting, sending, sharing, posting and paying in an app or on a website ask with the switch
 *   off. Open by default: the person can allow each once, for a conversation, or always, unless the
 *   admin set that kind to ask every time.
 * - A password or other sign-in detail changed on a website is a hand-off: only the person has it.
 * - The switch asks before every change that isn't a read, a Bot's own workspace included, unless a
 *   rule allows it.
 * - A Bot's own workspace (`computer_write_file`, `computer_run_command`) is left out of the safety
 *   asks, so deleting a file there asks only when the switch, Auto-review or a rule says so.
 */

export const ALWAYS_ASKS =
<<<<<<< e3fb3519d1f6fe6b7f19b13cdfab1ee99530d1c9
  "员工在你的应用或网站上删除、发送、分享或发布内容之前，总会先征得你的同意。";

export const HANDED_TO_YOU = "付款和账号安全设置的改动，员工会留给你亲自处理。";
=======
  "Bots ask for your approval before deleting, sending, sharing, posting, or paying in your apps or on websites. You can allow each one once, for a conversation, or always.";

export const HANDED_TO_YOU =
  "Bots leave changing a password on a website for you to do yourself.";
>>>>>>> 776dcffce8776bcc9c2d17de3c5132451d0d868d

export const ASK_FIRST_TITLE = "做任何改动前都先问我";

export const ASK_FIRST_DESCRIPTION =
  "对你的应用、网站和文件的每一处改动都要先经你同意，日常的编辑和更新也不例外。";
