# Page Forge — selected design and implementation handoff

Prepared October 5, 2026; updated October 8, 2026. This is the canonical record for continuing the application in a new session.

## Decision and status

The user explicitly chose **Page Forge** as the name and asked for a complete production UI redesign combining **Print desk** with the attached **Ocean Blue Serenity** palette and an original dark-fantasy atmosphere. **RuneBinder is reference copy only and must not replace Page Forge.**

The production redesign and the prioritized review improvements are implemented. The shared image/PDF workspace, fitted Print desk preview, compact working mode, persistent export dock, collapsible mobile Binding Options, native editor/preview dialogs, progress/results, and Page Forge branding are integrated. Current local verification passes **540/540 regression tests**. The [upload-order follow-up](UPLOAD-ORDER-2026-10-08.md) ensures Forge waits for every selected file to finish importing, confirms five uploaded images match their numbered PDF pages, and documents native-picker selection limits. Read [the October 8 UI implementation record](PAGE-FORGE-IMPROVEMENTS-2026-10-08.md) for the design improvements and browser/dependency evidence; earlier native/mixed output evidence remains recorded below.

The older Document workspace, Guided flow, Focus canvas, Page board, and cream/copper Print desk mockups are historical alternatives in [UI-REDESIGN-BRIEF.md](UI-REDESIGN-BRIEF.md). They are not additional application tabs and do not define the current production colors. [UI-REVIEW.md](UI-REVIEW.md) explains the original usability concerns. [Memory.md](../Memory.md) retains the audit ledger, processing constraints, and prior implementation history.

## Visual identity

Page Forge should feel like a precise print desk inside a forgotten magical archive: solemn, elegant, mystical, and restrained. Dark navy surfaces surround a clear paper preview. Thin rules, angular framing, quiet celestial geometry, and small blue light effects supply the atmosphere. The controls remain understandable as ordinary file, page, and PDF controls.

Create original geometric ornaments and document emblems. Do not reuse Elden Ring logos, symbols, characters, interface assets, screenshots, or artwork. Avoid bright white application chrome, oversized rounded cards, neon styling, glossy game buttons, heavy glass effects, and decorative clutter.

The user supplied `C:/Users/skpra/Downloads/Ocean Blue Serenity.png`; the palette is recorded below so future work does not depend on the Downloads file remaining available.

| Token role | Exact foundation color | Intended use |
| --- | --- | --- |
| Deep navy | `#03045E` | Dominant atmosphere and background foundation; mix toward near-black for large reading surfaces. |
| Royal dark blue | `#023E8A` | Navigation, elevated panels, dialogs, and depth. |
| Ocean blue | `#0077B6` | Dividers, borders, secondary controls, inactive structure. |
| Active blue | `#0096C7` | Active details and restrained progress illumination. |
| Arcane cyan | `#00B4D8` | Hover and drag illumination, subtle glows. |
| Bright highlight | `#48CAE4` | Important interactive accents and visible focus. |
| Pale supporting text | `#90E0EF` | Secondary information on dark surfaces. |
| Light blue | `#ADE8F4` | Supporting highlights and quieter pale details. |
| Icy primary text | `#CAF0F8` | Main readable text on dark surfaces. |
| Antique gold | `#C6A15B` | The single additional accent: emblem, selected border, fine rules, key heading detail, and primary action edge. |

Treat the suggested balance as art direction, not a literal pixel quota: roughly 75% dark navy, 15% blue/cyan detail, 7% pale text, and 3% antique gold. A PDF's paper remains faithful to its output; dark surrounding chrome must not tint exported content. Do not use bright cyan for every edge or gold for large surfaces.

## Typography and component tokens

