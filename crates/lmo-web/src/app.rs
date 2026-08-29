use leptos::prelude::*;
use leptos_meta::{provide_meta_context, MetaTags, Stylesheet, Title};
use leptos_router::{
    components::{Route, Router, Routes},
    path,
};
use lmo_core::{
    catalog, fmt_money, fmt_rate,
    model::RateMode,
    query::available_years,
    search, CostBreakdown, Model, Query, Workload,
};

use crate::speed::SpeedTool;

pub fn shell(options: leptos::config::LeptosOptions) -> impl IntoView {
    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8"/>
                <meta name="viewport" content="width=device-width, initial-scale=1"/>
                <link rel="preconnect" href="https://fonts.googleapis.com"/>
                <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous"/>
                <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..800&family=IBM+Plex+Mono:wght@400;500;600&family=Public+Sans:wght@400;500;600&display=swap"/>
                <AutoReload options=options.clone() />
                <HydrationScripts options/>
                <MetaTags/>
            </head>
            <body>
                <App/>
            </body>
        </html>
    }
}

#[component]
pub fn App() -> impl IntoView {
    provide_meta_context();

    view! {
        <Stylesheet id="leptos" href="/pkg/lmo-web.css"/>
        <Title text="LMOmnibus"/>
        <Router>
            <TopNav/>
            <main class="shell">
                <Routes fallback=|| view! { <p style="padding:40px 0">"Page not found."</p> }>
                    <Route path=path!("/") view=HomePage/>
                    <Route path=path!("/tools/cost") view=CostTool/>
                    <Route path=path!("/tools/speed") view=SpeedTool/>
                </Routes>
            </main>
        </Router>
    }
}

#[component]
fn TopNav() -> impl IntoView {
    view! {
        <div class="topnav">
            <a class="wordmark" href="/"><span class="lm">"LM"</span>"Omnibus"</a>
            <nav>
                <a href="/tools/cost">"Cost Calculator"</a>
                <a href="/tools/speed">"Speed Simulator"</a>
            </nav>
        </div>
    }
}

#[component]
fn HomePage() -> impl IntoView {
    view! {
        <Title text="LMOmnibus - Instruments for language models"/>
        <header class="masthead">
            <h1 class="wordmark-big"><span class="lm">"LM"</span>"Omnibus"</h1>
            <p class="thesis">"A workbench of instruments for pricing, comparing, and choosing language models."</p>
            <div class="cta-row">
                <a class="btn btn-primary" href="/tools/cost">"Open the Cost Calculator ->"</a>
                <a class="btn btn-ghost" href="/tools/speed">"Try the Speed Simulator"</a>
            </div>
        </header>
    }
}

#[derive(Clone)]
struct SearchView {
    hits: Vec<&'static Model>,
    vendor_counts: Vec<(String, String, u32)>,
    total: u32,
}

fn run_search(text: &str, vendors: &[String], year: Option<i32>) -> SearchView {
    let q = Query {
        text: text.to_string(),
        vendors: vendors.to_vec(),
        released_year: year,
        released_month: None,
        limit: 25,
    };
    let res = search(catalog::all(), &q);
    SearchView {
        hits: res.hits,
        vendor_counts: res.vendor_counts,
        total: res.total_matching,
    }
}

