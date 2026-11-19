/**
 * 给一次厂商调用设期限（上游 vendor-deadline.ts，fork X5 移植）。
 *
 * 到期时既中止请求（把 signal 交给 SDK，让放弃真正到达网络），也让等待的一方拿到拒绝。
 * 一个人的浏览器在等这次回答时，不能被厂商挂住；轮询次数限不住每次调用本身没有上限。
 */
class VendorTimeoutError extends Error {
  constructor(afterMs: number) {
    super(`The broker did not answer within ${afterMs}ms.`);
    this.name = "VendorTimeoutError";
  }
}

const VENDOR_CALL_TIMEOUT_MS = 10_000;

export function withVendorDeadline<T>(
  call: (signal: AbortSignal) => Promise<T>,
  afterMs: number = VENDOR_CALL_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new VendorTimeoutError(afterMs));
    }, afterMs);
  });
  const answer = new Promise<T>((resolve) => resolve(call(controller.signal)));
  return Promise.race([answer, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
