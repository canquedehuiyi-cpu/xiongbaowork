/**
 * 运行前自检：当前网络命名空间里是不是只剩回环网卡。
 *
 * Firecrawl 渲染脚本页时拉起的 Chrome 会自己联网（后台请求不受 FIRECRAWL_CLOUD=off 管），所以对比脚本
 * 在碰 Firecrawl 之前必须确认外网不通；做法是由 `isolated.sh` 建一个只有 lo 的命名空间。
 */
import { readFileSync } from "node:fs";

/** 网卡名列表里有回环、且除它之外什么都没有。 */
export function onlyLoopback(interfaces: string[]): boolean {
  return interfaces.includes("lo") && interfaces.every((name) => name === "lo");
}

/**
 * 当前网络命名空间的网卡名。读 /proc/net/dev 而不是 /sys/class/net：后者是挂载时那个命名空间的视图，
 * 新建命名空间后不重新挂载就还是宿主的网卡。
 */
export function listInterfaces(): string[] {
  return readFileSync("/proc/net/dev", "utf8")
    .split("\n")
    .slice(2)
    .map((line) => line.split(":")[0]?.trim() ?? "")
    .filter((name) => name !== "");
}
