use std::io::Cursor;
use std::path::Path;

use image::{DynamicImage, ImageFormat, Rgb, Rgb32FImage, RgbImage, Rgba, RgbaImage};

use crate::models::dto::BoundingBox;
use crate::services::image_io::{self, DEFAULT_PIXEL_LIMIT};

/// JPEG with a minimal EXIF APP1 segment carrying the given orientation.
pub(super) fn jpeg_with_orientation(w: u32, h: u32, orientation: u16) -> Vec<u8> {
    let mut jpeg = Vec::new();
    DynamicImage::ImageRgb8(RgbImage::from_pixel(w, h, Rgb([90, 160, 40])))
        .write_to(&mut Cursor::new(&mut jpeg), ImageFormat::Jpeg)
        .unwrap();
    jpeg_with_orientation_from(jpeg, orientation)
}

/// Inject an EXIF orientation APP1 segment into an existing JPEG byte stream.
pub(super) fn jpeg_with_orientation_from(jpeg: Vec<u8>, orientation: u16) -> Vec<u8> {
    let mut tiff = b"II*\0\x08\0\0\0".to_vec();
    tiff.extend_from_slice(&1u16.to_le_bytes()); // one IFD entry
    tiff.extend_from_slice(&0x0112u16.to_le_bytes()); // Orientation
    tiff.extend_from_slice(&3u16.to_le_bytes()); // SHORT
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&orientation.to_le_bytes());
    tiff.extend_from_slice(&[0, 0]);
    tiff.extend_from_slice(&0u32.to_le_bytes()); // no next IFD

    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend(tiff);
    let len = (app1.len() + 2) as u16;
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
    out.extend_from_slice(&len.to_be_bytes());
    out.extend(app1);
    out.extend_from_slice(&jpeg[2..]);
    out
}

#[test]
fn exif_rotation_swaps_header_and_decoded_dimensions() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("rot.jpg");
    std::fs::write(&p, jpeg_with_orientation(40, 20, 6)).unwrap();
    let (w, h, _) = image_io::read_header(&p, DEFAULT_PIXEL_LIMIT).unwrap();
    assert_eq!((w, h), (20, 40));
    let img = image_io::decode_oriented(&p, DEFAULT_PIXEL_LIMIT).unwrap();
    assert_eq!((img.width(), img.height()), (20, 40));
}

#[test]
fn upright_exif_keeps_dimensions() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("up.jpg");
    std::fs::write(&p, jpeg_with_orientation(40, 20, 1)).unwrap();
    let (w, h, _) = image_io::read_header(&p, DEFAULT_PIXEL_LIMIT).unwrap();
    assert_eq!((w, h), (40, 20));
}

#[test]
fn alpha_input_is_composited_over_white() {
    let mut rgba = RgbaImage::new(2, 1);
    rgba.put_pixel(0, 0, Rgba([0, 0, 0, 0])); // fully transparent
    rgba.put_pixel(1, 0, Rgba([10, 20, 30, 255])); // opaque
    let rgb = image_io::to_rgb_for_inference(&DynamicImage::ImageRgba8(rgba));
    assert_eq!(rgb.get_pixel(0, 0).0, [255, 255, 255]);
    assert_eq!(rgb.get_pixel(1, 0).0, [10, 20, 30]);
}

#[test]
fn sixteen_bit_and_float_inputs_convert_to_rgb8() {
    let img16 = DynamicImage::ImageRgb16(image::ImageBuffer::from_pixel(
        3,
        3,
        image::Rgb([65535u16, 0, 32768]),
    ));
    let rgb = image_io::to_rgb_for_inference(&img16);
    assert_eq!(rgb.get_pixel(0, 0).0[0], 255);
    let f = DynamicImage::ImageRgb32F(Rgb32FImage::from_pixel(2, 2, image::Rgb([1.0, 0.0, 0.0])));
    assert_eq!(
        image_io::to_rgb_for_inference(&f).get_pixel(0, 0).0,
        [255, 0, 0]
    );
}

#[test]
fn pixel_limit_rejects_oversized_images() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("big.png");
    RgbImage::new(100, 100).save(&p).unwrap();
    let e = image_io::read_header(&p, 5_000).unwrap_err();
    assert_eq!(e.code(), "OutOfMemory");
}

#[test]
fn relative_and_missing_paths_are_rejected() {
    assert_eq!(
        image_io::validate_input_path("rel/a.png")
            .unwrap_err()
            .code(),
        "InvalidInput"
    );
    let missing = std::env::temp_dir().join("photom-definitely-missing.png");
    assert_eq!(
        image_io::validate_input_path(&missing.display().to_string())
            .unwrap_err()
            .code(),
        "InvalidInput"
    );
}

#[test]
fn bounding_box_is_tight() {
    let mut m = image::GrayImage::new(10, 10);
    for y in 2..5 {
        for x in 3..8 {
            m.put_pixel(x, y, image::Luma([255]));
        }
    }
    assert_eq!(
        image_io::mask_bounding_box(&m, 10),
        Some(BoundingBox {
            x: 3,
            y: 2,
            width: 5,
            height: 3
        })
    );
    assert_eq!(
        image_io::mask_bounding_box(&image::GrayImage::new(4, 4), 10),
        None
    );
}

#[allow(dead_code)]
fn _assert_path(_: &Path) {}
