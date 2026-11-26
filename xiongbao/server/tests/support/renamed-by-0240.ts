/**
 * A historical migration's SQL as it has to run against a database after migration 0240.
 *
 * 0240 renamed the application roles and the team helpers; migrations before it spell the old names,
 * and their files are frozen byte for byte. A test that replays one of them on the shared, fully
 * migrated test database (to put a table back the way the migration found it) replays it under the
 * names that database carries now.
 *
 * legacy-compat：introducedIn 0.2.16，removeIn 0.2.17，the R4 baseline replaces the historical migrations
 */
export function renamedBy0240(text: string): string {
  return text
    .replaceAll("openbot_role_writer", "xiongbao_role_writer")
    .replaceAll("openbot_app", "xiongbao_app")
    .replaceAll("openbot_team_", "xiongbao_team_")
    .replaceAll("openbot_flow_share_", "xiongbao_flow_share_")
    .replaceAll("openbot_grant_stamp_guard", "xiongbao_grant_stamp_guard")
    .replaceAll("openbot_mcp_tool_stamp_guard", "xiongbao_mcp_tool_stamp_guard")
    .replaceAll(
      "openbot_channel_waker_group_link",
      "xiongbao_channel_waker_group_link",
    )
    .replaceAll("openbot_waker_group_absent", "xiongbao_waker_group_absent");
}
