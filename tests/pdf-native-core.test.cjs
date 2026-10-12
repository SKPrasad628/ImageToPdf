const assert = require('node:assert/strict');
const { test } = require('node:test');
const { harness, PDFLib: L, native } = require('./helpers/pdf-native-harness.cjs');
const N = key => L.PDFName.of(key);
async function fixture(decorate) {
  const document = await L.PDFDocument.create();
  document.addPage([200, 300]); document.addPage([300, 400]);
  if (decorate) await decorate(document);
  return { name: 'source.pdf', numPages: 2, bytes: await document.save() };
}
test('signed source stays byte-identical untouched and is rejected before any rewrite', async () => {
  const source = await fixture(document => {
    document.catalog.set(N('Perms'), document.context.obj({ DocMDP: document.context.register(
      document.context.obj({ Type: 'Sig', ByteRange: [0, 12, 30, 10], Contents: L.PDFHexString.of('abcd') })) }));
  });
  const h = harness();
  const result = await h.api.prepareStructurePreservingPdf([native('a', 0), native('a', 1)], { getSource: () => source });
  assert.deepEqual(result.bytes, source.bytes);
  await assert.rejects(h.api.prepareStructurePreservingPdf([native('a', 1)], { getSource: () => source }), /digital signature/);
});
test('PDF scripts and XFA cannot silently survive with broken references', async () => {
  for (const decorate of [document => document.catalog.set(N('AA'), document.context.obj({
    WC: { S: 'JavaScript', JS: L.PDFString.of('this.getField("name")') }
  })), document => document.catalog.set(N('AcroForm'), document.context.obj({ Fields: [], XFA: L.PDFString.of('<xfa/>') }))]) {
    const source = await fixture(decorate);
    await assert.rejects(harness().api.prepareStructurePreservingPdf([native('a', 0)], { getSource: () => source }), /scripts|XFA/);
  }
});
test('unsupported catalog features block rewrite while exact output remains available', async () => {
  const source = await fixture(document => document.catalog.set(N('Threads'), document.context.obj([])));
  const h = harness();
  const result = await h.api.prepareStructurePreservingPdf([native('a', 0), native('a', 1)], { getSource: () => source });
  assert.deepEqual(result.bytes, source.bytes);
  await assert.rejects(h.api.prepareStructurePreservingPdf([native('a', 0)], { getSource: () => source }), /catalog feature \/Threads/);
});
test('graph copying maps cross-page references and separates duplicate self references', async () => {
  const source = await fixture(document => {
    document.getPage(0).node.set(N('TestRef'), document.getPage(1).ref);
    document.getPage(1).node.set(N('TestRef'), document.getPage(1).ref);
  });
  const h = harness();
  const plan = await h.plan({ a: source }, [native('a', 1), native('a', 0), native('a', 1)]);
  const refs = plan.document.getPages().map(page => page.ref.toString());
  assert.equal(plan.entries[0].page.node.get(plan.library.PDFName.of('TestRef')).toString(), refs[0]);
  assert.equal(plan.entries[1].page.node.get(plan.library.PDFName.of('TestRef')).toString(), refs[0]);
  assert.equal(plan.entries[2].page.node.get(plan.library.PDFName.of('TestRef')).toString(), refs[2]);
});
test('image-edited PDF originals are checked even when no native page remains', async () => {
  const source = await fixture(document => document.context.register(document.context.obj({ Type: 'Sig', ByteRange: [0, 1, 2, 3] })));
  let decoded = false;
  await assert.rejects(harness().api.prepareStructurePreservingPdf([
    { name: 'edited page', originalPdfSource: { sourceId: 'a', pageIndex: 0 } }
  ], { getSource: () => source, prepareImage() { decoded = true; } }), /digital signature/);
  assert.equal(decoded, false);
});
test('metadata and layer visibility stay connected to copied page resources', async () => {
  const source = await fixture(document => {
    document.setTitle('Layered source'); document.setLanguage('en-IN');
    const layer = document.context.register(document.context.obj({ Type: document.context.register(N('OCG')), Name: L.PDFString.of('Notes') }));
    document.catalog.set(N('OCProperties'), document.context.obj({ OCGs: [layer], D: { Order: [layer], ON: [layer] } }));
    document.getPage(0).node.set(N('Resources'), document.context.obj({ Properties: { Notes: layer } }));
  });
  const plan = await harness().plan({ a: source }, [native('a', 0), native('a', 0)]);
  const library = plan.library, name = key => library.PDFName.of(key);
  const oc = plan.document.catalog.lookup(name('OCProperties'), library.PDFDict).lookup(name('OCGs'), library.PDFArray).get(0);
  const resource = plan.entries[0].page.node.lookup(name('Resources'), library.PDFDict).lookup(name('Properties'), library.PDFDict).get(name('Notes'));
  assert.equal(oc.toString(), resource.toString());
  const duplicateResource = plan.entries[1].page.node.lookup(name('Resources'), library.PDFDict).lookup(name('Properties'), library.PDFDict).get(name('Notes'));
  assert.equal(oc.toString(), duplicateResource.toString());
  assert.equal(plan.document.getTitle(), 'Layered source');
});
test('saved print page ranges follow reordered and duplicated output positions', async () => {
  const source = await fixture(document => document.catalog.set(N('ViewerPreferences'), document.context.obj({ PrintPageRange: [0, 0], NumCopies: 2 })));
  const plan = await harness().plan({ a: source }, [native('a', 1), native('a', 0), native('a', 0)]);
  const preferences = plan.document.catalog.lookup(plan.library.PDFName.of('ViewerPreferences'), plan.library.PDFDict);
  assert.deepEqual(Array.from(preferences.lookup(plan.library.PDFName.of('PrintPageRange'), plan.library.PDFArray).asArray(), item => item.asNumber()), [1, 2]);
});
test('conformance declarations are retained exactly untouched but never falsely recertified', async () => {
  const source = await fixture(document => document.catalog.set(N('Metadata'), document.context.register(
    document.context.stream('<x:xmpmeta xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"><pdfuaid:part>1</pdfuaid:part></x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }))));
  const h = harness();
  const result = await h.api.prepareStructurePreservingPdf([native('a', 0), native('a', 1)], { getSource: () => source });
  assert.deepEqual(result.bytes, source.bytes);
  await assert.rejects(h.api.prepareStructurePreservingPdf([native('a', 0)], { getSource: () => source }), /cannot recertify/);
});
test('alternate XML encodings and escaped conformance namespaces cannot bypass native checks', async () => {
  for (const metadata of [Buffer.from('<x xmlns:a="http://www.aiim.org/pdfa/ns&#x2f;id/" a:part="1"/>'),
    Buffer.concat([Buffer.from([255, 254]), Buffer.from('<x xmlns:a="http://www.aiim.org/pdfa/ns/id/"/>', 'utf16le')]),
    Buffer.from('<!DOCTYPE x [<!ENTITY profile "http://www.aiim.org/pdfa/ns/id/">]><x/>')]) {
    const source = await fixture(document => document.catalog.set(N('Metadata'), document.context.register(
      document.context.stream(new Uint8Array(metadata), { Type: 'Metadata', Subtype: 'XML' }))));
    await assert.rejects(harness().api.prepareStructurePreservingPdf([native('a', 0)], { getSource: () => source }), /recertify|XML metadata/);
  }
});
