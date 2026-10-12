from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[2]
folder = Path(__file__).resolve().parent
image = Image.new('RGB', (400, 240), 'white')
draw = ImageDraw.Draw(image)
draw.rectangle((0, 0, 199, 119), fill=(220, 30, 30))
draw.rectangle((200, 0, 399, 119), fill=(30, 180, 60))
draw.rectangle((0, 120, 199, 239), fill=(30, 60, 220))
draw.rectangle((200, 120, 399, 239), fill=(220, 180, 30))
draw.rectangle((15, 15, 35, 35), fill='black')
for name in ['source.png', 'target.png']:
    image.save(folder / name)

html = (root / 'index.html').read_text(encoding='utf-8')
policy = "default-src 'self' blob: data:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; object-src 'none'; connect-src 'self' blob: data:"
html = html.replace('<head>', '<head><base href="../../"><meta http-equiv="Content-Security-Policy" content="' + policy + '">', 1)
controls = '''<aside style="padding:12px;background:#192d3e;color:white" aria-label="Test fixture controls">
<strong>Batch 6 QA: external resources blocked by Content Security Policy</strong>
<button type="button" onclick="qaLoadNative()">Load native PDF fixture</button>
<button type="button" onclick="qaLoadImages()">Load image fixtures</button>
<button type="button" onclick="qaFaultOne()">Make page 2 unreadable</button>
<button type="button" onclick="qaFaultAll()">Make all pages unreadable</button>
<span id="qaStatus" role="status">Ready</span></aside>'''
body_end = html.index('>', html.index('<body')) + 1
html = html[:body_end] + controls + html[body_end:]
assert controls in html
html = html.replace('</body>', '<script src="tmp/batch6/browser-fixture.js"></script></body>')
(folder / 'browser-fixture.html').write_text(html, encoding='utf-8')
print('Created controlled browser fixture with the production scripts and external resources blocked.')
