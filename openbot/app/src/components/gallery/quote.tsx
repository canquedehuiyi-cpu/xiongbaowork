import { z } from "zod";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { GalleryFrame } from "./frame";
import { GalleryMarkdown } from "./markdown";

export const QuoteCardProps = z.object({
  quote: z
    .string()
    .describe("The quotation itself, without surrounding quote marks"),
  attribution: z
    .string()
    .describe(
      "Who said or wrote it, e.g. 'Grace Hopper' or 'the 2026 annual report'",
    ),
  context: z
    .string()
    .optional()
    .describe(
      "One short line of context: where it is from, or why it matters here",
    ),
});

type QuoteArgs = z.infer<typeof QuoteCardProps>;

export function QuoteCard({ quote, attribution, context }: Partial<QuoteArgs>) {
  if (!quote) {
    return (
      <GalleryFrame title="引用">
        <p className="text-sm text-muted-foreground">没有可引用的内容。</p>
      </GalleryFrame>
    );
  }

  return (
    <GalleryFrame caption={context} title="引用">
      <blockquote className="border-l-2 border-border pl-4">
        <GalleryMarkdown className="text-sm leading-relaxed">
          {quote}
        </GalleryMarkdown>
        {attribution ? (
          <footer className="mt-2 text-xs text-muted-foreground">
            {attribution}
          </footer>
        ) : null}
      </blockquote>
    </GalleryFrame>
  );
}

export const GALLERY: GalleryComponent[] = [
  {
    name: "showQuote",
    title: "Quotation",
    kind: "card",
<<<<<<< 4abbcd6a3db206b598d2fc6a41298762a4ebb371
    summary: "显示一段引文，以及是谁说的或写的。",
=======
    summary: "Shows a quotation and who said or wrote it.",
>>>>>>> 799267df33f0e0c0e4c049d98453d9b95a74167b
    description:
      "Show a quotation with its attribution. Use when the exact words matter, something a person said, or a line from a document you were given.",
    parameters: QuoteCardProps,
    Component: QuoteCard as GalleryComponent["Component"],
    preview: {
      quote:
        "75 元以下的餐费不需要发票，超过的需要；超过 500 元要先经过你的经理同意再花。",
      attribution: "报销制度",
      context: "三月最后一次修改。",
    },
    confirmation: "The quotation is now on screen for the person.",
  },
];
