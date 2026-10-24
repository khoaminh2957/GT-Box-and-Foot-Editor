"""scripts/design_lint.py: every rule fires on a minimal bad example, and the shipped UI files pass."""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import design_lint as dl  # noqa: E402

BAD = {
    "gradient": ("a.css", "body { background: linear-gradient(135deg, #123, #456); }"),
    "blur / glass": ("a.css", ".card { backdrop-filter: blur(12px); }"),
    "shadow or glow": ("a.css", ".card { box-shadow: 0 0 24px rgba(0,0,0,.3); }"),
    "gradient text": ("a.css", "h1 { -webkit-background-clip: text; background-clip: text; }"),
    "emoji or dingbat": ("a.html", "<button>\U0001F680 Start</button>"),
    "thick one-sided accent border": ("a.css", ".card { border-left: 4px solid #345; }"),
    "pure black or white background": ("a.css", "body { background: #000; }"),
    "large corner radius": ("a.css", ".card { border-radius: 16px; }"),
    "animation named pulse / bounce / glow": ("a.css", "@keyframes pulse { to { opacity: .5 } }"),
    "overshooting easing": ("a.css", ".x { transition: all .3s cubic-bezier(.34, 1.56, .64, 1); }"),
    "purple or neon colour": ("a.css", ".x { color: #7c3aed; }"),
    "marketing copy": ("a.html", "<h1>Seamless labelling</h1>"),
    "overused web font first in the stack": ("a.css", "body { font-family: 'Inter', sans-serif; }"),
    "web font import": ("a.css", "@import url('https://fonts.googleapis.com/css2?family=Inter');"),
    "more than three primary buttons (no hierarchy)": ("a.html", '<button class="primary">1</button><button class="primary">2</button><button class="primary">3</button><button class="primary">4</button>'),
}


@pytest.mark.parametrize("rule", sorted(BAD))
def test_each_tell_is_detected(rule):
    name, text = BAD[rule]
    assert rule in {f[2] for f in dl.check(name, text)}, [f[2] for f in dl.check(name, text)]


def test_neon_cyan_is_detected_and_a_muted_blue_is_not():
    assert any("neon cyan" in f[3] for f in dl.check("a.css", ".x { color: #38bdf8; }"))
    assert dl.check("a.css", ".x { color: #2b5d8c; background: #e8ebed; border: 1px solid #cbd2d7; }") == []


def test_plain_flat_css_passes():
    css = ":root { --ink: #1b2126; } body { background: #e8ebed; font: 13px system-ui, sans-serif; } button { border: 1px solid #a9b2b9; border-radius: 2px; transition: background .1s ease-out; }"
    assert dl.check("a.css", css) == []


def test_the_shipped_ui_files_pass():
    assert dl.main([str(ROOT / n) for n in dl.DEFAULT_FILES]) == 0
