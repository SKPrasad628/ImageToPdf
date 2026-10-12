# Phone fixes — October 13, 2026

The five reported phone problems were prioritized before the next audit batch. The screenshots identified Android Chrome, a native image context menu on a page-rail thumbnail, and three JPEG imports rejected with “Image dimensions could not be verified safely.” The user confirmed that the white area after cropping appeared in the main PDF preview or downloaded PDF.

The fixes are implemented in the local application. The supplied screenshots were inspected in the conversation and were not copied into the repository. All verification fixtures use synthetic images. Existing hosted files must be replaced with this updated application before these changes appear on the phone.

## Resulting behavior

| Report | Fix |
| --- | --- |
| Image long-press opens the browser menu | Thumbnail holds can start page reordering through the preview button. Controlled thumbnail/preview images suppress the native image context menu, callout, and image dragging. Normal text controls and named application menus remain usable. |
| Valid JPEGs fail import | Intake scans JPEG marker offsets beyond the original 64 KiB window, skipping large metadata payloads to locate image dimensions. Reads remain bounded to 1,024 markers and 256 KiB; EXIF orientation, cancellation, import order, and retained-byte limits remain enforced. Invalid/unverified files receive more useful recovery guidance. |
| Pinch zoom-out fails over images | Thumbnail and preview ancestors permit browser panning and pinch zoom. Early scrolling or a second finger cancels a pending hold; an active reorder cancels without dropping or consuming the two-finger event. Crop mode allows browser pinch while one finger edits the selection. Preview plus/minus/Fit and desktop wheel behavior remain available. |
| Crop corners reset selection and discarded area becomes white | Corners and edges resize the existing selection; dragging inside moves it. Taps preserve the selection. Coordinates use exact source pixels with clamped boundaries and cancellation rollback. Applying a crop creates a smaller image and defaults that page to its trimmed paper bounds, without changing other pages. **Use cropped page size** can be turned off in Layout to place that crop on the chosen paper. |
| Default margin should be None | New sessions and **New document** start at **0 mm / None**, including when older saved settings contain 10 mm. A chosen margin still applies to the current document. Canceling New document keeps that choice. Other layout preferences retain their existing persistence. |

Crop page metadata survives saving, resizing, rotations, duplication, undo/redo, captured exports, and preview invalidation. Batch edits retain each target's own cropped-page choice. Revert clears the crop and restores the original working content; imported PDF physical bounds and native source references are restored too. A full-image crop Apply is a no-op.

## Implementation and tests

- `js/app.js`, `js/forge-preview.js`, and `css/minimal-ui.css` handle scoped context-menu suppression and gesture ownership. Hold tracking cancels on movement, a second finger, document changes, rebuilding, and native cancellation. Legacy PDF-list holds receive the same cancellation protections.
- `js/file-intake.js` performs sparse JPEG header reads; `js/import-queue.js` supplies cancellation context; `js/raster-limits.js` retains safe dimension validation and improves its error explanation.
- `js/editor.js` and `css/minimal-editor.css` implement corner/edge/move hit testing, scaled touch targets, pointer capture, legacy touch handling, selection persistence, exact crop coordinates, output sizing, and cropped page metadata.
- `js/pdf-layout.js` uses trimmed page bounds when `cropPageBounds` is present and `cropToBounds` is not false. `js/forge-ui.js` exposes the per-page choice and tracks it in output freshness. `js/app.js` captures it in history, duplication, and export. `index.html` explains crop handles and includes the zero-margin default and per-page control.

**774/774 full regression tests pass**, with no failures or skips. Command: `node --experimental-vm-modules --test tests/*.test.cjs`. Log: `../tmp/phone-follow-up/full-tests.log`. This adds **53 tests** to the 721-test baseline: seven intake, 21 gesture/preview, 15 crop/editor, six margin/layout/UI, and four independent-review regressions. All **18 production JavaScript files** pass syntax checks. The dependency inventory passes unchanged: **222 files / 7,974,424 bytes**.

An independent review checked stationary clicks, new selections drawn beyond the top/left, all resize/move clamps, numeric **1 × 1** cropping at the far edge of a **4,800 × 4,000** source, and cancellation of both legacy crop and PDF-list drag gestures. The uncovered cases became permanent regressions. No critical crop metadata/history/repeated-Apply regression was found.

## Browser and binary verification

The browser viewport was set to **360 × 800**; the document's measured content viewport was **354 × 800**, with no horizontal document overflow. A development-only fixture loads synthetic files through the production import queue; editor and export actions use the normal UI.

1. Both JPEG fixtures imported in order: **2/2**. Each places its size header beyond **196 KiB** of metadata. Production intake read **65,620** and **65,612 bytes** respectively, rather than reading the full sources. Independent Pillow decoding agrees with the baseline **500 × 700** and EXIF-6 **700 × 500** display dimensions. [Phone import screenshot](verification/phone-intake-2026-10-12.png).
2. A thumbnail context-menu action produced no image popup. Computed thumbnail ancestors and the central preview permit pinch zoom; Chrome normalizes `pan-x pan-y pinch-zoom` to `manipulation`. The crop canvas reports `pinch-zoom`. Preview controls completed **100% → 125% → 100%**. These observations complement the controlled gesture regressions; they do not constitute physical multitouch testing.
3. Selected source coordinates **x=50, y=80, width=300, height=400**. A tap preserved them. Dragging the existing bottom-right handle retained the origin and resized the selection to **349 × 440**. Applying and saving showed a **29.5 × 37.3 mm** cropped page. Turning off **Use cropped page size** restored A4; turning it back on restored the trimmed page. Margin **None** was selected. [Crop selection](verification/phone-crop-selection-2026-10-12.png), [trimmed PDF preview](verification/phone-cropped-page-2026-10-12.png).
4. With Preserve original quality on, the actual download contained **two pages / 41,836 bytes**. The cropped first page measures **29.5487 × 37.2533 mm**, with its image painted over the entire page. Its **349 × 440** decoded pixels match the original source region **(50,80)–(399,520)** with maximum channel difference **1/255**. The second image retains **700 × 500** EXIF orientation on unchanged **297 × 210 mm** A4 landscape; its decoded pixels also differ by at most **1/255**. Both Poppler renders were visually inspected. [Independent PDF verification](verification/phone-pdf-verification-2026-10-12.json).

Captured browser warning/error logs were empty. The verifier and synthetic fixtures remain under `tmp/phone-follow-up/` as development evidence, outside application assets.

## Audit and boundaries

Original audit issues **35–38 and 54** are now implemented and verified through this requested priority work. The ledger is **35/57**: issues **1–30, 35–38, and 54** complete. The next original batch remains **31–35**, with **31–34** still open. This pass did not advance those remaining issues.

Physical Android/iOS multitouch and the exact bytes of the user's rejected photographs were unavailable. The evidence covers controller behavior, responsive browser interactions, valid long-metadata JPEG fixtures, and the actual exported PDF. It does not establish every image encoding or every browser. HEIC/AVIF and other unsupported formats still require conversion to a supported format.

Uncropped images placed on fixed A4 paper can still have aspect-ratio space with **Full image**, even at zero requested margins. The uncropped 700:500 fixture has approximately **1.5 mm** on each horizontal side because its ratio differs from A4. The cropped page's default trimmed sizing removes the discarded page area; explicitly choosing fixed paper can reintroduce ordinary layout space. Pending-transform crop semantics, blur fidelity, remaining resize issues, and individual editor-operation undo retain their separate audit scope.
