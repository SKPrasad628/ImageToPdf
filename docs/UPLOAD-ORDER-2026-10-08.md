# Page Forge — default upload order

Implemented and verified October 8, 2026.

## Requested behavior

New images keep their upload order by default: the first received image becomes page 1, the next becomes page 2, and the last becomes the last page. Filename, file size, and decoding speed do not change that order. Later selections append after earlier selections. Imported PDFs retain their internal page order within the same queue.

The numbered page rail is the PDF order. Explicit actions such as dragging, Earlier/Later, Sort A-Z, or Reverse order change that order intentionally; export respects the resulting arrangement.

## Fix and implementation

The existing FIFO import queue already copied the picker/drop list by index and decoded files sequentially. The missing guard allowed Forge PDF to become enabled after the first image committed, while the remaining selected images were still loading. Export could therefore capture an incomplete prefix of a selection.

- `js/import-queue.js`: exposes `hasPendingImports()` and refreshes the UI at queue start and final drain. The guard includes the running import and all waiting selections, including canceled work until resource cleanup settles.
- `js/forge-ui.js`: disables both export buttons throughout import, exposes an accessible loading message, and marks the page rail busy. Completion or cancellation restores the ready state automatically.
- `js/app.js`: the shared export entry point also rejects direct calls during import. Its cleanup keeps export disabled if a new import started while a captured export was encoding.
- `index.html` and `css/page-forge.css`: explain that upload order becomes page order, and that the numbered rail determines PDF order.
- `tests/upload-order.test.cjs`: runs the actual intake, import queue, document renderer, UI state, and export loop together. Only browser decoding and PDF encoding/download boundaries are mocked.

## Native picker boundary

The app receives the browser's selected-file list, not the sequence of clicks inside the operating-system picker. A multi-file picker can provide an order different from the user's click sequence. Page Forge preserves the order it receives; it cannot reconstruct unexposed click chronology. For an exact first-selected/last-selected sequence, choose one image at a time with Add files, or arrange the numbered pages before export. See the [HTML file-input specification](https://html.spec.whatwg.org/multipage/input.html#file-upload-state-(type=file)).

Do not claim that this change detects click chronology within a native multi-file picker. The automated chooser test below verifies supplied file-list order, not native Windows click order.

## Verification

- `node --experimental-vm-modules --test tests/*.test.cjs`: **540 passed**, zero failures, cancellations, or skips. Four new integration tests cover a five-image selection with a delayed second decode, overlapping selections, intentional reordering, and active/queued cancellation. Log: `../tmp/page-forge-upload-order-tests.log`.
- All three changed JavaScript files pass `node --check`.
- HTML contains 158 unique IDs. The loaded workspace and ordering hint have no horizontal overflow at 320 x 740 CSS pixels; the normal viewport was restored afterward.
- Fresh browser selection used deliberately nonalphabetical filenames, with Preserve original quality enabled. Forge remained disabled while the first image was visible and the remaining files were importing, then became enabled after all five finished. No browser warnings/errors were recorded.
- Browser-generated `page-forge-upload-order-2026-10-08.pdf`: **5 pages, 39,684 bytes**. Independent pypdf inspection followed each page's actual image drawing operator rather than its shared resource list; every drawn image matched the corresponding source's dimensions and RGB pixels exactly. Poppler rendered all five pages; the rendered sequence was visually checked.

| PDF page | Uploaded image |
| --- | --- |
| 1 | `z-first.png` |
| 2 | `a-second.png` |
| 3 | `m-third.png` |
| 4 | `b-fourth.png` |
| 5 | `c-last.png` |

QA inputs and render intermediates are under `../tmp/upload-order/`; the PDF is in the local Downloads folder. Browser screenshot: `verification/page-forge-upload-order.jpg`. These are test fixtures, not user documents. No deployment or unrelated audit completion was performed.
