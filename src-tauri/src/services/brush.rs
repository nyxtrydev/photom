//! Brush stroke replay for full-resolution export. Port of `src/canvas/brush.ts`: live painting in
//! the editor and this replay use the same dab spacing/falloff, so exports match the preview.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrushMode {
    Keep,
    Erase,
}

/// One stroke in SOURCE-image coordinates. `points` are `[x, y, pressure]`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub mode: BrushMode,
    /// Diameter in source px.
    pub size: f64,
    /// 0..=100.
    pub hardness: f64,
    pub points: Vec<[f64; 3]>,
}

/// Hard limits applied to saved strokes (they come from files, so they are untrusted).
const MAX_STROKES: usize = 5000;
const MAX_POINTS: usize = 20_000;

pub fn sanitize(strokes: Vec<Stroke>) -> Vec<Stroke> {
    strokes
        .into_iter()
        .take(MAX_STROKES)
        .filter_map(|mut s| {
            s.points.truncate(MAX_POINTS);
            s.points.retain(|p| p[0].is_finite() && p[1].is_finite());
            for p in &mut s.points {
                p[2] = if p[2].is_finite() {
                    p[2].clamp(0.0, 1.0)
                } else {
                    1.0
                };
            }
            s.size = if s.size.is_finite() {
                s.size.clamp(1.0, 150.0)
            } else {
                40.0
            };
            s.hardness = if s.hardness.is_finite() {
                s.hardness.clamp(0.0, 100.0)
            } else {
                70.0
            };
            (!s.points.is_empty()).then_some(s)
        })
        .collect()
}

pub fn falloff(d: f64, radius: f64, hardness: f64) -> f64 {
    let core = radius * (hardness / 100.0);
    if d <= core {
        return 1.0;
    }
    if d >= radius {
        return 0.0;
    }
    let t = (d - core) / (radius - core);
    1.0 - t * t * (3.0 - 2.0 * t)
}

fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

#[allow(clippy::too_many_arguments)]
fn stamp(
    delta: &mut [i16],
    w: usize,
    h: usize,
    cx: f64,
    cy: f64,
    radius: f64,
    hardness: f64,
    mode: BrushMode,
) {
    let r = radius.max(0.5);
    let x0 = (cx - r).floor().max(0.0) as usize;
    let y0 = (cy - r).floor().max(0.0) as usize;
    let x1 = (((cx + r).ceil() + 1.0).min(w as f64)).max(0.0) as usize;
    let y1 = (((cy + r).ceil() + 1.0).min(h as f64)).max(0.0) as usize;
    if x0 >= x1 || y0 >= y1 {
        return;
    }
    let keep = mode == BrushMode::Keep;
    for y in y0..y1 {
        let dy = y as f64 + 0.5 - cy;
        for x in x0..x1 {
            let dx = x as f64 + 0.5 - cx;
            let a = falloff((dx * dx + dy * dy).sqrt(), r, hardness);
            if a <= 0.0 {
                continue;
            }
            let v = js_round(a * 255.0) as i16;
            let i = y * w + x;
            if keep {
                if v > delta[i] {
                    delta[i] = v;
                }
            } else if -v < delta[i] {
                delta[i] = -v;
            }
        }
    }
}

const SPACING: f64 = 0.2;

struct Painter<'a> {
    delta: &'a mut [i16],
    w: usize,
    h: usize,
    scale: f64,
    mode: BrushMode,
    size: f64,
    hardness: f64,
    last: Option<[f64; 3]>,
    carry: f64,
}

