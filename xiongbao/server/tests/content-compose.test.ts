import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("the content port is published", () => {
  test("docker-compose.yml sets XIONGBAO_CONTENT_PORT and maps 3773 on loopback", () => {
    const compose = read("docker-compose.yml");
    expect(compose).toContain('XIONGBAO_CONTENT_PORT: "3773"');
    const mappings = [...compose.matchAll(/^\s*- "([^"\n]*):3773"/gm)].map(
      (match) => match[1],
    );
    expect(mappings.length).toBeGreaterThanOrEqual(1);
    for (const mapping of mappings) {
      expect(
        mapping?.startsWith("127.0.0.1:") || mapping?.startsWith("[::1]:"),
      ).toBe(true);
    }
  });

  test("the delivery compose maps 3773, loopback unless the deployment says otherwise", () => {
    const compose = read("docker/compose.delivery.yml");
    expect(compose).toMatch(
      /XIONGBAO_CONTENT_BIND:-127\.0\.0\.1\}:\$\{XIONGBAO_CONTENT_HOST_PORT:-3773\}:3773"/,
    );
  });

  test("both compose files name the host port the same way", () => {
    for (const file of ["docker-compose.yml", "docker/compose.delivery.yml"]) {
      expect(read(file)).toContain("XIONGBAO_CONTENT_HOST_PORT:-3773");
    }
  });

  test("the Dockerfile exposes 3773", () => {
    expect(read("Dockerfile")).toMatch(/^EXPOSE 3773$/m);
  });

  test("the deployment manual tells the operator to open the security group and map 3773", () => {
    const manual = read("docs/deployment-xiongbao.md");
    expect(manual).toContain("安全组");
    expect(manual).toContain("3773");
    expect(manual).toContain("XIONGBAO_CONTENT_PORT=3773");
    expect(manual).toContain("XIONGBAO_CONTENT_DOMAIN");
    expect(manual).toContain("泛域名解析");
    expect(manual).toContain("泛域名证书");
    expect(manual).toContain("proxy_set_header Host $host");
    expect(manual).toContain("HSTS");
    expect(manual).toContain("access_log off");
    expect(manual).toContain("约 1 分钟");
  });

  test("the configuration reference and the changelog describe the content origin", () => {
    const configuration = read("docs/configuration.md");
    expect(configuration).toContain("XIONGBAO_CONTENT_PORT");
    expect(configuration).toContain("XIONGBAO_CONTENT_DOMAIN");
    expect(read("CHANGELOG.md")).toContain("XIONGBAO_CONTENT_PORT");
  });
});
