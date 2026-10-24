"""Design lint: fails when the UI files show the visual tells that mark a page as machine-generated.

The rules come from published catalogues of "AI slop" in interfaces, written down here so that they are checked on every push instead of remembered:
  https://www.impeccable.style/slop   https://cdn.jsdelivr.net/npm/pixelslop@0.3.8/dist/skill/resources/ai-slop-patterns.md
Covered: gradients (backgrounds and text), blur/glass, glow and any drop shadow, purple-violet and neon-cyan accents, emoji and dingbats as icons, thick one-sided accent borders,
generic web-font stacks (Inter, Roboto, ...), pure black/white backgrounds, large rounded corners, pulse/bounce/glow animation and overshooting easing, marketing copy, many primary buttons.
Not covered (cannot be checked by a script): layout rhythm, copy quality, whether the tool is pleasant to use.  Passing this lint does not make a design good; failing it means a known tell is present.

usage: design_lint.py [file ...]      default: style.css index.html app.js logic.js cloud.js      exit 1 when something is found"""
import colorsys, re, sys
from pathlib import Path

DEFAULT_FILES = ["style.css", "index.html", "app.js", "logic.js", "cloud.js"]
OVERUSED_FONTS = {"inter", "roboto", "poppins", "plus jakarta sans", "geist", "syne", "dm sans", "space grotesk", "montserrat", "outfit", "jetbrains mono"}
EMOJI = re.compile("[☀-➿⭐⬆⬇️\U0001f300-\U0001faff]")
COPY = re.compile(r"\b(web edition|ai-powered|supercharge|seamless|world-class|next-gen|revolutionary|blazing)\b", re.I)


def lines_matching(text, pattern, flags=0, keep=None):
    """(line number, snippet) of every line matching `pattern` and, when given, accepted by keep(full_line)."""
    return [(i + 1, l.strip()[:90]) for i, l in enumerate(text.splitlines()) if re.search(pattern, l, flags) and (keep is None or keep(l))]


def big_radius(line):
    return any(int(v) > 4 for v in re.findall(r"(\d+)px", line.split("border-radius", 1)[1]))


def overshoots(line):
    for m in re.finditer(r"cubic-bezier\(\s*[-\d.]+\s*,\s*([-\d.]+)\s*,\s*[-\d.]+\s*,\s*([-\d.]+)", line):
        if any(float(v) < 0 or float(v) > 1 for v in m.groups()):
            return True
    return False


def colour_findings(text):
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        for m in re.finditer(r"#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b|rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)", line):
            if m.group(1):
                h = m.group(1)
                h = "".join(c * 2 for c in h) if len(h) == 3 else h
                r, g, b = (int(h[k:k + 2], 16) / 255 for k in (0, 2, 4))
            else:
                r, g, b = (int(m.group(k)) / 255 for k in (2, 3, 4))
            hue, light, sat = colorsys.rgb_to_hls(r, g, b)
            hue *= 360
            if 255 <= hue <= 320 and sat >= 0.30 and 0.15 <= light <= 0.85:
                out.append((i, f"purple/violet colour {m.group(0)}"))
            if 170 <= hue <= 200 and sat >= 0.70 and light >= 0.35:
                out.append((i, f"neon cyan colour {m.group(0)}"))
    return out


def check(name, text):
    f = []
    add = lambda rule, hits: f.extend((name, ln, rule, snip) for ln, snip in hits)
    css_like = name.endswith((".css", ".html", ".js"))
    if css_like:
        add("gradient", lines_matching(text, r"(linear|radial|conic)-gradient\("))
        add("blur / glass", lines_matching(text, r"backdrop-filter|filter\s*:\s*blur"))
        add("shadow or glow", lines_matching(text, r"(box|text)-shadow\s*:|drop-shadow\(|shadowBlur"))
        add("gradient text", lines_matching(text, r"background-clip\s*:\s*text|-webkit-text-fill-color"))
        add("emoji or dingbat", lines_matching(text, EMOJI.pattern))
        add("thick one-sided accent border", lines_matching(text, r"border-(left|right|top|bottom)\s*:\s*([3-9]|\d\d+)px"))
        add("pure black or white background", lines_matching(text, r"background(-color)?\s*:\s*(#000(000)?|#fff(fff)?|black|white)\s*[;}]", re.I))
        add("large corner radius", lines_matching(text, r"border-radius\s*:\s*\d+px", keep=big_radius))
        add("animation named pulse / bounce / glow", lines_matching(text, r"@keyframes\s+\w*(pulse|bounce|glow|shimmer|float|wiggle)|animation(-name)?\s*:[^;]*(pulse|bounce|glow|shimmer|float|wiggle)", re.I))
        add("overshooting easing", lines_matching(text, r"cubic-bezier\(", keep=overshoots))
        add("purple or neon colour", colour_findings(text))
        add("marketing copy", lines_matching(text, COPY.pattern, re.I))
    if name.endswith(".css"):
        for ln, l in lines_matching(text, r"font-family\s*:"):
            first = re.split(r",", l.split(":", 1)[1])[0].strip(" ;\"'").lower()
            if first in OVERUSED_FONTS:
                f.append((name, ln, "overused web font first in the stack", l))
        add("web font import", lines_matching(text, r"fonts\.googleapis\.com|@font-face"))
    if name.endswith(".html"):
        n_primary = len(re.findall(r'class="[^"]*\bprimary\b', text))
        if n_primary > 3:
            f.append((name, 0, "more than three primary buttons (no hierarchy)", f"{n_primary} found"))
    return f


def main(argv=None):
    files = (argv if argv is not None else sys.argv[1:]) or DEFAULT_FILES
    found = []
    for name in files:
        p = Path(name)
        if not p.exists():
            print(f"design_lint: {name} not found", file=sys.stderr)
            return 1
        found += check(p.name if p.suffix else name, p.read_text())
    for name, ln, rule, snip in found:
        print(f"{name}:{ln}: {rule}: {snip}")
    print(f"design_lint: {len(found)} finding(s) in {len(files)} file(s)")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
