# Page Forge — UI redesign brief and concept archive

Prepared October 5, 2026; updated October 6, 2026, for continuing the redesign in a new session.

## Status and starting point

**Selected direction, October 5, 2026: Page Forge.** The user chose the Print desk workflow, the supplied Ocean Blue Serenity palette, and an original dark-fantasy archive atmosphere. The explicit name **Page Forge** overrides the RuneBinder name in the pasted style reference. Production implementation is underway; final integration verification is pending. [PAGE-FORGE-DESIGN.md](PAGE-FORGE-DESIGN.md) is now the canonical design and implementation handoff.

The five earlier concepts below are retained as historical design context. Their cream/copper, neutral, graphite/violet, and lime/yellow treatments are not the selected production palette. User feedback found the first additional alternatives too similar and difficult to discover; they were subsequently separated and made visually distinct. The original concept's resize error was repaired. Historical mockup checks below apply to those mockups only.

Read these before implementation:

- [Selected Page Forge direction](PAGE-FORGE-DESIGN.md): current palette, typography, workflows, implementation map, and verification status.
- [Original UI review](UI-REVIEW.md): historical findings, source references, and reasons for the proposal; recheck current source before treating them as unresolved.
- [Project memory](../Memory.md): user preferences, preservation constraints, audit history, and existing architecture.
- Production source: `index.html`, `css/styles.css`, and `js/`.
- Interactive concept: `C:/Users/skpra/.codex/visualizations/2026/10/04/01a10809-2285-79f3-ae36-3806f568cf96/photopdf-redesign.html`.
- Browser preview wrapper: `C:/Users/skpra/OneDrive/Desktop/Photo to PDF/tmp/ui-redesign-preview.html`.
- Focus canvas: `C:/Users/skpra/.codex/visualizations/2026/10/04/01a10809-2285-79f3-ae36-3806f568cf96/photopdf-focus-canvas.html`.
- Page board: `C:/Users/skpra/.codex/visualizations/2026/10/04/01a10809-2285-79f3-ae36-3806f568cf96/photopdf-page-board.html`.
- Print desk: `C:/Users/skpra/.codex/visualizations/2026/10/04/01a10809-2285-79f3-ae36-3806f568cf96/photopdf-print-desk.html`.
- Three-concept comparison archive: `C:/Users/skpra/.codex/visualizations/2026/10/04/01a10809-2285-79f3-ae36-3806f568cf96/photopdf-more-designs.html`.
- Additional-concepts wrapper: `C:/Users/skpra/OneDrive/Desktop/Photo to PDF/tmp/ui-more-designs-preview.html`.
- Current individual browser wrappers: `tmp/ui-focus-canvas-preview.html`, `tmp/ui-page-board-preview.html`, and `tmp/ui-print-desk-preview.html` in the project directory.

Each additional concept is presented as its own inline visualization so all three are immediately visible; the combined carousel remains an archive, rather than the only way to find them. The concepts use synthetic sample photos/documents, sample-page operations, and simulated output behavior. They are not conversion engines. Feature coverage, layout calculations, and mobile behavior are simplified; use this brief and production behavior to guide implementation rather than copying the mockups wholesale.

The original concept's ResizeObserver loop was reproduced and fixed: inactive variants are no longer temporarily unhidden for measurement, observer callbacks schedule work on the next animation frame, and dimensions are written only when changed. Local browser checks reported no runtime errors after orientation, margins, placement, rotation, variant switching, both simulated export summaries, and checks at 320, 736, and 1024 pixels wide. This is local browser evidence, not verification on every browser or device.

The three current individual mockups use responsive CSS without custom ResizeObservers. Local browser checks at 320, 736, and 1024 pixels reported zero runtime errors and no horizontal overflow for each design. Desktop and phone appearances were inspected. Interaction checks covered Focus canvas page navigation, rotation, moving a page, orientation, margins, and export summary; Page board selection, batch rotation, reversed order with stable selection, layout, quality choice, and export summary; and Print desk page selection, A4/Letter, orientation, numeric margins, guide visibility, and export summary. A clipped phone document preview was corrected to scale the complete sample document, and the narrow canvas controls were reflowed to keep their values readable. These are simplified concept checks, not verification of production PDF output, physical print accuracy, or every browser/device.

