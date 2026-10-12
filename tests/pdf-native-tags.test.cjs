const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { harness, PDFLib: L, native, bundled } = require('./helpers/pdf-native-harness.cjs');
const N = value => L.PDFName.of(value);

async function fixture(options = {}) {
  const pdf = await L.PDFDocument.create();
  pdf.setLanguage(options.lang || 'en-US');
  const root = pdf.context.obj({ Type: 'StructTreeRoot' }), rootRef = pdf.context.register(root);
  const document = pdf.context.obj({ Type: 'StructElem', S: 'Document', P: rootRef });
  const documentRef = pdf.context.register(document);
  root.set(N('K'), pdf.context.obj([documentRef]));
  const sections = [], parents = [], ids = [];
  for (let index = 0; index < 2; index++) {
    const page = pdf.addPage([300 + index * 10, 400]);
    page.pushOperators(L.PDFOperator.of('BDC', [N('P'), pdf.context.obj({ MCID: 0 })]));
    page.drawText(`Tagged source page ${index + 1}`, { x: 25, y: 350 });
    page.pushOperators(L.endMarkedContent());
    page.pushOperators(L.PDFOperator.of('BDC', [N('Figure'), pdf.context.obj({ MCID: 2 })]));
    page.drawRectangle({ x: 25, y: 290, width: 40, height: 30 });
    page.pushOperators(L.endMarkedContent());
    const section = pdf.context.obj({ Type: 'StructElem', S: 'Sect', P: documentRef });
    const sectionRef = pdf.context.register(section);
    sections.push(sectionRef);
    const paragraph = pdf.context.obj({ Type: 'StructElem', S: options.role || 'P', P: sectionRef,
      Pg: page.ref, K: 0, ActualText: L.PDFString.of(`Actual page ${index + 1}`), ID: L.PDFString.of(`p${index}`) });
    if (options.className) paragraph.set(N('C'), N(options.className));
    const paragraphRef = pdf.context.register(paragraph);
    ids.push(L.PDFString.of(`p${index}`), paragraphRef);
    const figure = pdf.context.obj({ Type: 'StructElem', S: 'Figure', P: sectionRef, Pg: page.ref,
      K: { Type: 'MCR', Pg: page.ref, MCID: 2 }, Alt: L.PDFString.of(`Rectangle on page ${index + 1}`) });
    const figureRef = pdf.context.register(figure);
    const link = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [25, 330, 200, 355],
      StructParent: index * 10 + 1, P: page.ref, A: { S: 'URI', URI: L.PDFString.of('https://example.test/') } });
    const linkRef = pdf.context.register(link); page.node.addAnnot(linkRef);
    const linked = pdf.context.obj({ Type: 'StructElem', S: 'Link', P: sectionRef,
      Pg: page.ref, K: { Type: 'OBJR', Pg: page.ref, Obj: linkRef } });
    const linkedRef = pdf.context.register(linked);
    section.set(N('K'), pdf.context.obj([paragraphRef, figureRef, linkedRef]));
    page.node.set(N('StructParents'), L.PDFNumber.of(index * 10));
    parents.push(index * 10, [paragraphRef, L.PDFNull, figureRef], index * 10 + 1, linkedRef);
  }
  document.set(N('K'), pdf.context.obj(sections));
  root.set(N('ParentTree'), pdf.context.register(pdf.context.obj({ Nums: parents })));
  root.set(N('ParentTreeNextKey'), L.PDFNumber.of(12));
  root.set(N('IDTree'), pdf.context.register(pdf.context.obj({ Names: ids })));
  if (options.role) root.set(N('RoleMap'), pdf.context.obj({ [options.role]: options.roleTarget || 'P' }));
  if (options.className) root.set(N('ClassMap'), pdf.context.obj({ [options.className]: { O: 'Layout', SpaceBefore: options.space || 3 } }));
  pdf.catalog.set(N('StructTreeRoot'), rootRef);
  pdf.catalog.set(N('MarkInfo'), pdf.context.obj({ Marked: true, UserProperties: true }));
  if (options.mutate) options.mutate(pdf);
  return { bytes: await pdf.save(), name: options.name || 'tagged.pdf', numPages: 2 };
}

