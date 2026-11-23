"""pick.html must never set iframe.srcdoc before appendChild or outside requestAnimationFrame.

Setting srcdoc before the iframe has layout runs the piece's setup at width 0; canvas getImageData then throws
IndexSizeError and the piece freezes. The two patterns are copied from art-ops/wall_lint.py (FROZEN-IFRAME, 2026-11-18).
"""
import os
import re

PAGE = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "learning", "pick.html")
DATA = re.compile(r'<script id="data" type="application/json">.*?</script>', re.S)
SRCDOC_THEN_APPEND = re.compile(r'(\w+)\.srcdoc\s*=\s*[^;]+;\s*\w+\.appendChild\(\s*\1\s*\)')
BARE_SRCDOC = re.compile(r'(?<!\{)(\w+)\.srcdoc\s*=\s*\w+')


def lint(text):
    code = DATA.sub("", text)
    out = [m.group(0)[:90] for m in SRCDOC_THEN_APPEND.finditer(code)]
    for m in BARE_SRCDOC.finditer(code):
        if "requestAnimationFrame" not in code[max(0, m.start() - 60):m.start()]:
            out.append(code[m.start():m.start() + 60])
    return out


def test_current_page_is_clean():
    assert lint(open(PAGE).read()) == []


def test_lint_goes_red_on_the_old_order_and_on_a_bare_srcdoc():
    old = "function show(el,html){const x=document.createElement('iframe');x.srcdoc=html;el.appendChild(x)}"
    assert lint(old), "srcdoc-before-appendChild must be flagged"
    bare = "function show(el,html){const x=document.createElement('iframe');el.appendChild(x);x.srcdoc=html}"
    assert lint(bare), "srcdoc outside requestAnimationFrame must be flagged"
    new = "function show(el,html){const x=document.createElement('iframe');el.appendChild(x);requestAnimationFrame(()=>requestAnimationFrame(()=>{x.srcdoc=html}))}"
    assert lint(new) == []