**Recheck current code before implementing.** Some source behavior is newer than `Memory.md`: local libraries and a persistent export report already exist, while historical audit entries still describe them as unresolved. Do not reproduce those old defects as current findings or mark audit issues fixed from this brief alone. Historical line numbers may have moved.

## Product objective

Make adding photos or PDFs, arranging pages, checking the actual output, and exporting one coherent workflow on desktop, tablet, and phone. Keep the document visible, make action scope explicit, and retain the processing and preservation work already completed.

The highest-priority changes are:

1. Replace separate Convert and Edit PDF interfaces with one shared document workspace.
2. Show the paper layout that will be exported, including margins and clipping.
3. Separate the active preview page from explicitly selected pages for batch actions.
4. Keep page actions discoverable and export reachable in long documents.
5. Show essential settings first, with advanced controls only when relevant.
6. Make keyboard, touch, progress, and failure states part of the design.

## Shared workspace requirements retained by Page Forge

Use a compact application header and three areas below it: page rail on the left, large output preview in the center, and Layout inspector on the right. A persistent export area contains the primary action and its quality toggle. The central paper surface should dominate the screen.

### Header and empty state

- Header: Page Forge, editable document name, total page count, Undo, Redo, and Add files.
- Use one document name as the export filename source; normalize `.pdf` once and retain existing filename safeguards.
- Keep Undo/Redo available after the last page disappears when history still permits recovery.
- Empty state: “Add photos or PDFs,” a browse button, drag-and-drop target, supported-format hint, and accurate local-processing reassurance.
- Put detailed file/resource limits in an accessible “File requirements” disclosure; show relevant limits inline when a file is rejected.
- Use the existing intake queue so imported file order remains predictable. One Add files action accepts both supported image files and PDFs.
- After import, replace the large empty state with the document workspace. Add files remains available.

### Page rail and page actions

- Show numbered, uncropped thumbnails with a short filename and image/PDF source indicator; allow a full-name tooltip or accessible description.
- Clicking a page makes it the active preview page. Its highlight must differ from the checkbox selection state.
- Checkboxes explicitly select pages for batch actions. Provide Select all, Clear selection, a selection count, and an unambiguous action toolbar.
- “Rotate page” acts on the active page. “Rotate 3 selected pages” acts on the checked set. A separate “Rotate all pages” always means every page.
- Reorder by drag-and-drop and by visible Move earlier / Move later controls. Provide keyboard alternatives and announce the resulting page position.
- Expose Duplicate and Remove through visible actions or a labeled page menu; essential controls must not depend on hover.
- Keep selection and active-page identity stable through reordering and undo. After deletion, choose a predictable neighboring preview page or the empty state.
- Retain Undo for reversible removals; use clear scope wording for Clear document.

### Actual output preview

- Render the active page inside the correct paper rectangle, including its physical size, orientation, margins, and visible crop.
- Use `computePdfLayout` from `js/pdf-layout.js` for image-page geometry so preview and export agree. Do not introduce competing CSS-only layout math.
- For preserved native PDF pages, show their real page box and rotation; do not imply image-layout settings will affect their native export.
- Update the preview when layout, order, active page, rotation, or committed image edits change.
- Show page position, paper dimensions, relevant cropping/scaling feedback, and Fit page / zoom controls where useful. Zoom changes viewing only.
- Put Rotate, Crop, and Adjust beside the preview. Name source-image rotation separately from paper orientation.
- Use bounded previews and the existing cache/resource limits. Guard asynchronous rendering against stale page or settings state.
- Resize handling must converge: measure a stable container, avoid writing dimensions that feed back into that same measurement, and skip unchanged size writes.

### Layout inspector

Primary controls, in order:

1. Paper size: A4, Letter, A3, A5, and Fit to image, preserving current options.
2. Orientation: Auto per image, Portrait, Landscape.
3. Margins: numeric millimetres, optionally with named presets that expose their actual values.
4. Image placement: Contain (no crop), Fill within margins, and Print size (DPI).

State the settings scope beside the inspector heading. Initially preserve the engine's shared settings model: document layout applies to image output pages, with native PDF preservation exceptions explained. Do not imply per-page layout overrides exist unless their storage and export behavior are implemented.

