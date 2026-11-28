/**
 * 每个键恰好对应一个可写控制；控制上写 `data-setting-key={key}`，只读行不带。
 *
 * 键名规则：写哪份数据就叫什么——审批偏好 `approvals.*`、团队审批 `approvals.team.*`、
 * 能力开关 `capability.<id>`、企业设置 `enterprise.<EnterpriseSettings 的键>`、
 * 网络策略 `network.policy.*`。
 *
 * 后续 PR 把自己搬进来的设置键追加到这里；`tests/settings-render-once.test.tsx` 逐受众检查
 * 它们在所有话题页里恰好出现一次，`tests/settings-single-writer.test.ts` 检查写它们的
 * mutation 只被一个组件文件引用。
 */
export const SETTING_KEYS: readonly string[] = [
  "account.name",
  "account.instructions",
  "appearance.theme",
  "appearance.skin",
  "appearance.messageList",
  "network.policy.organization",
  "enterprise.inactiveComputerDays",
];