async function rewrite(records, images) {
  const h = harness(), plan = await h.plan(records, images);
  h.window.PhotoPdfNativeTags.apply(plan);
  h.window.PhotoPdfNativeCore.validate(plan);
  const bytes = await plan.document.save({ updateFieldAppearances: false });
  return { h, plan, bytes, pdf: await L.PDFDocument.load(bytes) };
}

function structure(pdf) {
  const root = pdf.catalog.lookup(N('StructTreeRoot'), L.PDFDict), rootRef = pdf.catalog.get(N('StructTreeRoot'));
  const elements = [], content = [], objects = [];
  const pages = new Set(pdf.getPages().map(page => page.ref.toString()));
  function walk(raw, parent, inherited) {
    const value = pdf.context.lookup(raw);
    if (value instanceof L.PDFArray) { value.asArray().forEach(kid => walk(kid, parent, inherited)); return; }
    if (value instanceof L.PDFNumber) { content.push({ parent, page: inherited, mcid: value.asNumber() }); return; }
    assert.ok(value instanceof L.PDFDict);
    const pg = value.get(N('Pg')) || inherited;
    if (pg) assert.ok(pages.has(pg.toString()), 'every tag page belongs to the output page tree');
    const type = value.lookupMaybe(N('Type'), L.PDFName)?.decodeText();
    if (type === 'MCR') { content.push({ parent, page: pg, mcid: value.lookup(N('MCID'), L.PDFNumber).asNumber() }); return; }
    if (type === 'OBJR') { objects.push({ parent, page: pg, obj: value.get(N('Obj')) }); return; }
    assert.equal(value.get(N('P')).toString(), parent.toString(), 'each structure parent is rebuilt');
    elements.push({ ref: raw, value });
    const kids = value.get(N('K')); if (kids) walk(kids, raw, pg);
  }
  const kids = root.get(N('K')); if (kids) walk(kids, rootRef);
  const nums = root.lookup(N('ParentTree'), L.PDFDict).lookup(N('Nums'), L.PDFArray);
  const parents = new Map();
  for (let index = 0; index < nums.size(); index += 2) {
    const key = nums.lookup(index, L.PDFNumber).asNumber();
    assert.equal(parents.has(key), false, 'parent keys are globally unique');
    parents.set(key, nums.get(index + 1));
  }
  for (const item of content) {
    const page = pdf.context.lookup(item.page);
    const key = page.lookup(N('StructParents'), L.PDFNumber).asNumber();
    const owners = pdf.context.lookup(parents.get(key), L.PDFArray);
    assert.equal(owners.get(item.mcid).toString(), item.parent.toString(), 'each MCID resolves back to its enclosing element');
  }
  for (const item of objects) {
    const object = pdf.context.lookup(item.obj, L.PDFDict);
    const page = pdf.context.lookup(item.page);
    assert.ok(page.lookup(N('Annots'), L.PDFArray).asArray().some(ref => ref.toString() === item.obj.toString()));
    assert.equal(parents.get(object.lookup(N('StructParent'), L.PDFNumber).asNumber()).toString(), item.parent.toString());
  }
  const ownedKeys = new Set(pdf.getPages().map(page => page.node.lookupMaybe(N('StructParents'), L.PDFNumber)?.asNumber()).filter(value => value !== undefined));
  objects.forEach(item => ownedKeys.add(pdf.context.lookup(item.obj).lookup(N('StructParent'), L.PDFNumber).asNumber()));
  assert.equal(ownedKeys.size, parents.size, 'the parent tree contains no omitted-page entries');
  return { root, elements, content, objects, parents };
}

test('tagged page deletion prunes hierarchy, ParentTree, and IDTree without flattening it', async () => {
  const record = await fixture();
  const result = await rewrite({ a: record }, [native('a', 1)]);
  const tags = structure(result.pdf);
  assert.deepEqual(tags.elements.map(item => item.value.lookup(N('S'), L.PDFName).decodeText()), ['Document', 'Sect', 'P', 'Figure', 'Link']);
  assert.equal(tags.content.length, 2); assert.equal(tags.objects.length, 1);
  const paragraph = tags.elements.find(item => item.value.lookup(N('S'), L.PDFName) === N('P')).value;
  assert.equal(paragraph.lookup(N('ActualText'), L.PDFString).decodeText(), 'Actual page 2');
  const names = tags.root.lookup(N('IDTree'), L.PDFDict).lookup(N('Names'), L.PDFArray);
  assert.equal(names.size(), 2); assert.equal(names.lookup(0, L.PDFString).decodeText(), 'p1');
  assert.match(result.plan.report.adjustments.join(' '), /omitted pages/);
});

