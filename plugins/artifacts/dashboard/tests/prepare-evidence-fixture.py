#!/usr/bin/env python3
"""격리된 Artifacts 대시보드 증거 캡처용 fixture HERMES_HOME을 만든다."""

from __future__ import annotations

import argparse
import base64
import os
from pathlib import Path

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
SVG_ACTIVE = b"""<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" onload="alert('SVG_EXECUTED_ONLOAD')">
<rect width="320" height="160" fill="#315a7d"/>
<text x="20" y="85" fill="white" font-size="24">SVG img-only fixture</text>
<script>alert('SVG_EXECUTED_SCRIPT'); console.log('SVG_EXECUTED_SCRIPT')</script>
</svg>
"""
PDF_MINIMAL = b"""%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 52>>stream
BT /F1 18 Tf 30 100 Td (PDF download-only fixture) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
trailer<</Root 1 0 R/Size 6>>
startxref
0
%%EOF
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True, type=Path)
    args = parser.parse_args()
    home = args.home.expanduser().resolve()
    if home == Path.home().resolve() / ".hermes":
        parser.error("production HERMES_HOME은 fixture 대상으로 사용할 수 없다")

    alpha = home / "task-staging" / "fixture-alpha-page"
    beta = home / "task-staging" / "fixture-beta-page"
    alpha.mkdir(parents=True, exist_ok=True)
    beta.mkdir(parents=True, exist_ok=True)

    for i in range(56):
        target = alpha / f"page-{i:02d}.png"
        target.write_bytes(PNG_1X1)
        stamp = 2_000_000_000 - i
        os.utime(target, (stamp, stamp))

    (alpha / "stale-target.txt").write_text("stale cache retry fixture\n", encoding="utf-8")
    (alpha / "active-script.svg").write_bytes(SVG_ACTIVE)
    (alpha / "download-only.pdf").write_bytes(PDF_MINIMAL)
    (beta / "beta-note.txt").write_text("second project fixture\n", encoding="utf-8")

    (home / "config.yaml").write_text(
        "dashboard:\n"
        "  artifacts:\n"
        "    topic_map:\n"
        "      - prefix: fixture-alpha\n"
        "        project: fixture-alpha\n"
        "      - prefix: fixture-beta\n"
        "        project: fixture-beta\n",
        encoding="utf-8",
    )
    print(home)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
