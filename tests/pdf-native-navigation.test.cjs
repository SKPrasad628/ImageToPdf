'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { harness, PDFLib: L, native, bundled } = require('./helpers/pdf-native-harness.cjs');
const N = key => L.PDFName.of(key);
const get = (dict, key) => dict.get(N(key));

async function fixture(configure = () => {}) {
  const pdf = await L.PDFDocument.create();
  const pages = [pdf.addPage([300, 400]), pdf.addPage([300, 400]), pdf.addPage([300, 400])];
  await configure(pdf, pages);
  return { bytes: await pdf.save(), name: 'fixture.pdf', numPages: 3 };
}
function link(pdf, page, properties) {
  page.node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 100, 100], ...properties })));
}
function annotation(pdf, page, subtype, properties = {}) {
  const dictionary = pdf.context.obj({ Type: 'Annot', Subtype: subtype, Rect: [0, 0, 100, 100], ...properties });
  const ref = pdf.context.register(dictionary);
  page.node.addAnnot(ref);
  return { dictionary, ref };
}
async function exportNavigation(records, pages) {
  const h = harness(), plan = await h.plan(records, pages);
  h.window.PhotoPdfNativeNavigation.apply(plan);
  h.window.PhotoPdfNativeCore.validate(plan);
  const bytes = await plan.document.save({ updateFieldAppearances: false, addDefaultPage: false });
  return { plan, pdf: await L.PDFDocument.load(bytes, { updateMetadata: false }), bytes };
}
function annot(pdf, pageIndex, annotIndex = 0) {
  return pdf.getPages()[pageIndex].node.lookup(N('Annots'), L.PDFArray).lookup(annotIndex, L.PDFDict);
}
function namePairs(pdf, category) {
  const names = pdf.catalog.lookup(N('Names'), L.PDFDict).lookup(N(category), L.PDFDict).lookup(N('Names'), L.PDFArray);
  const result = [];
  for (let index = 0; index < names.size(); index += 2) result.push([names.lookup(index).decodeText(), names.lookup(index + 1)]);
  return result;
}

test('reordered direct links, GoTo, page AA and self-links target actual output pages', async () => {
  const source = await fixture((pdf, pages) => {
    link(pdf, pages[0], { Dest: [pages[2].ref, N('Fit')] });
    link(pdf, pages[0], { A: { S: 'GoTo', D: [pages[0].ref, N('XYZ'), null, null, null] } });
    pages[0].node.set(N('AA'), pdf.context.obj({ O: { S: 'GoTo', D: [pages[1].ref, N('Fit')] } }));
  });
  const { pdf } = await exportNavigation({ a: source }, [native('a', 2), native('a', 0), native('a', 0), native('a', 1)]);
  assert.equal(annot(pdf, 1).lookup(N('Dest'), L.PDFArray).get(0), pdf.getPages()[0].ref);
  assert.equal(annot(pdf, 2, 1).lookup(N('A'), L.PDFDict).lookup(N('D'), L.PDFArray).get(0), pdf.getPages()[2].ref);
  assert.equal(pdf.getPages()[2].node.lookup(N('AA'), L.PDFDict).lookup(N('O'), L.PDFDict).lookup(N('D'), L.PDFArray).get(0), pdf.getPages()[3].ref);
});