#[component]
fn CostTool() -> impl IntoView {
    let years = available_years(catalog::all());
    let vendor_count = {
        let mut v: Vec<&str> = catalog::all().iter().map(|m| m.vendor_key.as_str()).collect();
        v.sort_unstable();
        v.dedup();
        v.len()
    };

    let query_text = RwSignal::new(String::new());
    let selected_vendors = RwSignal::new(Vec::<String>::new());
    let released_year = RwSignal::new(None::<i32>);
    let bench = RwSignal::new(Vec::<String>::new());

    let input_tokens = RwSignal::new(12_000u32);
    let output_tokens = RwSignal::new(1_800u32);
    let requests_per_month = RwSignal::new(40_000u32);
    let cached_pct = RwSignal::new(0u8);

    let search_view = Signal::derive(move || {
        run_search(&query_text.get(), &selected_vendors.get(), released_year.get())
    });

    let add_to_bench = move |key: String| {
        bench.update(|b| {
            if !b.contains(&key) {
                b.push(key);
            }
        });
    };
    let remove_from_bench = move |key: String| {
        bench.update(|b| b.retain(|k| k != &key));
    };
    let toggle_vendor = move |vk: String| {
        selected_vendors.update(|v| {
            if let Some(pos) = v.iter().position(|x| x == &vk) {
                v.remove(pos);
            } else {
                v.push(vk);
            }
        });
    };

    let bench_costs = Signal::derive(move || {
        let workload = Workload {
            input_tokens: input_tokens.get(),
            output_tokens: output_tokens.get(),
            requests_per_month: requests_per_month.get(),
            cached_pct: cached_pct.get(),
        };
        let mut rows: Vec<(&'static Model, CostBreakdown)> = bench
            .get()
            .iter()
            .filter_map(|k| catalog::by_key(k))
            .filter_map(|m| m.cost_for(&workload, RateMode::Standard).map(|c| (m, c)))
            .collect();
        rows.sort_by_key(|a| a.1.monthly_cost);
        rows
    });

    let cheapest = Signal::derive(move || {
        bench_costs.get().first().map(|(_, c)| c.monthly_cost)
    });

    view! {
        <Title text="LMOmnibus - Cost Calculator"/>
        <div class="tool-head">
            <span class="eyebrow">"Tool 01"</span>
            <h1>"Cost Calculator"</h1>
            <p class="sub">"Search for the models you actually use, add them to the bench, and compare what your workload really costs — including long-context tiers and live promotional rates."</p>
        </div>

        <div class="searchfield">
            <input
                type="text"
                placeholder="Search by model or vendor - try \"opus\" or \"gpt\""
                prop:value=move || query_text.get()
                on:input=move |ev| query_text.set(event_target_value(&ev))
            />
            <span class="count">{move || format!("{} match{}", search_view.get().total, if search_view.get().total == 1 { "" } else { "es" })}</span>
        </div>

        <div class="workload">
            <h2>"Workload"</h2>
            <div class="inputs-row">
                <div class="inp">
                    <span class="il">"Input tokens / request"</span>
                    <input type="number" min="0" step="100"
                        prop:value=move || input_tokens.get().to_string()
                        on:input=move |ev| { if let Ok(v) = event_target_value(&ev).parse() { input_tokens.set(v); } }
                    />
                </div>
                <div class="inp">
                    <span class="il">"Output tokens / request"</span>
                    <input type="number" min="0" step="100"
                        prop:value=move || output_tokens.get().to_string()
                        on:input=move |ev| { if let Ok(v) = event_target_value(&ev).parse() { output_tokens.set(v); } }
                    />
                </div>
                <div class="inp">
                    <span class="il">"Requests / month"</span>
                    <input type="number" min="0" step="1000"
                        prop:value=move || requests_per_month.get().to_string()
                        on:input=move |ev| { if let Ok(v) = event_target_value(&ev).parse() { requests_per_month.set(v); } }
                    />
                </div>
                <div class="inp">
                    <span class="il">"Cached input %"</span>
                    <input type="number" min="0" max="100" step="5"
                        prop:value=move || cached_pct.get().to_string()
                        on:input=move |ev| { if let Ok(v) = event_target_value(&ev).parse::<u8>() { cached_pct.set(v.min(100)); } }
                    />
                </div>
            </div>
        </div>

        <div class="filters-row">
            <div class="filter-group">
                <span class="filter-label">"Released"</span>
                <select on:change=move |ev| {
                    let v = event_target_value(&ev);
                    released_year.set(if v.is_empty() { None } else { v.parse().ok() });
                }>
                    <option value="">"Any year"</option>
                    {years.iter().map(|y| {
                        let y = *y;
                        view! { <option value=y.to_string()>{y.to_string()}</option> }
                    }).collect_view()}
                </select>
            </div>
        </div>

        <div class="chips">
            {move || {
                let sv = search_view.get();
                let selected = selected_vendors.get();
                sv.vendor_counts.into_iter().take(10).enumerate().map(|(i, (vk, vn, count))| {
                    let is_on = selected.contains(&vk);
                    let vk_click = vk.clone();
                    let variant = format!("chip p{}", (i % 4) + 1);
                    view! {
                        <button
                            type="button"
                            class=variant
                            class:on=is_on
                            aria-pressed=is_on
                            on:click=move |_| toggle_vendor(vk_click.clone())
                        >
                            {format!("{vn} {count}")}
                        </button>
                    }
                }).collect_view()
            }}
        </div>

        <div class="results">
            <div class="res-row hdr">
                <span>"Model"</span>
                <span class="n">"Released"</span>
                <span class="n">"In /MTok"</span>
                <span class="n out-rate">"Out /MTok"</span>
                <span></span>
            </div>
            <For
                each=move || search_view.get().hits
                key=|m| m.key.clone()
                let:model
            >
                {
                    let key_for_click = model.key.clone();
                    let std_rate = model.standard();
                    let name_for_label = model.display_name.clone();
                    view! {
                        <button
                            type="button"
                            class="res-row"
                            aria-label=format!("Add {name_for_label} to bench")
                            on:click=move |_| add_to_bench(key_for_click.clone())
                        >
                            <span>
                                <span class="nm">{model.display_name.clone()}</span>
                                <span class="vd">{model.vendor_name.clone()}</span>
                            </span>
                            <span class="n">{model.released.as_year_month()}</span>
                            <span class="n">{fmt_rate(std_rate.input)}</span>
                            <span class="n out-rate">{fmt_rate(std_rate.output)}</span>
                            <span class="add">"+"</span>
                        </button>
                    }
                }
            </For>
            <Show when=move || search_view.get().hits.is_empty()>
                <div class="empty-note">"No models match. Try a different name, vendor, or year."</div>
            </Show>
        </div>

        <div class="bench-head">
            <h2>{move || format!("Bench ({})", bench.get().len())}</h2>
            <Show when=move || !bench.get().is_empty()>
                <button class="clear" on:click=move |_| bench.set(Vec::new())>"Clear bench"</button>
            </Show>
        </div>

        <Show
            when=move || !bench.get().is_empty()
            fallback=|| view! { <div class="empty-bench">"Search above and add a model to see what it costs."</div> }
        >
            <div class="bench-grid">
                <For
                    each=move || bench_costs.get()
                    key=|(m, _)| m.key.clone()
                    let:row
                >
                    {
                        let (model, breakdown) = row;
                        let is_cheapest = cheapest.get() == Some(breakdown.monthly_cost);
                        let key_for_remove = model.key.clone();
                        let delta = cheapest.get().map(|c| breakdown.monthly_cost - c);
                        view! {
                            <div class="bench-card" class:best=is_cheapest>
                                <button class="rm" on:click=move |_| remove_from_bench(key_for_remove.clone())>"x"</button>
                                <div class="bn">{model.display_name.clone()}</div>
                                <div class="bv">{format!("{} - {}", model.vendor_name, model.released.as_year_month())}</div>
                                <div class="figure-big">{fmt_money(breakdown.monthly_cost)}<span class="figure-unit">"/mo"</span></div>
                                {move || {
                                    if is_cheapest {
                                        view! { <div class="delta down">"cheapest on bench"</div> }.into_any()
                                    } else if let Some(d) = delta {
                                        view! { <div class="delta up">{format!("+{} vs cheapest", fmt_money(d))}</div> }.into_any()
                                    } else {
                                        view! { <div></div> }.into_any()
                                    }
                                }}
                                <Show when=move || breakdown.tier_crossed>
                                    <div class="tier-badge">"long-context tier applied"</div>
                                </Show>
                                <Show when=move || breakdown.uses_promo>
                                    <div class="promo-badge">{format!("promo rate - list is {}/{}", fmt_rate(model.standard().list_input()), fmt_rate(model.standard().list_output()))}</div>
                                </Show>
                            </div>
                        }
                    }
                </For>
            </div>
        </Show>

        <div class="foot">
            <span class="mono">{format!("{} models tracked", catalog::all().len())}</span>
            <span class="mono">{format!("{} vendors", vendor_count)}</span>
            <span>"Built in Rust with Leptos"</span>
        </div>
    }
}
