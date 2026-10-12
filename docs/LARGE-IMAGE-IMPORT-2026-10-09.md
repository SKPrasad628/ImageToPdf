# Page Forge: large-image import

Implemented and locally verified on 2026-10-09.

## Requested behavior

Accept larger photos instead of rejecting everything above the editor's working-size limit. If a source cannot be retained at its original dimensions or byte size, automatically fit it to a practical working copy while keeping its proportions, orientation, transparency, and place in the upload sequence.

## Current behavior

- Supported image sources can now be up to **256 MiB**, **256,000,000 pixels**, and **65,535 pixels per side**. Header dimensions must be verifiable. JPEG, PNG, WebP, GIF, and BMP remain supported; PDF input remains limited to 50 MiB. TIFF, AVIF, SVG, and unrecognized images still need conversion to a supported format.
- Ordinary images within the available working budget retain their original encoded bytes. They are not recompressed just because they were uploaded.
- Oversized images are fitted without upscaling to at most **16,000,000 pixels** and **8,192 pixels per side**, preserving aspect ratio subject to integer pixel rounding. Browser decoding applies source orientation; bounded JPEG/PNG EXIF inspection helps plan the correctly oriented dimensions.
- The fitter starts at the highest planned size allowed by those raster limits. It uses high-quality resampling and creates a **lossless PNG working copy**, retaining alpha transparency. If the encoded PNG exceeds its byte allowance, it reduces dimensions and retries from the same bounded decoded image. Decode or canvas-allocation failures also trigger smaller bounded attempts.
- A working image can use up to **32 MiB**, or less when the document's shared **128 MiB** retained-file budget has less space available. Thumbnail space is reserved before fitting. Completely exhausted storage still gives an actionable error.
- Where available, a dedicated worker performs the resize and encoding. Worker loading failure falls back to bounded bitmap decoding on the main thread. There is no full-resolution HTML image fallback for oversized sources. A browser without the required bounded bitmap decoder receives an explicit compatibility message.
- Intake remains sequential and shares the existing decode queue. Large images keep file-list/upload order, later selections append, and Forge stays disabled until all pending imports finish. Explicit manual reordering still determines PDF order.

Fitting is a deliberate reduction in pixel detail, even though the resulting PNG introduces no further lossy compression. The original file on the user's device is unchanged. The app retains the fitted copy as the image's original working version: **editing, Revert, undo/redo, duplication, and Preserve original quality operate on that copy**. They cannot recover discarded source pixels.

## Visible feedback

Import progress names the image being fitted. The persistent import report lists source dimensions and working dimensions for each adjusted image. The active page also displays its adjustment beneath the print proof. Opening the editor explains that Revert restores the working copy. Selecting an untouched ordinary image hides the adjustment notice.

## Implementation

| File | Change |
| --- | --- |
| `js/raster-limits.js` | Separate source-input caps from working-raster caps; aspect-preserving fit and available-byte planning. |
| `js/file-intake.js` | Bounded JPEG/PNG orientation metadata and oriented display dimensions. |
| `js/large-image.js` | Worker dispatch, shared bounded decoding/resampling/PNG retries, cancellation and cleanup. |
| `js/large-image-worker.js` | Dedicated worker entry point using the same normalization core. |
| `js/import-queue.js` | Ordered fitting before source allocation; reserve only working-copy bytes; adjusted-image reports. |
| `js/app.js` | Clear decoded cache before normalization; retain adjustment metadata in history snapshots. |
| `js/forge-ui.js`, `js/editor.js`, `index.html` | Active-page/editor notices, updated requirements, and script integration. |

Bitmaps are closed and temporary canvases released on success, failure, and cancellation. Workers terminate when their job ends. A canceled import cannot commit a late result or disrupt the next selection. Oversized original sources do not receive retained document URLs alongside their fitted copies.

## Verification

**589/589 tests passed**, with no failures or skips, using:

```powershell
node --experimental-vm-modules --test tests/*.test.cjs
```