test('legacy and tree named destinations survive colliding merges, including duplicate self-links', async () => {
  const legacy = await fixture((pdf, pages) => {
    pdf.catalog.set(N('Dests'), pdf.context.obj({ start: { D: [pages[0].ref, N('Fit')] } }));
    link(pdf, pages[0], { Dest: N('start') });
  });
  const tree = await fixture((pdf, pages) => {
    const leaf = pdf.context.register(pdf.context.obj({ Names: [L.PDFHexString.fromText('start'), [pages[0].ref, N('Fit')]] }));
    pdf.catalog.set(N('Names'), pdf.context.obj({ Dests: { Kids: [leaf], Limits: [L.PDFHexString.fromText('start'), L.PDFHexString.fromText('start')] } }));
    link(pdf, pages[0], { A: { S: 'GoTo', D: L.PDFHexString.fromText('start') } });
  });
  const { pdf } = await exportNavigation({ a: legacy, b: tree }, [native('b', 0), native('a', 0), native('b', 0)]);
  const pairs = namePairs(pdf, 'Dests');
  assert.deepEqual(pairs.map(([key]) => key), ['start', 'start (source 2)']);
  const byName = new Map(pairs);
  assert.equal(byName.get('start').get(0), pdf.getPages()[1].ref);
  assert.equal(byName.get('start (source 2)').get(0), pdf.getPages()[0].ref);
  assert.equal(annot(pdf, 0).lookup(N('A'), L.PDFDict).lookup(N('D')).decodeText(), 'start (source 2)');
  assert.equal(annot(pdf, 2).lookup(N('A'), L.PDFDict).lookup(N('D'), L.PDFArray).get(0), pdf.getPages()[2].ref);
});

test('omitted targets are removed and reported while valid successor actions survive', async () => {
  const source = await fixture((pdf, pages) => {
    pdf.catalog.set(N('Dests'), pdf.context.obj({ gone: [pages[2].ref, N('Fit')] }));
    link(pdf, pages[0], { Dest: L.PDFString.of('gone') });
    link(pdf, pages[0], { A: { S: 'GoTo', D: [pages[2].ref, N('Fit')], Next: { S: 'URI', URI: L.PDFString.of('https://example.test') } } });
    pdf.catalog.set(N('OpenAction'), pdf.context.obj([pages[2].ref, N('Fit')]));
  });
  const { pdf, plan } = await exportNavigation({ a: source }, [native('a', 0)]);
  assert.equal(get(annot(pdf, 0), 'Dest'), undefined);
  assert.equal(annot(pdf, 0, 1).lookup(N('A'), L.PDFDict).lookup(N('S')).decodeText(), 'URI');
  assert.equal(get(pdf.catalog, 'OpenAction'), undefined);
  assert.equal(get(pdf.catalog, 'Names'), undefined);
  assert.match(plan.report.adjustments.join(' '), /omitted page 3/);
});

test('bookmark hierarchy, collapsed counts, styling and valid descendant destinations survive deletion', async () => {
  const source = await fixture((pdf, pages) => {
    const root = pdf.context.obj({ Type: 'Outlines' }), rootRef = pdf.context.register(root);
    const parent = pdf.context.obj({ Title: L.PDFString.of('Chapter'), Parent: rootRef, Count: -1, Dest: [pages[1].ref, N('Fit')], C: [1, 0, 0], F: 2 });
    const parentRef = pdf.context.register(parent);
    const child = pdf.context.obj({ Title: L.PDFString.of('Section'), Parent: parentRef, A: { S: 'GoTo', D: [pages[2].ref, N('Fit')] } });
    const childRef = pdf.context.register(child);
    parent.set(N('First'), childRef); parent.set(N('Last'), childRef);
    root.set(N('First'), parentRef); root.set(N('Last'), parentRef); root.set(N('Count'), L.PDFNumber.of(1));
    pdf.catalog.set(N('Outlines'), rootRef);
  });
  const { pdf, plan } = await exportNavigation({ a: source }, [native('a', 2), native('a', 0)]);
  const root = pdf.catalog.lookup(N('Outlines'), L.PDFDict), parent = root.lookup(N('First'), L.PDFDict), child = parent.lookup(N('First'), L.PDFDict);
  assert.equal(get(parent, 'Dest'), undefined);
  assert.equal(parent.lookup(N('Count'), L.PDFNumber).asNumber(), -1);
  assert.equal(parent.lookup(N('F'), L.PDFNumber).asNumber(), 2);
  assert.equal(child.lookup(N('A'), L.PDFDict).lookup(N('D'), L.PDFArray).get(0), pdf.getPages()[0].ref);
  assert.equal(get(child, 'Parent'), get(root, 'First'));
  assert.match(plan.report.adjustments.join(' '), /omitted page 2/);
});