- **Headings and brand:** Cinzel, followed by Georgia/serif fallback. Use measured letter spacing and occasional uppercase for short labels. Avoid long paragraphs in spaced uppercase.
- **Reading text:** EB Garamond, with Georgia/serif fallback, for atmospheric prose and supporting narrative. Compact technical values, filenames, and controls use a system UI stack for scanning; keep these large and readable at browser zoom. Native fallback remains available if a local font fails.
- **Font delivery:** local files under `vendor/fonts/`, declared in `css/fonts.css` with `font-display: swap`. Retain the SIL Open Font Licenses and font provenance. No Google Fonts stylesheet or third-party font request at runtime.
- **Surfaces:** near-square panels, restrained chamfered details, 1 px rules, double-border details in the upload tablet, and subtle blue shadowing. Decorative corners must not reduce button hit areas.
- **Spacing:** organize controls into clear groups with consistent gaps; give the paper preview room to breathe. Keep supporting controls subordinate to the active page and Forge PDF action.
- **Controls:** native labeled inputs/selects and real buttons. Use visible focus, adequate contrast, and touch targets around 44 CSS pixels. Keep page actions visible instead of depending on hover.
- **Motion:** short, understated border/opacity transitions, a restrained circular progress ornament, and respect `prefers-reduced-motion`. Progress remains understandable from text when animation is off.

## Product copy

| Purpose | Copy direction |
| --- | --- |
| Brand | Page Forge |
| Hero | Bind Thy Images Into a Tome |
| Supporting sentence | Gather your images, arrange their order, and forge them into a single PDF. |
| Main intake | Drop Thy Images Here, with an ordinary Choose files action and explicit PDF support. |
| Settings | Binding Options |
| Main action | Forge PDF |
| Processing | Binding the pages… plus actual measurable progress where available. |
| Complete export | Thy Tome Is Forged, with filename, page count, actual bytes, and download action. |
| Partial or failed export | Plain, explicit warning explaining missing pages or failure; never use the complete-success heading. |

Use fantasy language sparingly. Format limits, native-PDF preservation warnings, error messages, numeric measurements, and technical options use ordinary language. Do not copy the sample prompt's 20 MB limit: the actual application limits govern the advertised requirements.

## Workspace and workflow

### 1. Add pages

Use one combined file picker and drop target for supported images and PDFs. The empty-state upload tablet is the main visual object: fine double borders, original geometric ornament, and restrained cyan drag feedback. After adding content, keep a compact Add files action available.

The existing FIFO import queue owns each selection. It preserves selected-file order and each PDF's contiguous page group; overlapping selections cannot interleave. Keep transactional PDF imports, cancellation, filename/type detection, limits, password handling, and persistent rejected-file reporting.

Supported intake and limits come from the production engine: JPEG, PNG, WebP, GIF, and BMP with verifiable dimensions, plus PDF. Images have a 32 MiB input limit, 16-megapixel raster limit, and 8,192-pixel per-side limit; PDF inputs have a 50 MiB limit; documents contain at most 200 pages. Unsupported formats receive actionable reasons. Do not promise TIFF, SVG, AVIF, or arbitrary `image/*` browser decoding when the current safety checks reject them.

### 2. Arrange and inspect

The desktop Print desk uses a page rail, a dominant central paper preview, and a ruled Binding Options inspector. Show page number, filename, source type, and explicit checkbox in the rail. Page selection activates its preview; checkbox selection identifies batch targets. These two states must be visually distinct and must retain stable page identity across reorder, duplicate, delete, undo, and redo.

Expose rotate, edit, duplicate, remove, Move earlier, and Move later through visible controls. Drag reordering is an optional shortcut, not the only way to organize pages. Make bulk action scope explicit: a checked set, the active page, or all pages. Keep Undo/Redo usable after the last visible page is removed when history still allows recovery.

The production image editor retains its guarded operations and save flow. Its native modal, explicit keyboard focus loop, connected post-save focus restoration, associated input labels, readable slider values, and consistent SVG controls are implemented and locally checked. The earlier proposed draft-editor/Apply/Cancel architecture is not implemented by this pass, and complete screen-reader/device acceptance remains separate.

### 3. Preview the output

`js/forge-preview.js` supplies the central output preview. Image-page placement must use `computePdfLayout` from `js/pdf-layout.js`, including paper size, orientation, margin clipping, Contain/Fill/Print size, print DPI, and overflow behavior. Display physical dimensions and explain scaling or cropping when relevant.

