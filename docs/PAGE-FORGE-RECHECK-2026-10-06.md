# Page Forge — independent recheck and recommended improvements

Reviewed October 6, 2026. This supplements [the design handoff](PAGE-FORGE-DESIGN.md). This pass reviews the implemented application; it does not change application code or mark historical audit items complete.

**Implementation update, October 8:** all five functional corrections and the listed design improvements are implemented. The final suite passes **536/536**, with fresh desktop/phone browser checks and a new independently inspected PDF. Read [the implementation and verification record](PAGE-FORGE-IMPROVEMENTS-2026-10-08.md) for current behavior, screenshots, and coverage limits. Findings and measurements below are the historical October 6 baseline.

## Fresh verification

- `node --experimental-vm-modules --test tests/*.test.cjs`: **508 passed, zero failures or skips**. Log: `../tmp/page-forge-recheck-tests.log`.
- `node scripts/dependency-check.cjs`: **222 local files verified, 7,973,623 bytes**.
- Browser: the existing two-image document rendered at **1400 × 900** and **320 × 740**, with no horizontal overflow. The current page preview, settings, and local fonts were present. Browser log inspection returned no captured warnings or errors.
- Keyboard checks reproduced focus escaping both the editor and full-size preview, and focus loss after arrow navigation. The original active page and normal browser viewport were restored afterward.
- A separate code review reproduced the hidden-Redo case through the actual production history functions in the existing test harness.
- This pass did not generate another PDF. The earlier independently inspected five-page download remains documented in [PDF verification](verification/page-forge-pdf-verification.md).

Passing the current suite does not mean the interaction issues below are covered. Each functional correction needs a regression for its actual user-visible failure.

## Functional findings, in recommended order

### 1. Keep keyboard focus inside modal tools — P2

**Observed in the browser:** opening Edit page focuses Close editor. Pressing Shift+Tab moves focus to the background **Forge PDF** button while the editor remains open. Full size has the same behavior. Both containers declare `aria-modal="true"`, but that declaration does not make background controls inert.

**Correction:** use native modal dialogs consistently, or implement complete focus containment and an inert background. On close/save, restore focus to a control that still exists after the page rail is rendered again.

References: `index.html:168`, `index.html:321`, `js/editor.js:161`, `js/app.js:1301`. The existing native Tools/About/Privacy dialogs provide a useful implementation pattern.

### 2. Keep Redo visible when Undo empties the document — P2

**Reproduced through production functions:** import the first document, then Undo. The document has zero pages and the history index is zero, so the history bar disappears even though Redo is enabled. Calling Redo restores the pages, but the visible recovery action is missing.

**Correction:** show history controls whenever either Undo or Redo is available. Add an empty-state recovery message such as “Document removed — Redo to restore.”

Reference: `js/app.js:278`; the visibility condition currently checks only pages or an undoable history index.

### 3. Preserve focus during page navigation — P2

**Observed in the browser:** focus Preview page 1, press ArrowRight, and page 2 becomes active while focus moves to `BODY`. The arrow handler rebuilds the page rail and removes the focused thumbnail. Code inspection also shows that the handler intercepts arrows outside the rail, including ordinary page buttons.

**Correction:** scope page-navigation shortcuts to the relevant workspace controls, update active/checked state without rebuilding every card, and retain focus on the newly active thumbnail. Let arrow keys retain normal scrolling behavior elsewhere.

References: `js/app.js:591`, `js/app.js:1610`.

### 4. Name editor inputs for assistive technology — P2

**Observed/code-confirmed:** the browser accessibility tree lists the Custom angle numeric input without a name. Lock AR, crop coordinates, and filter sliders also have visual text without proper label associations.

**Correction:** associate every label with its input, expand “Lock AR” to “Lock aspect ratio,” and expose slider names and current values clearly.

References: `index.html:199`, `index.html:213`, `index.html:233`, `index.html:272`.

### 5. Identify an older export after the document changes — P3

**Code-confirmed:** the retained Download PDF action deliberately serves the last generated file. Editing pages or changing margins/orientation does not mark that download as older than the current document. Page rendering may hide the success heading while leaving its report and generic download action visible.

**Correction:** retain the useful previous file, but show **“Changes since export — forge again”** and rename the action **“Download previous PDF”** until a new export completes. Compare document/settings revisions rather than filenames alone.

References: `js/forge-ui.js:46`, `js/forge-ui.js:103`, `js/app.js:721`, `js/app.js:920`.

## Design improvements

### Highest impact: introduce a compact working mode

The ocean-blue palette, original emblem, fine gold rules, and restrained fantasy typography form a coherent identity. The main remaining design problem is how much space precedes the work.

Fresh measurements with only two pages:

| Viewport | Document height | Position of Forge PDF from document top |
| --- | ---: | ---: |
| 1400 × 900 | 1,921 px | 1,611 px |
| 320 × 740 | 3,465 px | 3,090 px |

At desktop size the workspace begins around **602 px** from the top. On the narrow screen, the first viewport is mostly branding, upload, history, and toolbar controls; the actual document is still below it. See [fresh mobile evidence](verification/page-forge-recheck-mobile.jpg).

Recommended changes:

1. Keep the ceremonial hero for the empty state. Once files exist, use a compact document heading and Add files action.
2. Give the desktop proof a fit-to-viewport mode so users can inspect a whole page and reach settings without repeated scrolling.
3. Keep the export controls persistently reachable. On mobile, use a compact bottom action area containing Forge PDF and its Preserve original quality control, with enough content padding to avoid covering inputs.
4. Put Sort, Reverse order, and Free undo history under a labeled More menu. Keep Undo/Redo visible and keep the active page's essential actions easy to reach.
5. Use a compact mobile page strip or list, followed by preview and collapsible Binding Options. Preserve non-drag reordering and clear page numbering.

### Clarify states and improve readability

- **Current page versus checked pages:** both currently receive gold emphasis. Use a cyan edge plus a “Viewing” cue for the current preview, and gold checkmarks for batch selection. Do not rely on color alone.
- **Quality:** when Preserve original quality is on, show an explicit “Original quality — lossless export” status instead of making a disabled Standard dropdown the dominant state. Keep the required quality control beside Forge PDF; show compression choices when it is off.
- **Small technical text:** filenames and navigation measured 12 px. Raise frequently read labels, filenames, and guidance toward 14 px, while reserving smaller type for secondary ornament labels.
- **Icon consistency:** replace mixed emoji and text glyphs in the editor with a small consistent icon set, retaining accessible names and visible labels for less familiar actions.

## Suggested next pass

First fix the five functional findings with focused regressions. Then implement compact working mode and a persistent export action. Finish with selection-state colors, quality copy, text sizing, and icon consistency. Further fantasy decoration is lower priority than these workflow improvements.

This was local browser and code verification, not a complete cross-browser, screen-reader, real-device, or printer certification. The historical audit count remains 24/57 until its individual acceptance work is completed.
