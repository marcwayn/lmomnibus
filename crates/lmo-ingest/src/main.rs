//! Fetches the OpenRouter model catalog, normalizes it into `lmo_core::Model`,
//! applies curated corrections from `data/overrides.json`, and writes the
//! result to `data/catalog.json` — the file the running app embeds at
//! compile time. Run with `cargo run -p lmo-ingest`.

use anyhow::{Context, Result};
use lmo_core::model::{
    Capabilities, Model, Promo, Provenance, RateCard, RateMode, RateTier, ReleaseDate, Scores,
};
use rust_decimal::Decimal;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::str::FromStr;

const FEED_URL: &str = "https://openrouter.ai/api/v1/models";
const OUT_PATH: &str = "data/catalog.json";
const OVERRIDES_PATH: &str = "data/overrides.json";

#[derive(Debug, Deserialize)]
struct OrResponse {
    data: Vec<OrModel>,
}

#[derive(Debug, Deserialize)]
struct OrModel {
    id: String,
    name: String,
    created: i64,
    context_length: Option<u32>,
    #[serde(default)]
    architecture: OrArchitecture,
    pricing: OrPricing,
    #[serde(default)]
    top_provider: OrTopProvider,
    #[serde(default)]
    supported_parameters: Vec<String>,
    /// Present (as an object) when this id is a pointer/alias to another
    /// model. We only care whether it's set — alias rows are skipped.
    #[serde(default)]
    alias_target: Option<serde_json::Value>,
    #[serde(default)]
    benchmarks: Option<OrBenchmarks>,
}

#[derive(Debug, Deserialize, Default)]
struct OrArchitecture {
    #[serde(default)]
    modality: String,
}

#[derive(Debug, Deserialize)]
struct OrPricing {
    prompt: Option<String>,
    completion: Option<String>,
    #[serde(default)]
    input_cache_read: Option<String>,
    #[serde(default)]
    input_cache_write: Option<String>,
    #[serde(default)]
    overrides: Option<Vec<OrTierOverride>>,
}

