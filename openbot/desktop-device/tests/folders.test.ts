/**
 * The 本地文件夹 section's rules (ui/folders.js), without a window: what the form accepts, what it
 * says when it does not, what is handed to the shell's `add_root` and `remove_root` commands, and
 * what the list shows.
 */
import { expect, test } from "bun:test";
import {
  addFolder,
  describeFolders,
  isAbsolutePath,
  removeFolder,
  validateFolder,
} from "../ui/folders.js";

test("a filled-in form is tidied and passed on, on either system", () => {
  expect(
    validateFolder({
      name: " 工作资料 ",
      path: " /Users/me/Documents/工作资料 ",
    }),
  ).toEqual({
    ok: true,
    value: { name: "工作资料", path: "/Users/me/Documents/工作资料" },
  });
  expect(validateFolder({ name: "合同", path: "D:\\合同" })).toMatchObject({
    ok: true,
  });
  expect(isAbsolutePath("\\\\nas\\share")).toBeTrue();
  expect(isAbsolutePath("Documents/工作资料")).toBeFalse();
});

test("each field says what is wrong with it, in Chinese", () => {
  expect(validateFolder({ name: "  ", path: "/tmp" })).toEqual({
    ok: false,
    field: "name",
    error: "请给这个文件夹起个名字。",
  });
  expect(validateFolder({ name: "名".repeat(61), path: "/tmp" })).toMatchObject(
    {
      field: "name",
      error: "名称最多 60 个字。",
    },
  );
  expect(validateFolder({ name: "a=b", path: "/tmp" })).toMatchObject({
    field: "name",
  });
  expect(validateFolder({ name: "周报", path: "" })).toMatchObject({
    field: "path",
    error: "请填写文件夹的路径。",
  });
  expect(validateFolder({ name: "周报", path: "文档/周报" })).toMatchObject({
    field: "path",
    error: "请填写文件夹的完整路径（绝对路径）。",
  });
});

test("adding hands the checked form to add_root and returns the folders after it, or the refusal", async () => {
  const sent: Array<[string, unknown]> = [];
  const roots = [
    {
      ref: "fld_AAAAAAAAAAAAAAAAAAAAAA",
      name: "工作资料",
      path: "/Users/me/工作资料",
    },
  ];
  const invoke = async (command: string, args?: Record<string, unknown>) => {
    sent.push([command, args]);
    return roots;
  };
  expect(
    await addFolder({ name: " 工作资料", path: "/Users/me/工作资料 " }, invoke),
  ).toEqual({ roots });
  expect(sent).toEqual([
    ["add_root", { name: "工作资料", path: "/Users/me/工作资料" }],
  ]);

  // A form the window can already refuse starts nothing.
  expect(await addFolder({ name: "", path: "/x" }, invoke)).toEqual({
    error: "请给这个文件夹起个名字。",
  });
  expect(sent).toHaveLength(1);

  // The runner's refusal (for example, a folder over its own data directory) is shown as it is.
  const refused = async () => {
    throw "这个文件夹包含或位于设备端自己的数据目录（里面有设备令牌和浏览器登录状态），不能添加。";
  };
  expect(await addFolder({ name: "数据", path: "/Users/me" }, refused)).toEqual(
    {
      error:
        "这个文件夹包含或位于设备端自己的数据目录（里面有设备令牌和浏览器登录状态），不能添加。",
    },
  );
});

test("removing names the folder by its reference", async () => {
  const sent: Array<[string, unknown]> = [];
  const result = await removeFolder(
    "fld_AAAAAAAAAAAAAAAAAAAAAA",
    async (command, args) => {
      sent.push([command, args]);
      return [];
    },
  );
  expect(result).toEqual({ roots: [] });
  expect(sent).toEqual([
    ["remove_root", { reference: "fld_AAAAAAAAAAAAAAAAAAAAAA" }],
  ]);
});

test("the list shows each folder with its place on this computer, and says when there are none", () => {
  expect(describeFolders([])).toEqual({
    empty: "还没有添加本地文件夹。",
    items: [],
  });
  expect(
    describeFolders([
      {
        ref: "fld_AAAAAAAAAAAAAAAAAAAAAA",
        name: "工作资料",
        path: "/Users/me/工作资料",
      },
    ]),
  ).toEqual({
    empty: null,
    items: [
      {
        ref: "fld_AAAAAAAAAAAAAAAAAAAAAA",
        name: "工作资料",
        path: "/Users/me/工作资料",
        remove: "移除 工作资料",
      },
    ],
  });
});
