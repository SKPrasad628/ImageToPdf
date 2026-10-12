// Development-only controls. Production intake/editor/export code is unchanged.
async function qaImport(paths) {
  const status = document.getElementById('qaStatus');
  status.textContent = 'Loading local fixtures';
  try {
    const files = await Promise.all(paths.map(async path => {
      const response = await fetch(path);
      if (!response.ok) throw new Error('Fixture unavailable');
      const blob = await response.blob();
      return new File([blob], path.split('/').pop(), { type: blob.type });
    }));
    await handleFiles(files, 'convert');
    status.textContent = 'Fixtures imported';
  } catch (error) { status.textContent = error.message; }
}
function qaLoadNative() { return qaImport(['tmp/issue-16/source-a.pdf']); }
function qaLoadImages() { return qaImport(['tmp/batch6/source.png', 'tmp/batch6/target.png']); }
function qaFaultOne() {
  if (!images[1]) return;
  images[1].src = 'data:image/png;base64,AA==';
  images[1].name = 'unreadable-target.png';
  refreshAll();
  document.getElementById('qaStatus').textContent = 'Controlled decode failure inserted for page 2';
}
function qaFaultAll() {
  images.forEach(image => { image.src = 'data:image/png;base64,AA=='; });
  refreshAll();
  document.getElementById('qaStatus').textContent = 'Controlled decode failures inserted for every page';
}
