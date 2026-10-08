from pathlib import Path
import importlib.util
import sys

script = Path('C:/Users/skpra/.codex/plugins/cache/openai-bundled/visualize/1.0.46/skills/visualize/scripts/render.py')
spec = importlib.util.spec_from_file_location('visualize_render', script)
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('C:/Users/skpra/.codex/visualizations/2026/10/04/01a10809-2285-79f3-ae36-3806f568cf96/photopdf-redesign.html')
output_prefix = {
    'photopdf-more-designs': 'ui-more-designs',
    'photopdf-focus-canvas': 'ui-focus-canvas',
    'photopdf-page-board': 'ui-page-board',
    'photopdf-print-desk': 'ui-print-desk',
}.get(source.stem, 'ui-redesign')
fragment = source.read_text(encoding='utf-8')
probe = '''<output id="qa-errors" aria-live="polite" data-errors="0">Runtime errors: 0</output>
<script>
(() => {
  const output = document.getElementById('qa-errors');
  const errors = [];
  window.addEventListener('error', event => {
    errors.push(event.message);
    output.dataset.errors = String(errors.length);
    output.textContent = 'Runtime errors: ' + errors.length + ' | ' + errors.slice(-3).join(' | ');
  });
})();
</script>'''
Path('tmp/' + output_prefix + '-qa.html').write_text(renderer._render_document(probe + fragment, 'PhotoPDF resize regression check'), encoding='utf-8')
Path('tmp/' + output_prefix + '-preview.html').write_text(renderer._render_document(fragment, 'PhotoPDF Redesign'), encoding='utf-8')
print('Rendered preview and instrumented runtime-error check.')
