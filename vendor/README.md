# Bundled dependencies

The application uses these local, pinned browser bundles. It does not switch to a CDN if a local dependency fails.

| Package | Version | Included files | License |
| --- | --- | --- | --- |
| jsPDF | 2.5.1 | `jspdf/jspdf.umd.min.js` | MIT |
| PDF.js (`pdfjs-dist`) | 6.3.289 | legacy parser and matching worker, CMaps, standard fonts, WASM/fallback decoders, ICC profile | Apache-2.0 plus included font/decoder licenses |
| pdf-lib | 1.17.1 | Standalone ESM bundle, renamed `.mjs` for unambiguous module loading | MIT plus retained embedded dependency notices |

`manifest.json` records provenance, file lengths and SHA-256 hashes. Verify the complete dependency directory with `node scripts/dependency-check.cjs`; this check does not use the network. After an intentional dependency update, review the version, licenses and loader constants, then run `node scripts/dependency-check.cjs --write`. Changing the manifest is a packaging operation, not an automatic trust decision.

The downloaded jsPDF and PDF.js npm archive SHA-256 values are recorded in the manifest. pdf-lib was copied from an existing verified-version local npm installation. All original bundles and notices are retained unchanged apart from pdf-lib's filename extension. The interface uses self-hosted Cinzel and EB Garamond TrueType fonts, with system font fallbacks and their original SIL Open Font Licenses in `fonts/`; it makes no remote font requests.

The same checker follows every entry-page script and stylesheet, nested CSS imports and font URLs, and literal lazy module/worker paths. Missing files and external resource URLs fail validation before publishing. This resource check validates the application's current URL patterns; the loader regressions also verify that variable PDF worker/rendering asset URLs stay inside the bundled package. It does not install a service worker or certify that a hosted page can be reopened without connectivity. A complete folder served on loopback needs no internet connection for its libraries or fonts; a first visit to a remote host still needs that host to deliver the files.

Upload every file in `vendor/`, not only the three main JavaScript bundles. PDF.js can need CMaps, fonts, decoders or color profiles for a particular document even when a simple PDF appears to work without them.
