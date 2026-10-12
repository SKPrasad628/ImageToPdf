const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { harness, PDFLib: L, native, bundled } = require('./helpers/pdf-native-harness.cjs');
const N = name => L.PDFName.of(name);

async function fixture(options = {}) {
  const pdf = await L.PDFDocument.create();
  const pages = [pdf.addPage([400, 500]), pdf.addPage([400, 500]), pdf.addPage([400, 500])];
  const form = pdf.getForm();
  const text = form.createTextField('person.name');
  text.setText(options.text || 'Alice');
  text.addToPage(pages[0], { x: 20, y: 400, width: 200, height: 30 });
  text.addToPage(pages[1], { x: 20, y: 400, width: 200, height: 30 });
  const check = form.createCheckBox('confirmed');
  check.addToPage(pages[0], { x: 20, y: 350, width: 20, height: 20 });
  check.check();
  const radio = form.createRadioGroup('colour');
  radio.addOptionToPage('Red', pages[0], { x: 20, y: 300, width: 20, height: 20 });
  radio.addOptionToPage('Blue', pages[1], { x: 20, y: 300, width: 20, height: 20 });
  radio.addOptionToPage('Green', pages[2], { x: 20, y: 300, width: 20, height: 20 });
  radio.select(options.radio || 'Blue');
  const drop = form.createDropdown('choice');
  drop.addOptions(['One', 'Two']); drop.select('Two');
  drop.addToPage(pages[2], { x: 20, y: 400, width: 200, height: 30 });
  const acro = pdf.catalog.lookup(N('AcroForm'), L.PDFDict);
  const hidden = form.createTextField('calculation'); hidden.setText('42');
  acro.set(N('CO'), pdf.context.obj([hidden.ref, text.ref]));
  form.updateFieldAppearances();
  if (options.mutate) await options.mutate({ pdf, pages, form, acro, text, radio, check, hidden });
  return { bytes: await pdf.save({ updateFieldAppearances: false }), name: options.name || 'form.pdf', numPages: 3 };
}

async function rebuild(records, pages) {
  const h = harness();
  const plan = await h.plan(records, pages);
  h.window.PhotoPdfNativeForms.apply(plan);
  h.window.PhotoPdfNativeCore.validate(plan);
  const bytes = await plan.document.save({ updateFieldAppearances: false });
  return { h, plan, pdf: await L.PDFDocument.load(bytes), bytes };
}

async function exportNative(records, pages) {
  const h = harness();
  const result = await h.api.prepareStructurePreservingPdf(pages, { getSource: id => records[id] });
  return { result, pdf: await L.PDFDocument.load(result.bytes) };
}

function checkTree(pdf) {
  const context = pdf.context, pages = pdf.getPages();
  const form = pdf.catalog.lookup(N('AcroForm'), L.PDFDict);
  const roots = form.lookup(N('Fields'), L.PDFArray), widgets = new Set(), seen = new Set();
  function visit(ref, parent) {
    assert.ok(ref instanceof L.PDFRef, 'fields and widgets are indirect objects');
    const dict = context.lookup(ref, L.PDFDict);
    assert.ok(!seen.has(dict), 'tree has no repeated nodes'); seen.add(dict);
    assert.equal(dict.get(N('Parent'))?.toString(), parent?.toString());
    if (dict.get(N('Subtype')) === N('Widget')) {
      widgets.add(dict);
      const page = pages.find(page => page.ref.toString() === dict.get(N('P')).toString());
      assert.ok(page, 'widget belongs to a retained page');
      assert.ok(page.node.Annots().asArray().some(ref => context.lookup(ref) === dict), 'widget is in that page annotation array');
    }
    const kids = dict.lookupMaybe(N('Kids'), L.PDFArray);
    if (kids) kids.asArray().forEach(kid => visit(kid, ref));
  }
  roots.asArray().forEach(ref => visit(ref));
  for (const page of pages) for (const raw of page.node.Annots()?.asArray() || []) {
    const dict = context.lookup(raw);
    if (dict.get(N('Subtype')) === N('Widget')) assert.ok(widgets.has(dict), 'each retained page widget belongs to the AcroForm tree');
  }
  return widgets.size;
}

