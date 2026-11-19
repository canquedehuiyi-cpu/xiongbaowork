/**
 * 起草时被改对象的版本。执行时重新算一遍，对不上就说明草稿起草之后对象被别人改过，不能照旧执行。
 */

/** 员工的版本就是资料最后更新的时刻。 */
export function versionOfEmployee(profile: { updatedAt: Date }): string {
  return profile.updatedAt.toISOString();
}

/**
 * 群聊没有更新时间可用，改名和成员顺序都算「被改过」，所以两者一起编码；
 * 用数组而不是对象，键的顺序就不会影响结果。
 */
export function versionOfGroup(group: {
  name: string;
  order: readonly string[];
}): string {
  return JSON.stringify([group.name, [...group.order]]);
}