test('embedded files and associated files preserve bytes and reference identity with collision-safe names', async () => {
  const make = text => fixture(async pdf => {
    await pdf.attach(Buffer.from(text), 'notes.txt', { mimeType: 'text/plain' });
    await pdf.save(); // Flush pdf-lib's pending attachment into its name tree.
    const pairs = pdf.catalog.lookup(N('Names'), L.PDFDict).lookup(N('EmbeddedFiles'), L.PDFDict).lookup(N('Names'), L.PDFArray);
    const af = pdf.context.obj([pairs.get(1)]);
    pdf.catalog.set(N('AF'), af);
  });
  const { pdf } = await exportNavigation({ a: await make('first attachment'), b: await make('second attachment') }, [native('a', 0), native('b', 0)]);
  const files = namePairs(pdf, 'EmbeddedFiles');
  assert.deepEqual(files.map(([key]) => key), ['notes.txt', 'notes.txt (source 2)']);
  const af = pdf.catalog.lookup(N('AF'), L.PDFArray);
  files.forEach(([key, file], index) => {
    const stream = file.lookup(N('EF'), L.PDFDict).lookup(N('F'));
    assert.equal(Buffer.from(L.decodePDFRawStream(stream).decode()).toString(), index ? 'second attachment' : 'first attachment');
    assert.equal(af.lookup(index), file);
  });
});

test('attachment-only source records are retained when none of their native pages remain', async () => {
  const source = await fixture(async pdf => { await pdf.attach(Buffer.from('keep this'), 'note.txt'); });
  const { pdf } = await exportNavigation({ a: source }, [{ name: 'edited image page', filters: {} }]);
  assert.equal(namePairs(pdf, 'EmbeddedFiles')[0][0], 'note.txt');
});

test('PageLabels retain source labels through reorder, duplication, merging and image gaps', async () => {
  const source = await fixture(pdf => {
    pdf.catalog.set(N('PageLabels'), pdf.context.obj({ Nums: [0, { S: 'r', P: L.PDFString.of('Intro '), St: 2 }, 2, { P: L.PDFString.of('Appendix') }] }));
  });
  const { pdf } = await exportNavigation({ a: source }, [native('a', 1), { name: 'image' }, native('a', 2), native('a', 1)]);
  const labels = pdf.catalog.lookup(N('PageLabels'), L.PDFDict).lookup(N('Nums'), L.PDFArray);
  assert.equal(labels.lookup(1, L.PDFDict).lookup(N('St'), L.PDFNumber).asNumber(), 3);
  assert.equal(labels.lookup(1, L.PDFDict).lookup(N('P')).decodeText(), 'Intro ');
  assert.equal(labels.lookup(3, L.PDFDict).lookup(N('St'), L.PDFNumber).asNumber(), 2);
  assert.equal(labels.lookup(5, L.PDFDict).lookup(N('P')).decodeText(), 'Appendix');
  assert.equal(labels.lookup(7, L.PDFDict).lookup(N('St'), L.PDFNumber).asNumber(), 3);
});

test('incoming links and page labels retain raster-replaced pages while native self-links keep their own occurrence', async () => {
  const source = await fixture((pdf, pages) => {
    pdf.catalog.set(N('Dests'), pdf.context.obj({ target: [pages[1].ref, N('Fit')] }));
    pdf.catalog.set(N('PageLabels'), pdf.context.obj({ Nums: [0, { S: 'D', P: L.PDFString.of('Source ') }] }));
    link(pdf, pages[0], { Dest: N('target') });
    link(pdf, pages[1], { A: { S: 'GoTo', D: N('target') } });
    pages[1].node.set(N('AA'), pdf.context.obj({ O: { S: 'URI', URI: L.PDFString.of('https://example.test/native-only') } }));
  });
  const raster = { name: 'edited source page', originalPdfSource: { sourceId: 'a', pageIndex: 1 } };
  const { pdf } = await exportNavigation({ a: source }, [native('a', 0), raster, native('a', 1)]);
  const destination = new Map(namePairs(pdf, 'Dests')).get('target');
  assert.equal(destination.get(0), pdf.getPages()[1].ref);
  assert.equal(annot(pdf, 0).lookup(N('Dest')).decodeText(), 'target');
  assert.equal(annot(pdf, 2).lookup(N('A'), L.PDFDict).lookup(N('D'), L.PDFArray).get(0), pdf.getPages()[2].ref);
  assert.equal(pdf.getPages()[1].node.get(N('Annots')), undefined);
  assert.equal(pdf.getPages()[1].node.get(N('AA')), undefined);
  const labels = pdf.catalog.lookup(N('PageLabels'), L.PDFDict).lookup(N('Nums'), L.PDFArray);
  assert.equal(labels.lookup(3, L.PDFDict).lookup(N('St'), L.PDFNumber).asNumber(), 2);
  assert.equal(labels.lookup(5, L.PDFDict).lookup(N('St'), L.PDFNumber).asNumber(), 2);
});

