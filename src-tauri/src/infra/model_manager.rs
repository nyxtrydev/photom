use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::models::dto::ModelKind;
use crate::models::error::{AppError, AppResult};

/// One acceptable file for a model, with its expected checksum (`None` = user-supplied).
#[derive(Debug, Clone, Copy)]
pub struct ModelFile {
    pub name: &'static str,
    pub sha256: Option<&'static str>,
}

/// Static description of a supported model.
#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub kind: ModelKind,
    /// Acceptable files in order of preference (the first one found wins).
    pub files: &'static [ModelFile],
    pub input_size: u32,
    pub mean: [f32; 3],
    pub std: [f32; 3],
    /// Output is logits and needs a sigmoid before min-max normalisation.
    pub sigmoid: bool,
    pub licence: &'static str,
}

impl ModelSpec {
    /// The preferred file (what Photom ships).
    pub fn primary(&self) -> &ModelFile {
        &self.files[0]
    }

    /// Checksum for a file name, if it is one of the known files.
    pub fn sha_for(&self, file_name: &str) -> Option<&'static str> {
        self.files
            .iter()
            .find(|f| f.name == file_name)
            .and_then(|f| f.sha256)
    }
}

/// File name of a model the user imported in Settings (never checksum-verified).
pub fn custom_file_name(kind: ModelKind) -> &'static str {
    match kind {
        ModelKind::Fast => "custom-fast.onnx",
        ModelKind::Quality => "custom-quality.onnx",
    }
}

const FAST_FILES: [ModelFile; 2] = [
    // ISNet general-use (DIS, Apache-2.0) with weights stored as float16: half the size, identical
    // masks (see scripts/make-fast-model.py and docs/PERFORMANCE.md).
    ModelFile {
        name: "isnet-general-use-fp16.onnx",
        sha256: Some("45f290cb2f44771e27f9d77645201617e704a30ce89d5a928089a0a8fa293c06"),
    },
    // The original float32 file (rembg release v0.0.0). Developer fallback via `npm run model:fetch`.
    ModelFile {
        name: "isnet-general-use.onnx",
        sha256: Some("60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a"),
    },
];

const QUALITY_FILES: [ModelFile; 1] = [ModelFile {
    name: "birefnet-general.onnx",
    sha256: None,
}];

pub fn spec(kind: ModelKind) -> ModelSpec {
    match kind {
        ModelKind::Fast => ModelSpec {
            kind,
            files: &FAST_FILES,
            input_size: 1024,
            mean: [0.5, 0.5, 0.5],
            std: [1.0, 1.0, 1.0],
            sigmoid: false,
            licence: "Apache-2.0",
        },
        // BiRefNet general, MIT. Supplied by the user via Settings > Model > Import model file.
        ModelKind::Quality => ModelSpec {
            kind,
            files: &QUALITY_FILES,
            input_size: 1024,
            mean: [0.485, 0.456, 0.406],
            std: [0.229, 0.224, 0.225],
            sigmoid: true,
            licence: "MIT",
        },
    }
}

/// Locates model files. Search order: a user-imported model, then the user models dir, bundled
/// resources and the dev tree, trying each acceptable file name in order of preference.
#[derive(Debug, Clone)]
pub struct ModelManager {
    user_dir: Option<PathBuf>,
    search_dirs: Vec<PathBuf>,
}

impl ModelManager {
    pub fn new(user_dir: Option<PathBuf>, resource_dir: Option<PathBuf>) -> Self {
        let mut search_dirs = Vec::new();
        search_dirs.extend(user_dir.clone());
        if let Some(r) = resource_dir {
            search_dirs.push(r.join("resources").join("models"));
            search_dirs.push(r.join("models"));
        }
        if cfg!(debug_assertions) {
            search_dirs.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models"));
        }
        // CI and power users can point at a folder of models without installing them.
        if let Some(dir) = std::env::var_os("PHOTOM_MODELS_DIR") {
            search_dirs.push(PathBuf::from(dir));
        }
        Self {
            user_dir,
            search_dirs,
        }
    }

    pub fn locate(&self, kind: ModelKind) -> Option<PathBuf> {
        if let Some(custom) = self
            .user_dir
            .as_ref()
            .map(|d| d.join(custom_file_name(kind)))
            .filter(|p| p.is_file())
        {
            return Some(custom);
        }
        let sp = spec(kind);
        sp.files.iter().find_map(|f| {
            self.search_dirs
                .iter()
                .map(|d| d.join(f.name))
                .find(|p| p.is_file())
        })
    }

    pub fn require(&self, kind: ModelKind) -> AppResult<PathBuf> {
        self.locate(kind).ok_or_else(|| {
            AppError::ModelMissing(format!("{} not found", spec(kind).primary().name))
        })
    }
}

pub fn sha256_hex(path: &Path) -> AppResult<String> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

/// Verify a model file against its spec. Files with an unknown name (user-imported) always pass.
pub fn verify(path: &Path, spec: &ModelSpec) -> AppResult<()> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if let Some(expected) = spec.sha_for(name) {
        let actual = sha256_hex(path)?;
        if actual != expected {
            return Err(AppError::ModelLoad(format!(
                "checksum mismatch for {name} (expected {expected}, got {actual})"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vector() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.bin");
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(
            sha256_hex(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn verify_detects_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("isnet-general-use-fp16.onnx");
        std::fs::write(&p, b"not a model").unwrap();
        let err = verify(&p, &spec(ModelKind::Fast)).unwrap_err();
        assert_eq!(err.code(), "ModelLoad");
    }

    #[test]
    fn user_imported_models_are_not_checksum_verified() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(custom_file_name(ModelKind::Fast));
        std::fs::write(&p, b"anything").unwrap();
        assert!(verify(&p, &spec(ModelKind::Fast)).is_ok());
    }

    #[test]
    fn locate_prefers_a_custom_model_then_fp16_then_fp32() {
        let user = tempfile::tempdir().unwrap();
        let res = tempfile::tempdir().unwrap();
        let m = ModelManager {
            user_dir: Some(user.path().to_path_buf()),
            search_dirs: vec![res.path().to_path_buf()],
        };
        assert!(m.locate(ModelKind::Fast).is_none());
        std::fs::write(res.path().join("isnet-general-use.onnx"), b"x").unwrap();
        assert!(m
            .locate(ModelKind::Fast)
            .unwrap()
            .ends_with("isnet-general-use.onnx"));
        std::fs::write(res.path().join("isnet-general-use-fp16.onnx"), b"x").unwrap();
        assert!(m
            .locate(ModelKind::Fast)
            .unwrap()
            .ends_with("isnet-general-use-fp16.onnx"));
        std::fs::write(user.path().join("custom-fast.onnx"), b"x").unwrap();
        assert!(m
            .locate(ModelKind::Fast)
            .unwrap()
            .ends_with("custom-fast.onnx"));
    }

    #[test]
    fn a_missing_model_is_a_typed_error() {
        let empty = tempfile::tempdir().unwrap();
        let m = ModelManager {
            user_dir: None,
            search_dirs: vec![empty.path().to_path_buf()],
        };
        assert_eq!(
            m.require(ModelKind::Fast).unwrap_err().code(),
            "ModelMissing"
        );
    }
}
