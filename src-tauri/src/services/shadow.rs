//! Shadow settings and the geometry the export renderer shares with the editor preview.
//!
//! The editor draws shadows on a downscaled proxy in TypeScript (`src/canvas/shadow.ts`); this
//! module holds the same parameters, validation and canvas-bounds maths so exports match. Both
//! sides are checked against `tests/fixtures/shadow_bounds.json`.

use serde_json::Value;

pub const MAX_LAYERS: usize = 8;
pub const DEFAULT_COLOR: &str = "#2b1a10";

/// A rectangle in source pixels (origin = top-left of the source image).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

/// Limits shared with `src/canvas/shadow.ts`.
pub const MAX_CAST_LENGTH: f64 = 6.0;
pub const CONTACT_SQUASH: f64 = 0.25;
const CAST_LEVELS: usize = 4;

#[derive(Debug, Clone, PartialEq)]
pub struct DropLayer {
    pub visible: bool,
    pub angle: f64,
    pub distance: f64,
    pub blur: f64,
    pub spread: f64,
    pub opacity: f64,
    pub color: String,
}

/// A tight shadow where the subject touches the ground.
#[derive(Debug, Clone, PartialEq)]
pub struct ContactLayer {
    pub visible: bool,
    pub size: f64,
    pub softness: f64,
    pub ground_offset: f64,
    pub opacity: f64,
    pub color: String,
}

/// The subject projected along the light onto the floor.
#[derive(Debug, Clone, PartialEq)]
pub struct CastLayer {
    pub visible: bool,
    pub angle: f64,
    pub elevation: f64,
    pub length: f64,
    pub squash: f64,
    pub falloff: f64,
    pub blur: f64,
    pub blur_growth: f64,
    pub opacity: f64,
    pub color: String,
}

/// A flipped, faded, blurred copy of the subject under it (uses the subject's own colours).
#[derive(Debug, Clone, PartialEq)]
pub struct ReflectionLayer {
    pub visible: bool,
    pub gap: f64,
    pub fade: f64,
    pub blur: f64,
    pub opacity: f64,
}

