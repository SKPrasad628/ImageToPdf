const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/pdf-images.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const jpeg = Uint8Array.from([255,216,255,224,0,4,0,0,255,218,0,2,7,8,9,255,217]);
const exifJpeg = Uint8Array.from([255,216,255,225,0,8,69,120,105,102,0,0,255,218,0,2,7,255,217]);
const pngSignature = [137,80,78,71,13,10,26,10];
function pngChunk(type, data = []) {
  const size = data.length;
  return [size >>> 24, size >>> 16 & 255, size >>> 8 & 255, size & 255,
    ...Buffer.from(type), ...data, 0,0,0,0];
}
const png = Uint8Array.from([...pngSignature, ...pngChunk('IHDR', Array(13).fill(0)), ...pngChunk('IEND')]);

function harness(bytes = jpeg, options = {}) {
  const encodes = [], draws = [], transforms = [], canvases = [], fetches = [];
  const context = vm.createContext({
    Uint8Array, String,
    async loadImage(src) {
      if (options.decodeFailure) throw new Error('Decode failed');
      return {src, naturalWidth:1200, naturalHeight:800};
    },
    async fetch(src) {
      fetches.push(src);
      if (options.fetchFailure) throw new Error('Unreadable bytes');
      return {ok:true, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }};
    },
    exportQuality: () => 0.72,
    buildFilterStringFrom: () => 'grayscale(100%)',
    document: {
      createElement() {
        const ctx = {
          filter:'none', fillRect() { transforms.push('white'); },
          translate(...args) { transforms.push(['translate', ...args]); },
          rotate(angle) { transforms.push(['rotate', angle]); },
          scale(...args) { transforms.push(['scale', ...args]); },
          drawImage(image) { draws.push({src:image.src, filter:this.filter}); }
        };
        const canvas = {width:0, height:0, getContext:() => ctx,
          toDataURL(type, quality) { encodes.push({type,quality,width:this.width,height:this.height}); return `data:${type};base64,test`; }};
        canvases.push(canvas); return canvas;
      }
    }
  });
  vm.runInContext(source, context);
  return {context, encodes, draws, transforms, canvases, fetches,
    prepare(image = {}, settings = {}) { return context.preparePdfImage({src:'blob:current', rotation:0, ...image}, settings); }};
}

test('preservation embeds JPEG source bytes without a canvas or recompression', async () => {
  const h = harness(); const result = await h.prepare({}, {preserveQuality:true, quality:0.01});
  assert.equal(result.format, 'JPEG'); assert.deepEqual(Array.from(result.data), Array.from(jpeg));
  assert.equal(result.w,1200); assert.equal(result.h,800); assert.equal(h.encodes.length,0);
});

test('preservation embeds PNG source bytes and does not flatten transparency', async () => {
  const h = harness(png); const result = await h.prepare({}, {preserveQuality:true});
  assert.equal(result.format,'PNG'); assert.deepEqual(Array.from(result.data),Array.from(png));
  assert.equal(h.encodes.length,0); assert.equal(h.transforms.includes('white'),false);
});

test('EXIF-bearing JPEGs normalize through full-resolution lossless PNG', async () => {
  const h = harness(exifJpeg); const result = await h.prepare({}, {preserveQuality:true});
  assert.equal(result.format,'PNG'); assert.equal(h.encodes[0].type,'image/png');
  assert.equal(h.encodes[0].quality,undefined); assert.equal(h.encodes[0].width,1200);
});

test('PNG with EXIF uses orientation-aware decoded pixels', async () => {
  const bytes = Uint8Array.from([...pngSignature,...pngChunk('eXIf',[1,2,3]),...pngChunk('IEND')]);
  const h = harness(bytes); const result = await h.prepare({}, {preserveQuality:true});
  assert.equal(result.format,'PNG'); assert.equal(h.encodes.length,1);
});

for (const bytes of [Uint8Array.from([255,216,255,225,255,255]), Uint8Array.from([...pngSignature,255,255,255,255,73,69,78,68])]) {
  test(`malformed ${bytes[0] === 255 ? 'JPEG' : 'PNG'} metadata uses a safe lossless fallback`, async () => {
    const h = harness(bytes); const result = await h.prepare({}, {preserveQuality:true});
    assert.equal(result.format,'PNG'); assert.equal(h.encodes.length,1);
  });
}