- Reveal Photo print DPI when Fit to image or Print size requires it; default remains 300. Explain that embedded photo DPI is not read.
- Reveal overflow behavior for Print size: Scale down to fit or Keep size and crop.
- Imported PDF pages retain saved physical dimensions when using their original size; choosing image output and a standard paper size is an explicit change.
- Show PDF content controls only when PDF pages are present. Preserve PDF pages and Images (apply layout) must describe their different effects.
- Avoid a wall of disabled controls. When a control remains visible but unavailable, explain why beside it.
- Validate numeric input with associated, actionable messages; do not silently show one value while exporting another.

### Persistent export area

- Use one primary label throughout: **Forge PDF**. Keep it reachable without scrolling through the page list.
- Place **Preserve original quality** directly beside Forge PDF, including on mobile. Remember its choice using the existing settings mechanism.
- Explain concisely: avoids additional lossy export compression of current image detail; files may be larger; earlier quality loss cannot be restored.
- Disable conflicting compression choices while preservation is enabled, with a reason. Do not confuse image quality preservation with native PDF structure preservation.
- Retain the existing image-quality modes when preservation is off, and disclose them under export options rather than among primary layout controls.
- Disable duplicate export starts across all views. Export uses the existing captured document/settings snapshot, independent of later UI changes.
- Display measured output size after export. Do not promise speculative file-size estimates.
- Keep the persistent result report with the filename, actual page count, actual bytes, and any omitted/failed pages. A partial result must not look like complete success.

## Phone and tablet behavior

- On phones, use Pages / Preview / Layout views over the same document state, with the export area persistently reachable.
- Keep page selection and viewing position when switching views. Opening a page in Preview should not lose its place in Pages.
- Use a labeled page-action sheet for touch operations; provide Move earlier/later in addition to drag gestures.
- Keep Forge PDF and its quality toggle together in a bottom action area that respects device safe areas and does not obscure content.
- At intermediate widths, collapse or switch the inspector using available space; avoid squeezing all three desktop columns into unreadable panels.
- Adapt to zoom, landscape phones, and virtual keyboards. Set content minimum sizes carefully so nested grids/flex items do not force horizontal overflow.
- Breakpoints are implementation choices to validate with content; the mockup is not evidence of real-device compatibility.

## Alternative concept: Guided flow

The second concept uses **Add → Arrange → Export** for occasional users who primarily want quick conversion. Add accepts files and shows intake results; Arrange handles ordering and page actions; Export presents layout, output preview, quality, filename, and the final action.

- Keep Back available and preserve the same document/settings state between stages.
- Make completed stages revisitable; do not make users restart to add another image or fix page order.
- Reuse the same engine, selection rules, quality/preservation constraints, and error reporting as the workspace.
- This reduces the number of controls visible at once but adds navigation when users repeatedly adjust layout and page content. Document workspace remains the recommendation for the full current editing feature set.
- Treat all five concepts as product alternatives, not five production tabs to implement together.

## Three additional visual and workflow directions

### Focus canvas

A full graphite editor uses a violet accent, a slim vertical tool rail, a dominant white paper preview, compact page metadata, and a horizontal filmstrip along the bottom. Keep the canvas spacious; layout settings belong in a collapsible panel and Export PDF with its quality toggle stays in persistent chrome. Its dark surfaces and tool placement should feel like a focused image editor. On phones, expose the filmstrip and tools without covering the page. This suits visual review, cropping, rotation, and careful editing of a few pages. A filmstrip shows fewer pages at once than a grid, so large-document organization takes more scrolling; explicit batch selection and a page overview remain necessary.

### Page board

A bold lime/yellow stationery theme uses large typography, square page cards, thick ink borders, and an edge-to-edge responsive grid. Put layout choices in a horizontal control bar and make Export PDF prominent alongside Preserve original quality. Numbered cards, source-type labels, explicit checkboxes, and a selection-count toolbar support batch actions. Selecting a page opens an expanded true-output preview without losing the grid position. This is strongest for bulk photo conversion, sorting, removing duplicates, and organizing many pages. The tradeoff is less room for judging margins or subtle crops; users need a deliberate full-preview step before export. On phones, wrap the layout bar and reduce grid columns while retaining clear selection actions.

### Print desk

