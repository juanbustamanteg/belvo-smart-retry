"""Convert the project's Markdown documents (PRD, user guide) to .docx.

Handles headings, paragraphs, bullet and numbered lists, pipe tables, fenced code blocks,
**bold**, *italic* and `code`. Usage: python3 scripts/md_to_docx.py FILE.md [FILE.md ...]
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

INK = RGBColor(0x14, 0x2D, 0x29)
ACCENT = RGBColor(0x00, 0x7B, 0x62)
MUTED = RGBColor(0x5A, 0x63, 0x6B)


def runs(p, text: str, size: float | None = None, bold_all=False):
    for part in re.split(r"(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)", text):
        if not part:
            continue
        if part.startswith("**"):
            r = p.add_run(part[2:-2]); r.bold = True
        elif part.startswith("`"):
            r = p.add_run(part[1:-1]); r.font.name = "Menlo"; r.font.size = Pt(8.5)
        elif part.startswith("*"):
            r = p.add_run(part[1:-1]); r.italic = True
        else:
            r = p.add_run(part)
        if bold_all:
            r.bold = True
        if size and not part.startswith("`"):
            r.font.size = Pt(size)


def shade(cell, hex_fill: str):
    tc = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear"); shd.set(qn("w:color"), "auto"); shd.set(qn("w:fill"), hex_fill)
    tc.append(shd)


def add_table(doc, rows: list[list[str]]):
    header, body = rows[0], rows[1:]
    t = doc.add_table(rows=1, cols=len(header))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    for i, h in enumerate(header):
        c = t.rows[0].cells[i]; c.text = ""
        p = c.paragraphs[0]; runs(p, h, 9, bold_all=True)
        for r in p.runs:
            r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        shade(c, "142D29")
    for row in body:
        cells = t.add_row().cells
        for i, v in enumerate(row[: len(header)]):
            cells[i].text = ""
            runs(cells[i].paragraphs[0], v, 9)
    doc.add_paragraph()


def convert(md_path: Path) -> Path:
    lines = md_path.read_text(encoding="utf-8").splitlines()
    doc = Document()
    sec = doc.sections[0]
    sec.page_height, sec.page_width = Cm(27.94), Cm(21.59)
    sec.left_margin = sec.right_margin = Cm(2.0)
    sec.top_margin = sec.bottom_margin = Cm(1.8)
    st = doc.styles["Normal"]; st.font.name = "Calibri"; st.font.size = Pt(10.5)
    st.paragraph_format.space_after = Pt(4)
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            code = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                code.append(lines[i]); i += 1
            p = doc.add_paragraph()
            r = p.add_run("\n".join(code)); r.font.name = "Menlo"; r.font.size = Pt(8.5)
            p.paragraph_format.left_indent = Cm(0.5)
            i += 1
            continue
        if line.startswith("|"):
            table = []
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not all(re.fullmatch(r":?-{3,}:?", c) for c in cells):
                    table.append(cells)
                i += 1
            add_table(doc, table)
            continue
        if not line.strip():
            i += 1
            continue
        m = re.match(r"^(#{1,4}) (.*)", line)
        if m:
            level = len(m.group(1))
            p = doc.add_paragraph()
            r = p.add_run(m.group(2)); r.bold = True
            r.font.size = Pt({1: 20, 2: 15, 3: 12.5, 4: 11}[level])
            r.font.color.rgb = ACCENT if level == 1 else INK
            p.paragraph_format.space_before = Pt(10 if level > 1 else 0)
            p.paragraph_format.keep_with_next = True
        elif re.match(r"^\s*- ", line):
            indent = (len(line) - len(line.lstrip())) // 2
            p = doc.add_paragraph(style="List Bullet 2" if indent else "List Bullet")
            runs(p, line.strip()[2:])
        elif re.match(r"^\d+\. ", line):
            p = doc.add_paragraph(style="List Number")
            runs(p, re.sub(r"^\d+\. ", "", line))
        else:
            p = doc.add_paragraph()
            runs(p, line)
            if i < 4 and ("Unofficial" in line or "Version" in line):
                for r in p.runs:
                    r.font.color.rgb = MUTED; r.font.size = Pt(9)
        i += 1
    out = md_path.with_suffix(".docx")
    doc.save(out)
    return out


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        print("wrote", convert(Path(arg)))
