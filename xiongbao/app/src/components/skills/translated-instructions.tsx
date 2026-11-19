import { useZh } from "@/lib/translations/queries";

/**
 * A skill's instructions in Chinese, for reading, when they were written in English and a translation
 * exists. Folded, under the field, because the field above keeps the original: that is what the
 * skill gives a model and what an edit changes, and a translation saved over it would quietly change
 * how the skill behaves.
 */
export function TranslatedInstructions({ text }: { text: string }) {
  const zh = useZh();
  const translated = zh(text);
  if (!text.trim() || translated === text) return null;
  return (
    <details
      className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
      data-slot="translated-instructions"
    >
      <summary className="cursor-pointer select-none text-muted-foreground">
        中文说明（自动翻译，仅供阅读；生效的是上面的原文）
      </summary>
      <p className="mt-2 whitespace-pre-wrap leading-relaxed">{translated}</p>
    </details>
  );
}
