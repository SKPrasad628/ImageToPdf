// Copy a PDF graph with deliberate page-reference mappings. Page-only copying
// cannot preserve the catalog's forms, destinations and logical structure.
(function () {
  'use strict';
  const handledCatalog = new Set(['Type', 'Pages', 'AcroForm', 'Outlines', 'Names',
    'Dests', 'OpenAction', 'AA', 'PageLabels', 'AF', 'StructTreeRoot', 'MarkInfo']);
  const copiedCatalog = new Set(['Version', 'Lang', 'Metadata', 'ViewerPreferences',
    'PageLayout', 'PageMode', 'URI', 'OCProperties', 'OutputIntents', 'Extensions']);
  function preflight(source, library, error) {
    const { PDFName, PDFDict } = library;
    const name = value => PDFName.of(value);
    // Rewriting signed bytes cannot retain their cryptographic validity. Never
    // emit a rewritten signature that looks intact but is no longer valid.
    const visited = new Set();
    const inspect = (object, depth = 0) => {
      if (!object || visited.has(object)) return;
      if (depth > 256 || visited.size > 250000) throw error(`“${source.name}” exceeds the supported PDF structure depth or object budget. Export the untouched document.`);
      visited.add(object);
      if (object instanceof library.PDFRef) return inspect(source.document.context.lookup(object), depth + 1);
      if (object instanceof library.PDFArray) { object.asArray().forEach(value => inspect(value, depth + 1)); return; }
      const dict = object instanceof PDFDict ? object : object.dict;
      if (!dict) return;
      if (dict.has(name('ByteRange')) || dict.get(name('Type')) === name('Sig') ||
          (dict.get(name('FT')) === name('Sig') && dict.has(name('V')) &&
            source.document.context.lookup(dict.get(name('V'))) !== library.PDFNull)) {
        throw error(`“${source.name}” contains a digital signature. Export its untouched complete document to retain the signature. A changed or merged native PDF cannot preserve signed bytes; choose Images only if you intend to discard the signature.`);
      }
      if (dict.get(name('S')) === name('JavaScript') || dict.has(name('JS'))) {
        throw error(`“${source.name}” contains PDF scripts whose page or field references cannot be safely rewritten. Export the untouched document, or choose Images to deliberately discard interactive content.`);
      }
      dict.entries().forEach(([, value]) => inspect(value, depth + 1));
    };
    for (const [, object] of source.document.context.enumerateIndirectObjects()) inspect(object);
    for (const [key] of source.document.catalog.entries()) {
      const feature = key.decodeText();
      if (!handledCatalog.has(feature) && !copiedCatalog.has(feature)) {
        throw error(`“${source.name}” uses the PDF catalog feature /${feature}, which cannot be safely rewritten. Export the untouched document, or choose Images to deliberately discard PDF structure.`);
      }
    }
    const form = source.document.catalog.lookupMaybe(name('AcroForm'), PDFDict);
    if (form && form.has(name('XFA'))) {
      throw error(`“${source.name}” contains an XFA form. Export the untouched document to keep it; choose Images only if you intend to discard the interactive form.`);
    }
    const metadata = source.document.catalog.get(name('Metadata'));
    if (metadata) {
      let bytes;
      try { bytes = library.decodePDFRawStream(source.document.context.lookup(metadata)).getBytes(1048577); }
      catch { throw error(`“${source.name}” contains metadata whose conformance declarations cannot be checked safely. Export the untouched document.`); }
      if (bytes.length > 1048576) throw error(`“${source.name}” has metadata exceeding the supported preservation limit. Export the untouched document.`);
      let xml;
      try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw error(`“${source.name}” uses unsupported XML metadata encoding. Export the untouched document.`); }
      const encoding = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(xml)?.[1];
      if (xml.includes('\u0000') || encoding && !/^(utf-8|us-ascii)$/i.test(encoding) || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
        throw error(`“${source.name}” uses XML metadata that cannot be checked safely. Export the untouched document.`);
      }
      // XML namespaces may contain numeric character references. Normalize them
      // before checking conformance; never resolve external/custom entities.
      xml = xml.replace(/&#(x[\da-f]+|\d+);/gi, (_, token) => {
        const code = token[0].toLowerCase() === 'x' ? parseInt(token.slice(1), 16) : Number(token);
        if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) {
          throw error(`“${source.name}” has invalid XML metadata character references. Export the untouched document.`);
        }
        return String.fromCodePoint(code);
      });
      if (/pdfa\/ns\/id|pdfua\/ns\/id|pdfx\/ns\/id|pdfaid:|pdfuaid:|pdfxid:/i.test(xml)) {
        throw error(`“${source.name}” declares PDF/A, PDF/UA or PDF/X conformance. Page Forge cannot recertify that standard after changes. Export the untouched document to preserve the declaration.`);
      }
    }
    const info = source.document.context.lookup(source.document.context.trailerInfo.Info);
    if (info instanceof PDFDict && (info.has(name('GTS_PDFXVersion')) || info.has(name('GTS_PDFXConformance')))) {
      throw error(`“${source.name}” declares PDF/X conformance. Export the untouched document to preserve that standard.`);
    }
  }

  function seedCopier(source, document, library, current) {
    const copier = library.PDFObjectCopier.for(source.document.context, document.context);
    const mappings = copier.traversedObjects;
    if (!(mappings instanceof Map)) throw new Error('The pinned PDF object copier is incompatible.');
    for (const page of source.pages) {
      const first = (source.navigationEntries || source.entries).find(entry => entry.sourcePage === page);
      const target = current && current.sourcePage === page ? current : first;
      mappings.set(page.ref, target ? target.page.ref : library.PDFNull);
      mappings.set(page.node, target ? target.page.node : library.PDFNull);
    }
    mappings.set(source.document.context.trailerInfo.Root, document.context.trailerInfo.Root);
    mappings.set(source.document.catalog, document.catalog);
    const seen = new Set();
    for (const page of source.pages) {
      let parent = page.node.get(library.PDFName.of('Parent'));
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        const dict = source.document.context.lookup(parent);
        mappings.set(parent, document.catalog.get(library.PDFName.of('Pages')));
        mappings.set(dict, document.catalog.Pages());
        parent = dict && dict.get(library.PDFName.of('Parent'));
      }
    }
    return copier;
  }

  async function create(library, records, images, error) {
    const document = await library.PDFDocument.create({ updateMetadata: false });
    const sources = Array.from(records, ([id, record]) => ({ ...record, id,
      pages: record.document.getPages(), entries: [], navigationEntries: [] }));
    sources.forEach(source => preflight(source, library, error));
    const sourceMap = new Map(sources.map(source => [source.id, source]));
    const entries = images.map((image, index) => {
      const page = document.addPage([1, 1]);
      if (!image.pdfSource) {
        const entry = { page, image, index };
        const descriptor = image.originalPdfSource;
        if (descriptor) {
          const source = sourceMap.get(descriptor.sourceId);
          Object.assign(entry, { pageIndex: descriptor.pageIndex,
            sourcePage: source.pages[descriptor.pageIndex], occurrence: 0, raster: true });
          source.navigationEntries.push(entry);
        }
        return entry;
      }
      const source = sourceMap.get(image.pdfSource.sourceId);
      const pageIndex = image.pdfSource.pageIndex;
      const sourcePage = source.pages[pageIndex];
      const occurrence = source.entries.filter(entry => entry.pageIndex === pageIndex).length;
      const entry = { page, image, index, sourcePage, pageIndex, occurrence };
      source.entries.push(entry);
      source.navigationEntries.push(entry);
      return entry;
    });
    for (const source of sources) source.copier = seedCopier(source, document, library);
    for (const source of sources) for (const entry of source.navigationEntries) if (entry.raster) entry.copier = source.copier;
    const plan = { library, document, sources, entries, error, report: { adjustments: [] } };
    copyCatalog(plan);
    for (const source of sources) {
      for (const entry of source.entries) {
        entry.copier = entry.occurrence ? seedCopier(source, document, library, entry) : source.copier;
        if (entry.occurrence) {
          // A duplicated comment may reply to a comment on another page. Share
          // those foreign annotations with the primary page instead of making
          // invisible extra comments whose /P points at a page without them.
          for (let pageIndex = 0; pageIndex < source.pages.length; pageIndex++) {
            if (pageIndex === entry.pageIndex) continue;
            const annotations = source.document.context.lookup(source.pages[pageIndex].node.get(library.PDFName.of('Annots')));
            if (!annotations) continue;
            if (!(annotations instanceof library.PDFArray)) throw error('A PDF annotation list is malformed. Export the untouched document.');
            const included = source.entries.some(candidate => candidate.pageIndex === pageIndex);
            for (const raw of annotations.asArray()) {
              const object = source.document.context.lookup(raw);
              const copied = included ? source.copier.copy(raw) : library.PDFNull;
              entry.copier.traversedObjects.set(raw, copied);
              entry.copier.traversedObjects.set(object, included ? document.context.lookup(copied) : library.PDFNull);
            }
          }
          // Duplicated pages share the catalog's optional-content groups. A
          // second copy of a group would disconnect layer visibility controls.
          for (const [ref, object] of source.document.context.enumerateIndirectObjects()) {
            if (object instanceof library.PDFDict && source.document.context.lookup(object.get(library.PDFName.of('Type'))) === library.PDFName.of('OCG')) {
              const copied = source.copier.copy(ref);
              entry.copier.traversedObjects.set(ref, copied);
              entry.copier.traversedObjects.set(object, document.context.lookup(copied));
            }
          }
        }
        for (const [key, value] of entry.sourcePage.node.entries()) {
          if (key !== library.PDFName.of('Parent')) entry.page.node.set(key, entry.copier.copy(value));
        }
        for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
          const name = library.PDFName.of(key);
          const value = entry.sourcePage.node.getInheritableAttribute(name);
          if (!entry.sourcePage.node.get(name) && value) entry.page.node.set(name, entry.copier.copy(value));
        }
      }
    }
    remapPrintRange(plan);
    return plan;
  }

  function remapPrintRange(plan) {
    const { document, sources, entries, library: L, error, report } = plan;
    const name = key => L.PDFName.of(key);
    const owner = sources.find(source => source.document.catalog.has(name('ViewerPreferences')));
    if (!owner) return;
    const sourcePreferences = owner.document.catalog.lookup(name('ViewerPreferences'), L.PDFDict);
    const raw = sourcePreferences.get(name('PrintPageRange'));
    if (!raw) return;
    const range = owner.document.context.lookup(raw);
    if (!(range instanceof L.PDFArray) || range.size() % 2) throw error('The PDF print page range is malformed. Export the untouched document.');
    const chosen = new Set();
    for (let index = 0; index < range.size(); index += 2) {
      const start = range.lookup(index, L.PDFNumber).asNumber();
      const end = range.lookup(index + 1, L.PDFNumber).asNumber();
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= owner.pages.length) {
        throw error('The PDF print page range is invalid. Export the untouched document.');
      }
      for (let page = start; page <= end; page++) chosen.add(page);
    }
    const selected = entries.filter(entry => {
      const descriptor = entry.image.pdfSource || entry.image.originalPdfSource;
      return descriptor && descriptor.sourceId === owner.id && chosen.has(descriptor.pageIndex);
    }).map(entry => entry.index);
    const pairs = [];
    for (const index of selected) {
      if (pairs.length && index === pairs[pairs.length - 1] + 1) pairs[pairs.length - 1] = index;
      else pairs.push(index, index);
    }
    const preferences = document.catalog.lookup(name('ViewerPreferences'), L.PDFDict);
    if (pairs.length) preferences.set(name('PrintPageRange'), document.context.obj(pairs));
    else {
      preferences.delete(name('PrintPageRange'));
      report.adjustments.push('The saved print page range was removed because none of its pages remain.');
    }
  }

  function copyCatalog(plan) {
    const { document, sources, library, error } = plan;
    // The first PDF supplies document metadata and display preferences. Extra
    // source metadata remains attached to that source rather than overwriting it.
    for (const source of sources) {
      for (const [key, value] of source.document.catalog.entries()) {
        const feature = key.decodeText();
        if (!copiedCatalog.has(feature)) continue;
        if (!document.catalog.has(key)) document.catalog.set(key, source.copier.copy(value));
        else if (['OCProperties', 'OutputIntents', 'Extensions'].includes(feature)) {
          // Layer identifiers and color-output profiles need explicit merging.
          throw error(`Cannot safely combine /${feature} from more than one PDF. Export these PDFs separately to retain that feature, or choose Images to discard PDF structure.`);
        }
      }
    }
    const primary = sources[0];
    if (primary && primary.document.context.trailerInfo.Info) {
      document.context.trailerInfo.Info = primary.copier.copy(primary.document.context.trailerInfo.Info);
    }
  }

  function finalize(plan) {
    const modules = ['PhotoPdfNativeNavigation', 'PhotoPdfNativeForms', 'PhotoPdfNativeTags'];
    for (const name of modules) {
      if (!window[name] || typeof window[name].apply !== 'function') {
        throw plan.error('The PDF structure tools are incomplete. Reload the complete app folder.');
      }
      window[name].apply(plan);
    }
    validate(plan);
    return plan.report;
  }

  function validate(plan) {
    const { document, library, error } = plan;
    const name = key => library.PDFName.of(key);
    const pages = new Set(document.getPages().map(page => page.ref.toString()));
    const seen = new Set();
    const visit = (value, depth = 0, path = 'Catalog') => {
      if (!value || value === library.PDFNull || seen.has(value)) return;
      if (depth > 256) throw error('PDF structure nesting exceeds the supported preservation depth. Export the untouched document.');
      seen.add(value);
      if (value instanceof library.PDFRef) {
        const object = document.context.lookup(value);
        if (!object) throw error(`A PDF structure reference (${value.toString()} at ${path}) could not be preserved. No incomplete PDF was exported.`);
        if (object instanceof library.PDFDict && object.get(name('Type')) === name('Page') && !pages.has(value.toString())) {
          throw error('A PDF structure entry refers to an omitted page. No incomplete PDF was exported.');
        }
        visit(object, depth + 1, path);
      } else if (value instanceof library.PDFArray) {
        value.asArray().forEach((item, index) => visit(item, depth + 1, `${path}[${index}]`));
      } else if (value instanceof library.PDFDict || value.dict) {
        const dict = value.dict || value;
        for (const [key, item] of dict.entries()) {
          if (item === library.PDFNull && ['Pg', 'P', 'Parent'].includes(key.decodeText())) {
            throw error('A PDF structure entry lost its page or parent. No incomplete PDF was exported.');
          }
          visit(item, depth + 1, `${path}/${key.decodeText()}`);
        }
      }
    };
    visit(document.catalog);
  }
  window.PhotoPdfNativeCore = Object.freeze({ create, finalize, validate });
})();