test('tagged page reorder follows page positions while keeping nested semantic ancestry', async () => {
  const result = await rewrite({ a: await fixture() }, [native('a', 1), native('a', 0)]);
  const tags = structure(result.pdf);
  assert.deepEqual(tags.content.map(item => item.page.toString()), [result.pdf.getPage(0).ref.toString(), result.pdf.getPage(0).ref.toString(), result.pdf.getPage(1).ref.toString(), result.pdf.getPage(1).ref.toString()]);
  assert.equal(tags.elements.filter(item => item.value.lookup(N('S'), L.PDFName) === N('Document')).length, 1);
  assert.equal(tags.elements.filter(item => item.value.lookup(N('S'), L.PDFName) === N('Sect')).length, 2);
});

test('duplicated tagged pages get independent hierarchy, annotation refs, IDTree, and parent indexes', async () => {
  const result = await rewrite({ a: await fixture() }, [native('a', 0), native('a', 0), native('a', 0)]);
  const tags = structure(result.pdf);
  assert.equal(tags.content.length, 6); assert.equal(tags.objects.length, 3);
  assert.equal(new Set(tags.objects.map(item => item.obj.toString())).size, 3);
  assert.equal(new Set(result.pdf.getPages().map(page => page.node.lookup(N('StructParents'), L.PDFNumber).asNumber())).size, 3);
  assert.equal(tags.elements.filter(item => item.value.lookup(N('S'), L.PDFName) === N('Document')).length, 3);
  const ids = tags.elements.filter(item => item.value.has(N('ID'))).map(item => item.value.lookup(N('ID')).decodeText());
  assert.equal(new Set(ids).size, 3);
});

test('tagged source merges isolate conflicting roles, classes, identifiers, and document languages', async () => {
  const a = await fixture({ role: 'Custom', roleTarget: 'P', className: 'Spacing', lang: 'en-US' });
  const b = await fixture({ role: 'Custom', roleTarget: 'H1', className: 'Spacing', space: 9, lang: 'fr-FR' });
  const result = await rewrite({ a, b }, [native('b', 0), native('a', 0)]);
  const tags = structure(result.pdf), roles = tags.root.lookup(N('RoleMap'), L.PDFDict), classes = tags.root.lookup(N('ClassMap'), L.PDFDict);
  assert.equal(roles.keys().length, 2); assert.equal(classes.keys().length, 2);
  const paragraphs = tags.elements.filter(item => item.value.has(N('ID')));
  const targets = paragraphs.map(item => roles.lookup(item.value.lookup(N('S'), L.PDFName), L.PDFName).decodeText());
  assert.deepEqual(targets, ['H1', 'P']);
  const top = tags.elements.filter(item => item.value.lookup(N('S'), L.PDFName) === N('Document'));
  assert.equal(top[0].value.lookup(N('Lang'), L.PDFString).decodeText(), 'fr-FR');
  assert.equal(result.pdf.catalog.lookup(N('Lang'), L.PDFString).decodeText(), 'en-US');
  assert.match(result.plan.report.adjustments.join(' '), /role names.*attribute classes.*identifiers/s);
});

test('adding an untagged page retains existing tags and marks the result as incomplete', async () => {
  const record = await fixture(), h = harness();
  const plan = await h.plan({ a: record }, [native('a', 0), { name: 'photo' }]);
  h.window.PhotoPdfNativeTags.apply(plan);
  const pdf = await L.PDFDocument.load(await plan.document.save());
  structure(pdf);
  const mark = pdf.catalog.lookup(N('MarkInfo'), L.PDFDict);
  assert.equal(mark.lookup(N('Marked')), L.PDFBool.True);
  assert.equal(mark.lookup(N('UserProperties')), L.PDFBool.True);
  assert.equal(mark.lookup(N('Suspects')), L.PDFBool.True);
  assert.match(plan.report.adjustments.join(' '), /not fully tagged/);
});