For unedited native PDF pages in preservation mode, preview their saved physical page dimensions and rotation. Paper-layout settings apply to image content; do not imply that changing a global image margin reflows native PDF text. Native preview pixels may come from the existing bounded import raster, but export must still use the original native objects/bytes. A visual preview is not a color-managed print proof and does not guarantee fidelity for every advanced PDF feature.

Preview work must capture the active source/settings and reject stale asynchronous results. Release temporary resources and keep canvas dimensions bounded. Decorative measuring guides and ornamentation are preview-only and must not enter exported files.

### 4. Configure binding

Show paper size, orientation, margins, and placement first. Preserve supported existing paper sizes and image-placement options even if the sample style prompt listed fewer. Keep advanced controls for Photo print DPI (default 300), overflow scale/crop behavior, quality, and PDF content mode. Numeric margin controls remain accurate; named presets must map to documented values if introduced.

Keep **Preserve original quality** immediately beside **Forge PDF**, including on mobile, and persist its existing setting. Explain that it avoids new lossy export compression and cannot recover detail already lost. Distinguish it from **Preserve PDF content**, which controls the native PDF path.

### 5. Forge and recover

The main action invokes the existing shared export pipeline with an immutable capture of pages and settings. Prevent simultaneous export starts; progress and disabled state must remain coherent. Retain URL/source leases so live edits or clearing do not corrupt an in-flight export.

Keep complete, partial, and failed outcomes distinct. The persistent export report names omitted pages and their reasons and shows the actual generated file size. Partial output retains explicit warning copy rather than the complete-success heading.

The Download PDF action retains the generated URL, captured filename, output revisions, and its byte-budget reservation. Repeated downloads reuse the same output without another serialization or reservation. Changes since export rename it Download previous PDF and show an explicit forge-again message. A retry retains the previous file through failure when both outputs fit the download budget; a replacement needing its space evicts it only after validating the new output size. Replacing output, resetting results, creating another tome, or `pagehide` releases URL/reservation ownership exactly once. Navigation into the back/forward cache also triggers cleanup; returning restores the preview but requires forging again to restore the in-tab download action. An already downloaded file remains on the device. Failed initial download setup does not retain a URL or reservation.

Create another document and return-to-arrange actions must preserve the existing clear/undo rules and avoid unexplained data loss. Uploaded documents and generated output stay in the tab; no cross-device sync or saved document library is promised.

## Responsive and accessible behavior

The empty state keeps the hero and upload tablet. Once loaded, show the compact document heading and Add files. On phones use a shallow horizontal page strip, output preview, and collapsible Binding Options, with the quality toggle beside Forge PDF in the bottom dock. Desktop fits the complete paper within a viewport-sized desk with an independently scrollable inspector. Keep native non-drag Earlier/Later controls, avoid horizontal overflow, respect safe areas, and provide content/scroll padding for fields above the dock. Real-phone virtual-keyboard behavior still needs device testing.

Use ordinary landmarks, headings, labels, native controls, accessible names, and visible keyboard focus. Support non-drag reordering and keyboard page navigation. Announce processing/results without flooding live regions. Keep document shortcuts inactive in text fields, the image editor, and full-size preview. Decorative runes and geometry are hidden from assistive technology.

Automated checks cover dialog shortcut blocking, editor/full-size Tab boundaries, post-render focus restoration, empty Redo recovery, navigation without rebuilding cards, click-time export revisions, failed retries, and download budget ownership. Fresh browser checks confirmed editor/full-size focus loops, Save/Undo, visible empty Redo, whole-card navigation, quality states, stale/re-forged downloads, and a phone field above the dock. Screen-reader announcements, touch gestures, real-device virtual keyboards, and cross-browser behavior still require their own acceptance testing.

## Implementation map and invariants

