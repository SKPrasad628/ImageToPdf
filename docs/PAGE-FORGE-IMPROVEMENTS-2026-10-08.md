# Page Forge — implemented review improvements

Completed October 8, 2026. This records the changes requested from [the full review and prioritized improvements](PAGE-FORGE-RECHECK-2026-10-06.md). The production app remains **Page Forge**, with the Print desk workflow, Ocean Blue Serenity colors, local Cinzel/EB Garamond, and restrained original dark-fantasy ornament.

## Completed functional fixes

| Review item | Result |
| --- | --- |
| Modal keyboard focus | Editor and Full size use native modal dialogs, making the background inert. An explicit Tab/Shift+Tab loop keeps focus inside their visible, enabled controls. Escape performs session/resource cleanup. Editor Save restores focus after rendering, to a connected visible trigger or the same logical page's current thumbnail. |
| Empty-document Redo | History stays visible when Undo or Redo is available. Undoing the first import shows **Document removed — Redo to restore.** |
| Page navigation | Arrows work from the page rail and proof, preserve card nodes and checked identities, and focus the new thumbnail. Navigation reveals the entire active card, including its number and Viewing cue. Arrows outside the workspace retain browser behavior. |
| Editor names and values | All 16 editor inputs have associated labels. Custom angle and crop fields identify their units; Lock aspect ratio uses a complete label. Filter sliders expose current values with readable units after adjustment, presets, and reset. |
| Previous export state | Output-affecting document/settings revisions are captured when Forge PDF starts. Page edits, reordering, or changed binding settings show **Changes since export — forge again** and **Download previous PDF**. Preview focus, checked selection, and freeing history do not mark the export stale. Changes during encoding are also detected. |

The retained PDF keeps its original URL and filename. A retry keeps it available through failure when it fits the shared download budget; its partial-page warning remains explicit. A new valid output that needs the previous reservation's space evicts the previous file before reserving the replacement. Impossible oversized outputs cannot evict a valid previous file. Replacing output, resetting the result, and page exit release URL and byte ownership exactly once.

## Completed design changes

- **Empty versus working mode:** the empty document retains the ceremonial hero and engraved upload tablet. Loaded documents show a concise Your document heading, page count, and Add files action.
- **Desktop proof:** a viewport-sized working desk contains the rail, whole-page proof, and scrollable binding inspector. The paper scales to the available proof height without ResizeObserver. Native/image paper ratios remain accurate.
- **Persistent export:** Forge PDF and Preserve original quality remain beside each other in a fixed dock. The phone dock respects safe-area padding. Content padding and scroll offsets let settings fields move above it.
- **Secondary actions:** the native More disclosure contains Sort A–Z, Reverse order, Free undo history, Keyboard shortcuts, and Clear document. Undo/Redo stay visible. Actions close More; Escape closes it and restores summary focus.
- **Phone workflow:** shallow horizontal page cards precede the print preview and collapsible Binding options. Cards keep a 44-pixel checkbox hit area, readable filename, number, delete control, and Viewing cue. The thumbnail center remains available for preview clicks. Earlier/Later provide non-drag reordering. Scroll snapping is disabled so keyboard navigation can reveal the complete active card.
- **Selection:** cyan identifies the viewed page, with the visible word Viewing. Antique-gold checkmarks/outline identify checked batch targets. The states remain independent when moving pages or viewing full size.
- **Quality:** original-quality mode displays **Original quality — lossless export** and hides inactive JPEG compression choices. Switching it off restores the labeled compression selector. The dock explains that this preserves current detail and cannot recover earlier quality loss.
- **Readability and icons:** frequently used labels, navigation, filenames, and controls move toward 14 pixels. Editor controls use one original stroked SVG icon set with visible text and accessible names. Mobile selection/history status remains available to assistive technology without adding visual rows.
- **Navigation:** Home/brand/Skip links reach the main content. Image to PDF targets upload when empty and the workspace when loaded.

## Verification

- Full suite: `node --experimental-vm-modules --test tests/*.test.cjs` — **536 passed**, zero failures, cancellations, or skips. This adds 28 regressions to the 508-test baseline. Log: `../tmp/page-forge-improvements-tests.log`.
- All production JavaScript passes `node --check`. HTML has **156 unique IDs**, and all **13 local script references** exist.
- Dependency inventory: **222 files, 7,973,623 bytes**, verified by `node scripts/dependency-check.cjs`.
- Fresh local browser checks covered ArrowRight focus and checked-state retention; visible empty Redo; editor Tab/Shift+Tab boundaries; edit/save/Undo; full-size focus/Escape; More/Escape; Earlier/Undo; quality on/off; fresh export, stale download, repeat previous download, and successful re-export. The final compact thumbnail's pointer hit target and full-card visibility were checked separately.
- Loaded layout checks at **320 × 740**, **736 × 900**, **1024 × 768**, and **1400 × 900** found no horizontal overflow. The empty state was also checked at 320 pixels.
- At 1400 × 900 the desk starts around **260 pixels**, compared with roughly **602 pixels** in the review. Its bottom is around **750 pixels**, above the fixed export dock. At 1024 × 768 the desk bottom is around **618 pixels**, above the dock at **642 pixels**.
- The final 320-pixel document is **1,886 pixels** tall with two pages and collapsed binding options, compared with **3,465 pixels** in the review. The dock is about **118 pixels** high and remains reachable while scrolling. The expanded filename field was measured entirely above the dock.
- Browser log inspection returned no captured warnings or errors. Temporary viewport overrides were reset afterward.

Saved views: [desktop](verification/page-forge-improved-desktop.jpg), [phone](verification/page-forge-improved-mobile.jpg), and [empty phone](verification/page-forge-improved-empty-mobile.jpg).

## Actual PDF check

The fresh image-only browser export `page-forge-2026-10-08-qa.pdf` contains **two pages, 23,627 bytes**, both **210 × 297 mm**. Original quality was on, with Contain and 10 mm margins. Independent pypdf/Pillow inspection confirmed embedded decoded pixels match both source PNGs exactly. Both pages were rendered by Poppler and visually inspected.

After changing live margins to 20 mm, Download previous PDF downloaded the earlier file unchanged: the original and repeat both have SHA-256 `55b114dd578f286bd86f059b85d756a79dccf916a1da5b826e46d52b63564c2c`. Re-forging after returning to 10 mm restored the normal Download PDF label. The new serialization may have different metadata/identifiers; its dimensions and embedded source pixels were checked independently.

The PNG fixture content contains text drawn into an image; this check does not claim searchable text for image pages. The earlier five-page native/mixed preservation check remains in [PDF verification](verification/page-forge-pdf-verification.md). Native-PDF preservation regressions still pass in the full suite.

## Continuing in a new session

Read this file, [the canonical design handoff](PAGE-FORGE-DESIGN.md), and [Memory.md](../Memory.md) before changing the app. Keep the existing guarded import/editor/export engines, source leases, limits, original-quality toggle beside Forge PDF, separate viewed/checked state, native PDF path, and honest complete/partial/failed outcomes.

Use `python scripts/serve-preview.py` for local preview; it sets module/font MIME types explicitly. These checks used port 8767. No deployment was performed. Do not infer real-phone keyboard behavior, screen-reader certification, printer fidelity, or all-browser compatibility from desktop viewport emulation. Historical audit progress remains **24/57**, with issue 16 partial; this requested improvement pass does not complete unrelated audit entries.