#[derive(Debug, Deserialize)]
struct OrTierOverride {
    /// Absent on time-of-day discount tiers (`utc_start`/`utc_end`) rather
    /// than context-length tiers — those aren't modeled in v1, so entries
    /// without this field are skipped rather than misread as a token tier.
    #[serde(default)]
    min_prompt_tokens: Option<u32>,
    prompt: Option<String>,
    completion: Option<String>,
    #[serde(default)]
    input_cache_read: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct OrTopProvider {
    max_completion_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct OrBenchmarks {
    artificial_analysis: Option<OrArtificialAnalysis>,
}

#[derive(Debug, Deserialize)]
struct OrArtificialAnalysis {
    intelligence_index: Option<f32>,
    coding_index: Option<f32>,
    agentic_index: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct OverrideEntry {
    key: String,
    mode: String,
    input: Option<String>,
    output: Option<String>,
    promo: Option<OverridePromo>,
}

#[derive(Debug, Deserialize)]
struct OverridePromo {
    input: String,
    output: String,
    until: String,
}

fn main() -> Result<()> {
    let raw = fetch_feed()?;
    eprintln!("fetched {} raw entries from {FEED_URL}", raw.data.len());

    let models = normalize(raw.data);
    eprintln!("normalized to {} priced models", models.len());

    let models = apply_overrides(models)?;

    let json = serde_json::to_string_pretty(&models)?;
    std::fs::write(OUT_PATH, json).with_context(|| format!("writing {OUT_PATH}"))?;
    eprintln!("wrote {OUT_PATH} ({} models)", models.len());
    Ok(())
}

fn fetch_feed() -> Result<OrResponse> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("lmo-ingest/0.1 (+https://github.com/)")
        .build()?;
    let resp = client
        .get(FEED_URL)
        .send()
        .context("requesting OpenRouter models feed")?
        .error_for_status()
        .context("OpenRouter models feed returned an error status")?;
    resp.json::<OrResponse>().context("parsing feed JSON")
}

/// Vendor display names for known prefixes; anything else is title-cased
/// from its hyphenated slug as a reasonable fallback.
fn vendor_name(vendor_key: &str) -> String {
    let known: &[(&str, &str)] = &[
        ("anthropic", "Anthropic"),
        ("~anthropic", "Anthropic"),
        ("openai", "OpenAI"),
        ("google", "Google"),
        ("mistralai", "Mistral AI"),
        ("meta-llama", "Meta"),
        ("x-ai", "xAI"),
        ("z-ai", "Z.ai"),
        ("deepseek", "DeepSeek"),
        ("qwen", "Qwen"),
        ("moonshotai", "Moonshot AI"),
        ("minimax", "MiniMax"),
        ("nvidia", "NVIDIA"),
        ("cohere", "Cohere"),
        ("amazon", "Amazon"),
        ("perplexity", "Perplexity"),
        ("inclusionai", "InclusionAI"),
        ("poolside", "Poolside"),
        ("aion-labs", "AionLabs"),
        ("bytedance-seed", "ByteDance Seed"),
        ("openrouter", "OpenRouter"),
        ("thedrummer", "TheDrummer"),
    ];
    if let Some((_, name)) = known.iter().find(|(k, _)| *k == vendor_key) {
        return name.to_string();
    }
    vendor_key
        .split(['-', '_'])
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_vendor_prefix(name: &str) -> String {
    match name.find(": ") {
        Some(idx) => name[idx + 2..].to_string(),
        None => name.to_string(),
    }
}

/// Days since 1970-01-01 -> proleptic-Gregorian (year, month, day).
/// Howard Hinnant's `civil_from_days` — public-domain integer arithmetic,
/// used here so ingest needs no date/calendar dependency.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

fn release_date_from_unix(secs: i64) -> ReleaseDate {
    let days = secs.div_euclid(86400);
    let (year, month, _day) = civil_from_days(days);
    ReleaseDate { year, month: month as u8 }
}

fn dollars_per_token_to_usd_per_mtok(s: &str) -> Option<Decimal> {
    let d = Decimal::from_str(s).ok()?;
    Some(d * Decimal::from(1_000_000u64))
}

enum Suffix {
    Batch,
    Fast,
    None,
}

fn detect_suffix(id: &str) -> (String, Suffix) {
    if let Some(base) = id.strip_suffix(":batch") {
        (base.to_string(), Suffix::Batch)
    } else if let Some(base) = id.strip_suffix("-fast") {
        (base.to_string(), Suffix::Fast)
    } else {
        (id.to_string(), Suffix::None)
    }
}

fn normalize(raw: Vec<OrModel>) -> Vec<Model> {
    // Pass 1: drop alias pointers and marketing ":free" duplicates, group
    // the rest by their base id so batch/fast variants fold into one model
    // instead of appearing as separate catalog rows.
    let mut groups: BTreeMap<String, Vec<(RateMode, OrModel)>> = BTreeMap::new();
    for m in raw {
        if m.alias_target.is_some() {
            continue;
        }
        if m.id.ends_with(":free") {
            continue;
        }
        let (base_id, suffix) = detect_suffix(&m.id);
        let mode = match suffix {
            Suffix::Batch => RateMode::Batch,
            Suffix::Fast => RateMode::Fast,
            Suffix::None => RateMode::Standard,
        };
        groups.entry(base_id).or_default().push((mode, m));
    }

    let mut models = Vec::with_capacity(groups.len());

    for (base_id, mut entries) in groups {
        // Prefer the Standard entry as the metadata source; else the most
        // recently created entry in the group.
        entries.sort_by_key(|(mode, m)| {
            (
                if *mode == RateMode::Standard { 0 } else { 1 },
                std::cmp::Reverse(m.created),
            )
        });
        let (_, primary) = &entries[0];

        let vendor_key = base_id
            .split('/')
            .next()
            .unwrap_or(&base_id)
            .trim_start_matches('~')
            .to_string();

        let mut capabilities = Capabilities::default();
        for (_, e) in &entries {
            for p in &e.supported_parameters {
                match p.as_str() {
                    "tools" => capabilities.tools = true,
                    "reasoning" | "reasoning_effort" => capabilities.reasoning = true,
                    "response_format" | "structured_outputs" => {
                        capabilities.structured_output = true
                    }
                    _ => {}
                }
            }
        }

        let scores = primary.benchmarks.as_ref().and_then(|b| {
            b.artificial_analysis.as_ref().and_then(|aa| {
                if aa.intelligence_index.is_none()
                    && aa.coding_index.is_none()
                    && aa.agentic_index.is_none()
                {
                    None
                } else {
                    Some(Scores {
                        intelligence: aa.intelligence_index,
                        coding: aa.coding_index,
                        agentic: aa.agentic_index,
                    })
                }
            })
        });

        let mut rates: Vec<(RateMode, RateCard)> = Vec::new();
        for (mode, e) in &entries {
            let (Some(prompt), Some(completion)) = (&e.pricing.prompt, &e.pricing.completion)
            else {
                continue;
            };
            let (Some(input), Some(output)) = (
                dollars_per_token_to_usd_per_mtok(prompt),
                dollars_per_token_to_usd_per_mtok(completion),
            ) else {
                continue;
            };
            let cache_read = e
                .pricing
                .input_cache_read
                .as_deref()
                .and_then(dollars_per_token_to_usd_per_mtok);
            let cache_write = e
                .pricing
                .input_cache_write
                .as_deref()
                .and_then(dollars_per_token_to_usd_per_mtok);

            let mut tiers: Vec<RateTier> = e
                .pricing
                .overrides
                .as_ref()
                .into_iter()
                .flatten()
                .filter_map(|t| {
                    let above_input_tokens = t.min_prompt_tokens?;
                    let ti = dollars_per_token_to_usd_per_mtok(t.prompt.as_deref()?)?;
                    let to = dollars_per_token_to_usd_per_mtok(t.completion.as_deref()?)?;
                    let tc = t
                        .input_cache_read
                        .as_deref()
                        .and_then(dollars_per_token_to_usd_per_mtok);
                    Some(RateTier {
                        above_input_tokens,
                        input: ti,
                        output: to,
                        cache_read: tc,
                    })
                })
                .collect();
            tiers.sort_by_key(|t| t.above_input_tokens);

            rates.push((
                *mode,
                RateCard {
                    input,
                    output,
                    cache_read,
                    cache_write,
                    tiers,
                    promo: None,
                },
            ));
        }

        if rates.is_empty() {
            // Can't price it — nothing for a cost calculator to say.
            continue;
        }

        models.push(Model {
            key: base_id,
            display_name: strip_vendor_prefix(&primary.name),
            vendor_name: vendor_name(&vendor_key),
            vendor_key,
            released: release_date_from_unix(primary.created),
            knowledge_cutoff: None,
            context_tokens: primary.context_length.unwrap_or(0),
            max_output_tokens: primary.top_provider.max_completion_tokens,
            modality: primary.architecture.modality.clone(),
            capabilities,
            scores,
            rates,
            provenance: Provenance::Aggregate,
        });
    }

    models
}

fn apply_overrides(mut models: Vec<Model>) -> Result<Vec<Model>> {
    let raw = std::fs::read_to_string(OVERRIDES_PATH)
        .with_context(|| format!("reading {OVERRIDES_PATH}"))?;
    let overrides: Vec<OverrideEntry> = serde_json::from_str(&raw)?;

    for o in overrides {
        let Some(model) = models.iter_mut().find(|m| m.key == o.key) else {
            eprintln!("warning: override key {:?} not found in feed, skipping", o.key);
            continue;
        };
        let mode = match o.mode.as_str() {
            "standard" => RateMode::Standard,
            "batch" => RateMode::Batch,
            "fast" => RateMode::Fast,
            other => {
                eprintln!("warning: unknown override mode {other:?} for {}", o.key);
                continue;
            }
        };
        let Some((_, card)) = model.rates.iter_mut().find(|(m, _)| *m == mode) else {
            eprintln!(
                "warning: override for {} has no matching rate mode {:?} from feed",
                o.key, mode
            );
            continue;
        };
        if let Some(input) = o.input.as_deref().and_then(|s| Decimal::from_str(s).ok()) {
            card.input = input;
        }
        if let Some(output) = o.output.as_deref().and_then(|s| Decimal::from_str(s).ok()) {
            card.output = output;
        }
        if let Some(p) = o.promo {
            if let (Ok(pi), Ok(po)) = (Decimal::from_str(&p.input), Decimal::from_str(&p.output)) {
                card.promo = Some(Promo {
                    input: pi,
                    output: po,
                    until: p.until,
                });
            }
        }
        model.provenance = Provenance::FirstParty;
    }

    Ok(models)
}
