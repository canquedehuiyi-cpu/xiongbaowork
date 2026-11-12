/*
 * 团队的桌面逐次审批敏感词表：员工在配对的电脑上点击名字含这些词的控件时，每次都要人批准。
 * 存在已有的团队审批设置那一行上，沿用这张表的行级安全策略，不加表、不改策略。
 * 可空，不加默认值：NULL 表示用默认表（shared/desktop-control.ts 的 DEFAULT_DESKTOP_ACTION_WORDS），
 * 所以从没存过词表的团队跟着默认表走，默认表以后改了也能到。写入前的规范化在 approvals/store.ts。
 */
ALTER TABLE "approval_team_settings" ADD COLUMN "desktop_action_words" text[];
