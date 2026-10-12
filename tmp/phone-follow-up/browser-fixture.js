async function qaLoadCameraFiles() {
  const status = document.getElementById('qaPhoneStatus');
  status.textContent = 'Loading camera fixtures';
  try {
    const files = await Promise.all(['camera-large-metadata.jpg', 'camera-large-metadata-rotated.jpg'].map(async name => {
      const response = await fetch('tmp/phone-follow-up/' + name);
      if (!response.ok) throw new Error('Camera fixture unavailable');
      const bytes = await response.blob();
      return new File([bytes], name, { type: 'image/jpeg' });
    }));
    await handleFiles(files, 'convert');
    status.textContent = 'Camera fixture import finished';
  } catch (error) { status.textContent = error.message; }
}
