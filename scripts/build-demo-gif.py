"""Build the README demo animation as a deterministic Nomo-style illustration.

The animation is an illustrated UI flow rather than a screen recording. It
keeps the proportions and visual language of Nomo's desktop window so that the
README demo feels like the product while remaining reproducible on any host.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "demo_image.gif"
WIDTH, HEIGHT = 1280, 720

# Nomo's light interface is mostly neutral. Blue is reserved for selection,
# links and the two review marks so the document remains the visual focus.
COLORS = {
    "window": "#f5f8fa",
    "surface": "#ffffff",
    "rail": "#f4f7f9",
    "border": "#d7dee5",
    "rule": "#e6ebef",
    "text": "#252b33",
    "muted": "#68727e",
    "subtle": "#8c96a1",
    "blue": "#176fc1",
    "blue_soft": "#e9f2fc",
    "blue_line": "#4a94d5",
    "red": "#c74d4d",
    "purple": "#6c54b8",
    "purple_soft": "#f1edfb",
    "green": "#4e8a68",
}


def get_font(size: int, *, bold: bool = False, mono: bool = False) -> ImageFont.FreeTypeFont:
    if mono:
        candidates = [r"C:\Windows\Fonts\CascadiaCode.ttf", r"C:\Windows\Fonts\consola.ttf"]
    elif bold:
        candidates = [r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\msyhbd.ttc"]
    else:
        candidates = [r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\msyh.ttc"]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def get_cjk_font(size: int, *, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\msyh.ttc"] if bold else [r"C:\Windows\Fonts\msyh.ttc"]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return get_font(size, bold=bold)


FONT = {
    "brand": get_font(15, bold=True),
    "menu": get_font(12),
    "body": get_font(15),
    "small": get_font(12),
    "tiny": get_font(10),
    "heading": get_font(23, bold=True),
    "subheading": get_font(16, bold=True),
    "mono": get_font(12, mono=True),
    "mono_small": get_font(10, mono=True),
    "cjk_menu": get_cjk_font(12),
    "cjk_title": get_cjk_font(16, bold=True),
}


def text(draw: ImageDraw.ImageDraw, xy: tuple[int, int], value: str, key: str = "body", fill: str | None = None) -> None:
    draw.text(xy, value, font=FONT[key], fill=fill or COLORS["text"])


def box(
    draw: ImageDraw.ImageDraw,
    coords: tuple[int, int, int, int],
    *,
    fill: str = "#ffffff",
    outline: str | None = None,
    radius: int = 0,
    width: int = 1,
) -> None:
    if radius:
        draw.rounded_rectangle(coords, radius=radius, fill=fill, outline=outline, width=width)
    else:
        draw.rectangle(coords, fill=fill, outline=outline, width=width)


def folder_icon(draw: ImageDraw.ImageDraw, x: int, y: int, *, open_folder: bool = False) -> None:
    color = COLORS["blue"] if open_folder else COLORS["muted"]
    draw.line((x, y + 3, x + 5, y + 3, x + 8, y, x + 14, y, x + 16, y + 3, x + 16, y + 12, x, y + 12, x, y + 3), fill=color, width=1)


def file_icon(draw: ImageDraw.ImageDraw, x: int, y: int, *, active: bool = False) -> None:
    color = COLORS["blue"] if active else COLORS["muted"]
    draw.line((x + 2, y, x + 11, y, x + 15, y + 4, x + 15, y + 13, x + 2, y + 13, x + 2, y, x + 11, y, x + 11, y + 4, x + 15, y + 4), fill=color, width=1)


def app_icon(draw: ImageDraw.ImageDraw, x: int, y: int) -> None:
    draw.rounded_rectangle((x, y, x + 13, y + 13), radius=2, outline=COLORS["blue"], width=1)
    draw.line((x + 4, y + 3, x + 4, y + 10, x + 9, y + 6, x + 4, y + 3), fill=COLORS["blue"], width=1)


def toolbar_glyph(draw: ImageDraw.ImageDraw, x: int, y: int, label: str, *, active: bool = False) -> None:
    color = COLORS["blue"] if active else COLORS["muted"]
    text(draw, (x, y), label, "small", color)


def draw_top_chrome(draw: ImageDraw.ImageDraw, step: str, subtitle: str) -> None:
    box(draw, (0, 0, WIDTH - 1, 31), fill=COLORS["window"])
    draw.line((0, 31, WIDTH, 31), fill=COLORS["border"], width=1)
    app_icon(draw, 13, 9)
    text(draw, (32, 8), "Nomo", "brand")
    for x, label in ((75, "文件"), (111, "编辑"), (147, "段落"), (185, "格式"), (223, "查看"), (262, "设置")):
        text(draw, (x, 9), label, "cjk_menu")
    text(draw, (922, 10), subtitle, "tiny", COLORS["muted"])
    # Compact Windows controls echo the original title bar without stealing focus.
    draw.line((1199, 15, 1208, 15), fill=COLORS["muted"], width=1)
    draw.rectangle((1231, 11, 1239, 19), outline=COLORS["muted"], width=1)
    draw.line((1260, 11, 1268, 19), fill=COLORS["muted"], width=1)
    draw.line((1268, 11, 1260, 19), fill=COLORS["muted"], width=1)
    text(draw, (1127, 10), step, "tiny", COLORS["subtle"])


def draw_sidebar(draw: ImageDraw.ImageDraw, selected: str = "manuscript.md") -> None:
    box(draw, (0, 32, 178, HEIGHT), fill=COLORS["rail"])
    draw.line((178, 32, 178, HEIGHT), fill=COLORS["border"], width=1)
    text(draw, (16, 51), "⌄", "small", COLORS["blue"])
    folder_icon(draw, 31, 52, open_folder=True)
    text(draw, (54, 49), "NewMd", "subheading")
    rows = [
        ("folder", ".agents"),
        ("folder", ".codex"),
        ("folder", "assets"),
        ("folder", "docs"),
        ("folder", "scripts"),
        ("folder", "src"),
        ("file", "README.md"),
        ("file", "references.bib"),
        ("file", "manuscript.md"),
        ("file", "notes.md"),
    ]
    for index, (kind, name) in enumerate(rows):
        y = 80 + index * 27
        active = name == selected
        if active:
            box(draw, (9, y - 3, 169, y + 20), fill=COLORS["blue_soft"], radius=3)
            draw.rectangle((9, y - 3, 11, y + 20), fill=COLORS["blue"])
        if kind == "folder":
            folder_icon(draw, 38, y + 2)
        else:
            file_icon(draw, 39, y + 1, active=active)
        text(draw, (59, y + 1), name, "small", COLORS["blue"] if active else COLORS["text"])


def draw_document_chrome(draw: ImageDraw.ImageDraw, *, mode: str = "Semantic mode") -> None:
    box(draw, (179, 32, WIDTH, 61), fill=COLORS["surface"])
    draw.line((179, 61, WIDTH, 61), fill=COLORS["border"], width=1)
    box(draw, (188, 32, 410, 61), fill=COLORS["surface"], outline=COLORS["border"], radius=7)
    file_icon(draw, 201, 42, active=True)
    text(draw, (219, 40), "manuscript.md", "small")
    text(draw, (394, 40), "×", "small", COLORS["blue"])
    text(draw, (426, 40), "+", "body", COLORS["muted"])

    box(draw, (179, 62, WIDTH, 96), fill=COLORS["surface"])
    draw.line((179, 96, WIDTH, 96), fill=COLORS["rule"], width=1)
    glyphs = ((195, "H1"), (226, "B"), (250, "I"), (274, "S"), (299, "U"), (327, "~"), (356, "/"), (386, "[]"), (416, '"'), (447, "i"), (478, "="), (511, "+"), (544, "[]"), (578, "</>"), (623, "Σ"), (657, "{}"), (697, "x²"), (734, "="))
    for x, label in glyphs:
        toolbar_glyph(draw, x, 73, label)
    draw.line((766, 70, 766, 89), fill=COLORS["border"], width=1)
    text(draw, (1036, 74), "⌕", "body", COLORS["muted"])
    text(draw, (1062, 76), "60%", "tiny", COLORS["muted"])
    draw.line((1085, 81, 1131, 81), fill="#a9b6c1", width=2)
    draw.ellipse((1116, 75, 1127, 86), fill=COLORS["blue"])
    box(draw, (1148, 68, 1178, 90), fill=COLORS["blue_soft"], radius=3)
    text(draw, (1157, 74), "▣", "small", COLORS["blue"])
    box(draw, (1183, 68, 1212, 90), fill=COLORS["surface"], outline=COLORS["border"], radius=3)
    text(draw, (1192, 74), "</>", "tiny", COLORS["muted"])
    box(draw, (1217, 68, 1246, 90), fill=COLORS["blue_soft"], radius=3)
    text(draw, (1224, 74), "☷", "small", COLORS["blue"])
    text(draw, (1257, 74), "⌃", "small", COLORS["muted"])

    text(draw, (193, HEIGHT - 23), "Markdown  ·  " + mode, "tiny", COLORS["muted"])
    text(draw, (1115, HEIGHT - 23), "100%", "tiny", COLORS["muted"])
    box(draw, (1157, HEIGHT - 29, 1211, HEIGHT - 8), fill=COLORS["surface"], outline=COLORS["border"], radius=3)
    text(draw, (1169, HEIGHT - 24), "2685词", "tiny", COLORS["muted"])


def draw_outline(draw: ImageDraw.ImageDraw, title: str, items: list[str], selected: int = 0) -> None:
    x, y, w, h = 1087, 122, 178, 531
    box(draw, (x, y, x + w, h), fill=COLORS["surface"], outline=COLORS["border"], radius=4)
    title_key = "cjk_title" if any("\u4e00" <= character <= "\u9fff" for character in title) else "subheading"
    text(draw, (x + 14, y + 16), title, title_key)
    box(draw, (x + w - 36, y + 14, x + w - 14, y + 35), fill=COLORS["surface"], outline=COLORS["border"], radius=3)
    text(draw, (x + w - 29, y + 16), "⌃", "small", COLORS["muted"])
    text(draw, (x + 14, y + 50), "⌄", "small", COLORS["muted"])
    text(draw, (x + 30, y + 50), "Nomo Markdown", "small", COLORS["muted"])
    for index, item in enumerate(items):
        row_y = y + 82 + index * 29
        if index == selected:
            box(draw, (x + 10, row_y - 4, x + w - 10, row_y + 20), fill=COLORS["blue_soft"], radius=3)
        text(draw, (x + 24, row_y), item, "small", COLORS["blue"] if index == selected else COLORS["muted"])


def shell(step: str, subtitle: str, *, selected: str = "manuscript.md", mode: str = "Semantic mode") -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGB", (WIDTH, HEIGHT), COLORS["surface"])
    draw = ImageDraw.Draw(image)
    draw_top_chrome(draw, step, subtitle)
    draw_sidebar(draw, selected)
    draw_document_chrome(draw, mode=mode)
    return image, draw


def document_heading(draw: ImageDraw.ImageDraw, x: int, y: int, title: str, subtitle: str) -> None:
    text(draw, (x, y), title, "heading")
    text(draw, (x, y + 41), subtitle, "body", COLORS["muted"])


def editor_frame() -> Image.Image:
    image, draw = shell("1 / 4", "Semantic editing")
    x, right = 322, 1048
    document_heading(draw, x, 129, "Methods", "The method remains editable while Markdown stays the source of truth.")
    text(draw, (x, 197), "Headings, equations, citations, tables and images stay synchronized.", "body", COLORS["muted"])
    box(draw, (x, 245, right, 304), fill="#f7f9fb", outline=COLORS["border"], radius=3)
    text(draw, (x + 18, 263), "E = mc²", "subheading")
    text(draw, (right - 48, 267), "(1.1)", "small", COLORS["blue"])
    text(draw, (x, 348), "A semantic block can be edited without losing the original Markdown.", "body")
    text(draw, (x, 378), "The outline follows the document structure as you work.", "body", COLORS["muted"])
    # A restrained table echoes the real document surface and makes semantic blocks visible.
    box(draw, (x, 429, right, 541), fill=COLORS["surface"], outline=COLORS["border"])
    draw.line((x, 458, right, 458), fill=COLORS["border"], width=1)
    draw.line((x + 155, 429, x + 155, 541), fill=COLORS["border"], width=1)
    text(draw, (x + 12, 438), "Block", "small", COLORS["muted"])
    text(draw, (x + 170, 438), "Synchronized representation", "small", COLORS["muted"])
    text(draw, (x + 12, 472), "equation", "small")
    text(draw, (x + 170, 472), "TeX source  ·  rendered formula  ·  label (1.1)", "small")
    text(draw, (x + 12, 508), "paragraph", "small")
    text(draw, (x + 170, 508), "Markdown text  ·  semantic editing  ·  live outline", "small")
    draw_outline(draw, "文档大纲", ["Introduction", "Methods", "Results", "Discussion", "References"], selected=1)
    return image


def citation_frame() -> Image.Image:
    image, draw = shell("2 / 4", "Academic citation")
    x, right = 322, 1048
    document_heading(draw, x, 129, "Results", "Prior work supports this result")
    text(draw, (x, 197), "The citation stays in Markdown and renders in the selected style.", "body")
    text(draw, (x, 231), "Numeric and author–year output remain available from the same Zotero key.", "body", COLORS["muted"])
    # Inline citation: blue and quiet, like Nomo's document links.
    text(draw, (x, 276), "[@D9PGQUM4; @T4IQZGRM]", "mono", COLORS["blue"])
    draw.line((x, 294, x + 192, 294), fill=COLORS["blue_line"], width=1)
    text(draw, (x + 210, 276), "from the local Zotero library", "small", COLORS["muted"])
    box(draw, (x, 332, right, 415), fill="#f7f9fb", outline=COLORS["border"], radius=3)
    text(draw, (x + 14, 346), "References", "subheading")
    text(draw, (x + 14, 379), "1. Gagliardi et al.   ·   2. Li Manni et al.   ·   3. Benchmark", "small")
    # The source panel is deliberately compact, closer to Nomo's utility panels than a card dashboard.
    draw_outline(draw, "Zotero", ["127.0.0.1:23119/api", "D9PGQUM4  Strong correlation", "T4IQZGRM  Pair density", "MRHTZ5CI  Benchmark"], selected=0)
    return image


def review_frame() -> Image.Image:
    image, draw = shell("3 / 4", "Git review mode", mode="Review mode")
    x, right = 322, 830
    document_heading(draw, x, 129, "Review changes", "HEAD  →  working copy")
    box(draw, (x, 216, right, 257), fill="#f7f9fb", outline=COLORS["border"], radius=3)
    text(draw, (x + 14, 229), "The method remains stable.", "body")
    text(draw, (x, 290), "− old experimental condition", "body")
    draw.line((x, 313, x + 235, 313), fill=COLORS["red"], width=2)
    text(draw, (x, 339), "+ updated experimental condition", "body")
    draw.line((x, 362, x + 278, 362), fill=COLORS["blue_line"], width=2)
    text(draw, (x, 404), "Added text uses a blue underline.", "small", COLORS["blue"])
    text(draw, (x, 429), "Deleted text stays readable with a red strike-through.", "small", COLORS["red"])
    box(draw, (x, 475, right, 548), fill=COLORS["surface"], outline=COLORS["border"])
    text(draw, (x + 12, 488), "Unified diff", "small", COLORS["muted"])
    text(draw, (x + 12, 518), "@@ -12,2 +12,2 @@", "mono_small", COLORS["muted"])
    text(draw, (x + 180, 518), "− old condition", "mono_small", COLORS["red"])
    text(draw, (x + 340, 518), "+ updated condition", "mono_small", COLORS["blue"])
    draw_outline(draw, "审阅", ["1 change", "Hunk 1  ·  lines 12–14", "Accept selected", "Accept all", "Restore from index"], selected=1)
    return image


def draw_dialog(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int) -> None:
    # A subtle shadow and thin border match Nomo's settings dialogs.
    box(draw, (x + 5, y + 6, x + w + 5, y + h + 6), fill="#d9e0e7", radius=5)
    box(draw, (x, y, x + w, y + h), fill=COLORS["surface"], outline=COLORS["border"], radius=5)
    draw.line((x, y + 43, x + w, y + 43), fill=COLORS["rule"], width=1)


def export_frame() -> Image.Image:
    image, draw = shell("4 / 4", "Journal export")
    # Keep a quiet document behind the modal, as in Nomo's actual preferences windows.
    x = 322
    document_heading(draw, x, 129, "Manuscript", "Choose a template before exporting the document.")
    text(draw, (x, 198), "LaTeX and Word exports preserve equations, citations and references.", "body", COLORS["muted"])
    box(draw, (x, 245, 1048, 375), fill="#f7f9fb", outline=COLORS["border"], radius=3)
    text(draw, (x + 16, 262), "Export preview", "subheading")
    text(draw, (x + 16, 302), "Title   ·   Authors   ·   Abstract   ·   References", "small", COLORS["muted"])
    draw_outline(draw, "文档大纲", ["Title", "Abstract", "Methods", "Results", "References"], selected=0)

    draw_dialog(draw, 438, 174, 455, 342)
    text(draw, (463, 191), "Choose an export template", "subheading")
    text(draw, (463, 220), "Select a starting point for LaTeX or Word.", "small", COLORS["muted"])
    options = [("Nature family", "Nature article layout · bibliography style"), ("ACS family", "ACS article layout · achemso / ACS style")]
    for index, (title, detail) in enumerate(options):
        oy = 254 + index * 82
        selected = index == 0
        box(draw, (463, oy, 868, oy + 61), fill=COLORS["surface"], outline=COLORS["blue"] if selected else COLORS["border"], radius=4, width=2 if selected else 1)
        draw.ellipse((479, oy + 19, 493, oy + 33), outline=COLORS["blue"] if selected else COLORS["subtle"], width=2)
        if selected:
            draw.ellipse((483, oy + 23, 489, oy + 29), fill=COLORS["blue"])
        text(draw, (509, oy + 10), title, "subheading")
        text(draw, (509, oy + 36), detail, "tiny", COLORS["muted"])
    text(draw, (463, 484), "Cancel", "small", COLORS["muted"])
    box(draw, (800, 468, 868, 497), fill=COLORS["blue"], radius=3)
    text(draw, (818, 476), "Export", "small", "#ffffff")
    return image


def main() -> None:
    frames = [editor_frame(), citation_frame(), review_frame(), export_frame()]
    durations = [1400, 1600, 1700, 1900]
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        OUTPUT,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"wrote {OUTPUT} ({WIDTH}x{HEIGHT}, {len(frames)} frames)")


if __name__ == "__main__":
    main()
