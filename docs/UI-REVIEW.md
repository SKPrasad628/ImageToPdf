# PhotoPDF Studio — UI review and redesign proposal

Reviewed October 4, 2026. This is a design proposal, not an implementation of the application redesign.

## Review scope

Reviewed the current HTML, CSS, and interaction code, opened the application locally, and inspected the empty state and a document containing three synthetic image fixtures. Historical issues in `Memory.md` were checked against current code: several have already been addressed. In particular, the large introductory area already shrinks after importing files, libraries are now local, and export results have a persistent report. These are not listed as missing features here.

Phone-specific findings below follow the current CSS and document structure, not real-device testing. The interactive proposal uses sample artwork and simulates an export summary; it does not generate PDFs.

## Highest-impact findings

| Priority | Current issue | Effect on the user | Proposed change |
| --- | --- | --- | --- |
| High | Convert and Edit PDF are different interfaces over the same document. | Users must learn two layouts and infer which tab contains each action. Export changes label and position between views. | One document workspace that accepts photos and PDFs. View choices change the presentation, not the task. |
| High | The thumbnails are not previews of the PDF output. | Choosing paper size, orientation, margins, or fill does not show the resulting page; fixed portrait thumbnails also crop the source image. | A central paper preview that uses the same layout calculation as export. Update it immediately when settings change. |
| High | Selection appearance does not consistently identify action scope. | A normal clicked card and a multi-selected card look selected, but “Rotate all” handles them differently. | Separate the active preview page from explicit batch selection. Show checkboxes, selection count, and actions such as “Rotate 3 selected pages.” |
| High | Edit, preview, rotate, and duplicate appear only on hover. | Keyboard focus can land on visually hidden controls; touch users have little indication that the tools exist. Remove is only 18 × 18 px. | Visible selected-page toolbar; comfortable touch targets; full keyboard focus treatment. |
| Medium | Nine export controls appear together above the document, including irrelevant disabled controls. | Important choices compete with DPI, print overflow, and PDF preservation details before users reach their pages. | A small Layout inspector. Reveal print DPI only for print-size behavior and PDF preservation controls only when PDF pages are present. |
| Medium | Generate PDF follows the entire thumbnail grid. | Long documents require scrolling to the end. Edit PDF instead uses a small export button alongside Add and Merge. | One consistent Export PDF action in persistent workspace chrome, with Preserve original quality beside it. |
| Medium | The mobile layout stacks the detail panel below the entire page list. | Viewing or editing one page requires navigating away from its place in the list; rows still carry five small actions. | Mobile Pages, Preview, and Layout views, a page-action sheet, and a persistent export action. |
| Medium | Supporting text is small and faint. | Filenames use 9 px text, page numbers and settings labels 10 px, and muted text is difficult to scan. | Readable supporting text, stronger neutral contrast, fewer uppercase labels, and a consistent icon family. |
| High | Accessibility semantics and focus handling remain incomplete. | Several controls have no associated label; page containers are clickable divs; modal dialogs do not contain Tab focus. | Native labeled controls, keyboard page selection and reordering, dialog focus containment and restoration, and selection announcements. |
| Medium | Editor commit actions overlap. | Apply for individual tools, Apply to all, Save changes, and Revert all require users to understand multiple scopes. | One explicit Apply/Cancel editing session, with precisely named bulk operations only where supported. |

## Current source references

- Shared document and settings across tabs: `index.html:14`, `js/app.js:463`.
- Cropped thumbnails and settings refresh: `css/styles.css:111`, `js/app.js:593`, `js/app.js:908`.
- Hover-only tools and small remove action: `css/styles.css:113`, `css/styles.css:120`.
- Selection and bulk-operation mismatch: `js/app.js:616`, `js/app.js:726`, `js/app.js:743`.
- Settings inventory: `index.html:97`; conditional disabling: `js/app.js:856`.
- Export placement: `index.html:119`, `index.html:196`.
- Phone panel stacking and row controls: `css/styles.css:236`, `css/styles.css:255`, `index.html:191`.
- Small typography and muted palette: `css/styles.css:3`, `css/styles.css:97`, `css/styles.css:119`.
- Labels, page semantics, and dialog focus handling: `index.html:98`, `js/app.js:585`, `js/app.js:1011`, `js/editor.js:159`, `js/app.js:1555`.
- Multiple editor commit scopes: `index.html:274`, `index.html:294`, `index.html:359`.

Line references describe the source at review time.

## Recommended concept: Document workspace

Use a compact document tool with a quiet neutral background, white paper surfaces, one restrained accent, consistent line icons, and clear typography. The document should be the dominant visual element.

1. **Start:** “Add photos or PDFs,” a short supported-format hint, and local-processing reassurance. Put detailed size and resource limits under File requirements.
2. **Document header:** editable document name, page count, Undo/Redo, Add files, and a consistent export action.
3. **Page rail:** numbered uncropped thumbnails. Clicking opens the preview; explicit checkboxes activate batch selection. Support dragging and Move earlier/later controls.
4. **Paper preview:** show the actual output shape, margins, orientation, and clipped image area. Expose the selected page’s Rotate, Crop, and Adjust tools here.
5. **Layout inspector:** Paper size, Orientation, Margins, and Image placement first. Advanced print settings appear when relevant. Clearly distinguish settings for all image pages from changes to one page.
6. **Export:** keep Preserve original quality beside Export PDF as requested. When preservation is enabled, disable conflicting lossy-compression options with a clear reason. Explain that prior quality loss cannot be reversed.
7. **Mixed PDF documents:** mark original PDF pages and image pages. Show preservation notices at the action that changes a PDF page into an image. Existing advanced-feature limitations require architectural work and are not solved by visual design alone.
8. **Result:** retain the current persistent export report, actual file size, and information about omitted or failed pages. Add clear recovery actions where appropriate.

For a production mobile implementation, use Pages / Preview / Layout views and a bottom action area. The concept’s responsive layout demonstrates the visual treatment; it is not a finished mobile application.

## Alternative: Guided flow

Use Add → Arrange → Export for occasional users. Each stage exposes only its relevant choices, with Back available and document state preserved. This provides clearer onboarding, but it requires more navigation when users frequently adjust layout and page order. Prefer Document workspace for the full existing feature set; use the guided concept if simple conversion is the main product priority.

## Suggested implementation order

1. Unify document navigation and action names; preserve the current processing engine.
2. Build the output-layout preview from the existing layout engine.
3. Introduce consistent selection, visible page actions, and accessible controls.
4. Move advanced settings behind context-sensitive disclosure and keep export reachable.
5. Implement phone-specific views and verify keyboard, touch, long-document, and mixed PDF/image workflows.

This review does not mark any application defects as fixed.
