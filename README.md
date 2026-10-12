# Page Forge

A static browser application for arranging images and PDF pages, editing images, and forging one downloadable PDF. The minimal interface combines a print desk with an original dark-fantasy archive: ocean blues, restrained antique gold, serif branding, and readable controls. **Page Forge** is the product name; RuneBinder was a style reference in the design prompt.

Selected documents stay in the browser; the application does not upload them to a server. PDF libraries, rendering assets, and interface fonts are served from the application folder.

## Use the workspace

1. Add supported images or PDFs through the same file picker or drop zone. Files import in selection order; the pages within each PDF stay together.
2. Choose a page to inspect its output preview. **Edit page** and **Rotate** are beside the preview; **Page actions** contains duplicate, move, full-size preview, and remove. Use **Select pages** for checkbox-based batch changes. Dragging is optional.
3. Open **Change layout** for paper, orientation, margins, and image placement. Margins start at **None** for each new session/document; choose a margin when needed. Print-size controls appear when relevant; compression and PDF content preservation remain available. Phones use **Pages**, **Preview**, and **Layout** views. The editor groups tools into **Rotate & flip**, **Crop**, **Resize**, and **Adjust**, with a persistent **Save this page** action.
4. Choose the document name in the toolbar and **Preserve original quality** beside **Forge PDF**, then forge the document. Check the persistent result report for page counts, actual file size, and any omitted pages. **Help** contains instructions, shortcuts, file requirements, and privacy information.

Use the preview's **−** and **+** controls to inspect details at **100–400%** of the fitted page size. **Fit page** returns to the whole-page view; **100%** means that fitted view. While enlarged, scroll up over the preview to zoom in or down to zoom out. At 100%, ordinary scrolling moves the webpage, including over the preview. Start zooming with **+** or **Ctrl + mouse wheel**; ordinary scrolling at 100% keeps the fitted view.

The enlarged preview shows **Drag to move · Scroll to zoom**. Drag with a mouse or pen, or use touch scrolling to reach another part of the page. With the preview focused, arrow keys pan, **+ / −** zoom, and **0** returns to Fit page. Text fields keep their normal editing caret and text selection; ordinary interface text has no blinking caret.

On phones, browser pinch zoom remains available over page thumbnails and the main preview. Starting a scroll or adding a second finger cancels a pending or active hold reorder without moving the page. Page images suppress the browser's native image long-press menu; the app's named **Page actions** remain available. Browser page zoom is separate from the preview's own zoom buttons.

Zoom changes only the preview. Choosing another page, changing its layout, or resizing the window returns to Fit page. The preview draws more pixels for enlarged views, up to a 2,400-pixel long side; imported PDF pages use their existing import raster. Document edits, undo history, paper dimensions, and the exported PDF are unaffected.

In **Adjust**, **Update preview** applies the chosen adjustment to the current page. **Apply adjustments to all pages** retains those applied steps for the other pages, including when the sliders have returned to neutral. It adds this editing session's adjustments and rotation/flip changes to each page's existing effects and orientation. Crop and resize affect the current page only. Neutral Update preview keeps unchanged native PDF content; Revert clears the applied adjustment steps and restores the original working page.

In **Crop**, drag to select an area, then drag its corners or edges to resize it or its interior to move it. Crop coordinates use actual image pixels; canceled gestures restore the previous selection. Saving a crop uses the cropped page size by default, so the removed area does not remain as blank paper in the PDF. In Layout, turn off **Use cropped page size** to put that page on your chosen paper instead. This choice applies to the active cropped page. Standard paper with **Full image** can still leave space when the image and paper have different proportions; **None** removes requested margins, not that fitting space.

The current design specification and implementation handoff are in [Page Forge design](docs/PAGE-FORGE-DESIGN.md). The [October 11 preview zoom record](docs/PREVIEW-ZOOM-2026-10-11.md) covers detail inspection and verification; the [October 10 minimal UI record](docs/PAGE-FORGE-MINIMAL-UI-2026-10-10.md) records the earlier simplification. The earlier alternatives remain in [the redesign brief](docs/UI-REDESIGN-BRIEF.md).

## Use on your devices

Publish the complete application folder with GitHub Pages. Keep `index.html` at the top of the selected publishing source, with `css/`, `js/`, and `vendor/` alongside it. In the repository's **Settings → Pages**, choose **Deploy from a branch**, then select your branch and the folder containing `index.html`. Open the resulting HTTPS Pages URL on each device. Project sites can live under a repository path; the application uses relative asset URLs for this.

Do not upload only `index.html`. PDF.js needs its matching worker, fonts, CMaps, decoders and ICC profile for different documents. Include `.nojekyll` if using GitHub Pages to serve this static folder without Jekyll processing. See GitHub's [Pages publishing instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site).

Browser module loading requires serving the files. Double-clicking `index.html` with a `file:` URL is not a supported installation method. A static local development server can serve the complete folder; GitHub Pages supplies HTTPS for normal use.

