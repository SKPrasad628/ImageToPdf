import json
import re
from pathlib import Path
from pypdf import PdfReader
from pypdf.generic import ArrayObject, DictionaryObject, IndirectObject, NumberObject

ROOT = Path(__file__).resolve().parent
report = json.loads((ROOT / 'export-reports.json').read_text(encoding='utf-8'))
expected = {
    'source-a.pdf': {'pages': [('A', 1, 0), ('A', 2, 0)], 'fields': {'shared.name': 'Alice A - editable', 'shared.approved': '/Yes'}, 'attachments': ['a']},
    'source-b.pdf': {'pages': [('B', 1, 0), ('B', 2, 0)], 'fields': {'shared.name': 'Bob B - editable', 'shared.approved': '/Off'}, 'attachments': ['b']},
    'revised.pdf': {'pages': [('A', 2, 0), ('A', 1, 90), ('A', 2, 0)], 'fields': {'shared.name': 'Alice A - editable', 'shared.approved': '/Yes', 'shared_copy2_1.approved': '/Yes'}, 'attachments': ['a']},
    'merged.pdf': {'pages': [('A', 2, 0), ('B', 1, 0), ('A', 1, 0), ('B', 2, 0)], 'fields': {'shared.name': 'Alice A - editable', 'shared.approved': '/Yes', 'shared_source2_1.name': 'Bob B - editable', 'shared_source2_1.approved': '/Off'}, 'attachments': ['a', 'b']},
    'browser-export.pdf': {'pages': [('A', 1, 90), ('A', 1, 90), ('A', 2, 0), ('B', 1, 0), ('B', 2, 0)], 'fields': {'shared.name': 'Alice A - editable', 'shared.approved': '/Yes', 'shared_copy2_1.name': 'Alice A - editable', 'shared_source2_1.name': 'Bob B - editable', 'shared_source2_1.approved': '/Off'}, 'attachments': ['a', 'b']},
}

def resolve(value):
    return value.get_object() if hasattr(value, 'get_object') else value

def reference(value):
    if not isinstance(value, IndirectObject):
        value = getattr(value, 'indirect_reference', None)
    assert isinstance(value, IndirectObject), f'Expected indirect PDF reference, got {value!r}'
    return (value.idnum, value.generation)

def raw(dictionary, key):
    return dictionary.raw_get(key) if key in dictionary else None

def read_tree(value, leaf):
    tree = resolve(value)
    assert isinstance(tree, DictionaryObject)
    if leaf in tree:
        values = resolve(raw(tree, leaf))
        assert len(values) % 2 == 0
        return [(resolve(values[index]), values[index + 1]) for index in range(0, len(values), 2)]
    return [pair for kid in resolve(raw(tree, '/Kids') or []) for pair in read_tree(kid, leaf)]

def destination_page(reader, destination):
    value = resolve(destination)
    if isinstance(value, DictionaryObject):
        value = resolve(raw(value, '/D'))
    if isinstance(value, str):
        return reference(reader.named_destinations[value]['/Page'])
    assert isinstance(value, (list, ArrayObject)) and len(value) >= 2, f'Invalid destination {value!r}'
    return reference(value[0])