test('catalog opening destination is remapped and colliding catalog events retain chained actions', async () => {
  const make = tag => fixture((pdf, pages) => {
    pdf.catalog.set(N('OpenAction'), pdf.context.obj([pages[0].ref, N('Fit')]));
    pdf.catalog.set(N('AA'), pdf.context.obj({ WC: { S: 'URI', URI: L.PDFString.of(`https://example.test/${tag}`) } }));
  });
  const { pdf, plan } = await exportNavigation({ a: await make('a'), b: await make('b') }, [native('b', 0), native('a', 0)]);
  assert.equal(pdf.catalog.lookup(N('OpenAction'), L.PDFArray).get(0), pdf.getPages()[1].ref);
  const close = pdf.catalog.lookup(N('AA'), L.PDFDict).lookup(N('WC'), L.PDFDict);
  assert.equal(close.lookup(N('URI')).decodeText(), 'https://example.test/a');
  assert.equal(close.lookup(N('Next'), L.PDFArray).lookup(0, L.PDFDict).lookup(N('URI')).decodeText(), 'https://example.test/b');
  assert.match(plan.report.adjustments.join(' '), /opening view/);
});

test('relative URI and previous URI actions retain each source base after merging', async () => {
  const make = tag => fixture((pdf, pages) => {
    pdf.catalog.set(N('URI'), pdf.context.obj({ Base: L.PDFString.of(`https://example.test/${tag}/`) }));
    link(pdf, pages[0], { A: { S: 'URI', URI: L.PDFString.of('detail') }, PA: { S: 'URI', URI: L.PDFString.of('previous') } });
  });
  const { pdf } = await exportNavigation({ a: await make('a'), b: await make('b') }, [native('b', 0), native('a', 0)]);
  assert.equal(annot(pdf, 0).lookup(N('A'), L.PDFDict).lookup(N('URI')).decodeText(), 'https://example.test/b/detail');
  assert.equal(annot(pdf, 1).lookup(N('PA'), L.PDFDict).lookup(N('URI')).decodeText(), 'https://example.test/a/previous');
});

test('independent PDF.js reads rebuilt destinations, bookmarks, attachments and labels', async () => {
  const source = await fixture(async (pdf, pages) => {
    pdf.catalog.set(N('Names'), pdf.context.obj({ Dests: { Names: [L.PDFHexString.fromText('Chapter'), [pages[2].ref, N('Fit')]] } }));
    link(pdf, pages[0], { Dest: L.PDFHexString.fromText('Chapter') });
    const root = pdf.context.obj({ Type: 'Outlines' }), rootRef = pdf.context.register(root);
    const item = pdf.context.register(pdf.context.obj({ Title: L.PDFHexString.fromText('Chapter'), Parent: rootRef, Dest: L.PDFHexString.fromText('Chapter') }));
    root.set(N('First'), item); root.set(N('Last'), item); root.set(N('Count'), L.PDFNumber.of(1));
    pdf.catalog.set(N('Outlines'), rootRef);
    pdf.catalog.set(N('PageLabels'), pdf.context.obj({ Nums: [0, { S: 'r' }] }));
    pdf.catalog.set(N('OpenAction'), pdf.context.obj([pages[2].ref, N('Fit')]));
    await pdf.attach(Buffer.from('independent reader'), 'note.txt');
  });
  const { bytes } = await exportNavigation({ a: source }, [native('a', 2), native('a', 0)]);
  const reader = await import(pathToFileURL(path.join(bundled, 'pdfjs-dist/legacy/build/pdf.mjs')).href);
  const task = reader.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const destinations = await pdf.getDestinations();
    assert.equal(await pdf.getPageIndex(destinations.Chapter[0]), 0);
    assert.equal((await pdf.getOutline())[0].dest, 'Chapter');
    assert.deepEqual(await pdf.getPageLabels(), ['iii', 'i']);
    assert.equal(Buffer.from((await pdf.getAttachments())['note.txt'].content).toString(), 'independent reader');
    assert.equal((await (await pdf.getPage(2)).getAnnotations())[0].dest, 'Chapter');
    assert.equal(await pdf.getPageIndex((await pdf.getOpenAction()).dest[0]), 0);
  } finally { await task.destroy(); }
});

