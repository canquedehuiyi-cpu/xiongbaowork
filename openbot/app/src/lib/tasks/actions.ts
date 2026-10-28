import { client } from "../client";

export type TaskAction = { id: string; verb: "review" | "archive" };

/** Reject HTTP refusals; leave transport failures unknown, without retrying writes. */
export function taskAction({ id, verb }: TaskAction): Promise<Response> {
  return client(`/api/tasks/${encodeURIComponent(id)}/${verb}`, {
    method: "POST",
    fallback:
      verb === "review" ? "查收失败，请稍后重试。" : "归档失败，请稍后重试。",
  });
}
