const fs = require('node:fs');
const path = require('node:path');
const { harness, PDFLib: L, native } = require('../../tests/helpers/pdf-native-harness.cjs');
const output = __dirname;
const N = value => L.PDFName.of(value);
const attachments = { a: Uint8Array.from([0, 255, 1, 2, 65, 45, 112, 114, 111, 111, 102, 10]),
  b: Uint8Array.from([255, 0, 3, 4, 66, 45, 112, 114, 111, 111, 102, 10]) };

async function sourceDocument(id) {
  const letter = id.toUpperCase(), pdf = await L.PDFDocument.create();
  const font = await pdf.embedFont(L.StandardFonts.Helvetica), bold = await pdf.embedFont(L.StandardFonts.HelveticaBold);
  const color = id === 'a' ? L.rgb(0.04, 0.35, 0.66) : L.rgb(0.78, 0.28, 0.06);
  pdf.setTitle(`Source ${letter} - Native Structure QA`); pdf.setAuthor('Page Forge regression QA'); pdf.setLanguage('en-US');
  const pages = [pdf.addPage([420, 594]), pdf.addPage([594, 420])];
  const root = pdf.context.obj({ Type: 'StructTreeRoot' }), rootRef = pdf.context.register(root);
  const document = pdf.context.obj({ Type: 'StructElem', S: 'Document', P: rootRef });
  const documentRef = pdf.context.register(document), sections = [], parentEntries = [];
  let nextParentKey = 0;
  function elem(role, parent, page, kids, extra = {}) {
    return pdf.context.register(pdf.context.obj({ Type: 'StructElem', S: role, P: parent, Pg: page.ref, K: kids, ...extra }));
  }
  function tagged(page, mcid, role, draw) {
    page.pushOperators(L.PDFOperator.of('BDC', [N(role), pdf.context.obj({ MCID: mcid })]));
    draw(); page.pushOperators(L.endMarkedContent());
  }
  const form = pdf.getForm();
  const name = form.createTextField('shared.name');
  name.setText(id === 'a' ? 'Alice A - editable' : 'Bob B - editable');
  name.addToPage(pages[0], { x: 36, y: 290, width: 300, height: 30, borderWidth: 1, borderColor: color, font });
  name.setFontSize(13);
  const approved = form.createCheckBox('shared.approved');
  approved.addToPage(pages[1], { x: 36, y: 190, width: 20, height: 20, borderWidth: 1, borderColor: color });
  if (id === 'a') approved.check(); else approved.uncheck();
  const fields = [name, approved];
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index], width = page.getWidth(), height = page.getHeight();
    const section = pdf.context.obj({ Type: 'StructElem', S: 'Sect', P: documentRef });
    const sectionRef = pdf.context.register(section); sections.push(sectionRef);
    tagged(page, 0, 'P', () => {
      page.drawText(`SOURCE ${letter} / PAGE ${index + 1}`, { x: 36, y: height - 62, size: 24, font: bold, color });
      page.drawText(index === 0 ? 'Interactive summary - portrait 420 x 594 pt' : 'Native details - landscape 594 x 420 pt',
        { x: 36, y: height - 92, size: 12, font });
      page.drawText('Native text remains selectable; the vector swatch stays sharp.', { x: 36, y: height - 120, size: 11, font });
    });
    tagged(page, 1, 'Figure', () => {
      page.drawRectangle({ x: 36, y: height - 170, width: width - 72, height: 24, color });
      page.drawLine({ start: { x: 36, y: height - 180 }, end: { x: width - 36, y: height - 180 }, color, thickness: 2 });
    });
    const paragraph = elem('P', sectionRef, page, 0, { ActualText: L.PDFString.of(`Source ${letter}, page ${index + 1}. Native editable content.`) });
    const figure = elem('Figure', sectionRef, page, 1, { Alt: L.PDFString.of(id === 'a' ? 'Blue native vector swatch' : 'Orange native vector swatch') });
    const pageParentKey = nextParentKey++, mcidParents = [paragraph, figure], kids = [paragraph, figure];
    page.node.set(N('StructParents'), L.PDFNumber.of(pageParentKey));
    if (index === 0) {
      tagged(page, 2, 'Link', () => page.drawText('Internal link: open the detail page', { x: 36, y: 245, size: 12, font, color }));
      const linkParentKey = nextParentKey++;
      const link = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', P: page.ref, Rect: [34, 241, 290, 260], Border: [0, 0, 0],
        StructParent: linkParentKey, Dest: L.PDFString.of('jump-to-details') });
      const linkRef = pdf.context.register(link); page.node.addAnnot(linkRef);
      const linked = elem('Link', sectionRef, page, [L.PDFNumber.of(2), pdf.context.obj({ Type: 'OBJR', Pg: page.ref, Obj: linkRef })]);
      mcidParents.push(linked); kids.push(linked); parentEntries.push(linkParentKey, linked);
      page.drawText('Name field (live text, with retained appearance):', { x: 36, y: 333, size: 11, font });
      page.drawText(`Attachment: proof.bin / byte payload from source ${letter}`, { x: 36, y: 210, size: 10, font });
    } else {
      page.drawText(`Approval checkbox: ${id === 'a' ? 'checked' : 'unchecked'} in source ${letter}`, { x: 66, y: 196, size: 12, font });
      page.drawText('The canonical field value and widget appearance must agree.', { x: 36, y: 158, size: 11, font });
    }
    const widget = fields[index].acroField.getWidgets()[0];
    const widgetRef = pdf.context.getObjectRef(widget.dict), widgetParentKey = nextParentKey++;
    widget.dict.set(N('StructParent'), L.PDFNumber.of(widgetParentKey));
    const formTag = elem('Form', sectionRef, page, { Type: 'OBJR', Pg: page.ref, Obj: widgetRef },
      { Alt: L.PDFString.of(index === 0 ? `Editable name for source ${letter}` : `Approval for source ${letter}`) });
    kids.push(formTag); parentEntries.push(widgetParentKey, formTag, pageParentKey, mcidParents);
    section.set(N('K'), pdf.context.obj(kids));
    page.drawText(`QA fixture ${letter}${index + 1} | text + vectors + live form + tags`, { x: 36, y: 28, size: 9, font, color });
  }
  document.set(N('K'), pdf.context.obj(sections)); root.set(N('K'), pdf.context.obj([documentRef]));
  const pairs = [];
  for (let index = 0; index < parentEntries.length; index += 2) pairs.push([parentEntries[index], parentEntries[index + 1]]);
  pairs.sort((a, b) => a[0] - b[0]);
  root.set(N('ParentTree'), pdf.context.register(pdf.context.obj({ Nums: pairs.flat() })));
  root.set(N('ParentTreeNextKey'), L.PDFNumber.of(nextParentKey));
  pdf.catalog.set(N('StructTreeRoot'), rootRef); pdf.catalog.set(N('MarkInfo'), pdf.context.obj({ Marked: true }));
  const names = pdf.context.obj({ Dests: pdf.context.register(pdf.context.obj({ Names: [L.PDFString.of('jump-to-details'), [pages[1].ref, N('Fit')]] })) });
  pdf.catalog.set(N('Names'), pdf.context.register(names));
  pdf.catalog.set(N('OpenAction'), L.PDFString.of('jump-to-details'));
  pdf.catalog.set(N('PageLabels'), pdf.context.register(pdf.context.obj({ Nums: [0, { S: 'D', P: L.PDFString.of(`${letter}-`), St: 1 }] })));
  const outline = pdf.context.obj({ Type: 'Outlines', Count: 2 }), outlineRef = pdf.context.register(outline);
  const summary = pdf.context.obj({ Title: L.PDFString.of(`${letter}: summary`), Parent: outlineRef, Dest: [pages[0].ref, N('Fit')] });
  const detail = pdf.context.obj({ Title: L.PDFString.of(`${letter}: details`), Parent: outlineRef, Dest: L.PDFString.of('jump-to-details') });
  const summaryRef = pdf.context.register(summary), detailRef = pdf.context.register(detail);
  summary.set(N('Next'), detailRef); detail.set(N('Prev'), summaryRef);
  outline.set(N('First'), summaryRef); outline.set(N('Last'), detailRef); pdf.catalog.set(N('Outlines'), outlineRef);
  await pdf.attach(attachments[id], 'proof.bin', { mimeType: 'application/octet-stream', description: `Binary evidence for source ${letter}` });
  form.updateFieldAppearances(font);
  const bytes = await pdf.save({ updateFieldAppearances: false });
  fs.writeFileSync(path.join(output, `source-${id}.pdf`), bytes);
  return { bytes, name: `source-${id}.pdf`, numPages: 2 };
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const a = await sourceDocument('a'), b = await sourceDocument('b');
  const h = harness();
  const records = { a, b }, exports = {};
  for (const [filename, images] of Object.entries({
    revised: [native('a', 1), native('a', 0, { rotation: 90 }), native('a', 1)],
    merged: [native('a', 1), native('b', 0), native('a', 0), native('b', 1)]
  })) {
    const result = await h.api.prepareStructurePreservingPdf(images, { getSource: id => records[id] });
    fs.writeFileSync(path.join(output, `${filename}.pdf`), result.bytes);
    exports[filename] = { ...result, bytes: undefined, byteLength: result.bytes.length };
  }
  fs.writeFileSync(path.join(output, 'export-reports.json'), JSON.stringify({ exports,
    attachmentHex: Object.fromEntries(Object.entries(attachments).map(([id, value]) => [id, Buffer.from(value).toString('hex')])) }, null, 2));
  console.log(JSON.stringify({ files: ['source-a.pdf', 'source-b.pdf', 'revised.pdf', 'merged.pdf'].map(file => path.join(output, file)), exports }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
