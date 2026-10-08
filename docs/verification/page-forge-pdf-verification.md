# Page Forge browser PDF verification

Verified October 6, 2026, independently from the production browser session.

- Download: `C:/Users/skpra/Downloads/page-forge-browser-qa.pdf`
- Size: **18,954 bytes**; **5 pages**.
- SHA-256: `abc440b38df8cbffa08796cd49050414f44236fa11747ac5bf302db224d5247d`
- Sources: `tmp/pdfs/original-1.png`, `original-2.png`, and `native-original.pdf`.
- Methods: pypdf page/content inspection, Pillow comparison of decoded embedded image pixels, and Poppler rendering of every output page at 90 DPI followed by visual inspection.

| Output page | Content | Verified physical geometry |
| --- | --- | --- |
| 1 | `original-1.png` | A4 landscape, **297 x 210 mm**, Fill, 20 mm margins. |
| 2 | `original-2.png` | A4 landscape, **297 x 210 mm**, Fill, 20 mm margins. |
| 3 | Native source page 1 | **112.889 x 169.333 mm**, original 320 x 480 pt boxes, rotation 0. |
| 4 | Native source page 2 | MediaBox **215.9 x 279.4 mm**; retained CropBox is **176.389 x 246.944 mm**, rotation 0. |
| 5 | Native source page 3 | Original MediaBox **279.4 x 215.9 mm** and rotation 90 retained; effective display is **215.9 x 279.4 mm**. |

## Image-page checks

Both image pages contain one embedded image. Its dimensions and every decoded RGBA pixel match the supplied PNG: 320 x 480 pixels for page 1 and 612 x 792 pixels for page 2. No added lossy compression was observed.

Both content streams establish a clipping rectangle with origin **20 x 20 mm** and dimensions **257 x 170 mm** (`re`, `W`, `n` operators). The images scale to cover that rectangle. The output therefore retains the requested margins while Fill crops image content. Rendered pages show the expected central crop and clear white margins, without application ornaments or dark UI colors in the PDF.

## Native-page checks

Each output native page's MediaBox, CropBox, rotation, extracted native text, and decoded content-stream SHA-256 match its corresponding source page exactly. All three retain selectable `Native text page N` and `Selectable text and vector shapes` content; none contains an image XObject. Vector shapes remain vector content. The output preserves these pages' different original dimensions, rather than reflowing them to the global image-page settings.

All five rendered pages were inspected. Native text, shapes, original rotation, and source appearance were retained. The first source page's preexisting link rectangle crosses its heading in both source and output; this is fixture content, not a new export defect.

## Scope

This verifies the actual five-page browser-generated sample and the properties above. It does not certify every advanced PDF feature, annotation behavior, form interaction, font environment, printer, or document. Poppler emitted local missing-display-font warnings for Symbol/ArialUnicode, but the inspected fixture text rendered legibly. Native content-stream equality is independent evidence of retained source text/vector content.