impl ReflectionLayer {
    pub fn sigma(&self) -> f64 {
        self.blur / 2.0
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Layer {
    Drop(DropLayer),
    Contact(ContactLayer),
    Cast(CastLayer),
    Reflection(ReflectionLayer),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShadowParams {
    pub enabled: bool,
    pub auto_expand: bool,
    /// Blend layer colours in linear light.
    pub linear_light: bool,
    /// Ground line as a fraction of the image height; `None` = the subject's lowest pixel.
    pub ground_y: Option<f64>,
    pub layers: Vec<Layer>,
}

fn num(v: Option<&Value>, fallback: f64, min: f64, max: f64) -> f64 {
    match v.and_then(Value::as_f64) {
        Some(n) if n.is_finite() => n.clamp(min, max),
        _ => fallback,
    }
}

fn valid_hex(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn colour(l: &serde_json::Map<String, Value>) -> String {
    l.get("color")
        .and_then(Value::as_str)
        .filter(|c| valid_hex(c))
        .unwrap_or(DEFAULT_COLOR)
        .to_ascii_lowercase()
}

fn rgb(hex: &str) -> [u8; 3] {
    let p = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0);
    [p(1), p(3), p(5)]
}

impl DropLayer {
    /// Light direction -> where the shadow falls (y grows downward).
    pub fn offset(&self) -> (f64, f64) {
        let a = self.angle.to_radians();
        (-a.cos() * self.distance, a.sin() * self.distance)
    }

    pub fn sigma(&self) -> f64 {
        self.blur / 2.0
    }

    /// `(red, green, blue)` of the layer colour.
    pub fn rgb(&self) -> [u8; 3] {
        rgb(&self.color)
    }
}

impl CastLayer {
    /// The floor direction per source px of subject height: `(sx, sy)`.
    pub fn vector(&self) -> (f64, f64) {
        let a = self.angle.to_radians();
        let len = (self.length / self.elevation.to_radians().tan()).min(MAX_CAST_LENGTH);
        (-a.cos() * len, a.sin() * len * self.squash)
    }

    /// Blur sigmas (source px) of the levels the shadow is rendered at, near to far.
    pub fn sigmas(&self) -> Vec<f64> {
        if self.blur_growth <= 0.0 {
            return vec![self.blur / 2.0];
        }
        (0..CAST_LEVELS)
            .map(|i| (self.blur + self.blur_growth * i as f64 / (CAST_LEVELS - 1) as f64) / 2.0)
            .collect()
    }

    pub fn rgb(&self) -> [u8; 3] {
        rgb(&self.color)
    }
}

impl ContactLayer {
    pub fn rgb(&self) -> [u8; 3] {
        rgb(&self.color)
    }
}

impl Layer {
    pub fn visible(&self) -> bool {
        match self {
            Layer::Drop(l) => l.visible,
            Layer::Contact(l) => l.visible,
            Layer::Cast(l) => l.visible,
            Layer::Reflection(l) => l.visible,
        }
    }

    pub fn opacity(&self) -> f64 {
        match self {
            Layer::Drop(l) => l.opacity,
            Layer::Contact(l) => l.opacity,
            Layer::Cast(l) => l.opacity,
            Layer::Reflection(l) => l.opacity,
        }
    }

    pub fn drawable(&self) -> bool {
        self.visible() && self.opacity() > 0.0
    }

    pub fn as_drop(&self) -> Option<&DropLayer> {
        match self {
            Layer::Drop(l) => Some(l),
            _ => None,
        }
    }

    fn parse(l: &Value) -> Option<Self> {
        let l = l.as_object()?;
        let visible = l.get("visible").and_then(Value::as_bool) != Some(false);
        let color = colour(l);
        let n = |k: &str, fallback: f64, min: f64, max: f64| num(l.get(k), fallback, min, max);
        match l.get("type").and_then(Value::as_str)? {
            "drop" => Some(Layer::Drop(DropLayer {
                visible,
                angle: n("angle", 135.0, 0.0, 360.0),
                distance: n("distance", 24.0, 0.0, 500.0),
                blur: n("blur", 32.0, 0.0, 200.0),
                spread: n("spread", 0.0, -50.0, 100.0),
                opacity: n("opacity", 0.45, 0.0, 1.0),
                color,
            })),
            "contact" => Some(Layer::Contact(ContactLayer {
                visible,
                size: n("size", 40.0, 2.0, 300.0),
                softness: n("softness", 12.0, 0.0, 100.0),
                ground_offset: n("groundOffset", 0.0, -50.0, 100.0),
                opacity: n("opacity", 0.6, 0.0, 1.0),
                color,
            })),
            "cast" => Some(Layer::Cast(CastLayer {
                visible,
                angle: n("angle", 135.0, 0.0, 360.0),
                elevation: n("elevation", 40.0, 5.0, 85.0),
                length: n("length", 1.0, 0.1, 2.0),
                squash: n("squash", 0.5, 0.1, 1.0),
                falloff: n("falloff", 0.7, 0.0, 1.0),
                blur: n("blur", 6.0, 0.0, 100.0),
                blur_growth: n("blurGrowth", 40.0, 0.0, 150.0),
                opacity: n("opacity", 0.4, 0.0, 1.0),
                color,
            })),
            "reflection" => Some(Layer::Reflection(ReflectionLayer {
                visible,
                gap: n("gap", 4.0, 0.0, 100.0),
                fade: n("fade", 200.0, 10.0, 1000.0),
                blur: n("blur", 3.0, 0.0, 50.0),
                opacity: n("opacity", 0.35, 0.0, 1.0),
            })),
            // Layer types this version does not know (from a newer app) are skipped.
            _ => None,
        }
    }
}

impl ShadowParams {
    /// Read the `shadow` object of a state.json, clamping every value into range exactly as the
    /// editor does. `None` when there is nothing usable (no shadow).
    pub fn from_value(v: &Value) -> Option<Self> {
        let obj = v.as_object()?;
        let layers = obj
            .get("layers")
            .and_then(Value::as_array)
            .map(|a| a.iter().take(MAX_LAYERS).filter_map(Layer::parse).collect())
            .unwrap_or_default();
        Some(Self {
            enabled: obj.get("enabled").and_then(Value::as_bool) == Some(true),
            auto_expand: obj.get("autoExpand").and_then(Value::as_bool) != Some(false),
            linear_light: obj.get("linearLight").and_then(Value::as_bool) == Some(true),
            ground_y: match obj.get("groundY") {
                None | Some(Value::Null) => None,
                g => Some(num(g, 0.0, 0.0, 1.0)),
            },
            layers,
        })
    }

    /// True when the shadow would be drawn at all.
    pub fn active(&self) -> bool {
        self.enabled && self.layers.iter().any(Layer::drawable)
    }

    /// Where the subject stands (source px): the manual ground line, else its lowest pixel.
    pub fn ground(&self, subject: Option<Frame>, src_h: i64) -> Option<f64> {
        match self.ground_y {
            Some(g) => Some(g * src_h as f64),
            None => subject.map(|s| (s.y + s.h) as f64),
        }
    }

    /// The output canvas needed to hold the image and every visible shadow: the source rectangle
    /// unioned with each layer's footprint, rounded outward, at most one extra image size on any
    /// side. Drop: the subject box moved by the offset, grown by spread and three sigma of blur.
    /// Contact: the subject's width from the ground line down to the flattened band. Cast: the
    /// subject's width plus the full shadow vector, from the ground line.
    pub fn bounds(&self, subject: Option<Frame>, src_w: i64, src_h: i64) -> Frame {
        let base = Frame {
            x: 0,
            y: 0,
            w: src_w,
            h: src_h,
        };
        let Some(s) = subject else { return base };
        if !self.active() || !self.auto_expand {
            return base;
        }
        let ground = self.ground(subject, src_h).unwrap_or((s.y + s.h) as f64);
        let height = (ground - s.y as f64).max(1.0);
        let (sx0, sx1) = (s.x as f64, (s.x + s.w) as f64);
        let (mut x0, mut y0) = (0.0f64, 0.0f64);
        let (mut x1, mut y1) = (src_w as f64, src_h as f64);
        let mut grow = |a: f64, b: f64, c: f64, d: f64| {
            x0 = x0.min(a);
            y0 = y0.min(b);
            x1 = x1.max(c);
            y1 = y1.max(d);
        };
        for l in self.layers.iter().filter(|l| l.drawable()) {
            match l {
                Layer::Drop(l) => {
                    let (dx, dy) = l.offset();
                    let g = l.spread.max(0.0) + 3.0 * l.sigma();
                    grow(
                        sx0 + dx - g,
                        s.y as f64 + dy - g,
                        sx1 + dx + g,
                        (s.y + s.h) as f64 + dy + g,
                    );
                }
                Layer::Contact(l) => {
                    let g = 3.0 * l.softness / 2.0;
                    let top = ground + l.ground_offset;
                    grow(sx0 - g, top - g, sx1 + g, top + l.size * CONTACT_SQUASH + g);
                }
                Layer::Reflection(l) => {
                    let g = 3.0 * l.sigma();
                    let top = ground + l.gap;
                    grow(sx0 - g, top - g, sx1 + g, top + l.fade.min(height) + g);
                }
                Layer::Cast(l) => {
                    let (sx, sy) = l.vector();
                    let g = 3.0 * l.sigmas().into_iter().fold(0.0, f64::max);
                    grow(
                        sx0 + (sx * height).min(0.0) - g,
                        ground + (sy * height).min(0.0) - g,
                        sx1 + (sx * height).max(0.0) + g,
                        ground + (sy * height).max(0.0) + g,
                    );
                }
            }
        }
        let cap = src_w.max(src_h);
        let x0 = (x0.floor() as i64).max(-cap);
        let y0 = (y0.floor() as i64).max(-cap);
        let x1 = (x1.ceil() as i64).min(src_w + cap);
        let y1 = (y1.ceil() as i64).min(src_h + cap);
        Frame {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        }
    }
}

#[cfg(test)]
#[path = "shadow_tests.rs"]
mod tests;