def check_file(filename, requirements):
    reader = PdfReader(ROOT / filename, strict=True)
    assert len(reader.pages) == len(requirements['pages'])
    page_refs = {reference(page): index for index, page in enumerate(reader.pages)}
    root = reader.trailer['/Root']
    fields = reader.get_fields() or {}
    actual_fields = {key: str(field.get('/V')) for key, field in fields.items() if field.get('/FT') in ['/Tx', '/Btn']}
    assert actual_fields == requirements['fields'], (filename, actual_fields)
    acro = resolve(raw(root, '/AcroForm'))
    canonical_objects = set()
    def field_tree(value, parent=None):
        obj = resolve(value)
        key = reference(value)
        assert key not in canonical_objects
        canonical_objects.add(key)
        if parent is not None:
            assert reference(raw(obj, '/Parent')) == reference(parent)
        for child in resolve(raw(obj, '/Kids') or []):
            field_tree(child, value)
    for value in resolve(raw(acro, '/Fields')):
        field_tree(value)
    widgets, links, text_sequences = [], [], []
    for page_index, (page, (letter, original_page, rotation)) in enumerate(zip(reader.pages, requirements['pages'])):
        text = page.extract_text()
        assert f'SOURCE {letter} / PAGE {original_page}' in text
        text_sequences.append(f'{letter}{original_page}')
        assert int(page.get('/Rotate', 0)) % 360 == rotation
        expected_size = (420, 594) if original_page == 1 else (594, 420)
        assert (float(page.mediabox.width), float(page.mediabox.height)) == expected_size
        operators = page.get_contents().get_data()
        assert b'BDC' in operators and b'EMC' in operators and b'Tj' in operators and b're' in operators
        assert b' Do' not in operators, 'Fixture must retain text/vector page operators rather than raster image pages'
        for annotation_ref in resolve(raw(page, '/Annots') or []):
            annotation = resolve(annotation_ref)
            assert reference(raw(annotation, '/P')) == reference(page)
            if annotation.get('/Subtype') == '/Link':
                target = destination_page(reader, raw(annotation, '/Dest'))
                assert target in page_refs
                target_letter, target_source_page, _ = requirements['pages'][page_refs[target]]
                assert target_letter == letter and target_source_page == 2
                links.append({'page': page_index + 1, 'targetPage': page_refs[target] + 1})
            if annotation.get('/Subtype') != '/Widget':
                continue
            assert reference(annotation_ref) in canonical_objects
            node, pieces, value, ft, parents = annotation, [], None, None, []
            while node:
                if '/T' in node: pieces.append(str(node['/T']))
                if value is None and '/V' in node: value = str(node['/V'])
                if ft is None and '/FT' in node: ft = str(node['/FT'])
                parent = raw(node, '/Parent')
                if parent is None: break
                assert reference(parent) in canonical_objects
                parents.append(reference(parent))
                assert len(parents) < 20
                node = resolve(parent)
            full_name = '.'.join(reversed(pieces))
            assert full_name in actual_fields and actual_fields[full_name] == value
            appearance = resolve(raw(resolve(raw(annotation, '/AP')), '/N'))
            if ft == '/Btn':
                state = str(annotation['/AS'])
                assert state == value and state in appearance
                stream = resolve(raw(appearance, state))
            else:
                stream = appearance
            assert len(stream.get_data()) > 0
            assert '/BBox' in stream
            widgets.append({'page': page_index + 1, 'name': full_name, 'value': value, 'appearanceBytes': len(stream.get_data()), 'ref': reference(annotation_ref)})
    for named in reader.named_destinations.values():
        assert reference(named['/Page']) in page_refs
    outline_targets = []
    def outlines(values):
        for value in values:
            if isinstance(value, list): outlines(value)
            else:
                target = reference(value['/Page'])
                assert target in page_refs
                outline_targets.append({'title': value['/Title'], 'page': page_refs[target] + 1})
    outlines(reader.outline)
    attachment_pairs = read_tree(resolve(raw(root, '/Names')).raw_get('/EmbeddedFiles'), '/Names')
    extracted_attachments = []
    for tree_name, file_ref in attachment_pairs:
        filespec = resolve(file_ref)
        embedded = resolve(raw(filespec, '/EF'))
        stream = resolve(raw(embedded, '/UF') or raw(embedded, '/F'))
        data = stream.get_data()
        extracted_attachments.append({'name': str(tree_name), 'bytes': len(data), 'hex': data.hex()})
    assert sorted(item['hex'] for item in extracted_attachments) == sorted(report['attachmentHex'][source] for source in requirements['attachments'])
    assert len({reference(value) for value in resolve(raw(root, '/AF'))}) == len(requirements['attachments'])
    struct_ref = raw(root, '/StructTreeRoot')
    struct = resolve(struct_ref)
    parent_pairs = read_tree(raw(struct, '/ParentTree'), '/Nums')
    parent_tree = dict(parent_pairs)
    assert len(parent_pairs) == len(parent_tree)
    seen_elements, contents, objects = set(), [], []
    def walk(value, parent, inherited_page=None):
        node = resolve(value)
        if isinstance(node, (list, ArrayObject)):
            for child in node: walk(child, parent, inherited_page)
            return
        if isinstance(node, (int, NumberObject)):
            assert inherited_page is not None
            contents.append((reference(parent), reference(inherited_page), int(node)))
            return
        assert isinstance(node, DictionaryObject)
        page = raw(node, '/Pg') or inherited_page
        if page is not None: assert reference(page) in page_refs
        kind = node.get('/Type')
        if kind == '/MCR':
            assert '/Stm' not in node and '/StmOwn' not in node
            contents.append((reference(parent), reference(page), int(node['/MCID'])))
        elif kind == '/OBJR':
            objects.append((reference(parent), reference(page), reference(raw(node, '/Obj'))))
        else:
            key = reference(value)
            assert key not in seen_elements
            seen_elements.add(key)
            assert reference(raw(node, '/P')) == reference(parent)
            assert '/S' in node
            walk(raw(node, '/K'), value, page)
    walk(raw(struct, '/K'), struct_ref)
    owned_keys = set()
    for parent, page_ref, mcid in contents:
        page = reader.pages[page_refs[page_ref]]
        parent_key = int(page['/StructParents'])
        owned_keys.add(parent_key)
        owners = resolve(parent_tree[parent_key])
        assert reference(owners[mcid]) == parent
        assert mcid in map(int, re.findall(rb'/MCID\s+(\d+)', page.get_contents().get_data()))
    for parent, page_ref, object_ref in objects:
        page = reader.pages[page_refs[page_ref]]
        annots = {reference(item): resolve(item) for item in resolve(raw(page, '/Annots'))}
        assert object_ref in annots
        parent_key = int(annots[object_ref]['/StructParent'])
        assert parent_key not in owned_keys
        owned_keys.add(parent_key)
        assert reference(parent_tree[parent_key]) == parent
    assert owned_keys == set(parent_tree)
    assert {widget['ref'] for widget in widgets}.issubset({item[2] for item in objects})
    assert int(struct['/ParentTreeNextKey']) > max(parent_tree)
    assert root['/MarkInfo']['/Marked'].value is True
    assert len(widgets) == len(reader.pages)
    return {'file': filename, 'byteLength': (ROOT / filename).stat().st_size, 'pageOrder': text_sequences,
        'rotations': [entry[2] for entry in requirements['pages']], 'fields': actual_fields, 'widgets': widgets,
        'links': links, 'outlines': outline_targets, 'namedDestinationCount': len(reader.named_destinations),
        'attachments': extracted_attachments, 'structureElements': len(seen_elements), 'markedContentReferences': len(contents),
        'objectReferences': len(objects), 'parentTreeKeys': len(parent_tree), 'allChecksPassed': True}

result = {'parser': 'pypdf', 'checks': [check_file(file, values) for file, values in expected.items()],
    'exportReports': report['exports'], 'visualInspection': 'PNG renders generated for parent review; this JSON does not claim visual inspection.'}
(ROOT / 'independent-verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result, indent=2))