test('structure IDs and table Headers references stay matched after source merge and duplication', async () => {
  const record = await fixture({ mutate(pdf) {
    const root = pdf.catalog.lookup(N('StructTreeRoot'), L.PDFDict);
    const doc = pdf.context.lookup(root.lookup(N('K'), L.PDFArray).get(0));
    for (const sectionRef of doc.lookup(N('K'), L.PDFArray).asArray()) {
      const section = pdf.context.lookup(sectionRef), kids = section.lookup(N('K'), L.PDFArray);
      const header = pdf.context.lookup(kids.get(0)), data = pdf.context.lookup(kids.get(1));
      section.set(N('S'), N('Table'));
      const row = pdf.context.obj({ Type: 'StructElem', S: 'TR', P: sectionRef, K: [kids.get(0), kids.get(1)] });
      const rowRef = pdf.context.register(row);
      header.set(N('P'), rowRef); data.set(N('P'), rowRef);
      header.set(N('S'), N('TH')); data.set(N('S'), N('TD'));
      data.set(N('A'), pdf.context.obj({ O: 'Table', Headers: [header.get(N('ID'))] }));
      section.set(N('K'), pdf.context.obj([rowRef, kids.get(2)]));
    }
  } });
  const result = await rewrite({ a: record, b: record }, [native('a', 0), native('b', 0), native('b', 0)]);
  const tags = structure(result.pdf);
  const headers = tags.elements.filter(item => item.value.lookup(N('S'), L.PDFName) === N('TH'));
  const cells = tags.elements.filter(item => item.value.lookup(N('S'), L.PDFName) === N('TD'));
  assert.equal(headers.length, 3); assert.equal(cells.length, 3);
  const headerIds = headers.map(item => item.value.lookup(N('ID')).decodeText());
  assert.equal(new Set(headerIds).size, 3);
  assert.deepEqual(cells.map(item => item.value.lookup(N('A'), L.PDFDict).lookup(N('Headers'), L.PDFArray).lookup(0).decodeText()), headerIds);
});

test('page ownership inherited from ancestors is materialized on retained marked-content elements', async () => {
  const record = await fixture({ mutate(pdf) {
    const root = pdf.catalog.lookup(N('StructTreeRoot'), L.PDFDict);
    const doc = pdf.context.lookup(root.lookup(N('K'), L.PDFArray).get(0));
    for (let index = 0; index < 2; index++) {
      const section = pdf.context.lookup(doc.lookup(N('K'), L.PDFArray).get(index));
      section.set(N('Pg'), pdf.getPage(index).ref);
      const paragraph = pdf.context.lookup(section.lookup(N('K'), L.PDFArray).get(0));
      paragraph.delete(N('Pg'));
    }
  } });
  const result = await rewrite({ a: record }, [native('a', 1), native('a', 1)]);
  assert.equal(structure(result.pdf).content.length, 4);
});

test('the complete native exporter retains tagged structure through merge and page edits', async () => {
  const a = await fixture(), b = await fixture({ lang: 'de-DE' }), h = harness();
  const result = await h.api.prepareStructurePreservingPdf([native('a', 1), native('b', 0), native('a', 1, { rotation: 90 })],
    { getSource: id => ({ a, b })[id] });
  const pdf = await L.PDFDocument.load(result.bytes);
  assert.equal(structure(pdf).content.length, 6);
  assert.equal(pdf.getPage(2).getRotation().angle, 90);
  assert.equal(result.exactOriginal, false);
});