An editorial cream-and-copper “paper atelier” uses serif headings, a slim page rail, a quiet ruled inspector, and a document/receipt preview. Physical measurements and margin guides surround the paper. Group paper size/orientation, image placement, numeric margins, Photo print DPI, and print-size overflow behavior in a clear order. Retain a persistent export area; guides are preview overlays and must never appear in the PDF. This suits users who care about exact paper layout and image print size. Show DPI only when relevant, preserve the current shared layout scope, and describe cropping/scaling explicitly. Its precise controls require more learning and stronger mobile disclosure. It does not add printer calibration, bleed, color management, or professional prepress guarantees.

## Choosing among the five proposals

| Concept | Visual identity and layout | Best fit / recommendation | Main tradeoff |
| --- | --- | --- | --- |
| Document workspace | Neutral three-area workspace: pages, preview, settings. | Default for the full existing editing feature set. | Three desktop areas need deliberate adaptation on small screens. |
| Guided flow | Staged Add → Arrange → Export interface. | Occasional, simple conversion. | Repeated layout and page edits require moving between stages. |
| Focus canvas | Graphite/violet editor, vertical tools, large preview, horizontal filmstrip. | Visual review and focused editing of individual pages. | Filmstrip navigation is less efficient for large page collections. |
| Page board | Lime/yellow stationery, square ink-bordered cards, large grid, horizontal controls. | Prefer when bulk conversion and many-page organization are the priority. | Output detail needs an expanded preview. |
| Print desk | Cream/copper editorial typography, document preview, page rail, ruled inspector. | Precise paper measurements, margins, DPI, and placement. | More controls and terminology for casual users to learn. |

These layouts share the engine, preservation requirements, accessible interaction rules, and recovery behavior below. A style choice must not remove existing capabilities or imply an unimplemented feature.

## Image editor interaction model

Open a dedicated editor for the active page with the page name/position, current preview, tool controls, and one explicit **Apply changes / Cancel** pair for the whole session.

- Crop, resize, and adjustments update a draft. If a tool needs its own commit action, name it specifically (for example, “Set crop”) and distinguish it from saving the session.
- Apply changes commits the accepted operations once to the captured page identity; Cancel leaves the document unchanged.
- Keep existing operation serialization, session guards, temporary-resource ownership, and stale-callback protection.
- Do not repurpose the current overlapping Apply/Apply to all/Save/Revert controls with cosmetic relabeling alone; reconcile their state and scopes.
- Offer a precisely named batch action only for supported operations and an explicit target set. Preserve each target page's own source and transformations.
- Block or queue competing operations consistently during processing, show progress, and retain recoverable edits after failure where supported.
- If editor-local undo is added, define it separately from document undo and verify behavior across tool changes and cancellation.

## Mixed image/PDF preservation rules

- Identify original PDF pages and image pages in the page rail and contextual controls.
- Preserve the existing native PDF path for untouched pages and supported native page operations. Do not rebuild every page from its thumbnail or preview canvas.
- An untouched whole-PDF export can use exact original bytes through the current preservation path; that promise does not extend automatically to modified/merged documents.
- Before an image edit or raster-output choice converts a PDF page into a picture, explain the loss of searchable text/vector content at that action.
- Modified/merged output does not guarantee forms, bookmarks, internal links, accessibility tags, attachments, encryption, or signatures. Retain accurate notices and existing preservation failures.
- Audit issue 16 remains architectural work. A new layout does not resolve its advanced-feature preservation requirements, and no acceptance of those limitations is recorded.

## Accessibility and visual language

- Follow the selected dark ocean-blue Page Forge identity while keeping paper surfaces, control hierarchy, readable contrast, and visible focus clear. The earlier theme alternatives are archival; do not restore an unrelated light theme by default.
- Use readable supporting text and adequate contrast; avoid the current very small filename/label treatment. Start near 16 px for main text and validate supporting sizes at browser zoom.
- Target comfortable touch controls around 44 CSS pixels, clear visible focus, and non-color-only selection/error indicators.
- Use native buttons, inputs, labels, fieldsets, and meaningful accessible names. Icon-only controls need names and visible tooltips where helpful.
- Make page navigation, selection, reordering, editing, and export fully keyboard reachable; drag must have a non-drag equivalent.
- Dialogs move focus inside, contain focus, support appropriate Escape behavior, and restore focus to the invoking control. Background document shortcuts must not run while editing.
- Announce import/export progress, selected-page counts, reorder results, and failures without flooding the live region on each render.

