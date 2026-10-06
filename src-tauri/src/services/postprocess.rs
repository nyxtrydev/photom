use fast_image_resize::{FilterType, PixelType};
use image::GrayImage;

use super::preprocess::resize_u8;
use crate::models::error::{AppError, AppResult};

/// Min-max normalise a model output map to 0..=255. A constant map yields all zeros.
pub fn normalise_to_u8(values: &[f32], sigmoid: bool) -> Vec<u8> {
    let mapped: Vec<f32> = if sigmoid {
        values.iter().map(|v| 1.0 / (1.0 + (-v).exp())).collect()
    } else {
        values.to_vec()
    };
    let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
    for &v in &mapped {
        if v.is_finite() {
            lo = lo.min(v);
            hi = hi.max(v);
        }
    }
    let range = hi - lo;
    if !range.is_finite() || range <= f32::EPSILON {
        return vec![0; mapped.len()];
    }
    mapped
        .iter()
        .map(|&v| {
            if v.is_finite() {
                (((v - lo) / range) * 255.0).round().clamp(0.0, 255.0) as u8
            } else {
                0
            }
        })
        .collect()
}

/// Turn a model output (`side` x `side`) into an 8-bit alpha mask at the original resolution.
pub fn to_alpha_mask(
    output: &[f32],
    side: (u32, u32),
    target: (u32, u32),
    sigmoid: bool,
) -> AppResult<GrayImage> {
    if output.len() != (side.0 as usize) * (side.1 as usize) {
        return Err(AppError::Inference(format!(
            "unexpected output size {} for {}x{}",
            output.len(),
            side.0,
            side.1
        )));
    }
    let small = normalise_to_u8(output, sigmoid);
    let full = resize_u8(&small, side, target, PixelType::U8, FilterType::Bilinear)?;
    GrayImage::from_raw(target.0, target.1, full)
        .ok_or_else(|| AppError::Internal("mask buffer size mismatch".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minmax_spans_full_range() {
        let out = normalise_to_u8(&[0.2, 0.4, 0.6], false);
        assert_eq!((out[0], out[2]), (0, 255));
        assert!(out[1].abs_diff(128) <= 1);
    }

    #[test]
    fn constant_map_is_zero_not_nan() {
        assert_eq!(normalise_to_u8(&[0.7; 4], false), vec![0; 4]);
    }

    #[test]
    fn mask_has_target_dimensions() {
        let m = to_alpha_mask(&[0.0, 1.0, 1.0, 0.0], (2, 2), (50, 30), false).unwrap();
        assert_eq!(m.dimensions(), (50, 30));
    }

    #[test]
    fn wrong_output_length_is_an_error() {
        assert!(to_alpha_mask(&[0.0; 3], (2, 2), (4, 4), false).is_err());
    }
}
