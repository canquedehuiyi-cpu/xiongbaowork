/**
 * 员工的 Git 工作流四个工具（期 4 · Task 4.2）：`git_branch`、`git_commit`、`git_diff_summary`、
 * `open_pull_request`。
 *
 * 前三个在员工自己的工作区里跑 git（经电脑网关，和 `computer_run_command` 同一套审批和底线）；
 * 第四个把请求交给员工已经接入的 GitHub 一类连接器，没有连接器就说明请本人接入。服务器上的实现在
 * `server/src/computer/git-tools.ts`，对话按这些名字给步骤起中文名（`tool-name.ts`）。
 *
 * 权限名都是 `bot/<名字>`，员工的工具权限里可以逐个拒绝。
 */

export const GIT_BRANCH_TOOL = "git_branch";
export const GIT_COMMIT_TOOL = "git_commit";
export const GIT_DIFF_SUMMARY_TOOL = "git_diff_summary";
export const OPEN_PULL_REQUEST_TOOL = "open_pull_request";

/** 在工作区里跑 git 的三个（审批照电脑命令走）。 */
export const GIT_LOCAL_TOOLS: readonly string[] = [
  GIT_BRANCH_TOOL,
  GIT_COMMIT_TOOL,
  GIT_DIFF_SUMMARY_TOOL,
];

/** 四个都算，排在 `search_tools` 后面按需检索的就是这一批。 */
export const GIT_TOOLS: readonly string[] = [
  ...GIT_LOCAL_TOOLS,
  OPEN_PULL_REQUEST_TOOL,
];

/** `git_diff_summary` 带上的 diff 文字：默认与上限（字符数）。 */
export const GIT_DIFF_LIMITS = { default: 6_000, most: 30_000 } as const;

/** 一次提交最多带几个路径，每个文件最多检查多少字节。再大的请员工分批提交。 */
export const GIT_COMMIT_LIMITS = { paths: 50, fileBytes: 256 * 1024 } as const;
