use rust_decimal::Decimal;

fn group_thousands(digits: &str) -> String {
    let rev: Vec<char> = digits.chars().rev().collect();
    let mut out = String::new();
    for (i, c) in rev.iter().enumerate() {
        if i > 0 && i % 3 == 0 {
            out.push(',');
        }
        out.push(*c);
    }
    out.chars().rev().collect()
}

/// A dollar amount for display, grouped with commas: `$4,200.00`.
pub fn fmt_money(d: Decimal) -> String {
    let rounded = d.round_dp(2);
    let neg = rounded.is_sign_negative();
    let s = format!("{:.2}", rounded.abs());
    let (int_part, dec_part) = s.split_once('.').unwrap_or((s.as_str(), "00"));
    format!(
        "{}${}.{}",
        if neg { "-" } else { "" },
        group_thousands(int_part),
        dec_part
    )
}

/// A per-MTok rate for display: trimmed to the shortest representation that
/// keeps at least 2 decimals, so `$0.30` stays `$0.30` but a rate as fine as
/// `$0.022` isn't rounded away to `$0.02`.
pub fn fmt_rate(d: Decimal) -> String {
    let rounded = d.round_dp(4);
    let s = format!("{:.4}", rounded);
    let trimmed = s.trim_end_matches('0');
    let s = match trimmed.strip_suffix('.') {
        Some(head) => format!("{head}.00"),
        None => match trimmed.split_once('.') {
            Some((_, dec)) if dec.len() < 2 => format!("{trimmed}{}", "0".repeat(2 - dec.len())),
            Some(_) => trimmed.to_string(),
            None => format!("{trimmed}.00"),
        },
    };
    format!("${s}")
}

/// A plain integer for display, grouped with commas: `40,000`.
pub fn fmt_int(n: u32) -> String {
    group_thousands(&n.to_string())
}
