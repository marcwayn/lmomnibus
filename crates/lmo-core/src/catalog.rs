use crate::model::Model;
use std::sync::OnceLock;

/// The normalized catalog snapshot, produced by `lmo-ingest` and committed
/// to the repo. Embedding it at compile time means the running app — server
/// and browser WASM alike — never makes a network call to have data to show,
/// and a shared link renders correct figures with no fetch in the critical
/// path. Re-running ingest and redeploying is how the catalog refreshes.
const CATALOG_JSON: &str = include_str!("../../../data/catalog.json");

static CATALOG: OnceLock<Vec<Model>> = OnceLock::new();

pub fn all() -> &'static [Model] {
    CATALOG
        .get_or_init(|| {
            serde_json::from_str(CATALOG_JSON).expect("data/catalog.json must parse as Vec<Model>")
        })
        .as_slice()
}

pub fn by_key(key: &str) -> Option<&'static Model> {
    all().iter().find(|m| m.key == key)
}
