"""Read-only independent checks of the actual Batch 6 browser downloads."""
from pathlib import Path
import hashlib
import json

import numpy as np
from PIL import Image
from pypdf import PdfReader
from pypdf.generic import ContentStream, StreamObject

ROOT = Path(__file__).resolve().parents[2]
FOLDER = Path(__file__).resolve().parent
RESULT = ROOT / "docs/verification/batch6-pdf-verification-2026-10-12.json"


def inspect_pdf(filename, expected_pages, expected_bytes):
    path = FOLDER / filename
    assert path.stat().st_size == expected_bytes, (filename, path.stat().st_size)
    reader = PdfReader(path, strict=True)
    assert len(reader.pages) == expected_pages
    page_details, pixels = [], []
    for index, page in enumerate(reader.pages):
        # jsPDF shares an XObject resource dictionary across pages. Validate
        # the image actually painted by each page, rather than all resources.
        operations = ContentStream(page.get_contents(), reader).operations
        painted = [str(operands[0]) for operands, operator in operations if operator == b"Do"]
        assert len(painted) == 1, (filename, index, painted)
        name = painted[0]
        stream = page["/Resources"]["/XObject"][name].get_object()
        assert stream["/Subtype"] == "/Image"
        image = page.images[name].image
        rgba = np.asarray(image.convert("RGBA"))
        assert np.all(rgba[:, :, 3] == 255), (filename, index, "unexpected transparency")
        rgb = rgba[:, :, :3]
        assert np.array_equal(rgb[:, :, 0], rgb[:, :, 1])
        assert np.array_equal(rgb[:, :, 1], rgb[:, :, 2])
        pixels.append(rgb)
        page_details.append({
            "page": index + 1,
            "painted_xobject": name,
            "image_pixels": list(image.size),
            "paper_mm": [round(float(page.mediabox.width) * 25.4 / 72, 3),
                         round(float(page.mediabox.height) * 25.4 / 72, 3)],
            "pdf_rotation": page.rotation,
            "grayscale_values": sorted(int(value) for value in np.unique(rgb[:, :, 0])),
        })
    return {"file": str(path.relative_to(ROOT)), "bytes": path.stat().st_size,
            "pages": expected_pages, "page_details": page_details}, pixels


def inspect_native():
    # Reuse independent parser helpers, excluding the old file's execution
    # footer. Those helpers validate canonical forms and appearances, real
    # destination refs, attachment payloads, and tag ParentTree ownership.
    helper_path = ROOT / "tmp/issue-16/verify-fixtures.py"
    helper_source = helper_path.read_text(encoding="utf-8").split("\nresult = ")[0]
    helpers = {"__file__": str(helper_path)}
    exec(compile(helper_source, str(helper_path), "exec"), helpers)
    requirements = {"pages": [("A", 1, 90), ("A", 2, 0)],
                    "fields": {"shared.name": "Alice A - editable", "shared.approved": "/Yes"},
                    "attachments": ["a"]}
    verified = helpers["check_file"]("../batch6/native.pdf", requirements)
    path = FOLDER / "native.pdf"
    assert path.stat().st_size == 4952
    native = PdfReader(path, strict=True)
    original = PdfReader(ROOT / "tmp/issue-16/source-a.pdf", strict=True)
    source_requirements = {**requirements, "pages": [("A", 1, 0), ("A", 2, 0)]}
    source_verified = helpers["check_file"]("source-a.pdf", source_requirements)

    def appearances(page):
        hashes = []
        for annotation in page.get("/Annots", []):
            annotation = annotation.get_object()
            if annotation.get("/Subtype") != "/Widget":
                continue
            normal = annotation["/AP"]["/N"].get_object()
            if isinstance(normal, StreamObject):
                hashes.append({"normal": hashlib.sha256(normal.get_data()).hexdigest()})
            else:
                hashes.append({str(state): hashlib.sha256(stream.get_object().get_data()).hexdigest()
                               for state, stream in normal.items()})
        return hashes

    for source_page, output_page in zip(original.pages, native.pages):
        assert output_page.get_contents().get_data() == source_page.get_contents().get_data()
        assert output_page.extract_text() == source_page.extract_text()
        assert appearances(output_page) == appearances(source_page)
    for key in ["fields", "links", "outlines", "namedDestinationCount", "attachments",
                "structureElements", "markedContentReferences", "objectReferences", "parentTreeKeys"]:
        assert verified[key] == source_verified[key], (key, verified[key], source_verified[key])
    return {
        "file": str(path.relative_to(ROOT)), "source": "tmp/issue-16/source-a.pdf",
        "bytes": path.stat().st_size, "pages": 2, "rotations": [90, 0],
        "checks": {
            "native_text_and_vector_content_streams_identical_to_source": True,
            "extracted_text_identical_to_source": True,
            "widget_appearance_stream_hashes_identical_to_source": True,
            "fields_and_widget_values_retained": True,
            "links_bookmarks_named_destinations_target_actual_output_pages": True,
            "attachment_bytes_match_source": True,
            "structure_ancestry_and_parent_tree_ownership_valid": True,
        },
        "fields": verified["fields"], "links": verified["links"],
        "outlines": verified["outlines"], "attachments": verified["attachments"],
        "structure_elements": verified["structureElements"],
        "marked_content_references": verified["markedContentReferences"],
        "tagged_object_references": verified["objectReferences"],
        "parent_tree_keys": verified["parentTreeKeys"],
        "widgets": [{key: value for key, value in widget.items() if key != "ref"}
                    for widget in verified["widgets"]],
    }