For a local preview, run this from the application folder with Python 3:

```text
python scripts/serve-preview.py
```

Open [Page Forge locally](http://127.0.0.1:8766/). Stop the server with Ctrl+C, or choose another port with `python scripts/serve-preview.py --port 8080`. This helper serves the application folder and binds only to your computer's loopback address.

Correct JavaScript module MIME types are essential for PDF import and native PDF export. The preview helper explicitly serves `.mjs` and `.js` as `application/javascript`, `.wasm` as `application/wasm`, and `.ttf` as `font/ttf`. A generic server can inherit incorrect Windows MIME settings, such as serving `.mjs` as `text/plain`; browsers reject those module imports. Use the helper locally and retain correct MIME configuration when hosting the app.

## Local resources and connectivity

The application uses local dependencies and self-hosted fonts, with no CDN fallback or remote font request. Serving a complete copy from a reachable local static server does not require internet-hosted libraries for conversion. The [Batch 6 verification](docs/BATCH-6-2026-10-12.md) checks that local resource graph and actual image/native PDF import/export with external resources blocked.

A first visit to a hosted URL still needs a connection to fetch the application files. There is currently no service worker, verified offline installation, or application-managed cache readiness state. Browser caching alone is not a reliable offline guarantee. Open document state stays in the current tab; unfinished documents are not saved across tab closure or synchronized to other devices.

## Export behavior

The document name produces one `.pdf` extension, even if you enter repeated mixed-case PDF suffixes or trailing dots/spaces. The result report captures that filename, the output's actual size, and its page counts. Partial output says pages are missing and lists their original positions, filenames, and reasons with recovery steps. After a failed retry, **Download previous PDF** retains the prior file and any partial-output omissions alongside the new failure report. Continue editing, replace or re-add the listed files, then forge again to resolve missing pages.

Use **Preserve PDF pages** to retain native text, vectors, annotations, form values and appearances, bookmarks, internal links, attachments, and supported accessibility structures. Export rebuilds their references around the actual included pages. Duplicate form fields have independent names; colliding names in merged files are disambiguated. Links and form widgets belonging to deleted pages are removed and reported. An untouched whole source PDF exports byte-for-byte, including its signatures and encryption.

Native export refuses changes to signed/encrypted PDFs and detected structures it cannot safely rebuild (including XFA, scripts, and unsupported tagging/catalog features). These cases stop export with an explanation; the app does not automatically fall back to page images. Export that source untouched, or explicitly select **Images · apply layout** if losing PDF structure is acceptable. A mixed document retains its existing tags but does not become fully accessible merely by adding photos. Source metadata and display preferences come from the first PDF; other opening-view choices and any structural adjustments are reported. See the [preservation implementation and verification record](docs/PDF-PRESERVATION-2026-10-11.md) for supported features and boundaries.

Editor rotations in 90° steps and page-list rotations keep native PDF content. Crop, resize, flips, filters and other editor rotations explicitly create image content for those pages; the editor explains the loss before saving, and Revert restores the native source. **Preserve original quality** avoids added lossy compression in image export; it cannot restore existing losses.

Browser memory limits still apply, especially on phones. Import limits and error reports identify files or pages that cannot be processed. Device and browser UI compatibility checks remain separate from automated tests.

JPEG intake follows bounded marker headers rather than rejecting a valid image merely because its dimensions follow large camera metadata. EXIF orientation, upload order, cancellation, and resource limits remain enforced. Unsupported formats, malformed headers, and files beyond the limits still receive an import report.

## Verify the local dependencies

The app has no installation or build step. With a current Node.js release, run:

```text
node scripts/dependency-check.cjs
node --experimental-vm-modules --test tests/*.test.cjs
```

`vendor/manifest.json` records pinned versions, provenance and SHA-256 hashes. The checker compares every shipped dependency file, including licenses, against that inventory without network access. See [the dependency notes](vendor/README.md) before updating a library. Development scratch files in `tmp/` are not application assets and should not be published.

The October 13, 2026 [phone-fix verification](docs/PHONE-FIXES-2026-10-13.md) passes **774/774 regression tests**, all 18 production JavaScript syntax checks, and the **222-file / 7,974,424-byte** dependency inventory. A 360 × 800 responsive browser check imported two metadata-heavy JPEGs, resized an existing crop corner, checked per-page cropped-paper toggling, and exported a two-page PDF. Independent inspection confirms the exact crop fills its trimmed page while the other page retains its orientation and A4 paper; both pages were rendered and visually inspected. Gesture regressions use controlled events; a physical Android/iOS multi-touch check remains separate. The earlier [Batch 6 verification](docs/BATCH-6-2026-10-12.md) retains its 721-test and export/recovery evidence.

Outstanding issues and completed batches are tracked in [Memory.md](Memory.md).