test('independent PDF.js structure parsing sees tags, alternatives, and annotation objects after reorder and duplication', async () => {
  const result = await rewrite({ a: await fixture() }, [native('a', 1), native('a', 0), native('a', 1)]);
  const pdfjs = await import(pathToFileURL(path.join(bundled, 'pdfjs-dist/legacy/build/pdf.mjs')).href);
  const task = pdfjs.getDocument({ data: new Uint8Array(result.bytes), isEvalSupported: false, useSystemFonts: true });
  const pdf = await task.promise;
  try {
    for (let index = 1; index <= 3; index++) {
      const page = await pdf.getPage(index), tree = await page.getStructTree();
      const text = (await page.getTextContent({ includeMarkedContent: true })).items;
      const serialized = JSON.stringify(tree);
      assert.match(serialized, /"role":"Document"/); assert.match(serialized, /"role":"Sect"/);
      assert.match(serialized, /"role":"Figure"/); assert.match(serialized, /Rectangle on page/);
      assert.match(serialized, /"role":"Link"/); assert.match(serialized, /"type":"annotation"/);
      assert.ok(text.some(item => item.type === 'beginMarkedContentProps' && item.id));
      page.cleanup();
    }
  } finally { await pdf.destroy(); }
});

for (const [label, mutate, expression] of [
  ['inconsistent MCID parent mapping', pdf => {
    const root = pdf.catalog.lookup(N('StructTreeRoot'), L.PDFDict);
    root.lookup(N('ParentTree'), L.PDFDict).lookup(N('Nums'), L.PDFArray).lookup(1, L.PDFArray).set(0, L.PDFNull);
  }, /parent-tree mapping is inconsistent/],
  ['stream-owned marked content', pdf => {
    const root = pdf.catalog.lookup(N('StructTreeRoot'), L.PDFDict);
    const doc = pdf.context.lookup(root.lookup(N('K'), L.PDFArray).get(0));
    const section = pdf.context.lookup(doc.lookup(N('K'), L.PDFArray).get(0));
    const figure = pdf.context.lookup(section.lookup(N('K'), L.PDFArray).get(1));
    figure.lookup(N('K'), L.PDFDict).set(N('Stm'), pdf.context.register(pdf.context.flateStream('')));
  }, /unsupported \/Stm/],
  ['unsupported structure namespace', pdf => pdf.catalog.lookup(N('StructTreeRoot'), L.PDFDict).set(N('Namespaces'), pdf.context.obj([])), /unsupported \/Namespaces/],
  ['invalid structure parent', pdf => {
    const root = pdf.catalog.lookup(N('StructTreeRoot'), L.PDFDict);
    pdf.context.lookup(root.lookup(N('K'), L.PDFArray).get(0)).set(N('P'), pdf.getPage(0).ref);
  }, /inconsistent parent/],
  ['orphan annotation parent index', pdf => {
    const annotation = pdf.context.lookup(pdf.getPage(0).node.Annots().get(0));
    annotation.set(N('StructParent'), L.PDFNumber.of(999));
  }, /annotation parent-tree mapping is inconsistent|orphan indexes/],
  ['cyclic role maps', pdf => pdf.catalog.lookup(N('StructTreeRoot'), L.PDFDict).set(N('RoleMap'), pdf.context.obj({ Foo: 'Bar', Bar: 'Foo' })), /role map is cyclic/]
  , ['shared structure parent indexes', pdf => pdf.getPage(1).node.set(N('StructParents'), L.PDFNumber.of(0)), /shared between different objects/]
  , ['cyclic structure child arrays', pdf => {
    const root = pdf.catalog.lookup(N('StructTreeRoot'), L.PDFDict), kids = pdf.context.obj([]);
    const ref = pdf.context.register(kids); kids.push(ref); root.set(N('K'), ref);
  }, /safe processing limit/]
]) {
  test(`native tags fail closed for ${label}`, async () => {
    const record = await fixture({ mutate }), h = harness();
    const plan = await h.plan({ a: record }, [native('a', 0)]);
    assert.throws(() => h.window.PhotoPdfNativeTags.apply(plan), error => expression.test(error.message) && /Choose Images/.test(error.message));
  });
}

test('empty structure roots remain present when the source contains no tags', async () => {
  const pdf = await L.PDFDocument.create(); pdf.addPage([100, 100]);
  pdf.catalog.set(N('StructTreeRoot'), pdf.context.register(pdf.context.obj({ Type: 'StructTreeRoot', K: [] })));
  const result = await rewrite({ a: { bytes: await pdf.save(), name: 'empty.pdf', numPages: 1 } }, [native('a', 0)]);
  assert.equal(structure(result.pdf).elements.length, 0);
});