impl Painter<'_> {
    fn dab(&mut self, x: f64, y: f64, p: f64) {
        let radius = (self.size / 2.0) * p.max(0.2) * self.scale;
        stamp(
            self.delta,
            self.w,
            self.h,
            x * self.scale,
            y * self.scale,
            radius,
            self.hardness,
            self.mode,
        );
    }

    fn add(&mut self, x: f64, y: f64, p: f64) {
        let Some([lx, ly, lp]) = self.last else {
            self.last = Some([x, y, p]);
            self.dab(x, y, p);
            return;
        };
        let dist = (x - lx).hypot(y - ly);
        let step = (0.5 / self.scale).max(self.size * SPACING * p.max(0.2));
        let mut travelled = step - self.carry;
        while travelled <= dist {
            let t = if dist == 0.0 { 1.0 } else { travelled / dist };
            self.dab(lx + (x - lx) * t, ly + (y - ly) * t, lp + (p - lp) * t);
            travelled += step;
        }
        self.carry = dist - (travelled - step);
        self.last = Some([x, y, p]);
    }
}

/// Replay stored strokes into a cleared delta buffer (`scale` = buffer px per source px).
pub fn replay_strokes(delta: &mut [i16], w: usize, h: usize, scale: f64, strokes: &[Stroke]) {
    delta.fill(0);
    for s in strokes {
        let mut painter = Painter {
            delta: &mut *delta,
            w,
            h,
            scale,
            mode: s.mode,
            size: s.size,
            hardness: s.hardness,
            last: None,
            carry: 0.0,
        };
        for p in &s.points {
            painter.add(p[0], p[1], p[2]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stroke(mode: BrushMode, points: Vec<[f64; 3]>) -> Stroke {
        Stroke {
            mode,
            size: 6.0,
            hardness: 80.0,
            points,
        }
    }

    #[test]
    fn keep_then_erase_then_keep_override_each_other() {
        let mut d = vec![0i16; 400];
        let dab = |mode| stroke(mode, vec![[10.0, 10.0, 1.0]]);
        replay_strokes(
            &mut d,
            20,
            20,
            1.0,
            &[dab(BrushMode::Keep), dab(BrushMode::Erase)],
        );
        assert_eq!(d[10 * 20 + 10], -255);
        replay_strokes(
            &mut d,
            20,
            20,
            1.0,
            &[dab(BrushMode::Erase), dab(BrushMode::Keep)],
        );
        assert_eq!(d[10 * 20 + 10], 255);
    }

    #[test]
    fn a_long_stroke_has_no_gaps() {
        let mut d = vec![0i16; 60 * 60];
        replay_strokes(
            &mut d,
            60,
            60,
            1.0,
            &[stroke(
                BrushMode::Keep,
                vec![[5.0, 5.0, 1.0], [50.0, 40.0, 1.0]],
            )],
        );
        for i in 0..=20 {
            let t = i as f64 / 20.0;
            let (x, y) = (
                (5.0 + 45.0 * t).round() as usize,
                (5.0 + 35.0 * t).round() as usize,
            );
            assert!(d[y * 60 + x] > 200, "gap at ({x},{y})");
        }
    }

    #[test]
    fn radius_scales_with_the_buffer_scale() {
        let mut d = vec![0i16; 100 * 100];
        let s = Stroke {
            mode: BrushMode::Keep,
            size: 40.0,
            hardness: 100.0,
            points: vec![[100.0, 100.0, 1.0]],
        };
        replay_strokes(&mut d, 100, 100, 0.5, &[s]);
        assert_eq!(d[50 * 100 + 50], 255);
        assert_eq!(d[50 * 100 + 65], 0);
    }

    #[test]
    fn sanitize_drops_garbage_and_clamps() {
        let s = sanitize(vec![
            Stroke {
                mode: BrushMode::Keep,
                size: 1e9,
                hardness: -5.0,
                points: vec![[1.0, 2.0, 9.0], [f64::NAN, 1.0, 1.0]],
            },
            Stroke {
                mode: BrushMode::Erase,
                size: 10.0,
                hardness: 10.0,
                points: vec![],
            },
        ]);
        assert_eq!(s.len(), 1);
        assert_eq!(
            (
                s[0].size,
                s[0].hardness,
                s[0].points.len(),
                s[0].points[0][2]
            ),
            (150.0, 0.0, 1, 1.0)
        );
    }
}
