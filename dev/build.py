# Developer tool (not used by the app). Run: python3 dev/build.py [output.zip]
# 1. Draws the app icons from the potato map in js/config/icons.js
# 2. Fills in sw.js: FILES (every app file) and VERSION (a hash of their contents)
# 3. Optionally zips the whole repo for uploading through GitHub's web page
import hashlib, json, os, re, sys, zipfile
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {'.git', 'dev', 'node_modules'}

def potato():
    src = (ROOT / 'js/config/icons.js').read_text()
    block = src[src.index('export const POTATO = ['):]
    block = block[:block.index('];')]
    rows = re.findall(r"'([^']+)'", block)
    colors = dict(re.findall(r"(\w): '(#[0-9A-Fa-f]{6})'", src[src.index('POTATO_COLORS'):]))
    colors['c'] = '#2BB3C0'  # the headband uses the theme accent in the app; icons use Midnight Navy's
    return rows, colors

def render(rows, colors, size, scale, bg):
    img = Image.new('RGBA', (size, size), bg)
    px = img.load()
    off = (size - len(rows[0]) * scale) // 2
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == '.': continue
            c = colors[ch]
            col = (int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 255)
            for yy in range(scale):
                for xx in range(scale):
                    px[off + x * scale + xx, off + y * scale + yy] = col
    return img

def main():
    rows, colors = potato()
    icons = ROOT / 'icons'
    icons.mkdir(exist_ok=True)
    clear = (0, 0, 0, 0)
    render(rows, colors, 192, 11, clear).save(icons / 'icon-192.png')          # PC: potato only
    render(rows, colors, 512, 30, clear).save(icons / 'icon-512.png')
    render(rows, colors, 512, 20, (11, 26, 46, 255)).save(icons / 'icon-maskable-512.png')  # Android
    render(rows, colors, 32, 2, clear).save(icons / 'favicon-32.png')

    files = []
    for dirpath, dirnames, names in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for n in names:
            rel = Path(dirpath, n).relative_to(ROOT).as_posix()
            if rel == 'sw.js' or rel.endswith(('.md', '.zip')) or n.startswith('.'):
                continue
            files.append('./' + rel)
    files.sort(key=lambda f: (f != './index.html', f))
    h = hashlib.sha1()
    for f in files:
        h.update(f.encode()); h.update((ROOT / f[2:]).read_bytes())
    version = h.hexdigest()[:10]
    sw_path = ROOT / 'sw.js'
    sw = sw_path.read_text()
    sw = re.sub(r"const VERSION = '[^']*';", f"const VERSION = '{version}';", sw)
    sw = re.sub(r"const FILES = \[[\s\S]*?\];", "const FILES = " + json.dumps(files, indent=2) + ";", sw)
    sw_path.write_text(sw)
    print(f'version {version}, {len(files)} files cached')

    if len(sys.argv) > 1:
        out = Path(sys.argv[1]).resolve()
        if out.exists(): out.unlink()
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
            for dirpath, dirnames, names in os.walk(ROOT):
                dirnames[:] = [d for d in dirnames if d not in {'.git', 'node_modules'}]
                for n in names:
                    p = Path(dirpath, n)
                    if p.suffix == '.zip': continue
                    z.write(p, p.relative_to(ROOT).as_posix())
        print('zip', out)

main()