test('duplicated form field actions keep their own self-target after form-tree rebuilding', async () => {
  const source = await fixture((pdf, pages) => {
    const field = pdf.getForm().createTextField('jump');
    field.setText('content');
    field.addToPage(pages[0], { x: 0, y: 0, width: 100, height: 20 });
    pdf.catalog.set(N('Dests'), pdf.context.obj({ here: [pages[0].ref, N('Fit')] }));
    field.acroField.dict.set(N('AA'), pdf.context.obj({ K: { S: 'GoTo', D: N('here') } }));
  });
  const h = harness(), plan = await h.plan({ a: source }, [native('a', 0), native('a', 0)]);
  h.window.PhotoPdfNativeCore.finalize(plan);
  const pdf = await L.PDFDocument.load(await plan.document.save({ updateFieldAppearances: false }));
  const fields = pdf.getForm().getFields();
  assert.equal(fields.length, 2);
  const duplicated = fields.find(field => field.acroField.getWidgets()[0].dict.get(N('P')) === pdf.getPages()[1].ref);
  assert.ok(duplicated);
  assert.equal(duplicated.acroField.dict.lookup(N('AA'), L.PDFDict).lookup(N('K'), L.PDFDict).lookup(N('D'), L.PDFArray).get(0), pdf.getPages()[1].ref);
});

test('duplicated replies target actual foreign-page annotations and duplicate popups keep their own parents', async () => {
  const source = await fixture((pdf, pages) => {
    const parent = annotation(pdf, pages[1], 'Text', { P: pages[1].ref });
    const popup = annotation(pdf, pages[1], 'Popup', { Parent: parent.ref, P: pages[1].ref });
    parent.dictionary.set(N('Popup'), popup.ref);
    annotation(pdf, pages[0], 'Text', { IRT: parent.ref, RT: N('R'), P: pages[0].ref });
  });
  const { pdf } = await exportNavigation({ a: source }, [native('a', 0), native('a', 1), native('a', 0), native('a', 1)]);
  const foreign = pdf.getPages()[1].node.lookup(N('Annots'), L.PDFArray).get(0);
  assert.equal(annot(pdf, 0).get(N('IRT')), foreign);
  assert.equal(annot(pdf, 2).get(N('IRT')), foreign);
  const duplicate = pdf.getPages()[3].node.lookup(N('Annots'), L.PDFArray);
  assert.equal(annot(pdf, 3).get(N('Popup')), duplicate.get(1));
  assert.equal(annot(pdf, 3, 1).get(N('Parent')), duplicate.get(0));
  assert.notEqual(duplicate.get(0), foreign);
  pdf.getPages().forEach((page, index) => {
    const list = page.node.lookup(N('Annots'), L.PDFArray);
    for (let annotIndex = 0; annotIndex < list.size(); annotIndex++) assert.equal(annot(pdf, index, annotIndex).get(N('P')), page.ref);
  });
});

