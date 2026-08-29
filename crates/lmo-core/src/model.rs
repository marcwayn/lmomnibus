use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

/// USD per 1,000,000 tokens. Always `Decimal`, never `f64` — money is exact,
/// not approximated, all the way from ingest to the number shown on screen.
pub type UsdPerMTok = Decimal;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct ReleaseDate {
    pub year: i32,
    pub month: u8,
}

impl ReleaseDate {
    pub fn as_year_month(&self) -> String {
        format!("{:04}-{:02}", self.year, self.month)
    }

    pub fn months_since_epoch(&self) -> i32 {
        self.year * 12 + self.month as i32
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RateMode {
    Standard,
    Batch,
    Fast,
}

impl RateMode {
    pub fn label(&self) -> &'static str {
        match self {
            RateMode::Standard => "Standard",
            RateMode::Batch => "Batch",
            RateMode::Fast => "Fast",
        }
    }
}

/// A time-boxed introductory rate that supersedes the list rate while live.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Promo {
    pub input: UsdPerMTok,
    pub output: UsdPerMTok,
    /// ISO date the promo rate stops applying, e.g. "2026-08-31".
    pub until: String,
}

/// A long-context pricing tier. Vendors price the *whole* request at
/// whichever tier the prompt length clears — not marginally, like a tax
/// bracket. See `RateCard::tier_for`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateTier {
    pub above_input_tokens: u32,
    pub input: UsdPerMTok,
    pub output: UsdPerMTok,
    pub cache_read: Option<UsdPerMTok>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateCard {
    pub input: UsdPerMTok,
    pub output: UsdPerMTok,
    pub cache_read: Option<UsdPerMTok>,
    pub cache_write: Option<UsdPerMTok>,
    /// Ascending by `above_input_tokens`. Empty means a flat rate.
    pub tiers: Vec<RateTier>,
    pub promo: Option<Promo>,
}

impl RateCard {
    /// The rates that actually apply to a request of this prompt length:
    /// the highest tier threshold the prompt clears, or the base rate.
    pub fn effective_rates(&self, prompt_tokens: u32) -> EffectiveRates<'_> {
        if let Some(tier) = self
            .tiers
            .iter()
            .rev()
            .find(|t| prompt_tokens > t.above_input_tokens)
        {
            EffectiveRates {
                input: tier.input,
                output: tier.output,
                cache_read: tier.cache_read.or(self.cache_read),
                tier: Some(tier),
            }
        } else {
            EffectiveRates {
                input: self.input,
                output: self.output,
                cache_read: self.cache_read,
                tier: None,
            }
        }
    }

    /// The list rate, ignoring any live promo — what a durable budget
    /// should be built on.
    pub fn list_input(&self) -> UsdPerMTok {
        self.input
    }
    pub fn list_output(&self) -> UsdPerMTok {
        self.output
    }
}

pub struct EffectiveRates<'a> {
    pub input: UsdPerMTok,
    pub output: UsdPerMTok,
    pub cache_read: Option<UsdPerMTok>,
    pub tier: Option<&'a RateTier>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scores {
    pub intelligence: Option<f32>,
    pub coding: Option<f32>,
    pub agentic: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Capabilities {
    pub tools: bool,
    pub reasoning: bool,
    pub structured_output: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum Provenance {
    /// Transcribed from the vendor's own pricing page. Wins on conflict.
    FirstParty,
    /// Derived from the aggregate catalog feed. Broad coverage, weaker authority.
    Aggregate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Model {
    /// "anthropic/claude-opus-5"
    pub key: String,
    pub display_name: String,
    pub vendor_key: String,
    pub vendor_name: String,
    pub released: ReleaseDate,
    pub knowledge_cutoff: Option<String>,
    pub context_tokens: u32,
    pub max_output_tokens: Option<u32>,
    pub modality: String,
    pub capabilities: Capabilities,
    pub scores: Option<Scores>,
    /// Standard is always present. Batch and Fast are optional *modes of
    /// this model* — never separate catalog entries.
    pub rates: Vec<(RateMode, RateCard)>,
    pub provenance: Provenance,
}

impl Model {
    pub fn rate_card(&self, mode: RateMode) -> Option<&RateCard> {
        self.rates.iter().find(|(m, _)| *m == mode).map(|(_, c)| c)
    }

    /// The Standard rate card, or the first available mode if a model was
    /// ingested with no true standard rate (rare — e.g. batch-only pricing).
    pub fn standard(&self) -> &RateCard {
        self.rate_card(RateMode::Standard)
            .or_else(|| self.rates.first().map(|(_, c)| c))
            .expect("every model has at least one rate card")
    }

    pub fn available_modes(&self) -> Vec<RateMode> {
        self.rates.iter().map(|(m, _)| *m).collect()
    }
}