Latest suite log: `tmp/large-image-full-tests.log`. Focused coverage includes byte/dimension plans, EXIF orientations, transparent PNG output, memory/encoding retries, extreme aspect ratios, worker and main-thread paths, cancellation and disposal, ordered import, unchanged ordinary bytes, detached reports, history/duplicate metadata, and notice visibility. Mocked allocation failures verify recovery logic; they do not reproduce every device's memory behavior.

Changed JavaScript files passed syntax checks. HTML has **160 unique IDs** and all **17 local asset references** exist. The dependency check verified **222 local files / 7,973,623 bytes**.

### Real browser input

Synthetic local fixtures were uploaded through the actual file chooser at `http://127.0.0.1:8768/` in this order:

| Input | Source | Working copy | Result |
| --- | --- | --- | --- |
| `z-large-oriented.jpg` | 12,000 × 8,000 raw pixels; 96 MP; EXIF orientation 6; 1,573,472 bytes | 3,265 × 4,898 | Correct quarter-turn and aspect ratio; first page. |
| `a-large-bytes.png` | 6,000 × 4,000; 24 MP; 75,960,700 bytes | 3,702 × 2,468 | Fitted further to satisfy the PNG byte budget; second page. |
| `m-wide-alpha.png` | 10,000 × 2,000; 20 MP; 143,962 bytes | 8,190 × 1,638 | Wide proportions and transparency retained; third page. |

Both exports completed with all three pages: standard mode produced **5,103,091 bytes**; Preserve original quality produced **26,281,801 bytes**. Independent pypdf inspection of the downloaded lossless PDF followed each page's actual image drawing operator and confirmed the corresponding working dimensions in order. The first page's four quadrant samples confirm EXIF rotation. The third page's decoded image retains alpha 0 at its transparent corner and alpha 170 inside its translucent cyan rectangle. All three Poppler renders were visually inspected; the transparent areas render over the PDF's white paper correctly. These checks verify the fitted output, not equality with the original oversized source pixels.

Two additional real PNGs, **1 × 65,535** and **65,535 × 1**, subsequently imported as **1 × 8,192** and **8,192 × 1**, becoming pages four and five. They exercise the single-axis decoding edge cases and were not part of the three-page exported PDF described above.

The editor showed the correct 3,265 × 4,898 working-copy/Revert notice. At **320 × 740 CSS pixels**, import and page notices wrapped without horizontal page overflow (document scroll width 314 pixels). The viewport override was then reset. Browser console warning/error capture was empty. Current visual evidence:

- [Desktop fitting notice](verification/page-forge-large-image-desktop.png)
- [Phone fitting notice](verification/page-forge-large-image-mobile.png)

## Remaining boundaries

This increases supported source size; it does not promise unlimited inputs, RAM, pages, or exports. Browser decoders can have native memory overhead beyond the app's bounded working bitmap/canvas sizes. Cross-browser and low-memory real-device behavior still require device testing.

Existing document limits remain **200 pages**, **128 MiB retained files/history**, **64 MP aggregate raster export work**, and **128 MiB generated PDF output**. In particular, five near-16 MP pages exceed the aggregate export bound even though each can import successfully. That separate export guard remains in place and is not a promise that every accepted batch can be exported at its full working resolution. The automatic byte fitting is a bounded retry strategy, not a mathematical search for the largest possible PNG under every byte budget.

No hosting or deployment was performed. Historical audit progress remains **24/57**, with issue 16 partial. The prior [upload-order follow-up](UPLOAD-ORDER-2026-10-08.md) and [canonical design](PAGE-FORGE-DESIGN.md) remain relevant.

## Next-session handoff

Read this file, `Memory.md`, `docs/PAGE-FORGE-DESIGN.md`, and the current code first. Large-image source acceptance and bounded fitting are implemented; preserve ordinary image bytes, orientation/alpha, ordered mixed intake, cancellation, working-copy notices/history semantics, and resource cleanup. Do not silently restore the old 32 MiB source-input rejection or remove working limits. Use `scripts/serve-preview.py` for local browser checks and rerun focused regressions for changed paths. Evaluate aggregate export resizing separately if the user requests larger multi-image output batches.
