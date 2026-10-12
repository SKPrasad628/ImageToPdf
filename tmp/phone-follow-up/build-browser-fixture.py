from pathlib import Path

root = Path(__file__).resolve().parents[2]
folder = Path(__file__).resolve().parent
html = (root / 'index.html').read_text(encoding='utf-8')
html = html.replace('<head>', '<head><base href="../../">', 1)
controls = '''<aside style="padding:10px;background:#192d3e;color:white" aria-label="Test fixture controls">
<button type="button" id="qaCameraFiles" onclick="qaLoadCameraFiles()">Load camera JPEG fixtures</button>
<span id="qaPhoneStatus" role="status">Synthetic camera photos with size headers beyond 196 KiB</span></aside>'''
body_end = html.index('>', html.index('<body')) + 1
html = html[:body_end] + controls + html[body_end:]
html = html.replace('</body>', '<script src="tmp/phone-follow-up/browser-fixture.js"></script></body>')
(folder / 'browser-fixture.html').write_text(html, encoding='utf-8')
print('Created browser fixture using production intake/editor/export and synthetic JPEGs.')