test('annotation reply and popup relationships to omitted pages are removed and reported', async () => {
  const source = await fixture((pdf, pages) => {
    const parent = annotation(pdf, pages[1], 'Text');
    const reply = annotation(pdf, pages[0], 'Text', { IRT: parent.ref, RT: N('R') });
    const popup = annotation(pdf, pages[1], 'Popup', { Parent: reply.ref });
    reply.dictionary.set(N('Popup'), popup.ref);
  });
  const { pdf, plan } = await exportNavigation({ a: source }, [native('a', 0)]);
  assert.equal(annot(pdf, 0).get(N('IRT')), undefined);
  assert.equal(annot(pdf, 0).get(N('RT')), undefined);
  assert.equal(annot(pdf, 0).get(N('Popup')), undefined);
  assert.equal(annot(pdf, 0).get(N('P')), pdf.getPages()[0].ref);
  assert.match(plan.report.adjustments.join(' '), /annotation \/IRT relationship.*omitted page 2/);
  assert.match(plan.report.adjustments.join(' '), /annotation \/Popup relationship.*omitted page 2/);
});

for (const type of ['SubmitForm', 'ResetForm', 'ImportData']) {
  test(`full native export rejects ${type} source-wide actions before merging private foreign fields`, async () => {
    const publicSource = await fixture((pdf, pages) => {
      const field = pdf.getForm().createTextField('public');
      field.setText('shareable');
      field.addToPage(pages[0], { x: 0, y: 0, width: 100, height: 20 });
      link(pdf, pages[0], { A: { S: type, F: L.PDFString.of('https://example.test/submit'), Flags: 4 } });
    });
    const privateSource = await fixture((pdf, pages) => {
      const field = pdf.getForm().createTextField('private');
      field.setText('private content');
      field.addToPage(pages[0], { x: 0, y: 0, width: 100, height: 20 });
    });
    const records = { a: publicSource, b: privateSource }, h = harness();
    await assert.rejects(h.api.prepareStructurePreservingPdf([native('a', 0), native('b', 0)], { getSource: id => records[id] }), new RegExp(`${type}.*scope`));
    await assert.rejects(h.api.prepareStructurePreservingPdf([native('a', 0), native('a', 0)], { getSource: id => records[id] }), new RegExp(`${type}.*scope`));
  });
}

test('full native export rejects exclusion-based form submission after merging', async () => {
  const actionSource = await fixture((pdf, pages) => { link(pdf, pages[0], { A: { S: 'SubmitForm', F: L.PDFString.of('https://example.test/submit'), Flags: 1, Fields: [L.PDFString.of('public')] } }); });
  const records = { a: actionSource, b: await fixture() }, h = harness();
  await assert.rejects(h.api.prepareStructurePreservingPdf([native('a', 0), native('b', 0)], { getSource: id => records[id] }), /SubmitForm.*scope/);
});

test('Hide annotation targets use output membership and refuse an omitted target in full native export', async () => {
  const source = await fixture((pdf, pages) => {
    const target = annotation(pdf, pages[1], 'Text');
    link(pdf, pages[0], { A: { S: 'Hide', T: [target.ref] } });
  });
  const { pdf } = await exportNavigation({ a: source }, [native('a', 1), native('a', 0)]);
  const targets = annot(pdf, 1).lookup(N('A'), L.PDFDict).lookup(N('T'), L.PDFArray);
  assert.equal(targets.get(0), pdf.getPages()[0].node.lookup(N('Annots'), L.PDFArray).get(0));
  const h = harness();
  await assert.rejects(h.api.prepareStructurePreservingPdf([native('a', 0)], { getSource: () => source }), /Hide action target annotation was omitted/);
});

