# Native PDF preservation — October 11, 2026

Audit issue **16** is implemented and verified. Previously, page copying retained text and vectors but could leave document-level features absent or pointing to old pages. Native export now rebuilds supported forms, navigation, attachments, and accessibility structures around the actual exported pages. It refuses detected structures that cannot be rebuilt safely. The untouched complete-source path still returns the original bytes without rewriting the PDF.

## Resulting behavior

- Native text, vector drawing, page boxes, resources, and annotations remain PDF objects after reordering, deleting, duplicating, merging, and rotating pages in 90° steps.
- AcroForm values, widget appearances, field ancestry, resources, and calculation order are retained. Deleted widgets are pruned. Duplicate fields and colliding names from merged sources receive distinct names so their values remain independent; these changes appear in the export report.
- Bookmarks, direct and named internal destinations, supported actions, page labels, and annotation relationships are remapped to output pages. Links to removed pages are removed and reported. Incoming navigation can still target a page deliberately converted to an image. Duplicate self-links target the duplicate.
- Embedded files and associated-file references retain their payload bytes. Colliding attachment names are disambiguated.
- Supported tag trees retain their hierarchy, role/class mappings, language and alternative text. Page and annotation parent indexes are rebuilt; duplicated tagged pages receive independent structure. Existing source hierarchies remain intact when interleaved pages cannot safely be reordered within them, with an adjustment report.
- Page-list rotations and editor rotations in 90° steps retain native content. Crop, resize, flips, filters, and other editor rotations create image content for the edited page, as explained in the editor. Revert restores its native source.

## Implementation

`js/pdf-native-core.js` creates the ordered output page slots and maps original page/catalog references before copying objects. It materializes inherited page resources and geometry, coordinates the structure modules, and checks the final reachable catalog for missing references or references to omitted pages. Duplicate pages use separate object copiers while sharing canonical cross-page annotation and layer identities where required.

`js/pdf-native-navigation.js` rebuilds destination/name trees, outlines, page labels, attachment entries, actions, and annotation relationships. `js/pdf-native-forms.js` rebuilds fields and widgets, handles independent duplicate/collision names, and aliases conflicting form resources without rewriting strings or comments in appearance instructions. `js/pdf-native-tags.js` rebuilds structure ancestry, marked-content/object references, parent trees, and structure IDs.

`js/pdf-preserve.js` coordinates these modules, captures source identity for both native pages and raster replacements, embeds image pages, flushes deferred image objects before reference validation, and reports adjustments. `js/app.js` retains the required source leases during export. `js/editor.js` keeps right-angle editor rotations native. The four structure modules load before the exporter in `index.html`.

## Verification

- **704/704 full regression tests pass**, with no failures or skips. Command: `node --experimental-vm-modules --test tests/*.test.cjs`. Log: `../tmp/issue-16-full-tests.log`. This adds 87 tests to the previous 617-test baseline: 86 structure regressions and one native-editor rotation regression. Existing exporter tests also exercise the new behavior.
- The structure suites use the shipped PDF library and full exporter. Cases include deletion, reordering, duplication, collisions across sources, form appearances/resources, radio selection pruning, destinations, attachment bytes, tag parents/IDs, raster replacements, action scope, malformed graphs, signatures, encrypted-source refusal, XFA/scripts, indirect layer types, and bounded XML metadata checks.
- Independent **pypdf** reopening passed for two source fixtures and three outputs, totaling **16 pages**. It checked page text/order/rotation, field values and widget ownership, appearance streams, actual link/bookmark page references, exact embedded-file bytes, and tag marked-content/object references and parent indexes. Durable evidence: [verification JSON](verification/native-pdf-independent-2026-10-11.json). The generation and independent verification scripts remain in `../tmp/issue-16/` as development artifacts.
- Poppler rendered all fixture/output pages. Source renders and the final revised, merged, and browser-export renders were visually inspected: readable native text, vector swatches, retained form appearances, correct checked/unchecked boxes, and the requested rotations. The environment emitted fallback-font warnings for Symbol/ArialUnicode; the fixture text uses Helvetica and the checkbox mark is vector drawing. No fixture rendering defect was observed.
- The actual browser imported both two-page PDFs, saved a 90° editor rotation without converting the page to an image, duplicated that page, and downloaded **five pages / 10,115 bytes**. Independent parsing confirmed order **A1, A1, A2, B1, B2**, rotations **90°, 90°, 0°, 0°, 0°**, independent duplicate/merged field names, working page references, two exact attachment payloads, and rebuilt tag indexes. Captured browser warning/error logs were empty. [Workspace screenshot](verification/page-forge-native-pdf-2026-10-11.png).
- All 18 production JavaScript files pass syntax checks. The local dependency inventory passes: **222 files / 7,973,623 bytes**.

The browser run verifies the normal merged/duplicated export path. The last metadata/layer safety refinements and final wording were verified through real-library tests and the final generated fixtures; the downloaded browser artifact predates those refinements. This pass does not claim new cross-browser, physical-device, screen-reader, or formal accessibility certification.

## Preservation boundaries

Digital signatures cover the original bytes, so changed or merged signed PDFs are refused. Encryption is retained only by untouched complete-source export; native rewrites of encrypted sources are refused. Unsigned signature placeholders can be rebuilt. The exact-original path bypasses rewriting and retains all original document features, including features unsupported by the rewrite path.

Detected XFA, PDF JavaScript, unsupported catalog/action/tag structures, malformed or ambiguous references, unsafe field-name actions, and incompatible document-level layer/output-intent/extension combinations stop native export with an explanation. Metadata exceeding the supported limit, unchecked XML representations, and PDF/A, PDF/UA, or PDF/X declarations also require untouched export because Page Forge cannot recertify a changed document. Validation has depth/object limits. These safeguards cover the implemented cases; they are not a universal fidelity guarantee for every PDF extension.

Merging uses the first PDF's ordinary metadata and display preferences; only its opening view/action survives, with a report for other opening choices. Interleaved tagged source hierarchies may keep source reading order, with a report. Adding untagged images retains existing tags and marks the result as suspect rather than claiming complete accessibility. Pixel edits or the explicit **Images · apply layout** choice deliberately discard native structure for those pages. Page Forge does not generate new signatures, recreate source encryption, repair arbitrary malformed PDFs, or certify PDF/A, PDF/UA, or PDF/X.

Issues 1–25 are now complete (**25/57**). This change closes Batch 4; the next untouched audit batch remains **26–30**.
