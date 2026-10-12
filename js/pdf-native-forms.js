// Rebuild AcroForm trees around the widgets that actually survived page export.
// Page copying alone leaves stale field Kids/Parents and cannot merge forms.
(function () {
  'use strict';

  function apply(plan) {
    const { library: L, document: output, sources, report } = plan;
    const N = key => L.PDFName.of(key);
    const fail = message => { throw plan.error(`Interactive PDF forms cannot be preserved safely: ${message}`); };
    const lookup = (context, value) => value === undefined ? undefined : context.lookup(value);
    const isNull = value => value === undefined || value === L.PDFNull;
    const nameOf = value => value instanceof L.PDFName ? value.decodeText() : undefined;
    const textOf = value => value instanceof L.PDFString || value instanceof L.PDFHexString ? value.decodeText() : undefined;
    const adjustment = message => report.adjustments.push(message);
    const inherited = (node, key, context) => {
      for (let current = node; current; current = current.parent) {
        const value = lookup(context, current.dict.get(N(key)));
        if (!isNull(value)) return value;
      }
      return undefined;
    };
    const models = [], nameActionSources = new Set();

    // Validate the source graph before changing any copied field dictionaries.
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
      const source = sources[sourceIndex];
      const context = source.document.context;
      // Name-sensitive actions have document-wide scope, including actions in
      // sources without a field tree. Another source's renamed fields can be
      // affected, so this check cannot be limited to the source being renamed.
      const actionSeen = new Set();
      const actionQueue = context.enumerateIndirectObjects().map(([, object]) => object);
      while (actionQueue.length) {
        const object = lookup(context, actionQueue.pop());
        if (!object || actionSeen.has(object)) continue;
        if (actionSeen.size > 1000000) fail(`“${source.name}” has form actions exceeding the supported object limit.`);
        actionSeen.add(object);
        if (object instanceof L.PDFArray) {
          for (const item of object.asArray()) actionQueue.push(item);
        } else if (object instanceof L.PDFDict || object.dict) {
          const dict = object.dict || object;
          const action = nameOf(lookup(context, dict.get(N('S'))));
          if (dict.has(N('JS')) || ['JavaScript', 'ResetForm', 'SubmitForm', 'ImportData', 'Hide'].includes(action)) nameActionSources.add(source.name);
          for (const [, value] of dict.entries()) actionQueue.push(value);
        }
      }
      const formRaw = source.document.catalog.get(N('AcroForm'));
      const form = lookup(context, formRaw);
      const pageWidgets = new Map();
      for (let pageIndex = 0; pageIndex < source.pages.length; pageIndex++) {
        const annots = lookup(context, source.pages[pageIndex].node.get(N('Annots')));
        if (isNull(annots)) continue;
        if (!(annots instanceof L.PDFArray)) fail(`“${source.name}” has an invalid annotation list.`);
        for (let index = 0; index < annots.size(); index++) {
          const raw = annots.get(index), dict = lookup(context, raw);
          if (!(dict instanceof L.PDFDict) || nameOf(lookup(context, dict.get(N('Subtype')))) !== 'Widget') continue;
          if (pageWidgets.has(dict)) fail(`“${source.name}” uses the same form widget on several pages.`);
          const pagePointer = dict.get(N('P'));
          if (!isNull(pagePointer) && lookup(context, pagePointer) !== source.pages[pageIndex].node) {
            fail(`“${source.name}” has a form widget pointing to the wrong page.`);
          }
          pageWidgets.set(dict, { raw, pageIndex });
        }
      }
      if (isNull(form)) {
        if (pageWidgets.size) fail(`“${source.name}” has widgets without an AcroForm field tree.`);
        continue;
      }
      if (!(form instanceof L.PDFDict)) fail(`“${source.name}” has an invalid AcroForm dictionary.`);
      if (!isNull(form.get(N('XFA')))) fail(`“${source.name}” contains an XFA form. Export its untouched complete PDF or choose Images.`);
      const fields = lookup(context, form.get(N('Fields')));
      if (!(fields instanceof L.PDFArray)) fail(`“${source.name}” has an invalid field list.`);
      for (const [key] of form.entries()) {
        if (!['Fields', 'NeedAppearances', 'SigFlags', 'CO', 'DR', 'DA', 'Q'].includes(key.decodeText())) {
          fail(`“${source.name}” uses unsupported AcroForm entry /${key.decodeText()}.`);
        }
      }
      const nodes = new Map(), names = new Set();
      function visit(raw, parent, inheritedType, prefix, depth = 0) {
        if (depth > 128 || nodes.size > 100000) fail(`“${source.name}” has a form tree exceeding the supported nesting or field limit.`);
        const dict = lookup(context, raw);
        if (!(dict instanceof L.PDFDict)) fail(`“${source.name}” has a non-dictionary field.`);
        if (nodes.has(dict)) fail(`“${source.name}” has a cyclic or shared field tree.`);
        const parentRaw = dict.get(N('Parent'));
        if ((!parent && !isNull(parentRaw)) || (parent && !isNull(parentRaw) && lookup(context, parentRaw) !== parent.dict)) {
          fail(`“${source.name}” has inconsistent form field parents.`);
        }
        const widget = nameOf(lookup(context, dict.get(N('Subtype')))) === 'Widget';
        const partialRaw = lookup(context, dict.get(N('T'))), partial = textOf(partialRaw);
        if (!isNull(partialRaw) && (partial === undefined || !partial || partial.includes('.'))) {
          fail(`“${source.name}” has an ambiguous field name.`);
        }
        const field = !widget || partial !== undefined || dict.has(N('FT'));
        if (!parent && !field) fail(`“${source.name}” has a root widget without a field.`);
        if (field && partial === undefined) fail(`“${source.name}” has an unnamed field.`);
        const typeRaw = lookup(context, dict.get(N('FT')));
        const type = isNull(typeRaw) ? inheritedType : nameOf(typeRaw);
        const fullName = partial === undefined ? prefix : (prefix ? `${prefix}.${partial}` : partial);
        if (field && names.has(fullName)) fail(`“${source.name}” has duplicate field name “${fullName}”.`);
        if (field) names.add(fullName);
        const node = { raw, dict, parent, widget, field, partial, fullName, type, children: [] };
        nodes.set(dict, node);
        const kids = lookup(context, dict.get(N('Kids')));
        if (!isNull(kids)) {
          if (!(kids instanceof L.PDFArray) || widget) fail(`“${source.name}” has invalid widget children.`);
          for (let index = 0; index < kids.size(); index++) node.children.push(visit(kids.get(index), node, type, fullName, depth + 1));
        }
        const fieldChildren = node.children.filter(child => child.field);
        const widgetChildren = node.children.filter(child => !child.field);
        if (fieldChildren.length && widgetChildren.length) fail(`“${source.name}” mixes child fields and widgets in one field.`);
        node.terminal = field && !fieldChildren.length;
        if (node.terminal && !['Tx', 'Btn', 'Ch', 'Sig'].includes(type)) fail(`“${source.name}” has an unsupported field type.`);
        if (type === 'Sig' && !isNull(lookup(context, dict.get(N('V'))))) {
          fail(`“${source.name}” has a digital signature. Export its untouched complete PDF or choose Images.`);
        }
        if (widget && !pageWidgets.has(dict)) fail(`“${source.name}” has a widget missing from its page annotations.`);
        return node;
      }
      const roots = [];
      for (let index = 0; index < fields.size(); index++) roots.push(visit(fields.get(index), null, undefined, ''));
      for (const widget of pageWidgets.keys()) {
        if (!nodes.has(widget)) fail(`“${source.name}” has an orphan form widget.`);
      }
      const dr = lookup(context, form.get(N('DR')));
      if (!isNull(dr) && !(dr instanceof L.PDFDict)) fail(`“${source.name}” has invalid default form resources.`);
      const co = lookup(context, form.get(N('CO')));
      if (!isNull(co) && !(co instanceof L.PDFArray)) fail(`“${source.name}” has an invalid form calculation order.`);
      models.push({ source, sourceIndex, context, form, roots, nodes, pageWidgets, dr, co });
    }

    if (!models.length) return;
    const outContext = output.context, outForm = outContext.obj({ Fields: [] });
    const outFields = outForm.lookup(N('Fields'), L.PDFArray);
    const outResources = outContext.obj({}), outCO = [];
    const reservedResourceNames = new Set(), usedResourceNames = new Set(), usedRootNames = new Set();
    for (const model of models) {
      if (!model.dr) continue;
      for (const [category, raw] of model.dr.entries()) {
        const values = lookup(model.context, raw);
        if (category.decodeText() === 'ProcSet') continue;
        if (!(values instanceof L.PDFDict)) fail(`“${model.source.name}” has invalid /${category.decodeText()} form resources.`);
        for (const [name] of values.entries()) reservedResourceNames.add(name.decodeText());
      }
    }

    function rewriteDA(raw, aliases, context) {
      const value = lookup(context, raw);
      if (isNull(value)) return undefined;
      if (!(value instanceof L.PDFString) && !(value instanceof L.PDFHexString)) fail('a default appearance is not a PDF string.');
      const content = value instanceof L.PDFString ? value.asString() : String.fromCharCode(...value.asBytes());
      // PDF tokenization: only names outside strings, hexadecimal strings and
      // comments are resource operands. Literal string contents stay intact.
      let result = '', index = 0;
      while (index < content.length) {
        const char = content[index];
        if (char === '%') {
          const start = index;
          while (index < content.length && content[index] !== '\r' && content[index] !== '\n') index++;
          result += content.slice(start, index); continue;
        }
        if (char === '(') {
          const start = index++; let depth = 1;
          while (index < content.length && depth) {
            if (content[index] === '\\') index += 2;
            else { if (content[index] === '(') depth++; if (content[index] === ')') depth--; index++; }
          }
          if (depth) fail('a default appearance contains an unterminated string.');
          result += content.slice(start, index); continue;
        }
        if (char === '<' && content[index + 1] !== '<') {
          const end = content.indexOf('>', index + 1);
          if (end < 0) fail('a default appearance contains an unterminated hexadecimal string.');
          result += content.slice(index, end + 1); index = end + 1; continue;
        }
        if (char === '/') {
          const start = ++index;
          while (index < content.length && !/[\s\x00()<>\[\]{}\/%]/.test(content[index])) index++;
          const token = content.slice(start, index);
          const decoded = token.replace(/#([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
          result += aliases.has(decoded) ? N(aliases.get(decoded)).toString() : `/${token}`;
          continue;
        }
        result += char; index++;
      }
      return L.PDFString.of(result);
    }

    for (const model of models) {
      const { source, sourceIndex, context, form, roots, nodes, pageWidgets } = model;
      const aliases = new Map();
      if (model.dr) {
        const sourceNames = new Set();
        for (const [category, raw] of model.dr.entries()) {
          if (category.decodeText() === 'ProcSet') continue;
          for (const [name] of lookup(context, raw).entries()) sourceNames.add(name.decodeText());
        }
        for (const name of sourceNames) {
          let target = name;
          if (usedResourceNames.has(target)) {
            let suffix = 1;
            do { target = `${name}_PF${sourceIndex + 1}_${suffix++}`; }
            while (usedResourceNames.has(target) || reservedResourceNames.has(target));
            aliases.set(name, target);
          }
          usedResourceNames.add(target);
        }
        for (const [category, raw] of model.dr.entries()) {
          if (category.decodeText() === 'ProcSet') {
            const proc = lookup(context, raw);
            if (!(proc instanceof L.PDFArray)) fail(`“${source.name}” has an invalid ProcSet resource list.`);
            let target = outResources.get(category);
            if (!target) { target = outContext.obj([]); outResources.set(category, target); }
            for (let index = 0; index < proc.size(); index++) {
              const value = lookup(context, proc.get(index));
              if (!(value instanceof L.PDFName)) fail(`“${source.name}” has an invalid ProcSet resource.`);
              if (!target.asArray().some(existing => existing.toString() === value.toString())) target.push(value);
            }
            continue;
          }
          let target = outResources.get(category);
          if (!target) { target = outContext.obj({}); outResources.set(category, target); }
          for (const [name, value] of lookup(context, raw).entries()) {
            target.set(N(aliases.get(name.decodeText()) || name.decodeText()), source.copier.copy(value));
          }
        }
      }
      if (aliases.size) adjustment(`Default form resource names from “${source.name}” were disambiguated for the merged PDF.`);
      const primaryEntries = source.entries.filter(entry => entry.occurrence === 0);
      const groups = [{ entries: primaryEntries, copier: source.copier, duplicate: false }];
      for (const entry of source.entries) {
        if (entry.occurrence > 0) groups.push({ entries: [entry], copier: entry.copier, duplicate: true });
      }
      let removedWidgets = 0;
      const primaryPages = new Set(primaryEntries.map(entry => entry.pageIndex));
      for (const widget of pageWidgets.values()) if (!primaryPages.has(widget.pageIndex)) removedWidgets++;
      if (removedWidgets) adjustment(`${removedWidgets} form widget${removedWidgets === 1 ? '' : 's'} on omitted pages from “${source.name}” were removed from the field tree.`);

      for (const group of groups) {
        const pages = new Map(group.entries.map(entry => [entry.pageIndex, entry]));
        const retained = new Map(), copies = new Map();
        function keep(node) {
          if (node.widget) return retained.set(node, pages.has(pageWidgets.get(node.dict).pageIndex)).get(node);
          let anyChild = false;
          for (const child of node.children) if (keep(child)) anyChild = true;
          // Nonvisual terminal fields (for example calculation values) remain
          // in the original group, but are not invented on duplicated pages.
          const keepHidden = node.terminal && !node.children.length && !group.duplicate;
          const value = anyChild || keepHidden;
          retained.set(node, value); return value;
        }
        for (const root of roots) keep(root);
        function copied(node) {
          if (copies.has(node)) return copies.get(node);
          const value = group.copier.copy(node.raw);
          const dict = lookup(outContext, value);
          if (!(dict instanceof L.PDFDict)) fail('a copied form field is unavailable.');
          const ref = value instanceof L.PDFRef ? value : outContext.register(dict);
          const copy = { ref, dict }; copies.set(node, copy); return copy;
        }
        // First obtain every retained reference. Then reconnect all Parents and
        // Kids so actions referencing copied field objects see the same graph.
        for (const [node, included] of retained) if (included) copied(node);
        for (const [node, copy] of copies) {
          const { dict, ref } = copy;
          if (node.parent && retained.get(node.parent)) dict.set(N('Parent'), copied(node.parent).ref);
          else dict.delete(N('Parent'));
          const children = node.children.filter(child => retained.get(child));
          if (node.children.length || dict.has(N('Kids'))) dict.set(N('Kids'), outContext.obj(children.map(child => copied(child).ref)));
          if (node.widget) {
            const entry = pages.get(pageWidgets.get(node.dict).pageIndex);
            dict.set(N('P'), entry.page.ref);
            const annots = lookup(outContext, entry.page.node.get(N('Annots')));
            if (!(annots instanceof L.PDFArray)) fail('a retained widget has no copied annotation list.');
            let found = false;
            for (let index = 0; index < annots.size(); index++) {
              if (lookup(outContext, annots.get(index)) === dict) { annots.set(index, ref); found = true; }
            }
            if (!found) fail('a retained widget could not be matched to its copied page.');
          }
          if (dict.has(N('DA'))) dict.set(N('DA'), rewriteDA(node.dict.get(N('DA')), aliases, context));
          if (!node.parent) {
            if (!dict.has(N('DA')) && form.has(N('DA'))) dict.set(N('DA'), rewriteDA(form.get(N('DA')), aliases, context));
            if (!dict.has(N('Q')) && form.has(N('Q'))) dict.set(N('Q'), group.copier.copy(form.get(N('Q'))));
          }
          if (node.terminal && node.type === 'Btn' && children.length < node.children.length) {
            // Radio /Opt entries correspond positionally to the original Kids.
            const options = lookup(context, node.dict.get(N('Opt')));
            if (!isNull(options)) {
              if (!(options instanceof L.PDFArray) || options.size() !== node.children.length) fail(`“${source.name}” has an ambiguous button option list.`);
              dict.set(N('Opt'), outContext.obj(node.children.map((child, index) => retained.get(child) ? group.copier.copy(options.get(index)) : undefined).filter(value => value !== undefined)));
            }
            const flags = inherited(node, 'Ff', context);
            if (flags && !(flags instanceof L.PDFNumber)) fail('button flags are invalid.');
            if (!flags || !(flags.asNumber() & 65536)) {
              const states = new Set(['Off']);
              for (const child of children) {
                const ap = lookup(context, child.dict.get(N('AP')));
                const normal = ap instanceof L.PDFDict ? lookup(context, ap.get(N('N'))) : undefined;
                if (!(normal instanceof L.PDFDict)) fail(`“${source.name}” has a button without named appearances.`);
                for (const [state] of normal.entries()) states.add(state.decodeText());
              }
              for (const key of ['V', 'DV']) {
                const value = inherited(node, key, context);
                if (value instanceof L.PDFName && !states.has(value.decodeText())) {
                  dict.set(N(key), N('Off'));
                  adjustment(`The ${key === 'V' ? 'selected' : 'default'} option of “${node.fullName}” was on an omitted page and was cleared.`);
                  if (key === 'V') for (const child of children) copied(child).dict.set(N('AS'), N('Off'));
                }
              }
            }
          }
        }
        for (const root of roots) {
          if (!retained.get(root)) continue;
          const copy = copied(root);
          let target = root.partial;
          if (usedRootNames.has(target) || group.duplicate) {
            let suffix = 1;
            const tag = group.duplicate ? `copy${group.entries[0].occurrence + 1}` : `source${sourceIndex + 1}`;
            do { target = `${root.partial}_${tag}_${suffix++}`; } while (usedRootNames.has(target));
            if (nameActionSources.size) fail(`“${Array.from(nameActionSources).join('”, “')}” contains field-name actions, while fields from “${source.name}” require renaming. Export the PDFs separately or choose Images.`);
            copy.dict.set(N('T'), L.PDFHexString.fromText(target));
            adjustment(`Form field “${root.partial}” from “${source.name}” was renamed to “${target}” to keep its values independent.`);
          }
          usedRootNames.add(target); outFields.push(copy.ref);
        }
        if (model.co) {
          for (let index = 0; index < model.co.size(); index++) {
            const node = nodes.get(lookup(context, model.co.get(index)));
            if (!node || !node.field) fail(`“${source.name}” calculates an unknown form field.`);
            if (retained.get(node)) outCO.push(copied(node).ref);
          }
        }
      }
      if (lookup(context, form.get(N('NeedAppearances'))) === L.PDFBool.True) outForm.set(N('NeedAppearances'), L.PDFBool.True);
    }
    if (outResources.entries().length) outForm.set(N('DR'), outResources);
    if (outCO.length) outForm.set(N('CO'), outContext.obj(outCO));
    // All defaults needed by each source are now on its rebuilt root fields.
    // Existing appearances are retained; saving must not regenerate them.
    if (outFields.size()) output.catalog.set(N('AcroForm'), outContext.register(outForm));
    else output.catalog.delete(N('AcroForm'));
  }

  window.PhotoPdfNativeForms = Object.freeze({ apply });
})();
