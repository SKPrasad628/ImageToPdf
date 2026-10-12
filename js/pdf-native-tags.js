// Rebuild the logical structure and its reverse indexes after native pages move.
// Source objects stay read-only. Unsupported structures abort native export;
// retaining stale ParentTree indexes would be worse than a visible failure.
(function () {
  'use strict';

  function apply(plan) {
    const lib = plan.library, output = plan.document, context = output.context;
    const name = value => lib.PDFName.of(value);
    const fail = message => { throw plan.error(`Could not safely preserve PDF accessibility tags: ${message} Choose Images to export a flattened copy.`); };
    const array = values => { const result = lib.PDFArray.withContext(context); values.forEach(value => result.push(value)); return result; };
    const dict = () => lib.PDFDict.withContext(context);
    const lookup = (source, value) => value instanceof lib.PDFRef ? source.document.context.lookup(value) : value;
    const get = (source, object, key) => lookup(source, object.get(name(key)));
    const type = object => object instanceof lib.PDFName ? object.decodeText() : '';
    const integer = (value, label) => {
      const number = value instanceof lib.PDFNumber ? value.asNumber() : NaN;
      if (!Number.isSafeInteger(number) || number < 0) fail(`${label} is invalid.`);
      return number;
    };
    const isString = value => value instanceof lib.PDFString || value instanceof lib.PDFHexString;
    const stringKey = value => Array.from(value.asBytes(), byte => byte.toString(16).padStart(2, '0')).join('');
    const adjustment = message => { if (!plan.report.adjustments.includes(message)) plan.report.adjustments.push(message); };
    const parsedSources = [];
    const sourceMarks = new Map();
    let processedNodes = 0;
    const check = depth => {
      if (++processedNodes > 50000 || depth > 100) fail('the structure exceeds the safe processing limit.');
    };
    const outputPosition = new Map(output.getPages().map((page, index) => [page.ref.toString(), index]));

    // Number/name trees can use either a flat leaf or nested /Kids. Detect
    // malformed or cyclic trees instead of trusting stale reverse references.
    function readTree(source, raw, field, keyReader) {
      const result = new Map(), visited = new Set();
      function visit(value, depth = 0) {
        check(depth);
        const node = lookup(source, value);
        if (!(node instanceof lib.PDFDict) || visited.has(node)) fail(`the ${field} tree is malformed or cyclic.`);
        visited.add(node);
        const entries = get(source, node, field), kids = get(source, node, 'Kids');
        if (entries && kids) fail(`the ${field} tree combines leaves and branches.`);
        if (entries) {
          if (!(entries instanceof lib.PDFArray) || entries.size() % 2) fail(`the ${field} tree has an invalid leaf.`);
          let previous = null;
          for (let index = 0; index < entries.size(); index += 2) {
            const key = keyReader(lookup(source, entries.get(index)));
            if (result.has(key) || (previous !== null && key <= previous)) fail(`the ${field} tree has duplicate or unsorted keys.`);
            previous = key; result.set(key, entries.get(index + 1));
          }
        } else if (kids) {
          if (!(kids instanceof lib.PDFArray)) fail(`the ${field} tree has invalid children.`);
          for (const child of kids.asArray()) visit(child, depth + 1);
        }
      }
      if (raw) visit(raw);
      return result;
    }

    function parseSource(source) {
      const catalog = source.document.catalog;
      const rootRaw = catalog.get(name('StructTreeRoot'));
      const pageByRef = new Map(source.pages.map((page, index) => [page.ref.toString(), index]));
      const annotations = new Map();
      for (let pageIndex = 0; pageIndex < source.pages.length; pageIndex++) {
        const page = source.pages[pageIndex], annots = get(source, page.node, 'Annots');
        if (annots && !(annots instanceof lib.PDFArray)) fail('a page annotation list is invalid.');
        for (const raw of annots ? annots.asArray() : []) {
          const object = lookup(source, raw);
          if (!(raw instanceof lib.PDFRef) || !(object instanceof lib.PDFDict)) fail('a tagged annotation is not an indirect dictionary.');
          annotations.set(raw.toString(), { raw, object, pageIndex });
        }
      }
      if (!rootRaw) {
        for (const page of source.pages) if (page.node.has(name('StructParents'))) fail('a page has a structure index without a structure tree.');
        for (const annotation of annotations.values()) if (annotation.object.has(name('StructParent'))) fail('an annotation has a structure index without a structure tree.');
        return null;
      }
      const root = lookup(source, rootRaw);
      if (!(root instanceof lib.PDFDict) || type(get(source, root, 'Type')) !== 'StructTreeRoot') fail('the structure root is invalid.');
      const supportedRoot = new Set(['Type', 'K', 'ParentTree', 'ParentTreeNextKey', 'RoleMap', 'ClassMap', 'IDTree']);
      for (const key of root.keys()) if (!supportedRoot.has(key.decodeText())) fail(`the structure root uses unsupported /${key.decodeText()}.`);
      const parentTree = readTree(source, root.get(name('ParentTree')), 'Nums', value => integer(value, 'A parent-tree key'));
      const idTree = readTree(source, root.get(name('IDTree')), 'Names', value => {
        if (!isString(value)) fail('an ID-tree key is not a string.');
        return stringKey(value);
      });
      const ids = new Map(), visited = new Set(), pageOwners = new Map(), annotationOwners = new Map();
      const knownParentKeys = new Set();
      for (const object of [...source.pages.map(page => ({ object: page.node, key: 'StructParents' })),
        ...Array.from(annotations.values(), annotation => ({ object: annotation.object, key: 'StructParent' }))]) {
        if (!object.object.has(name(object.key))) continue;
        const key = integer(get(source, object.object, object.key), 'A structure parent index');
        if (knownParentKeys.has(key)) fail('structure parent indexes are shared between different objects.');
        knownParentKeys.add(key);
      }
      for (const key of parentTree.keys()) if (!knownParentKeys.has(key)) fail('the parent tree contains unsupported stream parents or orphan indexes.');
      const supportedElement = new Set(['Type', 'S', 'P', 'ID', 'Pg', 'K', 'A', 'C', 'R', 'T', 'Lang', 'Alt', 'E', 'ActualText']);

      function pageFor(raw, inherited) {
        if (!raw) return inherited;
        if (!(raw instanceof lib.PDFRef) || !pageByRef.has(raw.toString())) fail('a structure element refers to a missing page.');
        return pageByRef.get(raw.toString());
      }
      function ownerMatches(raw, owner) { return lookup(source, raw) === owner.object; }
      function markedContent(mcid, pageIndex, owner, raw, mcr) {
        if (pageIndex === undefined) fail('marked content has no owning page.');
        const page = source.pages[pageIndex];
        const key = integer(get(source, page.node, 'StructParents'), 'A tagged page parent index');
        const parents = lookup(source, parentTree.get(key));
        if (!(parents instanceof lib.PDFArray) || mcid >= parents.size() || !ownerMatches(parents.get(mcid), owner)) fail('a marked-content parent-tree mapping is inconsistent.');
        let owned = pageOwners.get(pageIndex);
        if (!owned) pageOwners.set(pageIndex, owned = new Map());
        if (owned.has(mcid)) fail('a page has a repeated marked-content identifier.');
        owned.set(mcid, owner);
        return { kind: 'content', pageIndex, mcid, raw, mcr };
      }
      function children(raw, inherited, parent, depth = 0) {
        check(depth);
        const value = lookup(source, raw);
        if (!value || value === lib.PDFNull) return [];
        if (value instanceof lib.PDFArray) return value.asArray().flatMap(child => children(child, inherited, parent, depth + 1));
        if (value instanceof lib.PDFNumber) {
          if (!parent) fail('the structure root contains a bare marked-content identifier.');
          return [markedContent(integer(value, 'A marked-content identifier'), inherited, parent, raw, false)];
        }
        if (!(value instanceof lib.PDFDict)) fail('a structure child is not supported.');
        const childType = type(get(source, value, 'Type'));
        if (childType === 'MCR') {
          if (!parent) fail('the structure root contains marked content.');
          for (const key of value.keys()) if (!['Type', 'Pg', 'MCID'].includes(key.decodeText())) fail(`a marked-content reference uses unsupported /${key.decodeText()}.`);
          return [markedContent(integer(get(source, value, 'MCID'), 'A marked-content identifier'), pageFor(value.get(name('Pg')), inherited), parent, raw, true)];
        }
        if (childType === 'OBJR') {
          if (!parent) fail('the structure root contains an object reference.');
          for (const key of value.keys()) if (!['Type', 'Pg', 'Obj'].includes(key.decodeText())) fail(`an object reference uses unsupported /${key.decodeText()}.`);
          const target = value.get(name('Obj'));
          const annotation = target instanceof lib.PDFRef ? annotations.get(target.toString()) : undefined;
          const pageIndex = pageFor(value.get(name('Pg')), inherited);
          if (!annotation || pageIndex !== annotation.pageIndex) fail('a tagged object is not an annotation on its owning page.');
          const key = integer(get(source, annotation.object, 'StructParent'), 'A tagged annotation parent index');
          if (!ownerMatches(parentTree.get(key), parent) || annotationOwners.has(target.toString())) fail('an annotation parent-tree mapping is inconsistent.');
          annotationOwners.set(target.toString(), parent);
          return [{ kind: 'object', pageIndex, annotation, raw }];
        }
        if (childType && childType !== 'StructElem') fail(`a structure element has unsupported type /${childType}.`);
        if (visited.has(value)) fail('the structure hierarchy is cyclic or shares an element between parents.');
        visited.add(value);
        for (const key of value.keys()) if (!supportedElement.has(key.decodeText())) fail(`a structure element uses unsupported /${key.decodeText()}.`);
        const role = get(source, value, 'S');
        if (!(role instanceof lib.PDFName)) fail('a structure element has no role.');
        const expectedParent = parent ? parent.object : root;
        if (get(source, value, 'P') !== expectedParent) fail('a structure element has an inconsistent parent.');
        const node = { kind: 'element', object: value, raw, role: role.decodeText(), pageIndex: pageFor(value.get(name('Pg')), inherited) };
        const id = get(source, value, 'ID');
        if (id) {
          if (!isString(id)) fail('a structure identifier is not a string.');
          node.id = stringKey(id); node.idValue = id;
          if (ids.has(node.id)) fail('structure identifiers are duplicated.');
          ids.set(node.id, node);
          if (idTree.size && lookup(source, idTree.get(node.id)) !== value) fail('a structure ID-tree mapping is inconsistent.');
        }
        node.children = children(value.get(name('K')), node.pageIndex, node, depth + 1);
        return [node];
      }
      const roots = children(root.get(name('K')), undefined, null);
      for (const [key, raw] of idTree) if (!ids.has(key) || lookup(source, raw) !== ids.get(key).object) fail('the ID tree contains an orphan structure identifier.');
      for (let pageIndex = 0; pageIndex < source.pages.length; pageIndex++) {
        const page = source.pages[pageIndex];
        if (!page.node.has(name('StructParents'))) continue;
        const key = integer(get(source, page.node, 'StructParents'), 'A tagged page parent index');
        const parents = lookup(source, parentTree.get(key));
        if (!(parents instanceof lib.PDFArray)) fail('a page parent-tree mapping is missing.');
        if (parents.size() > 1000000) fail('a page parent-tree mapping is too large to rebuild safely.');
        for (let mcid = 0; mcid < parents.size(); mcid++) {
          const owner = lookup(source, parents.get(mcid));
          if (owner && owner !== lib.PDFNull && (!pageOwners.get(pageIndex) || !pageOwners.get(pageIndex).has(mcid))) fail('a page parent-tree mapping has unreferenced content.');
        }
      }
      for (const annotation of annotations.values()) if (annotation.object.has(name('StructParent')) && !annotationOwners.has(annotation.raw.toString())) fail('an annotation parent-tree mapping has no object reference.');
      const lang = get(source, catalog, 'Lang');
      if (lang && !isString(lang)) fail('the document language is invalid.');
      return { source, root, roots, ids, pageOwners, annotationOwners, lang,
        roleMap: get(source, root, 'RoleMap'), classMap: get(source, root, 'ClassMap') };
    }

    for (const source of plan.sources) {
      const mark = get(source, source.document.catalog, 'MarkInfo');
      if (mark) {
        if (!(mark instanceof lib.PDFDict)) fail('the MarkInfo dictionary is invalid.');
        for (const key of mark.keys()) {
          if (!['Marked', 'UserProperties', 'Suspects'].includes(key.decodeText())) fail(`MarkInfo uses unsupported /${key.decodeText()}.`);
          if (!(get(source, mark, key.decodeText()) instanceof lib.PDFBool)) fail('a MarkInfo flag is not a boolean.');
        }
        if (get(source, mark, 'Marked') === lib.PDFBool.True && !source.document.catalog.has(name('StructTreeRoot'))) fail('MarkInfo claims tags without a structure tree.');
        sourceMarks.set(source, mark);
      }
      const parsed = parseSource(source);
      if (parsed) parsedSources.push(parsed);
    }
    if (!parsedSources.length) {
      if (sourceMarks.size) {
        const mark = dict(); mark.set(name('Marked'), lib.PDFBool.False);
        for (const key of ['UserProperties', 'Suspects']) if (Array.from(sourceMarks, ([source, value]) => get(source, value, key)).includes(lib.PDFBool.True)) mark.set(name(key), lib.PDFBool.True);
        output.catalog.set(name('MarkInfo'), mark);
      }
      return;
    }
    const resultRoot = dict(), resultRootRef = context.register(resultRoot);
    resultRoot.set(name('Type'), name('StructTreeRoot'));
    const mergedRoles = dict(), mergedClasses = dict(), roleNames = new Set(), classNames = new Set();
    // Reserve every original name before generating aliases so a real source
    // name cannot accidentally collide with one of our generated names.
    for (const parsed of parsedSources) {
      for (const [map, used] of [[parsed.roleMap, roleNames], [parsed.classMap, classNames]]) {
        if (map && !(map instanceof lib.PDFDict)) fail('a role or class map is invalid.');
        if (map) map.keys().forEach(key => used.add(key.decodeText()));
      }
    }
    function alias(original, sourceIndex, used) {
      let candidate = `PF${sourceIndex + 1}_${original}`, suffix = 1;
      while (used.has(candidate)) candidate = `PF${sourceIndex + 1}_${original}_${suffix++}`;
      used.add(candidate); return candidate;
    }
    // Resolve role-map chains to their final role. Cyclic chains and PDF 2.0
    // namespace arrays are deliberately rejected, rather than misinterpreted.
    for (let sourceIndex = 0; sourceIndex < parsedSources.length; sourceIndex++) {
      const parsed = parsedSources[sourceIndex];
      parsed.roleAliases = new Map(); parsed.classAliases = new Map();
      const roleMap = parsed.roleMap;
      function roleTarget(role, active = new Set()) {
        if (!roleMap || !roleMap.has(name(role))) return role;
        if (active.has(role)) fail('a role map is cyclic.');
        active.add(role);
        const target = lookup(parsed.source, roleMap.get(name(role)));
        if (!(target instanceof lib.PDFName)) fail('a role map uses unsupported namespace roles.');
        return roleTarget(target.decodeText(), active);
      }
      if (roleMap) for (const key of roleMap.keys()) {
        const original = key.decodeText(), target = name(roleTarget(original));
        let replacement = original;
        if (mergedRoles.has(key) && mergedRoles.get(key).toString() !== target.toString()) {
          replacement = alias(original, sourceIndex, roleNames);
          adjustment('Conflicting accessibility role names were renamed while merging PDFs.');
        }
        parsed.roleAliases.set(original, replacement); mergedRoles.set(name(replacement), target);
      }
      if (parsed.classMap) for (const [key, value] of parsed.classMap.entries()) {
        const original = key.decodeText();
        // Attribute classes may contain source-specific object references. A
        // separate alias for every collision keeps their source meaning intact.
        let replacement = original;
        if (mergedClasses.has(key)) {
          replacement = alias(original, sourceIndex, classNames);
          adjustment('Conflicting accessibility attribute classes were renamed while merging PDFs.');
        }
        parsed.classAliases.set(original, replacement);
        const resolved = lookup(parsed.source, value);
        if (!(resolved instanceof lib.PDFDict) && !(resolved instanceof lib.PDFArray)) fail('an accessibility attribute class is invalid.');
        mergedClasses.set(name(replacement), parsed.source.copier.copy(value));
      }
    }

    let nextParentKey = 0;
    const parentEntries = [], idEntries = [], usedIds = new Set(), rootGroups = [];
    const markSuspects = Array.from(sourceMarks, ([source, value]) => get(source, value, 'Suspects')).includes(lib.PDFBool.True);
    const userProperties = Array.from(sourceMarks, ([source, value]) => get(source, value, 'UserProperties')).includes(lib.PDFBool.True);
    let hasTaggedContent = false;
    const taggedOutputPages = new Set();
    const outputLanguage = context.lookup(output.catalog.get(name('Lang')));

    function cloneTree(parsed, entries, duplicate) {
      const source = parsed.source;
      const entryByPage = new Map(entries.map(entry => [entry.pageIndex, entry]));
      const copier = duplicate ? entries[0].copier : source.copier;
      const contentOwners = new Map(), objectOwners = [], clones = new Map();
      const localIds = new Map();
      function rewriteClasses(raw) {
        const value = lookup(source, raw);
        if (value instanceof lib.PDFName) {
          const original = value.decodeText();
          if (!parsed.classAliases.has(original)) fail('a structure element uses an undefined attribute class.');
          return name(parsed.classAliases.get(original));
        }
        if (value instanceof lib.PDFArray) return array(value.asArray().map(item => {
          const resolved = lookup(source, item);
          if (resolved instanceof lib.PDFNumber) return resolved.clone();
          if (!(resolved instanceof lib.PDFName)) fail('a structure attribute class list is invalid.');
          return rewriteClasses(item);
        }));
        fail('a structure attribute class is invalid.');
      }
      function clone(node, parentRef) {
        const entry = entryByPage.get(node.pageIndex);
        if (node.kind !== 'element') {
          if (!entry) return null;
          const position = outputPosition.get(entry.page.ref.toString());
          taggedOutputPages.add(entry.page.ref.toString()); hasTaggedContent = true;
          if (node.kind === 'content') {
            let owners = contentOwners.get(entry);
            if (!owners) contentOwners.set(entry, owners = new Map());
            owners.set(node.mcid, parentRef);
            if (!node.mcr) return { value: lib.PDFNumber.of(node.mcid), positions: [position] };
            const result = dict(); result.set(name('Type'), name('MCR')); result.set(name('Pg'), entry.page.ref);
            result.set(name('MCID'), lib.PDFNumber.of(node.mcid));
            return { value: result, positions: [position] };
          }
          const copiedRef = entry.copier.copy(node.annotation.raw), copiedObject = context.lookup(copiedRef);
          const annots = entry.page.node.Annots();
          if (!(copiedObject instanceof lib.PDFDict) || !annots || !annots.asArray().some(raw => raw.toString() === copiedRef.toString())) fail('a copied tagged annotation is no longer on its owning page.');
          const result = dict(); result.set(name('Type'), name('OBJR')); result.set(name('Pg'), entry.page.ref); result.set(name('Obj'), copiedRef);
          objectOwners.push({ object: copiedObject, owner: parentRef });
          return { value: result, positions: [position] };
        }
        const result = dict(), resultRef = context.register(result);
        const kids = node.children.map(child => clone(child, resultRef)).filter(Boolean);
        // An element with no retained content must not continue pointing at a
        // removed page. Pure empty source roots remain represented by the root.
        if (!kids.length && (!entry || node.children.length)) return null;
        const positions = kids.length ? Array.from(new Set(kids.flatMap(child => child.positions)))
          : [outputPosition.get(entry.page.ref.toString())];
        const ordered = kids.slice().sort((left, right) => Math.min(...left.positions) - Math.min(...right.positions));
        const disjoint = ordered.every((child, index) => index === 0 || Math.max(...ordered[index - 1].positions) <= Math.min(...child.positions));
        if (disjoint) kids.splice(0, kids.length, ...ordered);
        else if (positions.length > 1) adjustment('Accessibility keeps source-defined reading order inside containers spanning reordered pages.');
        result.set(name('Type'), name('StructElem'));
        result.set(name('P'), parentRef);
        result.set(name('S'), name(parsed.roleAliases.get(node.role) || node.role));
        if (entry) result.set(name('Pg'), entry.page.ref);
        else if (kids.some(child => child.value instanceof lib.PDFNumber)) fail('marked content lost its inherited owning page.');
        result.set(name('K'), array(kids.map(child => child.value)));
        for (const key of ['A', 'R', 'T', 'Lang', 'Alt', 'E', 'ActualText']) {
          const raw = node.object.get(name(key));
          if (!raw) continue;
          const value = lookup(source, raw);
          if (key === 'R') integer(value, 'A structure revision');
          else if (key !== 'A' && !isString(value)) fail(`the structure /${key} value is not a string.`);
          result.set(name(key), copier.copy(raw));
        }
        if (!node.object.has(name('Lang')) && parentRef === resultRootRef && parsed.lang && (!outputLanguage || outputLanguage.toString() !== parsed.lang.toString())) result.set(name('Lang'), parsed.lang.clone());
        if (node.object.has(name('C'))) result.set(name('C'), rewriteClasses(node.object.get(name('C'))));
        if (node.id) {
          let idValue = node.idValue.clone(), id = node.id;
          if (usedIds.has(id)) {
            const prefix = `PF${parsedSources.indexOf(parsed) + 1}_${entries[0].occurrence || 0}_`;
            let suffix = 1;
            do { idValue = lib.PDFHexString.fromText(`${prefix}${suffix++}_${node.idValue.decodeText()}`); id = stringKey(idValue); } while (usedIds.has(id));
            adjustment('Repeated accessibility structure identifiers were renamed.');
          }
          usedIds.add(id); localIds.set(node.id, idValue); result.set(name('ID'), idValue);
          idEntries.push({ key: id, value: idValue, ref: resultRef });
        }
        clones.set(node, result);
        return { value: resultRef, positions };
      }
      const roots = parsed.roots.map(node => clone(node, resultRootRef)).filter(Boolean);
      // Header references are structure IDs. Copying them without adjusting an
      // ID collision would connect a table to the wrong document or occurrence.
      function rewriteAttributes(raw) {
        const value = context.lookup(raw);
        if (value instanceof lib.PDFArray) value.asArray().forEach(item => {
          const resolved = context.lookup(item);
          if (resolved instanceof lib.PDFNumber) integer(resolved, 'An attribute revision');
          else rewriteAttributes(item);
        });
        else if (value instanceof lib.PDFDict) {
          if (!(context.lookup(value.get(name('O'))) instanceof lib.PDFName)) fail('an accessibility attribute has no owner.');
          if (value.has(name('NS'))) fail('accessibility namespace attributes are unsupported.');
          const headers = context.lookup(value.get(name('Headers')));
          if (headers) {
            if (!(headers instanceof lib.PDFArray)) fail('a table Headers attribute is invalid.');
            for (let index = 0; index < headers.size(); index++) {
              const id = context.lookup(headers.get(index));
              if (!isString(id) || !localIds.has(stringKey(id))) fail('a retained table header refers to structure on an omitted page.');
              headers.set(index, localIds.get(stringKey(id)).clone());
            }
          }
        } else fail('an accessibility attribute is invalid.');
      }
      for (const clone of clones.values()) if (clone.has(name('A'))) rewriteAttributes(clone.get(name('A')));
      if (parsed.classMap) for (const key of parsed.classAliases.values()) {
        const value = mergedClasses.get(name(key));
        // A shared ClassMap cannot express different per-occurrence header IDs.
        const check = object => {
          const resolved = context.lookup(object);
          if (resolved instanceof lib.PDFArray) resolved.asArray().forEach(check);
          else if (resolved instanceof lib.PDFDict) {
            if (!(context.lookup(resolved.get(name('O'))) instanceof lib.PDFName)) fail('an accessibility attribute class has no owner.');
            if (resolved.has(name('NS'))) fail('accessibility namespace attributes are unsupported.');
            if (resolved.has(name('Headers'))) fail('table header identifiers inside shared attribute classes are unsupported.');
          } else fail('an accessibility attribute class is invalid.');
        };
        check(value);
      }
      for (const [entry, owners] of contentOwners) {
        const key = nextParentKey++, max = Math.max(...owners.keys());
        if (max > 1000000) fail('a marked-content identifier is too large to rebuild safely.');
        const values = Array.from({ length: max + 1 }, (_, index) => owners.get(index) || lib.PDFNull);
        entry.page.node.set(name('StructParents'), lib.PDFNumber.of(key));
        parentEntries.push([key, array(values)]);
      }
      for (const { object, owner } of objectOwners) {
        const key = nextParentKey++;
        object.set(name('StructParent'), lib.PDFNumber.of(key));
        parentEntries.push([key, owner]);
      }
      for (const entry of entries) if (!contentOwners.has(entry)) entry.page.node.delete(name('StructParents'));
      return roots;
    }

    for (const parsed of parsedSources) {
      const source = parsed.source;
      const firstEntries = source.entries.filter(entry => entry.occurrence === 0);
      if (firstEntries.length) rootGroups.push(...cloneTree(parsed, firstEntries, false));
      for (const entry of source.entries.filter(item => item.occurrence > 0)) {
        rootGroups.push(...cloneTree(parsed, [entry], true));
        adjustment('Duplicated tagged pages received independent accessibility structure and parent indexes.');
      }
      if (firstEntries.length < source.pages.length && parsed.roots.length) adjustment('Accessibility structure for omitted pages was pruned.');
    }
    rootGroups.sort((left, right) => Math.min(...left.positions) - Math.min(...right.positions));
    if (!rootGroups.every((group, index) => index === 0 || Math.max(...rootGroups[index - 1].positions) <= Math.min(...group.positions))) {
      adjustment('Accessibility keeps whole source hierarchies when pages from different documents or duplicates are interleaved.');
    }
    resultRoot.set(name('K'), array(rootGroups.map(group => group.value)));
    if (mergedRoles.keys().length) resultRoot.set(name('RoleMap'), mergedRoles);
    if (mergedClasses.keys().length) resultRoot.set(name('ClassMap'), mergedClasses);
    const nums = [];
    parentEntries.sort((left, right) => left[0] - right[0]).forEach(([key, value]) => nums.push(lib.PDFNumber.of(key), value));
    const parentTree = dict(); parentTree.set(name('Nums'), array(nums));
    resultRoot.set(name('ParentTree'), context.register(parentTree));
    resultRoot.set(name('ParentTreeNextKey'), lib.PDFNumber.of(nextParentKey));
    if (idEntries.length) {
      idEntries.sort((left, right) => left.key.localeCompare(right.key));
      const names = [];
      idEntries.forEach(entry => names.push(entry.value, entry.ref));
      const idTree = dict(); idTree.set(name('Names'), array(names));
      resultRoot.set(name('IDTree'), context.register(idTree));
    }
    output.catalog.set(name('StructTreeRoot'), resultRootRef);
    if (hasTaggedContent || sourceMarks.size) {
      const marked = dict(); marked.set(name('Marked'), hasTaggedContent ? lib.PDFBool.True : lib.PDFBool.False);
      if (userProperties) marked.set(name('UserProperties'), lib.PDFBool.True);
      if (markSuspects || (hasTaggedContent && taggedOutputPages.size !== output.getPageCount())) {
        marked.set(name('Suspects'), lib.PDFBool.True);
        if (markSuspects) adjustment('The source PDF flagged its accessibility structure as suspect; that flag was retained.');
        if (hasTaggedContent && taggedOutputPages.size !== output.getPageCount()) adjustment('Some output pages have no accessibility tags; the merged PDF is not fully tagged.');
      }
      output.catalog.set(name('MarkInfo'), marked);
      if (!output.catalog.has(name('Lang'))) {
        const lang = parsedSources.find(parsed => parsed.lang);
        if (lang) output.catalog.set(name('Lang'), lang.lang.clone());
      }
    }
  }

  window.PhotoPdfNativeTags = Object.freeze({ apply });
})();
