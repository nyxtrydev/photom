use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use image::RgbImage;

use crate::infra::model_manager::ModelSpec;
use crate::models::error::{AppError, AppResult};

pub(crate) fn resize_u8(
    data: &[u8],
    (sw, sh): (u32, u32),
    (dw, dh): (u32, u32),
    pixel_type: PixelType,
    filter: FilterType,
) -> AppResult<Vec<u8>> {
    let src = ImageRef::new(sw, sh, data, pixel_type)
        .map_err(|e| AppError::Internal(format!("resize source: {e}")))?;
    let mut dst = Image::new(dw, dh, pixel_type);
    Resizer::new()
        .resize(
            &src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(filter)),
        )
        .map_err(|e| AppError::Internal(format!("resize: {e}")))?;
    Ok(dst.into_vec())
}

/// Resize to the model input size, normalise (v/255, then (v-mean)/std) and lay out as NCHW f32.
pub fn preprocess(rgb: &RgbImage, spec: &ModelSpec) -> AppResult<Vec<f32>> {
    let s = spec.input_size;
    let resized = resize_u8(
        rgb.as_raw(),
        rgb.dimensions(),
        (s, s),
        PixelType::U8x3,
        FilterType::Lanczos3,
    )?;
    let plane = (s * s) as usize;
    let mut out = vec![0f32; 3 * plane];
    for (i, px) in resized.chunks_exact(3).enumerate() {
        for c in 0..3 {
            out[c * plane + i] = (f32::from(px[c]) / 255.0 - spec.mean[c]) / spec.std[c];
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::dto::ModelKind;
    use image::Rgb;

    fn spec() -> ModelSpec {
        ModelSpec {
            kind: ModelKind::Fast,
            files: &[],
            input_size: 16,
            mean: [0.5, 0.5, 0.5],
            std: [1.0, 1.0, 1.0],
            sigmoid: false,
            licence: "test",
        }
    }

    #[test]
    fn tensor_has_nchw_size() {
        let img = RgbImage::from_pixel(40, 30, Rgb([10, 20, 30]));
        assert_eq!(preprocess(&img, &spec()).unwrap().len(), 3 * 16 * 16);
    }

    #[test]
    fn normalisation_and_channel_order() {
        let img = RgbImage::from_pixel(8, 8, Rgb([255, 0, 128]));
        let t = preprocess(&img, &spec()).unwrap();
        let plane = 16 * 16;
        assert!((t[0] - 0.5).abs() < 1e-3); // R: 1.0 - 0.5
        assert!((t[plane] + 0.5).abs() < 1e-3); // G: 0.0 - 0.5
        assert!((t[2 * plane] - (128.0 / 255.0 - 0.5)).abs() < 1e-2);
    }
}