test('retained text/check/radio/choice fields preserve values, hierarchy and appearances', async () => {
  const record = await fixture();
  const { pdf } = await rebuild({ a: record }, [native('a', 2), native('a', 0), native('a', 1)]);
  const form = pdf.getForm();
  assert.equal(form.getTextField('person.name').getText(), 'Alice');
  assert.equal(form.getCheckBox('confirmed').isChecked(), true);
  assert.equal(form.getRadioGroup('colour').getSelected(), 'Blue');
  assert.deepEqual(form.getRadioGroup('colour').getOptions(), ['Red', 'Blue', 'Green']);
  assert.deepEqual(form.getDropdown('choice').getSelected(), ['Two']);
  assert.equal(form.getTextField('calculation').getText(), '42');
  assert.equal(checkTree(pdf), 7);
  for (const field of form.getFields()) for (const widget of field.acroField.getWidgets()) {
    assert.ok(widget.dict.has(N('AP')), 'existing widget appearance remains');
  }
});

test('deleted pages prune widget Kids and positional radio options while retaining a selected option', async () => {
  const record = await fixture();
  const { pdf, plan } = await rebuild({ a: record }, [native('a', 1), native('a', 0)]);
  const form = pdf.getForm();
  assert.equal(form.getTextField('person.name').acroField.getWidgets().length, 2);
  assert.deepEqual(form.getRadioGroup('colour').getOptions(), ['Red', 'Blue']);
  assert.equal(form.getRadioGroup('colour').getSelected(), 'Blue');
  assert.throws(() => form.getDropdown('choice'), /no form field/i);
  assert.equal(checkTree(pdf), 5);
  assert.ok(plan.report.adjustments.some(text => /2 form widgets.*omitted pages/.test(text)));
});

test('removing the selected radio widget clears its stale value and keeps the remaining button interactive', async () => {
  const record = await fixture();
  const { pdf, plan } = await rebuild({ a: record }, [native('a', 0)]);
  const form = pdf.getForm();
  assert.equal(form.getRadioGroup('colour').getSelected(), undefined);
  assert.deepEqual(form.getRadioGroup('colour').getOptions(), ['Red']);
  form.getRadioGroup('colour').select('Red');
  assert.equal(form.getRadioGroup('colour').getSelected(), 'Red');
  assert.equal(checkTree(pdf), 3);
  assert.ok(plan.report.adjustments.some(text => /selected option.*colour.*cleared/.test(text)));
});

test('duplicated pages receive independent named field trees without changing the original radio group', async () => {
  const record = await fixture();
  const { pdf, plan } = await rebuild({ a: record }, [native('a', 0), native('a', 1), native('a', 0)]);
  const form = pdf.getForm();
  assert.equal(form.getTextField('person.name').getText(), 'Alice');
  assert.equal(form.getTextField('person_copy2_1.name').getText(), 'Alice');
  form.getTextField('person_copy2_1.name').setText('Duplicate');
  assert.equal(form.getTextField('person.name').getText(), 'Alice');
  assert.equal(form.getTextField('person_copy2_1.name').getText(), 'Duplicate');
  assert.deepEqual(form.getRadioGroup('colour').getOptions(), ['Red', 'Blue']);
  assert.equal(form.getRadioGroup('colour').getSelected(), 'Blue');
  assert.deepEqual(form.getRadioGroup('colour_copy2_1').getOptions(), ['Red']);
  assert.equal(form.getRadioGroup('colour_copy2_1').getSelected(), undefined);
  assert.throws(() => form.getTextField('calculation_copy2_1'), /no form field/i);
  assert.equal(checkTree(pdf), 8);
  const co = pdf.catalog.lookup(N('AcroForm'), L.PDFDict).lookup(N('CO'), L.PDFArray);
  assert.equal(co.size(), 3);
  assert.ok(plan.report.adjustments.some(text => /keep its values independent/.test(text)));
});

