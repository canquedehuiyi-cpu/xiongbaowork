import { describe, expect, test } from "bun:test";
import {
  catalogueEntry,
  checkInRead,
  classifyTool,
  reviewedRead,
} from "../src/plugins/catalogue";

/**
 * GitHub 的只读名单。
 *
 * 来源是 GitHub 官方 github-mcp-server 仓库里每个工具的元数据快照
 * （pkg/github/__toolsnaps__/*.snap，提交 6fbcd00b，2026-11-09）：注解为 readOnlyHint: true 的工具名，
 * 一个不多一个不少，只去掉了 secret scanning 的两个工具（告警内容就是泄露的密钥，读出来等于读凭据，
 * 和例行任务不给 list_triggers 同一个理由）。
 *
 * 有了名单以后：
 * - 无人值守的 check-in 可以调用名单里的工具；
 * - 聊天里，名单外的名字一律按写处理（只收紧）；
 * - 写名单仍然优先。
 */
const GITHUB_READS: readonly string[] = [
  "actions_get",
  "actions_list",
  "custom_properties_read",
  "find_duplicate",
  "get_code_quality_finding",
  "get_code_scanning_alert",
  "get_commit",
  "get_dependabot_alert",
  "get_discussion",
  "get_discussion_comments",
  "get_file_blame",
  "get_file_contents",
  "get_gist",
  "get_global_security_advisory",
  "get_job_logs",
  "get_label",
  "get_latest_release",
  "get_me",
  "get_notification_details",
  "get_release_by_tag",
  "get_repository_tree",
  "get_tag",
  "get_team_members",
  "get_teams",
  "issue_artifact_read",
  "issue_dependency_read",
  "issue_read",
  "list_branches",
  "list_code_scanning_alerts",
  "list_commits",
  "list_dependabot_alerts",
  "list_discussion_categories",
  "list_discussions",
  "list_gists",
  "list_global_security_advisories",
  "list_issue_fields",
  "list_issue_types",
  "list_issues",
  "list_label",
  "list_notifications",
  "list_org_repository_security_advisories",
  "list_pull_requests",
  "list_releases",
  "list_repository_collaborators",
  "list_repository_security_advisories",
  "list_starred_repositories",
  "list_tags",
  "projects_get",
  "projects_list",
  "pull_request_read",
  "repository_ruleset_read",
  "search_code",
  "search_commits",
  "search_issues",
  "search_orgs",
  "search_pull_requests",
  "search_repositories",
  "search_users",
  "ui_get",
];

const silent = { effect: null, destructive: false, unclassified: false };

describe("GitHub 的只读名单", () => {
  const github = catalogueEntry("github");

  test("名单与 GitHub 官方工具元数据里的只读工具一致", () => {
    expect([...(github?.readTools ?? [])].sort()).toEqual(
      [...GITHUB_READS].sort(),
    );
    expect(Object.isFrozen(github?.readTools)).toBe(true);
    for (const name of GITHUB_READS)
      expect(github?.writeTools).not.toContain(name);
  });

  test("名单里的工具，check-in 可以当读调用", () => {
    for (const name of [
      "list_issues",
      "search_code",
      "pull_request_read",
      "get_file_contents",
    ]) {
      expect(reviewedRead(github, name, { destructive: false })).toBe(true);
      expect(checkInRead(github, name, silent)).toBe(true);
      expect(classifyTool(github, name, true)).toBe("read");
    }
  });

  test("secret scanning 的两个工具不进名单：check-in 不能读，聊天里按写来问", () => {
    for (const name of [
      "get_secret_scanning_alert",
      "list_secret_scanning_alerts",
    ]) {
      expect(github?.readTools).not.toContain(name);
      expect(checkInRead(github, name, silent)).toBe(false);
      expect(classifyTool(github, name, true)).toBe("write");
    }
  });

  test("名单外新出现的名字在聊天里按写处理，check-in 也不能用", () => {
    expect(classifyTool(github, "some_new_tool", true)).toBe("write");
    expect(checkInRead(github, "some_new_tool", silent)).toBe(false);
  });

  test("写名单里的工具照旧是写", () => {
    for (const name of ["create_issue", "merge_pull_request", "push_files"]) {
      expect(classifyTool(github, name, true)).toBe("write");
      expect(checkInRead(github, name, silent)).toBe(false);
    }
  });

  test("破坏性标记仍然优先于名单", () => {
    expect(
      checkInRead(github, "list_issues", { ...silent, destructive: true }),
    ).toBe(false);
  });
});