def main():
    original = np.asarray(Image.open(FOLDER / "source.png").convert("RGB"))
    target_original = np.asarray(Image.open(FOLDER / "target.png").convert("RGB"))
    assert original.shape == (240, 400, 3)
    assert np.array_equal(original, target_original)

    full, full_pixels = inspect_pdf("adjustments.pdf", 2, 8784)
    partial, partial_pixels = inspect_pdf("partial.pdf", 1, 5567)
    source, target = full_pixels
    assert source.shape == (240, 400, 3)
    assert target.shape == (400, 240, 3)
    rotated_source = np.rot90(source, k=-1)  # clockwise quarter-turn
    orientation_error = np.abs(target.astype(np.int16) - rotated_source.astype(np.int16))
    assert orientation_error.max() == 0, "target does not preserve the clockwise quick rotation"
    assert np.array_equal(partial_pixels[0], source), "partial PDF changed the included page"

    # Confirm the fixture has the selected B&W effect and contrast, allowing
    # two output levels for per-stage browser integer conversion. This bounded fixture
    # check does not establish general filter fidelity or arbitrary recipes.
    luminance = original @ np.array([0.2126, 0.7152, 0.0722])
    expected_gray = np.clip(1.05 * luminance - 0.05 * 127.5, 0, 255)
    expected_error = np.abs(source[:, :, 0].astype(float) - expected_gray)
    assert expected_error.max() <= 2.0, float(expected_error.max())
    assert source[25, 25].tolist() == [0, 0, 0]
    assert target[25, 214].tolist() == [0, 0, 0]
    assert full["page_details"][0]["paper_mm"] == [297.0, 210.0]
    assert full["page_details"][1]["paper_mm"] == [210.0, 297.0]

    report = {
        "date": "2026-10-12",
        "status": "passed",
        "method": "pypdf strict reopening and inspection of each page's painted image XObject; PIL and NumPy pixel comparisons",
        "documents": [full, partial, inspect_native()],
        "checks": {
            "identical_original_fixture_images": True,
            "current_page_retains_400x240_pixels": True,
            "target_retains_clockwise_90_degree_orientation_at_240x400_pixels": True,
            "target_vs_clockwise_current_max_channel_error": int(orientation_error.max()),
            "bounded_b_and_w_contrast_105_fixture_max_level_error": round(float(expected_error.max()), 5),
            "bounded_filter_tolerance_in_output_levels": 2,
            "black_orientation_marker_retained": True,
            "partial_included_page_identical_to_complete_source_page": True,
            "portrait_landscape_paper_geometry_agrees_with_pixels": True,
        },
        "limits": [
            "These checks inspect one controlled browser image fixture and its partial export, plus one native PDF fixture after a page rotation and neutral Apply.",
            "The page-to-page comparison verifies propagation and retained orientation; application tests establish recipe ownership and once-only application behavior.",
            "This does not establish all filter combinations, blur fidelity, other browsers, physical devices, or accessibility acceptance.",
            "The native tag checks validate this fixture's object ancestry and ParentTree; they do not establish universal PDF/UA conformance or screen-reader acceptance.",
        ],
    }
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
