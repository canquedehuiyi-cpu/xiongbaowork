/**
 * 包声明的 user-oauth 连接器的处置（Codex 审查意见 #499 之 513，用户裁决：现在就修）。
 *
 * 纯函数级测试，不连数据库。平台为连接器提供逐用户 OAuth 的前提是本构建目录里有该连接器的
 * 条目（OAuth client、授权端点、scope 都在目录里；store.ts 的 client 注册与逐用户连接均按
 * 目录条目设闸）。因此一个声明了 `auth: user-oauth` 的连接器，若本构建没有它的目录项，
 * 同步必须拒绝加载——绝不把它静默注册成共享凭据的 custom 服务器，让不同用户的调用打到
 * 同一个账号上。
 */
import { describe, expect, test } from "bun:test";

import {
  unsupportedPerUserConnectors,
  type PackageConnector,
} from "../src/tenant-package-capabilities";

const connector = (overrides: Partial<PackageConnector> = {}): PackageConnector => ({
  id: "tencent-docs",
  title: "腾讯文档",
  vendor: "Tencent",
  url: "https://docs.qq.com/mcp/",
  host: "docs.qq.com",
  auth: "user-oauth",
  credentialEnv: null,
  docsUrl: null,
  ...overrides,
});

describe("unsupportedPerUserConnectors", () => {
  test("user-oauth 且本构建目录没有该连接器：被标记（默认用真实目录查）", () => {
    // tencent-docs 不在本构建目录里（实测 catalogueEntry 返回 null）。
    expect(unsupportedPerUserConnectors([connector({ id: "tencent-docs" })])).toEqual(["tencent-docs"]);
  });

  test("user-oauth 但目录里有条目：不标记，逐用户 OAuth 由目录条目承接", () => {
    // github 在本构建目录里且 auth 为 user-oauth（实测）。
    expect(unsupportedPerUserConnectors([connector({ id: "github" })])).toEqual([]);
  });

  test("deployment-bearer 与 none 不受影响：共享本来就是声明的一部分", () => {
    expect(
      unsupportedPerUserConnectors([
        connector({ id: "no-entry-bearer", auth: "deployment-bearer", credentialEnv: "SOME_TOKEN" }),
        connector({ id: "no-entry-none", auth: "none" }),
      ]),
    ).toEqual([]);
  });

  test("注入的目录判定函数按声明顺序返回全部未支持的 id", () => {
    const connectors = [
      connector({ id: "a-user", auth: "user-oauth" }),
      connector({ id: "b-bearer", auth: "deployment-bearer" }),
      connector({ id: "c-user", auth: "user-oauth" }),
      connector({ id: "d-user-known", auth: "user-oauth" }),
    ];
    const known = new Set(["d-user-known"]);
    const flagged = unsupportedPerUserConnectors(connectors, (id) => known.has(id));
    expect(flagged).toEqual(["a-user", "c-user"]);
  });
});
