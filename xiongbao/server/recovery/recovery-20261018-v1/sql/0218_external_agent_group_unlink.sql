/*
 * 外部员工的招聘人可以把它移出群组（外部员工设计第 6 节：只有招聘人能把它拉进或移出群组，群主也不行）。
 *
 * - 目的：0128 起 `channel_agents` 的删除只给群主（`team_write_delete`）。外部员工（`device_acp`）永远是
 *   招聘人私有的，只有招聘人自己能把它链进群（0128 的插入策略：本人私有的员工）；招聘人不是群主时，
 *   原策略让他移不出去。本迁移在群主之外再放行一种删除：群成员删的是**自己私有的外部员工**那一行
 *   （`agents.tenant_id` 等于本帧租户、类型是 `device_acp`）。别人的员工、普通员工照旧只有群主能删。
 * - 「群主也不行」由应用层（`channels/group.ts` 的 `removeBots`）拒绝：群主的帧看不到别人私有员工的
 *   `agents` 行，数据库层无从分辨。
 * - 类型比较写成 `a.type::text = 'device_acp'`：不把字面量转成枚举，所以和 0215 加枚举值同一批执行也安全。
 * - 授权：不新增对象，只改策略。
 *
 * 回滚：把 `team_write_delete` 改回 0128 的写法
 *   `USING (tenant_id = 'team' AND public.openbot_team_channel_creator(channel_id))`。
 */
ALTER POLICY team_write_delete ON public.channel_agents
  USING (tenant_id = 'team'
         AND (public.openbot_team_channel_creator(channel_id)
              OR (public.openbot_team_channel_member(channel_id)
                  AND EXISTS (SELECT 1 FROM public.agents a
                               WHERE a.id = channel_agents.agent_id
                                 AND a.tenant_id = current_setting('app.tenant_id', true)
                                 AND a.type::text = 'device_acp'))));
