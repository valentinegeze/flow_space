"""Bundle calib/optical_flow/index.html + assets into a single offline HTML file.

Inlines the MP4 and PNGs as base64 data URIs and drops the external Google Fonts
reference so the page works fully offline.

Usage:
  python3 scripts/package_optical_flow.py
  python3 scripts/package_optical_flow.py --out ~/Desktop/stream_flow.html
"""
import argparse, base64, mimetypes, re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC_DIR = REPO / "calib" / "optical_flow"
DEFAULT_OUT = SRC_DIR / "index_standalone.html"


def to_data_uri(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    if mime is None:
        mime = "application/octet-stream"
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=str, default=str(DEFAULT_OUT))
    args = ap.parse_args()

    src_html = SRC_DIR / "index.html"
    html = src_html.read_text()

    # Drop external Google Fonts (system fallbacks already in font-family)
    html = re.sub(r'<link rel="preconnect"[^>]*>\s*', '', html)
    html = re.sub(r'<link href="https://fonts\.googleapis\.com[^"]*"[^>]*>\s*', '', html)

    # Find every src="..." and href="..." that points at a sibling file and inline it
    def inline(match):
        attr, fname = match.group(1), match.group(2)
        candidate = SRC_DIR / fname
        if candidate.is_file():
            uri = to_data_uri(candidate)
            print(f"  inlined {fname}  ({candidate.stat().st_size/1e6:.2f} MB → b64)")
            return f'{attr}="{uri}"'
        return match.group(0)

    html = re.sub(r'(src|href)="([^"]+)"', inline, html)

    out = Path(args.out).expanduser()
    out.write_text(html)
    print(f"\nWrote {out}  ({out.stat().st_size/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
