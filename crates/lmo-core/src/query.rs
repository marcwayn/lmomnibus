use crate::model::Model;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Query {
    /// Fuzzy, case-insensitive subsequence match against name, key, and vendor.
    pub text: String,
    /// OR within this facet; empty means "any vendor".
    pub vendors: Vec<String>,
    /// Exact-match release year filter.
    pub released_year: Option<i32>,
    /// Exact-match release month filter (1-12). Only meaningful alongside
    /// `released_year`, but applied independently so either can be set alone.
    pub released_month: Option<u8>,
    pub limit: usize,
}

impl Query {
    pub fn new() -> Self {
        Self {
            limit: 25,
            ..Default::default()
        }
    }
}

pub struct SearchResult<'a> {
    pub hits: Vec<&'a Model>,
    /// Vendor, name, and count — counted against the text + date filters,
    /// but not the vendor filter itself, so counts never read as zero.
    pub vendor_counts: Vec<(String, String, u32)>,
    pub total_matching: u32,
}

/// Distinct release years present in the catalog, descending.
pub fn available_years(catalog: &[Model]) -> Vec<i32> {
    let mut years: Vec<i32> = catalog.iter().map(|m| m.released.year).collect();
    years.sort_unstable();
    years.dedup();
    years.reverse();
    years
}

/// Subsequence fuzzy score: every character of `query` must appear in
/// `target`, in order. Rewards runs of consecutive matches and a match at
/// the very start of the string; penalizes a long target matched sparsely.
/// Returns `None` when `query` is non-empty and not a subsequence.
fn fuzzy_score(query: &str, target: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let q: Vec<char> = query.chars().collect();
    let t: Vec<char> = target.chars().collect();

    let mut ti = 0usize;
    let mut score = 0i32;
    let mut consecutive = 0i32;
    let mut first_match_idx: Option<usize> = None;

    for &qc in &q {
        let mut found = false;
        while ti < t.len() {
            if t[ti] == qc {
                if first_match_idx.is_none() {
                    first_match_idx = Some(ti);
                }
                consecutive += 1;
                score += 10 + consecutive * 3;
                ti += 1;
                found = true;
                break;
            }
            consecutive = 0;
            ti += 1;
        }
        if !found {
            return None;
        }
    }

    if first_match_idx == Some(0) {
        score += 25;
    }
    score -= ((t.len() as i32) - (q.len() as i32)).max(0) / 4;
    Some(score)
}

fn score_model(m: &Model, text_lower: &str) -> Option<i32> {
    if text_lower.is_empty() {
        return Some(0);
    }
    let by_name = fuzzy_score(text_lower, &m.display_name.to_lowercase());
    let by_key = fuzzy_score(text_lower, &m.key.to_lowercase()).map(|s| s - 5);
    let by_vendor = fuzzy_score(text_lower, &m.vendor_name.to_lowercase()).map(|s| s - 15);
    [by_name, by_key, by_vendor].into_iter().flatten().max()
}

/// Ranks the catalog against a query. Facet counts are computed against
/// every filter *except* the one they represent, so the vendor chips
/// re-weight live instead of collapsing to zero the moment one is chosen.
pub fn search<'a>(catalog: &'a [Model], q: &Query) -> SearchResult<'a> {
    let text_lower = q.text.trim().to_lowercase();

    let passes_date = |m: &Model| -> bool {
        if let Some(year) = q.released_year {
            if m.released.year != year {
                return false;
            }
        }
        if let Some(month) = q.released_month {
            if m.released.month != month {
                return false;
            }
        }
        true
    };

    let mut vendor_counts: BTreeMap<(String, String), u32> = BTreeMap::new();
    for m in catalog {
        if !passes_date(m) {
            continue;
        }
        if score_model(m, &text_lower).is_none() {
            continue;
        }
        *vendor_counts
            .entry((m.vendor_key.clone(), m.vendor_name.clone()))
            .or_insert(0) += 1;
    }

    let vendor_filter_active = !q.vendors.is_empty();

    let mut scored: Vec<(i32, &Model)> = catalog
        .iter()
        .filter_map(|m| {
            if !passes_date(m) {
                return None;
            }
            if vendor_filter_active && !q.vendors.iter().any(|v| v == &m.vendor_key) {
                return None;
            }
            let s = score_model(m, &text_lower)?;
            Some((s, m))
        })
        .collect();

    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.released.cmp(&a.1.released))
            .then_with(|| a.1.display_name.cmp(&b.1.display_name))
    });

    let total_matching = scored.len() as u32;
    let limit = if q.limit == 0 { 25 } else { q.limit };
    let hits = scored.into_iter().take(limit).map(|(_, m)| m).collect();

    let mut vendor_counts: Vec<(String, String, u32)> = vendor_counts
        .into_iter()
        .map(|((k, n), c)| (k, n, c))
        .collect();
    vendor_counts.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.1.cmp(&b.1)));

    SearchResult {
        hits,
        vendor_counts,
        total_matching,
    }
}
