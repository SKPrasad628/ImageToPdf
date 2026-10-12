// Rebuild document navigation against the actual output page identities.
// Source objects are read only; copied page annotations are already staged.
(function () {
  'use strict';
  const MAX_NODES = 20000;
  const MAX_DEPTH = 100;

  function apply(plan) {
    const { library: L, document: output, sources, report } = plan;
    const name = key => L.PDFName.of(key);
    const out = output.context;
    let visitedNodes = 0;
    const fail = message => { throw plan.error(`Native PDF navigation could not be preserved: ${message}`); };
    const adjustment = message => { if (!report.adjustments.includes(message)) report.adjustments.push(message); };
    const check = depth => { if (++visitedNodes > MAX_NODES || depth > MAX_DEPTH) fail('the document navigation exceeds the safe processing limit.'); };
    const lookup = (source, value) => source.document.context.lookup(value);
    const get = (dict, key) => dict.get(name(key));
    const dict = (source, value, label) => {
      const object = lookup(source, value);
      if (!(object instanceof L.PDFDict)) fail(`the ${label} is malformed.`);
      return object;
    };
    const strBytes = value => {
      if (!(value instanceof L.PDFName || value instanceof L.PDFString || value instanceof L.PDFHexString)) fail('a destination or attachment name is malformed.');
      return Array.from(value.asBytes()).map(byte => byte.toString(16).padStart(2, '0')).join('');
    };
    const stringFor = key => L.PDFHexString.of(key);
    const unique = (key, taken, sourceIndex) => {
      let result = key, counter = 1;
      while (taken.has(stringFor(result).decodeText())) {
        const suffix = ` (source ${sourceIndex + 1}${counter > 1 ? `-${counter}` : ''})`;
        const suffixBytes = Array.from(suffix).map(char => {
          const byte = char.charCodeAt(0).toString(16).padStart(2, '0');
          return key.startsWith('feff') ? `00${byte}` : key.startsWith('fffe') ? `${byte}00` : byte;
        }).join('');
        result = key + suffixBytes;
        counter++;
      }
      taken.add(stringFor(result).decodeText());
      return result;
    };

    // Name/number trees are checked before flattening: cycles, conflicting keys,
    // unknown entries and mixed leaf/interior nodes cannot be copied safely.
    function tree(source, root, numeric, label) {
      const values = new Map(), seen = new Set();
      function walk(raw, depth) {
        check(depth);
        const node = dict(source, raw, `${label} tree`);
        if (seen.has(node)) fail(`the ${label} tree contains a cycle or a shared branch.`);
        seen.add(node);
        for (const [key] of node.entries()) if (!['Names', 'Nums', 'Kids', 'Limits'].includes(key.decodeText())) fail(`the ${label} tree contains an unsupported entry /${key.decodeText()}.`);
        const kids = lookup(source, get(node, 'Kids'));
        const pairs = lookup(source, get(node, numeric ? 'Nums' : 'Names'));
        const limits = lookup(source, get(node, 'Limits'));
        if (limits) {
          if (!(limits instanceof L.PDFArray) || limits.size() !== 2) fail(`the ${label} tree limits are malformed.`);
          const ends = [lookup(source, limits.get(0)), lookup(source, limits.get(1))];
          if (numeric) {
            if (ends.some(item => !(item instanceof L.PDFNumber) || !Number.isInteger(item.asNumber()) || item.asNumber() < 0) || ends[0].asNumber() > ends[1].asNumber()) fail(`the ${label} tree limits are malformed.`);
          } else if (ends.some(item => !(item instanceof L.PDFString || item instanceof L.PDFHexString)) || strBytes(ends[0]) > strBytes(ends[1])) fail(`the ${label} tree limits are malformed.`);
        }
        if (kids && pairs) fail(`the ${label} tree mixes child nodes and values.`);
        if (kids) {
          if (!(kids instanceof L.PDFArray) || !kids.size()) fail(`the ${label} child list is malformed.`);
          for (let index = 0; index < kids.size(); index++) walk(kids.get(index), depth + 1);
        } else if (pairs) {
          if (!(pairs instanceof L.PDFArray) || pairs.size() % 2) fail(`the ${label} values are malformed.`);
          for (let index = 0; index < pairs.size(); index += 2) {
            const keyObject = lookup(source, pairs.get(index));
            let key;
            if (numeric) {
              if (!(keyObject instanceof L.PDFNumber) || !Number.isInteger(keyObject.asNumber()) || keyObject.asNumber() < 0) fail(`the ${label} index is malformed.`);
              key = keyObject.asNumber();
            } else {
              if (!(keyObject instanceof L.PDFString || keyObject instanceof L.PDFHexString)) fail(`the ${label} key must be a PDF string.`);
              key = strBytes(keyObject);
            }
            if (values.has(key)) fail(`the ${label} tree contains conflicting keys.`);
            values.set(key, pairs.get(index + 1));
          }
        } else fail(`the ${label} tree has no values or children.`);
      }
      walk(root, 0);
      return values;
    }

    const states = sources.map((source, index) => ({ source, index, destinations: new Map(), namedKeys: new Map(), firstPages: new Map(), pageIndices: new Map(), annotations: new Map() }));
    const destinationNames = new Set(), attachmentNames = new Set();
    const mergedDestinations = new Map(), mergedAttachments = new Map(), associatedFiles = [];
    for (const state of states) {
      const source = state.source;
      source.pages.forEach((page, index) => { state.pageIndices.set(page.ref, index); state.pageIndices.set(page.node, index); });
      source.pages.forEach((page, pageIndex) => {
        const annotations = lookup(source, get(page.node, 'Annots'));
        if (!annotations) return;
        if (!(annotations instanceof L.PDFArray)) fail('a source annotation list is malformed.');
        for (let index = 0; index < annotations.size(); index++) {
          check(0);
          const raw = annotations.get(index), original = dict(source, raw, 'annotation');
          if (!(raw instanceof L.PDFRef)) fail('a source annotation is not an indirect object.');
          if (state.annotations.has(original)) fail('the same annotation belongs to several source page entries.');
          const pagePointer = get(original, 'P');
          if (pagePointer && lookup(source, pagePointer) !== page.node) fail('a source annotation points to a different page than its annotation-list owner.');
          state.annotations.set(original, { raw, index, pageIndex });
        }
      });
      for (const entry of source.navigationEntries || source.entries) if (!state.firstPages.has(entry.pageIndex)) state.firstPages.set(entry.pageIndex, entry.page);
      const legacy = get(source.document.catalog, 'Dests');
      if (legacy) {
        for (const [key, value] of dict(source, legacy, 'legacy destination dictionary').entries()) state.destinations.set(strBytes(key), value);
      }
      const namesRaw = get(source.document.catalog, 'Names');
      if (namesRaw) {
        const names = dict(source, namesRaw, 'catalog name dictionary');
        for (const [key, value] of names.entries()) {
          const category = key.decodeText();
          if (category === 'Dests') {
            for (const [keyId, destination] of tree(source, value, false, 'destination')) {
              if (state.destinations.has(keyId)) fail('legacy and tree destinations use the same name.');
              state.destinations.set(keyId, destination);
            }
          } else if (category === 'EmbeddedFiles') {
            for (const [keyId, file] of tree(source, value, false, 'attachment')) {
              const specification = dict(source, file, 'embedded-file specification');
              const embedded = get(specification, 'EF');
              if (!embedded) fail('an embedded-file specification has no /EF data.');
              const streams = dict(source, embedded, 'embedded-file stream dictionary');
              if (!streams.keys().length || streams.values().some(stream => !(lookup(source, stream) instanceof L.PDFStream))) fail('an embedded-file stream is missing or malformed.');
              const outputKey = unique(keyId, attachmentNames, state.index);
              mergedAttachments.set(outputKey, source.copier.copy(file));
            }
          } else fail(`the catalog /Names/${category} feature requires an untouched original export.`);
        }
      }
      for (const key of state.destinations.keys()) state.namedKeys.set(key, unique(key, destinationNames, state.index));
      const af = lookup(source, get(source.document.catalog, 'AF'));
      if (af) {
        if (!(af instanceof L.PDFArray)) fail('the associated-file list is malformed.');
        for (let index = 0; index < af.size(); index++) {
          dict(source, af.get(index), 'associated-file specification');
          associatedFiles.push(source.copier.copy(af.get(index)));
        }
      }
    }

    function destination(state, raw, entry, active = new Set(), depth = 0, explicit = false) {
      check(depth);
      const source = state.source, value = lookup(source, raw);
      if (value instanceof L.PDFName || value instanceof L.PDFString || value instanceof L.PDFHexString) {
        const key = strBytes(value), target = state.destinations.get(key);
        if (!target) { adjustment(`A jump in “${source.name}” referenced a missing named destination and was removed.`); return null; }
        if (active.has(key)) fail('named destinations contain a cycle.');
        active.add(key);
        const valid = destination(state, target, entry, active, depth + 1, true);
        active.delete(key);
        // Self-links on duplicate pages require an explicit destination: a shared
        // named destination can otherwise point only at the first occurrence.
        return valid && (explicit || entry && state.firstPages.get(entry.pageIndex) !== entry.page) ? valid : valid && stringFor(state.namedKeys.get(key));
      }
      if (value instanceof L.PDFDict) {
        if (active.has(value)) fail('destination dictionaries contain a cycle.');
        active.add(value);
        const target = get(value, 'D');
        if (!target) fail('a destination dictionary has no /D entry.');
        for (const [key] of value.entries()) if (key.decodeText() !== 'D') fail(`the destination entry /${key.decodeText()} is unsupported.`);
        const result = destination(state, target, entry, active, depth + 1, explicit);
        active.delete(value);
        return result;
      }
      if (!(value instanceof L.PDFArray) || value.size() < 2) fail('a local destination is malformed.');
      const mode = lookup(source, value.get(1));
      const sizes = { XYZ: 5, Fit: 2, FitH: 3, FitV: 3, FitR: 6, FitB: 2, FitBH: 3, FitBV: 3 };
      if (!(mode instanceof L.PDFName) || sizes[mode.decodeText()] !== value.size()) fail('a local destination view is malformed or unsupported.');
      for (let index = 2; index < value.size(); index++) {
        const coordinate = lookup(source, value.get(index));
        if (!(coordinate instanceof L.PDFNumber && Number.isFinite(coordinate.asNumber())) && !(coordinate === L.PDFNull && mode.decodeText() !== 'FitR')) fail('a local destination coordinate is malformed.');
      }
      const originalTarget = value.get(0);
      let pageIndex = state.pageIndices.get(originalTarget);
      if (pageIndex === undefined) pageIndex = state.pageIndices.get(lookup(source, originalTarget));
      if (pageIndex === undefined) fail('a local destination does not refer to a source page.');
      const target = entry && entry.pageIndex === pageIndex ? entry.page : state.firstPages.get(pageIndex);
      if (!target) { adjustment(`Jumps to omitted page ${pageIndex + 1} of “${source.name}” were removed.`); return null; }
      const result = L.PDFArray.withContext(out);
      result.push(target.ref);
      for (let index = 1; index < value.size(); index++) result.push((entry ? entry.copier : source.copier).copy(value.get(index)));
      return result;
    }

    // Make destination definitions explicit to avoid dependent rename chains.
    for (const state of states) for (const [key, raw] of state.destinations) {
      const value = destination(state, raw, null, new Set(), 0, true);
      if (value) mergedDestinations.set(state.namedKeys.get(key), value);
    }

    function chain(actions) {
      const available = actions.filter(Boolean);
      if (!available.length) return null;
      if (available.length === 1) return available[0];
      const head = available[0];
      const existing = head.get(name('Next'));
      const next = L.PDFArray.withContext(out);
      if (existing) {
        const resolved = out.lookup(existing);
        if (resolved instanceof L.PDFArray) for (let index = 0; index < resolved.size(); index++) next.push(resolved.get(index));
        else next.push(existing);
      }
      for (const item of available.slice(1)) next.push(item);
      head.set(name('Next'), next);
      return head;
    }
    function action(state, raw, entry, active = new Set(), depth = 0) {
      check(depth);
      const source = state.source, original = dict(source, raw, 'action');
      if (active.has(original)) fail('actions contain a cycle.');
      active.add(original);
      const subtype = lookup(source, get(original, 'S'));
      if (!(subtype instanceof L.PDFName)) fail('an action has no valid subtype.');
      const type = subtype.decodeText();
      if (['JavaScript', 'GoToE', 'Movie', 'Rendition', 'GoTo3DView'].includes(type)) fail(`/${type} actions require an untouched original export.`);
      if (!['GoTo', 'GoToR', 'URI', 'Launch', 'Named', 'Hide', 'SubmitForm', 'ResetForm', 'ImportData', 'Sound', 'SetOCGState', 'Trans'].includes(type)) fail(`the action /${type} is unsupported.`);
      if (['SubmitForm', 'ResetForm', 'ImportData', 'Hide'].includes(type)) {
        const duplicates = states.some(item => {
          const pageIndices = new Set();
          return (item.source.navigationEntries || item.source.entries).some(page => { if (pageIndices.has(page.pageIndex)) return true; pageIndices.add(page.pageIndex); return false; });
        });
        if (sources.length > 1 || duplicates) fail(`/${type} actions could change their field or annotation scope after merging or duplication. Export the untouched original document.`);
      }
      const copied = out.obj({});
      const copier = entry ? entry.copier : source.copier;
      for (const [key, value] of original.entries()) if (!['D', 'Next'].includes(key.decodeText()) || key.decodeText() === 'D' && type !== 'GoTo') copied.set(key, copier.copy(value));
      if (type === 'Hide') {
        const rawTargets = get(original, 'T');
        if (!rawTargets) fail('a Hide action has no target.');
        const hideTarget = raw => {
          const target = lookup(source, raw);
          if (target instanceof L.PDFString || target instanceof L.PDFHexString) return copier.copy(raw);
          const membership = state.annotations.get(target);
          if (!(raw instanceof L.PDFRef) || !membership) fail('a Hide action target does not belong to its source annotation lists.');
          const owner = entry && entry.pageIndex === membership.pageIndex ? entry : source.entries.find(item => item.pageIndex === membership.pageIndex);
          if (!owner) fail('a Hide action target annotation was omitted from the output.');
          const list = out.lookup(get(owner.page.node, 'Annots'));
          if (!(list instanceof L.PDFArray) || membership.index >= list.size()) fail('a Hide action target lost its output annotation entry.');
          return list.get(membership.index);
        };
        const targets = lookup(source, rawTargets);
        if (targets instanceof L.PDFArray) {
          if (!targets.size()) fail('a Hide action target list is empty.');
          const rewritten = L.PDFArray.withContext(out);
          for (let index = 0; index < targets.size(); index++) rewritten.push(hideTarget(targets.get(index)));
          copied.set(name('T'), rewritten);
        } else copied.set(name('T'), hideTarget(rawTargets));
      }
      if (type === 'URI') {
        const uri = lookup(source, get(original, 'URI'));
        if (!(uri instanceof L.PDFString || uri instanceof L.PDFHexString)) fail('a URI action address is malformed.');
        const uriDictionary = get(source.document.catalog, 'URI');
        const base = uriDictionary && lookup(source, get(dict(source, uriDictionary, 'URI base dictionary'), 'Base'));
        if (base) {
          if (!(base instanceof L.PDFString || base instanceof L.PDFHexString)) fail('a URI base address is malformed.');
          try { copied.set(name('URI'), L.PDFString.of(new URL(uri.decodeText(), base.decodeText()).href)); }
          catch { fail('a relative URI cannot be resolved against its source base address.'); }
        } else {
          const outputBase = get(output.catalog, 'URI');
          if (outputBase) {
            try { new URL(uri.decodeText()); }
            catch { fail('a relative URI from a merged source would inherit a different document base.'); }
          }
        }
      }
      let target = true;
      if (type === 'GoTo') {
        const rawTarget = get(original, 'D');
        if (!rawTarget) fail('a GoTo action has no destination.');
        target = destination(state, rawTarget, entry);
        if (target) copied.set(name('D'), target);
      }
      const rawNext = get(original, 'Next'), successors = [];
      if (rawNext) {
        const next = lookup(source, rawNext);
        if (next instanceof L.PDFArray) for (let index = 0; index < next.size(); index++) successors.push(action(state, next.get(index), entry, active, depth + 1));
        else successors.push(action(state, rawNext, entry, active, depth + 1));
      }
      active.delete(original);
      return chain(target ? [copied, ...successors] : successors);
    }
    function rewriteActions(state, original, copied, entry) {
      const dest = get(original, 'Dest');
      if (dest) {
        const result = destination(state, dest, entry);
        if (result) copied.set(name('Dest'), result); else copied.delete(name('Dest'));
      }
      for (const key of ['A', 'PA']) {
        const a = get(original, key);
        if (a) {
          const result = action(state, a, entry);
          if (result) copied.set(name(key), result); else copied.delete(name(key));
        }
      }
      const aa = get(original, 'AA');
      if (aa) {
        const result = out.obj({});
        for (const [key, value] of dict(state.source, aa, 'additional-action dictionary').entries()) {
          const item = action(state, value, entry);
          if (item) result.set(key, item);
        }
        if (result.keys().length) copied.set(name('AA'), result); else copied.delete(name('AA'));
      }
    }

    function rewriteAnnotation(state, original, copied, entry) {
      rewriteActions(state, original, copied, entry);
      copied.set(name('P'), entry.page.ref);
      const subtype = lookup(state.source, get(original, 'Subtype'));
      if (!(subtype instanceof L.PDFName)) fail('a source annotation has no valid subtype.');
      if (subtype.decodeText() === 'Widget') return;
      const popup = subtype.decodeText() === 'Popup';
      if (popup && !get(original, 'Parent')) fail('a popup annotation has no parent.');
      const keys = popup ? ['IRT', 'Popup', 'Parent'] : ['IRT', 'Popup'];
      for (const key of keys) {
        const raw = get(original, key);
        if (!raw) continue;
        const target = lookup(state.source, raw), membership = state.annotations.get(target);
        if (!(raw instanceof L.PDFRef) || !membership) fail(`an annotation /${key} relationship does not refer to an annotation in its source page lists.`);
        const targetSubtype = lookup(state.source, get(target, 'Subtype'));
        if (!(targetSubtype instanceof L.PDFName) || key === 'Popup' && targetSubtype.decodeText() !== 'Popup' || key === 'Parent' && targetSubtype.decodeText() === 'Popup') fail(`an annotation /${key} relationship has an invalid target subtype.`);
        if (key === 'Popup') {
          const parent = get(target, 'Parent');
          if (!parent || lookup(state.source, parent) !== original) fail('a popup annotation points to a different parent than its owning annotation.');
        }
        const targetEntry = membership.pageIndex === entry.pageIndex ? entry : state.source.entries.find(item => item.pageIndex === membership.pageIndex);
        if (!targetEntry) {
          if (key === 'Parent') fail('a popup annotation would lose its omitted parent page.');
          copied.delete(name(key));
          if (key === 'IRT') copied.delete(name('RT'));
          adjustment(`An annotation /${key} relationship to omitted page ${membership.pageIndex + 1} of “${state.source.name}” was removed.`);
          continue;
        }
        const targetAnnotations = out.lookup(get(targetEntry.page.node, 'Annots'));
        if (!(targetAnnotations instanceof L.PDFArray) || membership.index >= targetAnnotations.size()) fail('an annotation relationship lost its output annotation-list entry.');
        copied.set(name(key), targetAnnotations.get(membership.index));
      }
    }

    const outlineRoot = out.obj({ Type: 'Outlines' }), outlineRootRef = out.register(outlineRoot), roots = [];
    function outlineLevel(state, first, active, depth) {
      const items = [];
      let current = first;
      while (current) {
        check(depth);
        const original = dict(state.source, current, 'outline item');
        if (active.has(original)) fail('bookmarks contain a cycle or a shared item.');
        active.add(original);
        const copied = out.obj({});
        for (const [key, value] of original.entries()) if (!['Parent', 'First', 'Last', 'Next', 'Prev', 'Count', 'Dest', 'A', 'AA'].includes(key.decodeText())) copied.set(key, state.source.copier.copy(value));
        rewriteActions(state, original, copied, null);
        const count = lookup(state.source, get(original, 'Count'));
        const children = get(original, 'First') ? outlineLevel(state, get(original, 'First'), active, depth + 1) : [];
        items.push({ dict: copied, ref: out.register(copied), children, open: !(count instanceof L.PDFNumber) || count.asNumber() >= 0 });
        current = get(original, 'Next');
      }
      return items;
    }
    function attachOutline(items, parent) {
      let visible = 0;
      items.forEach((item, index) => {
        item.dict.set(name('Parent'), parent);
        if (index) item.dict.set(name('Prev'), items[index - 1].ref);
        if (index + 1 < items.length) item.dict.set(name('Next'), items[index + 1].ref);
        const descendants = attachOutline(item.children, item.ref);
        if (item.children.length) {
          item.dict.set(name('First'), item.children[0].ref);
          item.dict.set(name('Last'), item.children[item.children.length - 1].ref);
          item.dict.set(name('Count'), L.PDFNumber.of(item.open ? descendants : -descendants));
        }
        visible += 1 + (item.open ? descendants : 0);
      });
      return visible;
    }

    let opening = null;
    const catalogAA = new Map();
    for (const state of states) {
      const source = state.source;
      for (const entry of source.entries) {
        if (get(entry.sourcePage.node, 'PresSteps')) fail('presentation navigation nodes require an untouched original export.');
        rewriteActions(state, entry.sourcePage.node, entry.page.node, entry);
        const annots = lookup(source, get(entry.sourcePage.node, 'Annots'));
        const copiedAnnots = out.lookup(get(entry.page.node, 'Annots'));
        if (annots) {
          if (!(annots instanceof L.PDFArray) || !(copiedAnnots instanceof L.PDFArray) || annots.size() !== copiedAnnots.size()) fail('copied page annotations do not match their source.');
          for (let index = 0; index < annots.size(); index++) rewriteAnnotation(state, dict(source, annots.get(index), 'annotation'), out.lookup(copiedAnnots.get(index), L.PDFDict), entry);
        }
      }
      const originalOutlines = get(source.document.catalog, 'Outlines');
      if (originalOutlines) {
        const root = dict(source, originalOutlines, 'outline root');
        if (get(root, 'First')) roots.push(...outlineLevel(state, get(root, 'First'), new Set(), 0));
      }
      const openAction = get(source.document.catalog, 'OpenAction');
      if (openAction) {
        const value = lookup(source, openAction);
        const result = value instanceof L.PDFDict && get(value, 'S') ? action(state, openAction, null) : destination(state, openAction, null);
        if (result && !opening) opening = result;
        else if (result) adjustment('Only the first source document’s opening view or action was retained in the merged document.');
      }
      const aa = get(source.document.catalog, 'AA');
      if (aa) for (const [key, raw] of dict(source, aa, 'catalog additional-action dictionary').entries()) {
        const value = action(state, raw, null);
        if (value) { if (!catalogAA.has(key)) catalogAA.set(key, []); catalogAA.get(key).push(value); }
      }
      // Fields may carry actions even without a widget on a selected page.
      const acroFormRaw = get(source.document.catalog, 'AcroForm');
      if (acroFormRaw) {
        function field(raw, depth, entry, seenFields) {
          check(depth);
          const original = dict(source, raw, 'form field');
          if (seenFields.has(original)) fail('form field actions contain a repeated field.');
          seenFields.add(original);
          const copied = out.lookup((entry ? entry.copier : source.copier).copy(raw));
          rewriteActions(state, original, copied, entry);
          const kids = lookup(source, get(original, 'Kids'));
          if (kids) {
            if (!(kids instanceof L.PDFArray)) fail('form field children are malformed.');
            for (let index = 0; index < kids.size(); index++) field(kids.get(index), depth + 1, entry, seenFields);
          }
        }
        const fields = lookup(source, get(dict(source, acroFormRaw, 'form'), 'Fields'));
        if (fields) {
          if (!(fields instanceof L.PDFArray)) fail('the form field list is malformed.');
          const contexts = [null, ...source.entries.filter(entry => entry.copier !== source.copier)];
          for (const entry of contexts) {
            const seenFields = new Set();
            for (let index = 0; index < fields.size(); index++) field(fields.get(index), 0, entry, seenFields);
          }
        }
      }
    }
    if (roots.length) {
      outlineRoot.set(name('First'), roots[0].ref);
      outlineRoot.set(name('Last'), roots[roots.length - 1].ref);
      outlineRoot.set(name('Count'), L.PDFNumber.of(attachOutline(roots, outlineRootRef)));
      output.catalog.set(name('Outlines'), outlineRootRef);
    }
    if (opening) output.catalog.set(name('OpenAction'), opening);
    if (catalogAA.size) {
      const aa = out.obj({});
      for (const [key, values] of catalogAA) aa.set(key, chain(values));
      output.catalog.set(name('AA'), aa);
    }
    const mergedNames = out.obj({});
    function addNameTree(category, values) {
      if (!values.size) return;
      const pairs = L.PDFArray.withContext(out);
      for (const key of Array.from(values.keys()).sort()) { pairs.push(stringFor(key)); pairs.push(values.get(key)); }
      mergedNames.set(name(category), out.register(out.obj({ Names: pairs })));
    }
    addNameTree('Dests', mergedDestinations);
    addNameTree('EmbeddedFiles', mergedAttachments);
    if (mergedNames.keys().length) output.catalog.set(name('Names'), out.register(mergedNames));
    if (associatedFiles.length) {
      const af = L.PDFArray.withContext(out);
      for (const file of associatedFiles) af.push(file);
      output.catalog.set(name('AF'), af);
    }

    if (states.some(state => get(state.source.document.catalog, 'PageLabels'))) {
      const labelsByPage = new Map();
      for (const state of states) {
        const raw = get(state.source.document.catalog, 'PageLabels');
        const ranges = raw ? Array.from(tree(state.source, raw, true, 'page label')).sort((a, b) => a[0] - b[0]) : [];
        if (ranges.some(([index]) => index >= state.source.pages.length)) fail('a page label range refers to a missing source page.');
        for (const entry of state.source.navigationEntries || state.source.entries) {
          const range = ranges.filter(([index]) => index <= entry.pageIndex).pop();
          const label = out.obj({});
          if (range) {
            const original = dict(state.source, range[1], 'page label');
            for (const [key, value] of original.entries()) {
              if (!['S', 'P', 'St'].includes(key.decodeText())) fail(`the page label entry /${key.decodeText()} is unsupported.`);
              label.set(key, state.source.copier.copy(value));
            }
            const prefix = lookup(state.source, get(original, 'P'));
            if (prefix && !(prefix instanceof L.PDFString || prefix instanceof L.PDFHexString)) fail('the page label prefix is malformed.');
            const start = lookup(state.source, get(original, 'St'));
            if (start && (!(start instanceof L.PDFNumber) || !Number.isInteger(start.asNumber()) || start.asNumber() < 1)) fail('the page label starting number is malformed.');
            const style = lookup(state.source, get(original, 'S'));
            if (style) {
              if (!(style instanceof L.PDFName) || !['D', 'R', 'r', 'A', 'a'].includes(style.decodeText())) fail('the page label numbering style is malformed.');
              label.set(name('St'), L.PDFNumber.of((start ? start.asNumber() : 1) + entry.pageIndex - range[0]));
            }
          } else { label.set(name('S'), name('D')); label.set(name('St'), L.PDFNumber.of(entry.pageIndex + 1)); }
          labelsByPage.set(entry.page, label);
        }
      }
      const nums = L.PDFArray.withContext(out);
      output.getPages().forEach((page, index) => { nums.push(L.PDFNumber.of(index)); nums.push(labelsByPage.get(page) || out.obj({ S: 'D', St: index + 1 })); });
      output.catalog.set(name('PageLabels'), out.register(out.obj({ Nums: nums })));
    }
  }
  window.PhotoPdfNativeNavigation = Object.freeze({ apply });
})();