| Area | Responsibility |
| --- | --- |
| `index.html` | Page Forge shell, semantic workspace, controls, upload/processing/result states, and retained editor/dialog markup. |
| `css/styles.css`, `css/page-forge.css` | Existing application state styles plus the Page Forge visual system, scoped to `body.forge-app` and loaded after the legacy stylesheet. |
| `css/fonts.css`, `vendor/fonts/` | Self-hosted Cinzel/EB Garamond and licenses. |
| `js/app.js` | Shared document state, active page/checked set, history, rendering hooks, controls, export snapshot/report, and download lifecycle. |
| `js/forge-ui.js` | Workspace action state, native information dialogs, active-page actions, and retained latest-download ownership. |
| `js/forge-preview.js`, `js/pdf-layout.js` | Bounded output preview and shared physical layout geometry. |
| `js/file-intake.js`, `js/import-queue.js`, `js/pdf-import.js` | Classification, one ordered mixed intake, limits, cancellation, and transactional PDF import. |
| `js/pdf-loader.js`, `js/pdf-preserve.js`, `js/pdf-images.js` | Local PDF dependencies, native preservation, and image export/quality. |
| `js/editor.js`, `js/raster-limits.js` | Guarded image editing and application-controlled resource bounds. |
| `vendor/manifest.json`, `scripts/dependency-check.cjs` | Reviewed local dependency inventory, hashes, and provenance. |
| `tests/` | Regression evidence for changed behavior and existing engine guarantees. |
| `scripts/serve-preview.py` | Loopback development server with explicit module/font MIME types and no-store responses. |

The hidden legacy Edit PDF DOM may remain temporarily for compatibility. Do not remove its IDs or hooks without updating all startup/progress/history paths and regression coverage. The visible product should present one shared workspace. Preserve existing local-storage setting keys so a brand rename does not discard users' preferences.

The theme defines the supplied palette as `--forge-navy`, `--forge-royal`, `--forge-ocean`, `--forge-blue`, `--forge-cyan`, `--forge-light`, `--forge-pale`, `--forge-mist`, `--forge-ice`, and `--forge-gold`. Large reading surfaces use derived `--forge-bg`, `--forge-panel`, and `--forge-panel-raised` values. Fonts are `--forge-heading`, `--forge-prose`, and `--forge-ui`. Modify these shared tokens before adding competing colors or ad hoc font declarations.

The preview module exposes `window.PageForgePreview.refresh()` and `.clear()`. Call refresh after active-page, document, layout, quality, or PDF-content-mode changes; call clear when the document is emptied. Its required elements are `forgePaper`, `forgePreviewCanvas`, `forgePreviewEmpty`, `forgeDimensions`, `forgePreviewLabel`, and `forgePlacementNote`. It coalesces updates with animation frames, bounds preview pixels to a 1,200-pixel maximum side, and has no ResizeObserver. Preserve request/source guards when extending it.

Keep native PDF preservation claims precise: untouched whole-source output can be byte-for-byte; supported page operations retain native text/vector content. Modified/merged PDFs do not guarantee forms, bookmarks, internal links, tags, attachments, encryption, or signatures. Audit issue 16 remains partial. Do not rasterize every page from the new preview.

## Verification and remaining work