test('merging colliding form names keeps both field values and default resources independent', async () => {
  const a = await fixture({ text: 'Alice', name: 'a.pdf', mutate({ pdf, acro, text }) {
    const resources = pdf.context.obj({ Font: { Shared: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' } } });
    acro.set(N('DR'), resources); acro.set(N('DA'), L.PDFString.of('/Shared 12 Tf 0 g'));
    text.acroField.dict.set(N('DA'), L.PDFString.of('/Shared 12 Tf 0 g'));
  } });
  const b = await fixture({ text: 'Bob', name: 'b.pdf', mutate({ pdf, acro, text }) {
    const resources = pdf.context.obj({ Font: { Shared: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier' } } });
    acro.set(N('DR'), resources); acro.set(N('DA'), L.PDFString.of('/Shared 12 Tf 0 g'));
    text.acroField.dict.set(N('DA'), L.PDFString.of('/Shared 12 Tf 0 g'));
  } });
  const { pdf } = await rebuild({ a, b }, [native('a', 0), native('b', 0)]);
  const form = pdf.getForm();
  assert.equal(form.getTextField('person.name').getText(), 'Alice');
  assert.equal(form.getTextField('person_source2_1.name').getText(), 'Bob');
  const acro = pdf.catalog.lookup(N('AcroForm'), L.PDFDict);
  const fonts = acro.lookup(N('DR'), L.PDFDict).lookup(N('Font'), L.PDFDict);
  assert.equal(fonts.lookup(N('Shared'), L.PDFDict).get(N('BaseFont')), N('Helvetica'));
  assert.equal(fonts.lookup(N('Shared_PF2_1'), L.PDFDict).get(N('BaseFont')), N('Courier'));
  const secondRoot = acro.lookup(N('Fields'), L.PDFArray).asArray().map(ref => pdf.context.lookup(ref)).find(dict => dict.lookup(N('T')).decodeText() === 'person_source2_1');
  assert.match(secondRoot.lookup(N('DA')).asString(), /\/Shared_PF2_1 12 Tf/);
  assert.equal(checkTree(pdf), 6);
});

test('the full exporter rewrites merged DA resources after CR-only comments without touching comment text', async () => {
  function mutate(font, appearance) {
    return ({ pdf, acro, text }) => {
      acro.set(N('DR'), pdf.context.obj({ Font: { Shared: { Type: 'Font', Subtype: 'Type1', BaseFont: font } } }));
      acro.set(N('DA'), L.PDFString.of(appearance));
      text.acroField.dict.set(N('DA'), L.PDFString.of(appearance));
    };
  }
  const a = await fixture({ name: 'a.pdf', text: 'Alice', mutate: mutate('Helvetica', '/Shared 12 Tf 0 g') });
  const b = await fixture({ name: 'b.pdf', text: 'Bob', mutate: mutate('Courier', '% /Shared stays in comment\r/S#68ared 12 Tf 0 g') });
  const { pdf } = await exportNative({ a, b }, [native('a', 0), native('b', 0)]);
  const form = pdf.getForm();
  assert.equal(form.getTextField('person.name').getText(), 'Alice');
  assert.equal(form.getTextField('person_source2_1.name').getText(), 'Bob');
  const appearance = form.getTextField('person_source2_1.name').acroField.dict.lookup(N('DA')).asString();
  assert.equal(appearance, '% /Shared stays in comment\r/Shared_PF2_1 12 Tf 0 g');
  const root = form.getTextField('person_source2_1.name').acroField.dict.lookup(N('Parent'), L.PDFDict);
  assert.equal(root.lookup(N('DA')).asString(), appearance);
  const fonts = pdf.catalog.lookup(N('AcroForm'), L.PDFDict).lookup(N('DR'), L.PDFDict).lookup(N('Font'), L.PDFDict);
  assert.equal(fonts.lookup(N('Shared'), L.PDFDict).get(N('BaseFont')), N('Helvetica'));
  assert.equal(fonts.lookup(N('Shared_PF2_1'), L.PDFDict).get(N('BaseFont')), N('Courier'));
  assert.equal(checkTree(pdf), 6);
});

test('merged field/widget dictionaries are retained with correct page and no stale Parent', async () => {
  const pdf = await L.PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  const field = pdf.context.obj({ FT: 'Tx', T: L.PDFString.of('single'), V: L.PDFString.of('Combined'),
    Type: 'Annot', Subtype: 'Widget', Rect: [20, 200, 200, 230], P: page.ref,
    DA: L.PDFString.of('/Helv 12 Tf'), AP: { N: pdf.context.register(pdf.context.flateStream('q Q', { BBox: [0, 0, 180, 30], Resources: {} })) } });
  const ref = pdf.context.register(field); page.node.addAnnot(ref);
  pdf.catalog.set(N('AcroForm'), pdf.context.obj({ Fields: [ref], DR: { Font: { Helv: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' } } } }));
  const record = { bytes: await pdf.save({ updateFieldAppearances: false }), name: 'combined.pdf', numPages: 1 };
  const result = await rebuild({ a: record }, [native('a', 0), native('a', 0)]);
  assert.equal(result.pdf.getForm().getTextField('single').getText(), 'Combined');
  assert.equal(result.pdf.getForm().getTextField('single_copy2_1').getText(), 'Combined');
  assert.equal(checkTree(result.pdf), 2);
});

test('an unsigned signature placeholder retains its field and widget', async () => {
  const record = await fixture({ mutate({ pdf, acro, pages }) {
    const field = pdf.context.obj({ FT: 'Sig', T: L.PDFString.of('signHere'), Kids: [] });
    const ref = pdf.context.register(field);
    const widget = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [20, 30, 180, 70], P: pages[0].ref, Parent: ref }));
    field.lookup(N('Kids'), L.PDFArray).push(widget); pages[0].node.addAnnot(widget);
    acro.lookup(N('Fields'), L.PDFArray).push(ref);
  } });
  const { pdf } = await rebuild({ a: record }, [native('a', 0)]);
  assert.ok(pdf.getForm().getSignature('signHere'));
  assert.equal(checkTree(pdf), 4);
});

for (const [label, mutate, pattern] of [
  ['orphan widget', ({ pdf, pages }) => pages[0].node.addAnnot(pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 20, 20], P: pages[0].ref }))), /orphan form widget/],
  ['wrong widget page', ({ pages, text }) => text.acroField.getWidgets()[0].dict.set(N('P'), pages[1].ref), /wrong page/],
  ['shared field child', ({ acro }) => acro.lookup(N('Fields'), L.PDFArray).push(acro.lookup(N('Fields'), L.PDFArray).get(0)), /cyclic or shared/],
  ['unknown field type', ({ text }) => text.acroField.dict.set(N('FT'), N('Unknown')), /unsupported field type/],
  ['XFA form', ({ acro }) => acro.set(N('XFA'), L.PDFString.of('<xfa/>')), /XFA/]
]) {
  test(`${label} fails safely instead of emitting a corrupt AcroForm`, async () => {
    const record = await fixture({ mutate });
    await assert.rejects(rebuild({ a: record }, [native('a', 0)]), pattern);
  });
}

test('a form-name action in a direct dictionary blocks a duplicated field rename', async () => {
  const record = await fixture({ mutate({ pdf, text }) {
    text.acroField.dict.set(N('AA'), pdf.context.obj({ K: { S: 'ResetForm', Fields: [L.PDFString.of('person.name')] } }));
  } });
  await assert.rejects(rebuild({ a: record }, [native('a', 0), native('a', 0)]), /field-name actions.*renaming/);
  const kept = await rebuild({ a: record }, [native('a', 0)]);
  const action = kept.pdf.getForm().getTextField('person.name').acroField.dict.lookup(N('AA'), L.PDFDict).lookup(N('K'), L.PDFDict);
  assert.equal(action.get(N('S')), N('ResetForm'));
  assert.equal(action.lookup(N('Fields'), L.PDFArray).lookup(0).decodeText(), 'person.name');
});

test('ImportData actions block duplicated field renaming because external FDF field names cannot be rewritten', async () => {
  const record = await fixture({ mutate({ pdf, text }) {
    text.acroField.dict.set(N('AA'), pdf.context.obj({ K: { S: 'ImportData', F: L.PDFString.of('values.fdf') } }));
  } });
  await assert.rejects(rebuild({ a: record }, [native('a', 0), native('a', 0)]), /field-name actions.*renaming/);
  const { pdf } = await rebuild({ a: record }, [native('a', 0)]);
  const action = pdf.getForm().getTextField('person.name').acroField.dict.lookup(N('AA'), L.PDFDict).lookup(N('K'), L.PDFDict);
  assert.equal(action.get(N('S')), N('ImportData'));
  assert.equal(action.lookup(N('F')).decodeText(), 'values.fdf');
});

test('an action in the first source blocks field renaming in another source', async () => {
  const a = await fixture({ name: 'actions.pdf', mutate({ pdf, text }) {
    text.acroField.dict.set(N('AA'), pdf.context.obj({ K: { S: 'Hide', T: L.PDFString.of('person.name') } }));
  } });
  const b = await fixture({ name: 'renamed.pdf' });
  await assert.rejects(rebuild({ a, b }, [native('a', 0), native('b', 0)]), /actions.pdf.*field-name actions.*renamed.pdf.*renaming/);
});

test('name-sensitive actions are checked even when their source has no AcroForm', async () => {
  const source = await L.PDFDocument.create();
  const page = source.addPage([300, 400]);
  page.node.set(N('AA'), source.context.obj({ O: { S: 'Hide', T: L.PDFString.of('person.name') } }));
  const noForm = { bytes: await source.save(), name: 'no-form.pdf', numPages: 1 };
  const a = await fixture({ name: 'first-form.pdf' }), b = await fixture({ name: 'renamed-form.pdf' });
  await assert.rejects(rebuild({ noForm, a, b }, [native('noForm', 0), native('a', 0), native('b', 0)]), /no-form.pdf.*field-name actions.*renamed-form.pdf.*renaming/);
});

test('radio option indexing stays correct when the first option is removed', async () => {
  const record = await fixture();
  const { pdf } = await rebuild({ a: record }, [native('a', 1), native('a', 2)]);
  const radio = pdf.getForm().getRadioGroup('colour');
  assert.deepEqual(radio.getOptions(), ['Blue', 'Green']);
  assert.equal(radio.getSelected(), 'Blue');
  radio.select('Green');
  assert.equal(radio.getSelected(), 'Green');
  assert.equal(checkTree(pdf), 4);
});

test('push buttons keep inherited field type/flags when one of their widgets is omitted', async () => {
  const record = await fixture({ mutate({ pdf, form, pages }) {
    const button = form.createButton('actions.send');
    button.addToPage('Send', pages[0], { x: 100, y: 250, width: 100, height: 30 });
    button.addToPage('Send', pages[1], { x: 100, y: 250, width: 100, height: 30 });
    const parent = button.acroField.dict.lookup(N('Parent'), L.PDFDict);
    parent.set(N('FT'), button.acroField.dict.get(N('FT')));
    parent.set(N('Ff'), button.acroField.dict.get(N('Ff')));
    button.acroField.dict.delete(N('FT')); button.acroField.dict.delete(N('Ff'));
  } });
  const { pdf } = await rebuild({ a: record }, [native('a', 0)]);
  assert.equal(pdf.getForm().getButton('actions.send').acroField.getWidgets().length, 1);
  assert.equal(checkTree(pdf), 4);
});

test('the independent PDF.js reader finds valid named widget values on reordered and duplicated output', async () => {
  const entry = path.join(bundled, 'pdfjs-dist/legacy/build/pdf.mjs');
  assert.ok(fs.existsSync(entry), 'bundled independent PDF.js reader is installed');
  const pdfjs = await import(pathToFileURL(entry).href);
  const record = await fixture();
  const { bytes } = await rebuild({ a: record }, [native('a', 1), native('a', 0), native('a', 0)]);
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true,
    standardFontDataUrl: path.join(bundled, 'pdfjs-dist/standard_fonts').replaceAll('\\', '/') + '/' });
  const reader = await task.promise;
  try {
    const first = await (await reader.getPage(1)).getAnnotations();
    const second = await (await reader.getPage(2)).getAnnotations();
    const duplicate = await (await reader.getPage(3)).getAnnotations();
    assert.equal(first.find(widget => widget.fieldName === 'person.name').fieldValue, 'Alice');
    assert.equal(second.find(widget => widget.fieldName === 'person.name').fieldValue, 'Alice');
    assert.equal(duplicate.find(widget => widget.fieldName === 'person_copy2_1.name').fieldValue, 'Alice');
    assert.equal(first.find(widget => widget.fieldName === 'colour').fieldValue, '1');
    assert.equal(duplicate.find(widget => widget.fieldName === 'colour_copy2_1').fieldValue, 'Off');
    assert.equal(duplicate.find(widget => widget.fieldName === 'confirmed_copy2_1').fieldValue, 'Yes');
  } finally { await reader.destroy(); }
});
