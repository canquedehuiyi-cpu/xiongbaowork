/*
 * 对话里跟在消息下面的卡，谁先出现：外部员工的卡（`acp-events.ts`）和交付闭环的卡（`tasks/delivery-chat.ts`）
 * 从同一条事件流里各自记下来，画在同一行下面时要按事件流里的先后排（`ChatTranscript` 的 `notes`）。两边在
 * 收到事件的那一刻（同步地）各取一个号，号只增不减，所以号的大小就是先后。
 */
let last = 0;

/** 下一个号：比之前给出的都大。 */
export function nextNoteOrder(): number {
  last += 1;
  return last;
}