- **Regression suite:** `node --experimental-vm-modules --test tests/*.test.cjs` passed **540/540**, with zero failures or skips. The UI improvement pass adds 28 regressions to the 508-test baseline; the upload-order follow-up adds four. Coverage includes the functional corrections described above, separate active/checked state, stable identity, stale preview rejection, output geometry, native preservation, honest export outcomes, resource cleanup, and import-to-export ordering. DOM/canvas boundaries are controlled in these automated tests; native-PDF checks also exercise real libraries. Latest log: `../tmp/page-forge-upload-order-tests.log`.
- **Local dependencies:** `node scripts/dependency-check.cjs` verified **222 files totaling 7,973,623 bytes**, including self-hosted fonts, licenses, parser/worker, and rendering assets.
- **Browser workflows:** the desktop workspace imported two PNGs followed by a three-page native PDF in order. Checks covered separate active-page and batch-checkbox state, moving a page and undoing, A4 landscape with Fill and 20 mm margins, Preserve original quality disabling JPEG compression selection, editor rotation/save/undo, Full size preserving the checked batch, Tools/About/Privacy dialog open/close, actual Forge PDF output, and Download PDF again. At 320 CSS pixels, the editor was visible and scrollable and its close action worked.
- **Layout:** the final two-image workspace was measured at **320 x 740**, **736 x 900**, **1024 x 768**, and **1400 x 900** CSS-pixel viewports with **no horizontal overflow**. The empty state was also checked at 320 x 740. Decorative orbit overflow was corrected with clipping; the workspace stacks at smaller widths.
- **Actual output:** `page-forge-browser-qa.pdf` contained **five pages and 18,954 bytes**. Its two image pages are exactly **297 x 210 mm**, with a **257 x 170 mm** clip rectangle inset by **20 mm**. Their embedded decoded pixels match the source PNGs. Three native pages retain their source boxes, rotation, selectable text, and identical content streams. All five Poppler renders were visually inspected. The native pages correctly keep their different original geometries. See [PDF output verification](verification/page-forge-pdf-verification.md) for sample details and coverage limits.
- **Current visual evidence:** [improved desktop workspace](verification/page-forge-improved-desktop.jpg) and [improved 320-pixel phone workspace](verification/page-forge-improved-mobile.jpg). Earlier redesign screenshots remain as historical evidence.
- **October 8 follow-up:** all review improvements are implemented and checked at the same four viewport sizes with no horizontal overflow. The working desk begins around 260 pixels on desktop; the compact two-page phone document is 1,886 pixels tall, with a persistent 118-pixel dock. A fresh two-page A4 export preserves both source PNGs' decoded pixels; Download previous PDF returned the older output unchanged after a live margin edit. Full details: [implementation record](PAGE-FORGE-IMPROVEMENTS-2026-10-08.md).
- **Earlier mixed-PDF repeat download:** both browser downloads were **18,954 bytes** with SHA-256 `abc440b38df8cbffa08796cd49050414f44236fa11747ac5bf302db224d5247d`. This confirms the repeated action downloaded the captured output unchanged. The October 8 record separately verifies a stale previous download and its newer lifecycle.
- **Development server:** use `python scripts/serve-preview.py` rather than relying on platform MIME defaults. It explicitly serves `.mjs`/`.js` as JavaScript, `.wasm` as WebAssembly, and `.ttf` as fonts; Windows otherwise served modules as `text/plain` and the browser rejected PDF imports. The default loopback port is **8766**; a fresh-origin browser QA run also used **8767**. Its `Cache-Control: no-store` behavior is for development and is not an offline-install or production caching strategy.
- **Coverage boundary:** local browser checks are not a claim of all-browser, real-device, screen-reader, or printer compatibility. Record tested viewport widths and workflows rather than simply saying “responsive tested.”
- **Audit ledger:** no audit boxes are changed by the redesign. The historical verified count remains **24/57**, with issue 16 partial and issues 26–57 awaiting their individual acceptance review. Some current implementations are newer than those historical unchecked descriptions.
- **Connectivity:** all libraries and fonts are local assets, but there is no implemented service worker or verified offline install/cache readiness. A hosted first load needs connectivity. A complete local static server can serve the app without third-party resources.
- **Deployment:** no publication or hosting setup is part of this UI change. Preserve `.nojekyll` and all required local dependency files when publishing later.

## Next-session prompt

> Continue improving **Page Forge**. Read `docs/PAGE-FORGE-IMPROVEMENTS-2026-10-08.md`, `docs/PAGE-FORGE-DESIGN.md`, `Memory.md`, and the current production code first. The redesign and prioritized review improvements are implemented and locally verified; use the recorded evidence and coverage limits rather than restarting the redesign. Preserve the Print desk workflow, compact loaded mode, persistent quality/export dock, exact Ocean Blue Serenity palette, restrained original dark-fantasy archive styling, sparse antique gold, Cinzel, and EB Garamond. Page Forge is the brand; do not rename it RuneBinder. Preserve ordered mixed image/PDF intake, native PDF export, physical output preview, the quality toggle beside Forge PDF, independent active/checked page state, stable history identity, resource limits, honest export reports, and the captured previous-download lifecycle. Use `python scripts/serve-preview.py` for local browser checks and rerun relevant validation after changes. Keep earlier alternatives archived. Historical audit progress is 24/57; continue the user's requested next work without marking unrelated audit issues complete unless each has its own implementation and acceptance evidence.