## Progress, error, and recovery states

- Import: show the current file, meaningful progress where measurable, accepted/rejected results, and actionable rejection reasons. Preserve successful intake ordering and transactional cleanup.
- Empty/cleared document: show the add-files state while retaining valid undo/redo recovery.
- Export: show progress and prevent duplicate starts; retain the existing immutable export snapshot and resource leases.
- Partial export: distinguish completed and omitted pages, list names/reasons, and offer an appropriate retry or edit action. Never silently downgrade a preservation failure to raster output.
- Resource limit: identify the exceeded constraint and suggest reducing pages/dimensions or exporting in smaller groups. Keep processing limits intact.
- Password-protected PDF: retain the existing password/cancel workflow and accessible focus behavior.
- Long operations: expose cancellation only when the underlying operation can actually cancel and clean up safely.

## Architecture to reuse

| File or area | Responsibility to retain or adapt |
| --- | --- |
| `index.html`, `css/styles.css` | Unified shell, semantic controls, responsive workspace, dialogs, and themes. |
| `js/app.js` | Shared document state, stable page identity, selection/history, rendering orchestration, settings, and export snapshot/report. Extract cohesive UI modules as needed. |
| `js/pdf-layout.js` | Physical page/image/clipping geometry shared by output preview and export. |
| `js/editor.js` | Editing sessions, guarded async work, image operations, and atomic commit. |
| `js/file-intake.js`, `js/import-queue.js` | Supported-format validation, ordered intake, cancellation, and capacity checks. |
| `js/pdf-loader.js`, `js/pdf-import.js` | Local PDF.js loading, password handling, PDF page import, and physical metadata. |
| `js/pdf-images.js`, `js/pdf-preserve.js` | Image encoding/quality and native PDF object preservation; keep these distinct. |
| `js/raster-limits.js` | Raster, decode, cache, and memory/work limits. |
| `vendor/`, `tests/` | Existing packaged dependencies and meaningful regression coverage. |

Keep HTML, CSS, and logic separated. Avoid rewriting processing code merely to reorganize controls. Preserve stable page IDs, resource leases, transactional imports, export snapshots, settings persistence, and undo semantics.

## Phased implementation and acceptance

1. **Establish the current baseline and unified shell.** Recheck source and tests; map every current feature into the new workspace. Verify add/import, ordering, undo/redo, settings persistence, and both image/native export paths still work.
2. **Implement the true output preview.** Share geometry with export; compare rendered PDFs with the UI for portrait/landscape/Auto, all paper sizes, contain/fill/print size, margins, DPI overflow, rotated photos, and mixed-size native pages.
3. **Fix interaction scope and editor flow.** Verify active-page versus checked-set actions, reorder/delete/undo selection, visible page controls, draft Apply/Cancel, queued edits, and stale async results.
4. **Finish contextual settings and export states.** Verify quality-toggle placement/persistence, relevant controls, duplicate-start protection, preservation notices, partial failure reports, and actual output size.
5. **Validate responsive and accessible behavior.** Check narrow phones, tablet widths, desktop, long documents, keyboard-only navigation, browser zoom, focus restoration, touch alternatives, dark mode, and resize stability. Record real-device and browser coverage accurately.

Use focused regression checks appropriate to each changed behavior plus browser/PDF visual verification where relevant. Keep historical audit numbering intact; mark an issue complete only when its own acceptance behavior is implemented and verified. Do not claim all audit issues are solved by the redesign.

## Reusable next-session prompt

> Continue work on **Page Forge**, using the selected Print desk workflow and original ocean-blue dark-fantasy archive identity. Read `docs/PAGE-FORGE-DESIGN.md`, `Memory.md`, this brief, and the current source first. Use Page Forge as the brand, not RuneBinder. Preserve the combined image/PDF intake, native PDF path, quality toggle beside Forge PDF, resource limits, and stable page/history behavior. Keep the output preview aligned with shared export geometry. Keep HTML, CSS, and JavaScript separated. Verify each changed workflow and report remaining limitations without marking unverified audit issues complete. Earlier concepts are references, not alternate production tabs.
