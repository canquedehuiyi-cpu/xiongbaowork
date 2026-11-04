/**
 * The 本地文件夹 section's rules (ui/folders.js), without a window: what the form accepts, what it
 * says when it does not, what is handed to the shell's `add_root` and `remove_root` commands
 * (including the folder's mode, read only unless the write box is ticked), and what the list shows.
 */
import { expect, test } from "bun:test";
import {
  addFolder,
  describeFolders,
  isAbsolutePath,
  modeFor,
  modeLabel,
  removeFolder,
  validateFolder,
  WRITE_WARNING,
} from "../ui/folders.js";

test("a filled-in form is tidied and passed on, on either system", () => {
  expect(
    validateFolder({
      name: " 工作资料 ",
      path: " /Users/me/Documents/工作资料 ",
    }),
  ).toEqual({
    ok: true,
    value: {
      name: "工作资料",
      path: "/Users/me/Documents/工作资料",
      mode: "read",
    },
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
    [
      "add_root",
      { name: "工作资料", path: "/Users/me/工作资料", mode: "read" },
    ],
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

test("a folder is read only unless the write box is ticked, and then it is sent as write", async () => {
  expect(modeFor(undefined)).toBe("read");
  expect(modeFor(false)).toBe("read");
  expect(modeFor(true)).toBe("write");
  // Only a real tick counts: a truthy value that is not `true` stays read only.
  expect(modeFor("true" as unknown as boolean)).toBe("read");

  expect(
    validateFolder({
      name: "后端",
      path: "/Users/me/code/backend",
      write: true,
    }),
  ).toEqual({
    ok: true,
    value: { name: "后端", path: "/Users/me/code/backend", mode: "write" },
  });
  expect(
    validateFolder({
      name: "后端",
      path: "/Users/me/code/backend",
      write: false,
    }),
  ).toMatchObject({ value: { mode: "read" } });

  const sent: Array<[string, unknown]> = [];
  const invoke = async (command: string, args?: Record<string, unknown>) => {
    sent.push([command, args]);
    return [];
  };
  await addFolder(
    { name: "后端", path: "/Users/me/code/backend", write: true },
    invoke,
  );
  await addFolder({ name: "周报", path: "/Users/me/周报" }, invoke);
  expect(sent).toEqual([
    [
      "add_root",
      { name: "后端", path: "/Users/me/code/backend", mode: "write" },
    ],
    ["add_root", { name: "周报", path: "/Users/me/周报", mode: "read" }],
  ]);

  // The warning shown while the box is ticked says what writing allows, in Chinese.
  expect(WRITE_WARNING).toContain("修改");
  expect(WRITE_WARNING).toContain("运行命令");
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
        mode: "只读",
        writable: false,
        remove: "移除 工作资料",
      },
    ],
  });
});

test("the list says which folders are read only and which are writable", () => {
  expect(modeLabel(undefined)).toBe("只读");
  expect(modeLabel("read")).toBe("只读");
  expect(modeLabel("write")).toBe("可写");
  // Anything the window does not know is shown as what the runner treats it as: read only.
  expect(modeLabel("admin")).toBe("只读");
  expect(
    describeFolders([
      {
        ref: "fld_AAAAAAAAAAAAAAAAAAAAAA",
        name: "周报",
        path: "/a",
        mode: "read",
      },
      {
        ref: "fld_BBBBBBBBBBBBBBBBBBBBBB",
        name: "后端",
        path: "/b",
        mode: "write",
      },
    ]).items.map(({ name, mode, writable }) => ({ name, mode, writable })),
  ).toEqual([
    { name: "周报", mode: "只读", writable: false },
    { name: "后端", mode: "可写", writable: true },
  ]);
});
