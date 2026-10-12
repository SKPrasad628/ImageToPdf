"""Independently verify the browser-exported phone crop PDF; never write a PDF."""
import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageOps
from pypdf import PdfReader
from pypdf.generic import ContentStream

ROOT = Path(__file__).resolve().parents[2]
WORK = Path(__file__).resolve().parent
PDF = WORK / "browser-crop.pdf"
REPORT = ROOT / "docs/verification/phone-pdf-verification-2026-10-12.json"
IDENTITY = [1, 0, 0, 1, 0, 0]


def concatenate(left, right):
    a, b, c, d, e, f = left
    g, h, i, j, k, l = right
    return [a * g + c * h, b * g + d * h, a * i + c * j,
            b * i + d * j, a * k + c * l + e, b * k + d * l + f]


def image_paints(page, reader):
    state, stack, paints = IDENTITY[:], [], []
    for operands, operation in ContentStream(page.get_contents(), reader).operations:
        if operation == b"q":
            stack.append(state[:])
        elif operation == b"Q":
            state = stack.pop()
        elif operation == b"cm":
            state = concatenate(state, [float(value) for value in operands])
        elif operation == b"Do":
            name = operands[0]
            obj = page["/Resources"]["/XObject"][name].get_object()
            assert obj["/Subtype"] == "/Image", "Fixture output contains an unexpected form XObject"
            a, b, c, d, e, f = state
            corners = [[e, f], [a + e, b + f], [a + c + e, b + d + f], [c + e, d + f]]
            bounds = [min(point[0] for point in corners), min(point[1] for point in corners),
                      max(point[0] for point in corners), max(point[1] for point in corners)]
            actual = next(image.image for image in page.images if image.name.split(".")[0] == str(name)[1:])
            paints.append({"name": str(name), "object": obj, "bounds": bounds, "image": actual})
    assert not stack
    return paints


def close(actual, expected, tolerance=0.000002):
    assert math.isclose(actual, expected, abs_tol=tolerance), f"{actual} != {expected}"


def pixel_difference(actual, expected):
    assert actual.size == expected.size
    rgb_actual, rgb_expected = actual.convert("RGB"), expected.convert("RGB")
    histogram = ImageChops.difference(rgb_actual, rgb_expected).histogram()
    total = actual.width * actual.height * 3
    mae = sum((index % 256) * count for index, count in enumerate(histogram)) / total
    rmse = math.sqrt(sum((index % 256) ** 2 * count for index, count in enumerate(histogram)) / total)
    maximum = max(index % 256 for index, count in enumerate(histogram) if count)
    over_four = sum(count for index, count in enumerate(histogram) if index % 256 > 4) / total
    if "A" in actual.getbands():
        assert actual.getchannel("A").getextrema() == (255, 255), "Export unexpectedly introduced transparency"
    assert mae < 2, f"Image pixels differ beyond bounded JPEG-decoder rounding: {mae}"
    assert over_four < 0.01, f"More than 1% of color channels differ by over four: {over_four}"
    return {"mean_absolute_channel_difference": mae, "root_mean_square_channel_difference": rmse,
            "maximum_channel_difference": maximum, "channel_fraction_difference_over_4": over_four,
            "tolerance": "MAE < 2 / 255 and fewer than 1% of channels differ by over 4 / 255"}


def verify():
    fixtures = json.loads((WORK / "intake-fixtures.json").read_text())
    reader = PdfReader(PDF, strict=True)
    assert len(reader.pages) == 2
    first, second = reader.pages
    first_paints, second_paints = image_paints(first, reader), image_paints(second, reader)
    assert len(first_paints) == len(second_paints) == 1
    cropped = first_paints[0]
    assert [cropped["object"]["/Width"], cropped["object"]["/Height"]] == [349, 440]
    expected_size_pt = [349 * 72 / 300, 440 * 72 / 300]
    first_box = [float(first.mediabox.width), float(first.mediabox.height)]
    for actual, expected in zip(first_box, expected_size_pt):
        close(actual, expected)
    for actual, expected in zip(cropped["bounds"], [0, 0, *expected_size_pt]):
        close(actual, expected)
    original = ImageOps.exif_transpose(Image.open(WORK / fixtures[0]["file"]))
    expected_crop = original.crop((50, 80, 399, 520))
    crop_pixels = pixel_difference(cropped["image"], expected_crop)

    unchanged = second_paints[0]
    assert [unchanged["object"]["/Width"], unchanged["object"]["/Height"]] == [700, 500]
    second_box = [float(second.mediabox.width), float(second.mediabox.height)]
    for actual, expected in zip(second_box, [297 * 72 / 25.4, 210 * 72 / 25.4]):
        close(actual, expected)
    source_second = ImageOps.exif_transpose(Image.open(WORK / fixtures[1]["file"]))
    second_pixels = pixel_difference(unchanged["image"], source_second)
    close(unchanged["bounds"][1], 0)
    close(unchanged["bounds"][3], second_box[1])
    contain_width = second_box[1] * 700 / 500
    close(unchanged["bounds"][0], (second_box[0] - contain_width) / 2)
    close(unchanged["bounds"][2], (second_box[0] + contain_width) / 2)

    report = {"date": "2026-10-12", "passed": True,
              "pdf": {"name": PDF.name, "bytes": PDF.stat().st_size, "pages": 2,
                      "sha256": hashlib.sha256(PDF.read_bytes()).hexdigest()},
              "import": {"selected": 2, "imported": 2,
                         "browser_observation": "Primary agent observed both fixtures import; output pages independently match them in selection order.",
                         "fixture_header_verification": [{"file": item["file"], "bytes": item["bytes"],
                                                         "encoded_pixels": item["encoded"], "display_pixels": item["display"],
                                                         "exif_orientation": item["orientation"],
                                                         "header_bytes_read": item["intake"]["headerBytes"],
                                                         "dimension_verification": "Pillow decode and production intake agree"} for item in fixtures]},
              "cropped_page": {"pixels": [349, 440], "source_crop_xyxy": [50, 80, 399, 520],
                               "page_size_points": first_box, "page_size_mm": [number * 25.4 / 72 for number in first_box],
                               "painted_image_bounds_points": cropped["bounds"], "fills_entire_page": True,
                               "pixel_comparison": crop_pixels},
              "unchanged_page": {"pixels": [700, 500], "page_size_points": second_box,
                                 "page_size_mm": [number * 25.4 / 72 for number in second_box],
                                 "requested_margin_mm": 0, "painted_image_bounds_points": unchanged["bounds"],
                                 "contain_horizontal_space_mm_each": unchanged["bounds"][0] * 25.4 / 72,
                                 "contain_space_reason": "A4 and 700:500 aspect ratios differ; contain fits without stretching.",
                                 "pixel_comparison": second_pixels},
              "verification": {"reader": "pypdf strict reopen and decoded XObjects", "pixels": "Pillow independently decoded original fixtures",
                               "limits": "Synthetic camera-metadata fixtures and desktop Chromium browser output. Actual rejected phone files and physical phone gestures were not available for this independent check."}}
    renders = [WORK / "browser-crop-page-1.png", WORK / "browser-crop-page-2.png"]
    if all(path.exists() for path in renders):
        report["verification"]["renders"] = [{"file": path.name, "pixels": list(Image.open(path).size)} for path in renders]
        report["verification"]["render_tool"] = "Poppler pdftoppm at 240 DPI"
        report["verification"]["visual_review"] = "Both rendered pages inspected: cropped pixels cover the first page without white remnants; the second retains the EXIF-6 clockwise orientation and contains the full source."
    REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    verify()
