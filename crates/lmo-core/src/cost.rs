use crate::model::{Model, RateMode};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

/// A workload shape: what one request looks like, and how many run per month.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Workload {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub requests_per_month: u32,
    /// 0-100. Share of input tokens served from a cache read instead of a
    /// fresh input token, at the (usually cheaper) cache-read rate.
    pub cached_pct: u8,
}

impl Default for Workload {
    fn default() -> Self {
        Self {
            input_tokens: 12_000,
            output_tokens: 1_800,
            requests_per_month: 40_000,
            cached_pct: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostBreakdown {
    pub mode: RateMode,
    pub uses_promo: bool,
    pub tier_crossed: bool,
    pub input_cost: Decimal,
    pub cache_cost: Decimal,
    pub output_cost: Decimal,
    pub monthly_cost: Decimal,
    pub blended_per_mtok: Decimal,
    pub effective_input_rate: Decimal,
    pub effective_output_rate: Decimal,
}

impl Model {
    /// Full monthly cost breakdown for this workload, at the given rate mode.
    /// Long-context tiering prices the *whole* request at whichever tier the
    /// prompt length clears (see `RateCard::effective_rates`); promotional
    /// rates are used when live, but callers building a durable budget
    /// should compare against `list_input`/`list_output` instead.
    pub fn cost_for(&self, workload: &Workload, mode: RateMode) -> Option<CostBreakdown> {
        let card = self.rate_card(mode)?;
        let eff = card.effective_rates(workload.input_tokens);

        let (input_rate, output_rate, uses_promo) = if let Some(promo) = &card.promo {
            (promo.input, promo.output, eff.tier.is_none())
        } else {
            (eff.input, eff.output, false)
        };

        let cached_pct = Decimal::from(workload.cached_pct.min(100));
        let hundred = Decimal::from(100u32);
        let cached_tokens = Decimal::from(workload.input_tokens) * cached_pct / hundred;
        let fresh_tokens = Decimal::from(workload.input_tokens) - cached_tokens;

        let requests = Decimal::from(workload.requests_per_month);

        let input_cost = fresh_tokens * requests / Decimal::from(1_000_000u64) * input_rate;
        let cache_cost = match eff.cache_read {
            Some(rate) if cached_pct > Decimal::ZERO => {
                cached_tokens * requests / Decimal::from(1_000_000u64) * rate
            }
            _ => Decimal::ZERO,
        };
        let output_cost = Decimal::from(workload.output_tokens) * requests
            / Decimal::from(1_000_000u64)
            * output_rate;

        let monthly_cost = input_cost + cache_cost + output_cost;

        let total_tokens = Decimal::from(
            (workload.input_tokens as u64 + workload.output_tokens as u64)
                * workload.requests_per_month as u64,
        );
        let blended_per_mtok = if total_tokens > Decimal::ZERO {
            monthly_cost / (total_tokens / Decimal::from(1_000_000u64))
        } else {
            Decimal::ZERO
        };

        Some(CostBreakdown {
            mode,
            uses_promo,
            tier_crossed: eff.tier.is_some(),
            input_cost,
            cache_cost,
            output_cost,
            monthly_cost,
            blended_per_mtok,
            effective_input_rate: input_rate,
            effective_output_rate: output_rate,
        })
    }

    /// The hit rate above which prompt caching stops paying for itself:
    /// where the saving on repeated input tokens equals the extra cost of
    /// having written the cache in the first place. `None` if the model
    /// doesn't expose cache pricing, or a cache write never pays for a
    /// single read (write ≤ savings-per-read already, so it always pays).
    pub fn cache_break_even_pct(&self, mode: RateMode) -> Option<Decimal> {
        let card = self.rate_card(mode)?;
        let read = card.cache_read?;
        let write = card.cache_write?;
        let saving_per_read = card.input - read;
        if saving_per_read <= Decimal::ZERO {
            return None;
        }
        let ratio = write / saving_per_read;
        Some((ratio * Decimal::from(100u32)).min(Decimal::from(100u32)))
    }
}

pub fn parse_decimal(s: &str) -> Option<Decimal> {
    Decimal::from_str(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Capabilities, Promo, Provenance, RateCard, RateTier, ReleaseDate};
    use std::str::FromStr;

    fn dec(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    fn model_with(rates: Vec<(RateMode, RateCard)>) -> Model {
        Model {
            key: "test/model".into(),
            display_name: "Test Model".into(),
            vendor_key: "test".into(),
            vendor_name: "Test".into(),
            released: ReleaseDate { year: 2026, month: 1 },
            knowledge_cutoff: None,
            context_tokens: 1_000_000,
            max_output_tokens: None,
            modality: "text->text".into(),
            capabilities: Capabilities::default(),
            scores: None,
            rates,
            provenance: Provenance::Aggregate,
        }
    }

    #[test]
    fn tiered_pricing_prices_the_whole_request_not_marginally() {
        // Mirrors GPT-5.6 Sol: $2.50/$15 base, $5.00/$22.50 above 272K prompt tokens.
        let card = RateCard {
            input: dec("2.50"),
            output: dec("15.00"),
            cache_read: None,
            cache_write: None,
            tiers: vec![RateTier {
                above_input_tokens: 272_000,
                input: dec("5.00"),
                output: dec("22.50"),
                cache_read: None,
            }],
            promo: None,
        };
        let m = model_with(vec![(RateMode::Standard, card)]);

        let workload = Workload {
            input_tokens: 300_000,
            output_tokens: 1_800,
            requests_per_month: 40_000,
            cached_pct: 0,
        };
        let breakdown = m.cost_for(&workload, RateMode::Standard).unwrap();

        assert!(breakdown.tier_crossed);
        // 300_000 * 40_000 tokens = 12,000 MTok * $5.00 = $60,000
        assert_eq!(breakdown.input_cost, dec("60000.00"));
        // 1_800 * 40_000 tokens = 72 MTok * $22.50 = $1,620
        assert_eq!(breakdown.output_cost, dec("1620.00"));
        assert_eq!(breakdown.monthly_cost, dec("61620.00"));
    }

    #[test]
    fn below_the_tier_threshold_uses_the_base_rate() {
        let card = RateCard {
            input: dec("2.50"),
            output: dec("15.00"),
            cache_read: None,
            cache_write: None,
            tiers: vec![RateTier {
                above_input_tokens: 272_000,
                input: dec("5.00"),
                output: dec("22.50"),
                cache_read: None,
            }],
            promo: None,
        };
        let m = model_with(vec![(RateMode::Standard, card)]);
        let workload = Workload {
            input_tokens: 12_000,
            output_tokens: 1_800,
            requests_per_month: 1,
            cached_pct: 0,
        };
        let breakdown = m.cost_for(&workload, RateMode::Standard).unwrap();
        assert!(!breakdown.tier_crossed);
        assert!(!breakdown.uses_promo);
    }

    #[test]
    fn promo_rate_applies_below_any_tier_and_is_flagged() {
        // Mirrors Claude Sonnet 5: list $3/$15, promo $2/$10 until 2026-08-31.
        let card = RateCard {
            input: dec("3.00"),
            output: dec("15.00"),
            cache_read: None,
            cache_write: None,
            tiers: vec![],
            promo: Some(Promo {
                input: dec("2.00"),
                output: dec("10.00"),
                until: "2026-08-31".into(),
            }),
        };
        let m = model_with(vec![(RateMode::Standard, card)]);
        let workload = Workload {
            input_tokens: 12_000,
            output_tokens: 1_800,
            requests_per_month: 40_000,
            cached_pct: 0,
        };
        let breakdown = m.cost_for(&workload, RateMode::Standard).unwrap();

        assert!(breakdown.uses_promo);
        // 12_000 * 40_000 = 480 MTok * $2.00 = $960
        assert_eq!(breakdown.input_cost, dec("960.00"));
        // 1_800 * 40_000 = 72 MTok * $10.00 = $720
        assert_eq!(breakdown.output_cost, dec("720.00"));
        assert_eq!(breakdown.monthly_cost, dec("1680.00"));
        // list rates stay accessible for a durable budget, ignoring the promo
        assert_eq!(m.standard().list_input(), dec("3.00"));
    }

    #[test]
    fn cache_reads_are_priced_only_on_the_cached_share() {
        let card = RateCard {
            input: dec("5.00"),
            output: dec("25.00"),
            cache_read: Some(dec("0.50")),
            cache_write: Some(dec("6.25")),
            tiers: vec![],
            promo: None,
        };
        let m = model_with(vec![(RateMode::Standard, card)]);
        let workload = Workload {
            input_tokens: 10_000,
            output_tokens: 0,
            requests_per_month: 1,
            cached_pct: 50,
        };
        let breakdown = m.cost_for(&workload, RateMode::Standard).unwrap();
        // 5,000 fresh tokens at $5.00/MTok + 5,000 cached tokens at $0.50/MTok
        assert_eq!(breakdown.input_cost, dec("0.025"));
        assert_eq!(breakdown.cache_cost, dec("0.0025"));
    }
}
