"""员工电脑的文档环境自检：真的生成一份 docx、xlsx、pptx、pdf（都带中文），再打开读回来。

镜像构建时跑一次（Dockerfile、agent-computer/Dockerfile），CI 的 image job 再以员工用户跑一次。
任何一项不过就以非零退出，构建失败，不会把一个「装了库却出不了中文」的镜像发出去。

每一项都是员工真会走的路：python-docx 写 Word，openpyxl 写带公式的 Excel，python-pptx 写 PPT，
weasyprint 把 HTML 排成 PDF，reportlab 直接画 PDF，markitdown 把 Office 文件转成文字来读，
pandoc 做 markdown 与 Word 互转，LibreOffice（只在单镜像里）把 Word 转成 PDF。中文是重点：
没有中文字体时 PDF 和 PPT 里的中文是方块，所以 PDF 两项都要读回原文，且字体要嵌进文件。

用法：python3 selfcheck.py [--out 目录] [--require-pandoc] [--require-soffice]
不加 --require-* 时，机器上没有 pandoc 或 soffice 就跳过那一项（agent-computer 镜像不装 LibreOffice）。
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TEXT = "熊宝文档自检：中文正文可以正常显示。"
TITLE = "季度汇报"

results: list[tuple[str, bool, str]] = []


def report(name: str, ok: bool, detail: str) -> bool:
    """记下一项并立刻打印：后面哪一项把进程弄崩了，前面的结论也已经在输出里。"""
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)
    return ok


def check(name: str):
    def wrap(fn):
        def run(*args, **kwargs) -> bool:
            try:
                return report(name, True, fn(*args, **kwargs) or "")
            except Exception as error:  # noqa: BLE001 — 每一项的失败都要报出来，不让一项拖垮全部
                return report(name, False, f"{type(error).__name__}: {error}")

        return run

    return wrap


def fc_list(pattern: str, fmt: str) -> list[str]:
    output = subprocess.run(
        ["fc-list", "-f", fmt, pattern], capture_output=True, text=True, timeout=30
    ).stdout
    return [line.strip() for line in output.splitlines() if line.strip()]


@check("cjk-font")
def cjk_font() -> str:
    families = fc_list(":lang=zh", "%{family}\n")
    if not families:
        raise AssertionError("fontconfig 里没有能显示中文的字体（fc-list :lang=zh 为空）")
    return families[0].split(",")[0]


def truetype_cjk_font() -> str:
    """reportlab 只能嵌 TrueType 轮廓的字体；Noto CJK 是 CFF 轮廓，所以另找一个 TrueType 的。"""
    files = fc_list(":lang=zh:fontformat=TrueType", "%{file}\n")
    if not files:
        raise AssertionError("没有 TrueType 轮廓的中文字体，reportlab 写不了中文")
    return sorted(files)[0]


@check("docx")
def make_docx(out: Path) -> str:
    from docx import Document
    from docx.oxml.ns import qn

    document = Document()
    document.add_heading(TITLE, level=1)
    paragraph = document.add_paragraph()
    run = paragraph.add_run(TEXT)
    run.font.name = "Noto Sans CJK SC"
    run._element.rPr.rFonts.set(qn("w:eastAsia"), "Noto Sans CJK SC")
    path = out / "selfcheck.docx"
    document.save(path)
    reread = "\n".join(p.text for p in Document(path).paragraphs)
    if TEXT not in reread or TITLE not in reread:
        raise AssertionError(f"读回的正文不对：{reread!r}")
    return str(path)


@check("xlsx")
def make_xlsx(out: Path) -> str:
    from openpyxl import Workbook, load_workbook

    book = Workbook()
    sheet = book.active
    sheet.title = "汇总"
    sheet.append(["项目", "金额"])
    sheet.append(["人工", 10])
    sheet.append(["材料", 20])
    sheet["B4"] = "=SUM(B2:B3)"
    path = out / "selfcheck.xlsx"
    book.save(path)
    sheet = load_workbook(path)["汇总"]
    if sheet["A1"].value != "项目" or sheet["B4"].value != "=SUM(B2:B3)":
        raise AssertionError(f"读回的单元格不对：{sheet['A1'].value!r} {sheet['B4'].value!r}")
    return str(path)


@check("pptx")
def make_pptx(out: Path) -> str:
    from pptx import Presentation

    deck = Presentation()
    slide = deck.slides.add_slide(deck.slide_layouts[1])
    slide.shapes.title.text = TITLE
    slide.placeholders[1].text = TEXT
    path = out / "selfcheck.pptx"
    deck.save(path)
    texts = [
        shape.text_frame.text
        for slide in Presentation(path).slides
        for shape in slide.shapes
        if shape.has_text_frame
    ]
    if TITLE not in texts or TEXT not in texts:
        raise AssertionError(f"读回的文字不对：{texts!r}")
    return str(path)


def embedded_fonts(path: Path) -> list[str]:
    """PDF 里真的嵌进去的字体名。没嵌字体的中文要靠看的人电脑上碰巧有字体，换台机器就是方块。"""
    from pypdf import PdfReader

    names: list[str] = []
    for page in PdfReader(path).pages:
        fonts = page.get("/Resources", {}).get("/Font", {})
        for font in fonts.values():
            font = font.get_object()
            descriptors = [font.get("/FontDescriptor")]
            for descendant in font.get("/DescendantFonts", []) or []:
                descriptors.append(descendant.get_object().get("/FontDescriptor"))
            for descriptor in descriptors:
                if descriptor is None:
                    continue
                descriptor = descriptor.get_object()
                if any(key in descriptor for key in ("/FontFile", "/FontFile2", "/FontFile3")):
                    names.append(str(font.get("/BaseFont")))
    return names


def pdf_text(path: Path) -> str:
    import pdfplumber

    with pdfplumber.open(path) as pdf:
        return "".join(page.extract_text() or "" for page in pdf.pages)


def assert_pdf_has_chinese(path: Path) -> str:
    text = pdf_text(path).replace(" ", "").replace("\n", "")
    if TEXT not in text:
        raise AssertionError(f"PDF 读回的文字不对（中文可能成了方块）：{text[:80]!r}")
    fonts = embedded_fonts(path)
    if not fonts:
        raise AssertionError("PDF 里没有嵌入字体")
    return f"{path}（嵌入字体 {fonts[0]}）"


@check("pdf-weasyprint")
def make_pdf_weasyprint(out: Path) -> str:
    from weasyprint import HTML

    path = out / "selfcheck-weasyprint.pdf"
    HTML(
        string=f"<html lang='zh'><body style='font-family: \"Noto Sans CJK SC\", sans-serif'>"
        f"<h1>{TITLE}</h1><p>{TEXT}</p></body></html>"
    ).write_pdf(path)
    return assert_pdf_has_chinese(path)


@check("pdf-reportlab")
def make_pdf_reportlab(out: Path) -> str:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    font_file = truetype_cjk_font()
    pdfmetrics.registerFont(TTFont("CJK", font_file, subfontIndex=0))
    path = out / "selfcheck-reportlab.pdf"
    page = canvas.Canvas(str(path), pagesize=A4)
    page.setFont("CJK", 14)
    page.drawString(72, 760, TEXT)
    page.save()
    return assert_pdf_has_chinese(path)


def markitdown_command() -> list[str]:
    """跑这个脚本的 Python 旁边的那个（在 venv 里跑时），否则 PATH 上的（镜像里是 /usr/local/bin/markitdown）。"""
    beside = Path(sys.executable).parent / "markitdown"
    if beside.exists():
        return [str(beside)]
    found = shutil.which("markitdown")
    if not found:
        raise AssertionError("找不到 markitdown 命令")
    return [found]


@check("markitdown")
def read_with_markitdown(out: Path) -> str:
    source = out / "selfcheck.docx"
    if not source.exists():
        raise AssertionError("没有可转换的 docx（docx 一项先失败了）")
    converted = subprocess.run(
        [*markitdown_command(), str(source)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if converted.returncode != 0:
        raise AssertionError(f"markitdown 退出码 {converted.returncode}：{converted.stderr[-300:]}")
    if TEXT not in converted.stdout:
        raise AssertionError(f"markitdown 输出里没有正文：{converted.stdout[:200]!r}")
    return f"{len(converted.stdout)} 字符"


@check("pandoc")
def convert_with_pandoc(out: Path) -> str:
    from docx import Document

    source = out / "selfcheck.md"
    source.write_text(f"# {TITLE}\n\n{TEXT}\n", encoding="utf-8")
    target = out / "selfcheck-pandoc.docx"
    subprocess.run(
        ["pandoc", str(source), "-o", str(target)], check=True, capture_output=True, timeout=120
    )
    reread = "\n".join(p.text for p in Document(target).paragraphs)
    if TEXT not in reread:
        raise AssertionError(f"pandoc 转出的 Word 里没有正文：{reread!r}")
    return str(target)


@check("soffice")
def convert_with_soffice(out: Path) -> str:
    source = out / "selfcheck.docx"
    if not source.exists():
        raise AssertionError("没有可转换的 docx（docx 一项先失败了）")
    profile = Path(tempfile.mkdtemp(prefix="soffice-profile-"))
    try:
        subprocess.run(
            [
                "soffice",
                f"-env:UserInstallation={profile.as_uri()}",
                "--headless",
                "--convert-to",
                "pdf",
                "--outdir",
                str(out),
                str(source),
            ],
            check=True,
            capture_output=True,
            timeout=180,
        )
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    return assert_pdf_has_chinese(out / "selfcheck.pdf")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", help="生成的文件放在这里；不给就用临时目录，跑完删掉")
    parser.add_argument("--require-pandoc", action="store_true")
    parser.add_argument("--require-soffice", action="store_true")
    options = parser.parse_args(argv)

    out = Path(options.out) if options.out else Path(tempfile.mkdtemp(prefix="docs-selfcheck-"))
    out.mkdir(parents=True, exist_ok=True)
    try:
        fonts = cjk_font()
        make_docx(out)
        make_xlsx(out)
        make_pptx(out)
        # 没有中文字体时排 PDF 的库会在原生代码里崩掉整个进程，所以这两项直接记失败，不去跑。
        for name, step in (
            ("pdf-weasyprint", make_pdf_weasyprint),
            ("pdf-reportlab", make_pdf_reportlab),
        ):
            if fonts:
                step(out)
            else:
                report(name, False, "没有中文字体，不排 PDF")
        read_with_markitdown(out)
        for name, required, step in (
            ("pandoc", options.require_pandoc, convert_with_pandoc),
            ("soffice", options.require_soffice, convert_with_soffice),
        ):
            if not shutil.which(name):
                if required:
                    report(name, False, f"找不到 {name} 命令")
                else:
                    report(name, True, "跳过：这台机器没有装")
            elif name == "soffice" and not fonts:
                report(name, False, "没有中文字体，不转 PDF")
            else:
                step(out)
    finally:
        if not options.out:
            shutil.rmtree(out, ignore_errors=True)

    failed = [name for name, ok, _ in results if not ok]
    print(f"docs selfcheck: {len(results) - len(failed)} passed, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    sys.exit(main(sys.argv[1:]))