test('other browser-supported formats export at full resolution as PNG', async () => {
  const h = harness(Uint8Array.from(Buffer.from('RIFF-WEBP')));
  const result = await h.prepare({}, {preserveQuality:true});
  assert.equal(result.format,'PNG'); assert.deepEqual([result.w,result.h],[1200,800]);
  assert.equal(h.encodes[0].quality,undefined); assert.equal(h.transforms.includes('white'),false);
  assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('rotation and flip preserve full-resolution pixels and apply transforms once', async () => {
  const h = harness(); const result = await h.prepare({rotation:90,flipH:true}, {preserveQuality:true});
  assert.equal(result.format,'PNG'); assert.deepEqual([result.w,result.h],[800,1200]);
  assert.equal(h.transforms.filter(call => Array.isArray(call) && call[0] === 'rotate').length,1);
  assert.deepEqual(h.transforms.find(call => Array.isArray(call) && call[0] === 'scale'),['scale',-1,1]);
  assert.equal(h.fetches.length,0);
});

test('edited photos use their current pixels rather than reverting to originalSrc', async () => {
  const h = harness(); await h.prepare({src:'blob:edited',originalSrc:'blob:original'}, {preserveQuality:true});
  assert.deepEqual(h.fetches,['blob:edited']);
});

test('switching preservation off uses the selected JPEG quality and white background', async () => {
  const h = harness(); const result = await h.prepare({}, {preserveQuality:false,quality:0.95});
  assert.equal(result.format,'JPEG'); assert.equal(h.encodes[0].type,'image/jpeg');
  assert.equal(h.encodes[0].quality,0.95); assert.equal(h.transforms.includes('white'),true);
  assert.equal(h.fetches.length,0);
});

test('unreadable source bytes still export decoded pixels losslessly', async () => {
  const h = harness(jpeg,{fetchFailure:true}); const result = await h.prepare({}, {preserveQuality:true});
  assert.equal(result.format,'PNG'); assert.equal(h.encodes[0].type,'image/png');
});

test('unreadable images are reported to the existing export skip handling', async () => {
  const h = harness(jpeg,{decodeFailure:true}); assert.equal(await h.prepare({}, {preserveQuality:true}),null);
});

function appFunction(name) {
  const match = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`));
  if (!match) throw new Error(`Missing ${name}`);
  return match[0];
}

test('toggle state persists, announces On/Off, and overrides compression selection', () => {
  const elements = new Map(), storage = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id,{value:'0.85',disabled:false,setAttribute(name,value){this[name]=value;}});
    return elements.get(id);
  };
  const context = vm.createContext({document:{getElementById:element},localStorage:{
    setItem:(key,value) => storage.set(key,value),getItem:key => storage.get(key)||null
  },updateSummary(){}});
  vm.runInContext(`let preserveOriginalQuality=false; const SETTING_IDS=['quality'];\n` +
    ['saveSettings','restoreSettings','updatePreserveQualityUI','togglePreserveQuality'].map(appFunction).join('\n'),context);
  context.togglePreserveQuality();
  assert.equal(element('preserveQualityBtn')['aria-pressed'],'true');
  assert.equal(element('preserveQualityState').textContent,'On'); assert.equal(element('quality').disabled,true);
  vm.runInContext('preserveOriginalQuality=false',context); context.restoreSettings(); context.updatePreserveQualityUI();
  assert.equal(element('preserveQualityBtn')['aria-pressed'],'true');
  context.togglePreserveQuality(); assert.equal(element('quality').disabled,false);
  assert.equal(element('quality').value,'0.85');
});

test('PDF generation passes original bytes and the correct format to jsPDF', async () => {
  const elements = new Map(), imagesAdded = [], settings = [];
  const values = {pageSize:'a4',orientation:'auto',imgFit:'contain',margin:'10',filename:'example',quality:'0.72',printDpi:'300',oversize:'shrink'};
  const element = id => {
    if (!elements.has(id)) elements.set(id,{value:values[id],classList:{remove(){},add(){}},scrollIntoView(){}});
    return elements.get(id);
  };
  class Pdf { addImage(...args) { imagesAdded.push(args); } output(type) { assert.equal(type,'blob'); return {size:100}; } }
  const context = vm.createContext({
    images:[{name:'photo'}], preserveOriginalQuality:true, currentTab:'convert', PAGE_SIZES:{a4:[210,297]},
    window:{jspdf:{jsPDF:Pdf}},document:{getElementById:element},setTimeout:resolve => {resolve();},
    exportQuality:() => 0.72,sanitizeFilename:name => name,setExportProgress(){},showToast(){},alert:message => {throw new Error(message);},
    retainUrl() {}, releaseUrl() {},
    copyPdfSource:value => value, pdfSources:new Map(), exportInProgress:false, updatePdfContentUI() {},
    lastExportReport:null,
    downloadPdfBlob() {},
    async preparePdfImage(image,options) { settings.push(options); return {data:jpeg,format:'JPEG',w:1200,h:800}; }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/pdf-layout.js'), 'utf8'), context);
  vm.runInContext(['formatFileBytes','estimateExportSize','getExportReport','publishExportReport','generatePDF'].map(appFunction).join('\n'),context); await context.generatePDF();
  assert.deepEqual(imagesAdded[0][0],jpeg); assert.equal(imagesAdded[0][1],'JPEG');
  assert.equal(settings[0].preserveQuality,true); assert.equal(element('preserveQualityBtn').disabled,false);
});