for (const [label, configure, expected] of [
  ['cyclic name trees', pdf => { const tree = pdf.context.obj({}), ref = pdf.context.register(tree); tree.set(N('Kids'), pdf.context.obj([ref])); pdf.catalog.set(N('Names'), pdf.context.obj({ Dests: ref })); }, /cycle/],
  ['unknown name tree feature', pdf => { pdf.catalog.set(N('Names'), pdf.context.obj({ Templates: { Names: [] } })); }, /Names\/Templates/],
  ['unknown name tree entry', pdf => { pdf.catalog.set(N('Names'), pdf.context.obj({ Dests: { Names: [], Special: true } })); }, /unsupported entry/],
  ['malformed name tree limits', pdf => { pdf.catalog.set(N('Names'), pdf.context.obj({ Dests: { Names: [], Limits: [1, 2] } })); }, /limits/],
  ['malformed destination view', (pdf, pages) => { link(pdf, pages[0], { Dest: [pages[0].ref, N('XYZ')] }); }, /destination view/],
  ['malformed page labels', pdf => { pdf.catalog.set(N('PageLabels'), pdf.context.obj({ Nums: [0, { S: 'D', P: 1 }] })); }, /label prefix/],
  ['malformed attachment specifications', pdf => { pdf.catalog.set(N('Names'), pdf.context.obj({ EmbeddedFiles: { Names: [L.PDFString.of('broken'), { Type: 'Filespec' }] } })); }, /\/EF/],
  ['presentation navigation nodes', (pdf, pages) => { pages[0].node.set(N('PresSteps'), pdf.context.obj({})); }, /presentation navigation/],
  ['orphaned popup after parent deletion', (pdf, pages) => { const parent = annotation(pdf, pages[1], 'Text'); annotation(pdf, pages[0], 'Popup', { Parent: parent.ref }); }, /popup annotation would lose/],
  ['wrong annotation page pointer', (pdf, pages) => { annotation(pdf, pages[0], 'Text', { P: pages[1].ref }); }, /different page/],
  ['annotation relationships outside page membership', (pdf, pages) => { const ghost = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [0, 0, 1, 1] })); annotation(pdf, pages[0], 'Text', { IRT: ghost }); }, /source page lists/],
  ['popup without a parent', (pdf, pages) => { annotation(pdf, pages[0], 'Popup'); }, /popup annotation has no parent/],
  ['cyclic named destinations', pdf => { pdf.catalog.set(N('Dests'), pdf.context.obj({ a: N('b'), b: N('a') })); }, /cycle/],
  ['unsafe embedded navigation', (pdf, pages) => { link(pdf, pages[0], { A: { S: 'GoToE', D: [0, N('Fit')], T: { R: 'C', N: L.PDFString.of('notes.txt') } } }); }, /GoToE/],
  ['unsafe rendition targets', (pdf, pages) => { link(pdf, pages[0], { A: { S: 'Rendition', AN: pages[1].ref } }); }, /Rendition/],
  ['unsafe three-dimensional view targets', (pdf, pages) => { link(pdf, pages[0], { A: { S: 'GoTo3DView', TA: pages[1].ref } }); }, /GoTo3DView/],
  ['cyclic actions', (pdf, pages) => { const a = pdf.context.obj({ S: 'URI', URI: L.PDFString.of('https://example.test') }), ref = pdf.context.register(a); a.set(N('Next'), ref); link(pdf, pages[0], { A: ref }); }, /cycle/],
  ['unknown actions', (pdf, pages) => { link(pdf, pages[0], { A: { S: 'Unrecognised' } }); }, /unsupported/],
  ['cyclic bookmarks', pdf => { const item = pdf.context.obj({ Title: L.PDFString.of('bad') }), ref = pdf.context.register(item); item.set(N('Next'), ref); pdf.catalog.set(N('Outlines'), pdf.context.obj({ First: ref })); }, /cycle/]
]) {
  test(`${label} fail closed instead of silently discarding document features`, async () => {
    const source = await fixture(configure);
    await assert.rejects(exportNavigation({ a: source }, [native('a', 0)]), expected);
  });
}

test('PDF scripts in form actions are rejected before native rewriting', async () => {
  const source = await fixture((pdf, pages) => {
    const field = pdf.getForm().createTextField('field');
    field.addToPage(pages[0], { x: 0, y: 0, width: 100, height: 20 });
    field.acroField.dict.set(N('AA'), pdf.context.obj({ K: { S: 'JavaScript', JS: L.PDFString.of('this.pageNum = 1') } }));
  });
  await assert.rejects(exportNavigation({ a: source }, [native('a', 0)]), /PDF scripts/);
});
