import { expect, test } from "bun:test";
import {
  CHECK_VIDEO_TOOL,
  DOCUMENTS_GUIDANCE,
  GENERATE_IMAGE_TOOL,
  GENERATE_VIDEO_TOOL,
  mediaGuidance,
  mediaIdOf,
  mediaUrl,
} from "./media";
import { UPDATE_PLAN_TOOL } from "./plan";
import { readToolName } from "./tool-name";

const id = "0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

test("a saved file's address, and the id read back from it", () => {
  expect(mediaUrl(id)).toBe(`/api/media/${id}`);
  expect(mediaIdOf(`/api/media/${id}`)).toBe(id);
  expect(
    mediaIdOf(`https://xiongbao.example/api/media/${id.toUpperCase()}`),
  ).toBe(id);
  expect(mediaIdOf(`/api/media/${id}?download=1`)).toBe(id);
  expect(mediaIdOf("/api/media/not-an-id")).toBeUndefined();
  expect(mediaIdOf(`/api/attachments/${id}`)).toBeUndefined();
  expect(mediaIdOf(`https://cdn.example/${id}.png`)).toBeUndefined();
});

test("nothing is said to a Bot that holds neither the media tools nor the computer", () => {
  expect(mediaGuidance([], { computer: false })).toBeUndefined();
  expect(
    mediaGuidance([UPDATE_PLAN_TOOL], { computer: false }),
  ).toBeUndefined();
});

test("the media words name only the tools the Bot holds", () => {
  const image = mediaGuidance([GENERATE_IMAGE_TOOL], { computer: false }) ?? "";
  expect(image).toContain(GENERATE_IMAGE_TOOL);
  expect(image).not.toContain(GENERATE_VIDEO_TOOL);
  expect(image).toContain("![说明](地址)");
  expect(image).not.toContain(DOCUMENTS_GUIDANCE);

  const video =
    mediaGuidance([GENERATE_VIDEO_TOOL, CHECK_VIDEO_TOOL], {
      computer: false,
    }) ?? "";
  expect(video).toContain(GENERATE_VIDEO_TOOL);
  expect(video).toContain(CHECK_VIDEO_TOOL);
  expect(video).not.toContain(`用 ${GENERATE_IMAGE_TOOL} 生成`);
});

test("a Bot with the computer is told how to make and check documents, and to read files with markitdown", () => {
  const said = mediaGuidance([], { computer: true }) ?? "";
  expect(said).toBe(DOCUMENTS_GUIDANCE);
  for (const library of [
    "python-docx",
    "openpyxl",
    "python-pptx",
    "weasyprint",
    "reportlab",
    "pandoc",
  ])
    expect(said).toContain(library);
  expect(said).toContain("生成后一定打开校验");
  expect(said).toContain("`markitdown <文件>`");
  // Both: the media words first, then the documents.
  const both = mediaGuidance([GENERATE_IMAGE_TOOL], { computer: true }) ?? "";
  expect(both.indexOf(GENERATE_IMAGE_TOOL)).toBeLessThan(
    both.indexOf("python-docx"),
  );
});

test("the transcript names each call in words", () => {
  expect(readToolName(GENERATE_IMAGE_TOOL, true).label).toBe("正在生成图片");
  expect(readToolName(GENERATE_IMAGE_TOOL).label).toBe("生成了图片");
  expect(readToolName(GENERATE_VIDEO_TOOL, true).label).toBe("正在生成视频");
  expect(readToolName(CHECK_VIDEO_TOOL, true).label).toBe("正在取视频");
});

test("a Bot holding the image tool is told where the picture lands on its computer, and to use that path in documents", () => {
  for (const computer of [false, true]) {
    const said = mediaGuidance([GENERATE_IMAGE_TOOL], { computer }) ?? "";
    expect(said).toContain("generated/");
    expect(said).toContain(`${GENERATE_IMAGE_TOOL} 的结果里`);
    expect(said).toContain("python-pptx");
    expect(said).toContain("不要去下载它");
  }
});

test("a video alone is never written to the computer, and the words say so; without the tools nothing changes", () => {
  const video = mediaGuidance([GENERATE_VIDEO_TOOL], { computer: true }) ?? "";
  expect(video).not.toContain("generated/");
  expect(video).toContain("不会放进电脑工作区");
  expect(mediaGuidance([], { computer: false })).toBeUndefined();
  expect(mediaGuidance([], { computer: true })).toBe(DOCUMENTS_GUIDANCE);
});
