import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";

/**
 * 服务器对 toolkit 只能用包名导入（`@xiongbao/toolkit/*`），不能用相对路径（`../../../toolkit/src/*`）。
 *
 * 镜像用 `bun build --packages=external` 打包服务器：包名导入留在包外，相对路径导入被内联进包里。两种写法
 * 混用时，同一个 toolkit 模块在线上就有两份：两份 AsyncLocalStorage（审批拿不到对话，见
 * `bundled-approval-context.test.ts`），两份错误类（`instanceof HeadlessToolSuspension` 认不出另一份抛的）。
 * 测试直接跑源码，两种写法落到同一个文件，看不出区别，所以在这里按写法拦住。
 */

const SERVER = join(import.meta.dir, "..");
const RELATIVE_TOOLKIT = /from\s+["'](?:\.\.\/)+toolkit\/src\//;

describe("server imports toolkit by package name", () => {
  test("no file under server/src or server/scripts imports toolkit by a relative path", async () => {
    const offenders: string[] = [];
    for (const root of ["src", "scripts"]) {
      for await (const path of new Glob("**/*.{ts,tsx}").scan({
        cwd: join(SERVER, root),
      })) {
        const text = await Bun.file(join(SERVER, root, path)).text();
        if (RELATIVE_TOOLKIT.test(text)) offenders.push(`${root}/${path}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
