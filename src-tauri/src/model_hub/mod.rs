//! Model Hub: catalog, registry and (from Phase H1) downloads for every installable AI model.

pub mod archive;
pub mod commands;
pub mod config;
pub mod downloader;
pub mod hub;
pub mod installer;
pub mod manifest;
pub mod registry;
pub mod session_cache;
pub mod verifier;

pub use hub::ModelHub;
