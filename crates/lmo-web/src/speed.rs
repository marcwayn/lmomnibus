use leptos::prelude::*;
use leptos_meta::Title;

/// On-topic filler for the streamed preview. Repeats (cycled by index) if
/// the requested output length exceeds its word count. This simulator does
/// not measure any real model — see the copy below the panel.
const SAMPLE_TEXT: &str = "Every response from a language model arrives one token at a time. A token is not quite a word and not quite a character — it might be a whole common word, a fragment of a longer one, or a single punctuation mark, and the exact boundary depends on the model's own tokenizer. What you experience as smooth streaming text is really a rapid sequence of small decode steps, each one producing the next token and appending it to what came before. The rate at which those steps happen is throughput, usually reported in tokens per second, and it is one of the most consequential and least visible numbers in choosing a model. A model that costs less per token but streams at a third of the speed can still finish a long response slower and feel less responsive in a live chat, even though the bill at the end of the month is smaller. Throughput depends on more than the model itself: batch size, hardware, quantization, and whether a provider is running a fast-tier variant or a standard one all move the number meaningfully. A model publishing thirty tokens a second under load and a fast-mode variant of the same model publishing eighty are, from a user's chair, two different products. Set a rate below, press start, and watch a paragraph assemble itself at that pace. Fifty tokens a second reads like a person typing quickly. Two hundred reads like the words are already there and merely being unveiled. Five reads like waiting. Once a rate has a feel attached to it, the number on a pricing page stops being abstract.";

fn sample_words() -> Vec<&'static str> {
    SAMPLE_TEXT.split_whitespace().collect()
}

/// Checks in every 50ms and sets `revealed` from *measured* wall-clock time
/// times the requested rate, rather than firing one timer per token. A
/// per-token timer would need sub-5ms intervals at the higher end of the
/// speed range, well below what JS timers reliably deliver (they clamp,
/// especially in backgrounded tabs); driving the reveal off real elapsed
/// time keeps total completion time correct even when individual ticks
/// fire late or coarsely.
#[cfg(feature = "hydrate")]
async fn run_ticker(running: RwSignal<bool>, revealed: RwSignal<usize>, total: usize, tokens_per_sec: f64) {
    const TICK_MS: u32 = 50;
    let start = js_sys::Date::now();
    loop {
        if !running.get_untracked() {
            return;
        }
        gloo_timers::future::TimeoutFuture::new(TICK_MS).await;
        if !running.get_untracked() {
            return;
        }
        let elapsed_s = (js_sys::Date::now() - start) / 1000.0;
        let target = ((elapsed_s * tokens_per_sec).floor() as usize).min(total);
        revealed.set(target);
        if target >= total {
            break;
        }
    }
    running.set(false);
}

#[cfg(not(feature = "hydrate"))]
async fn run_ticker(_running: RwSignal<bool>, _revealed: RwSignal<usize>, _total: usize, _tokens_per_sec: f64) {}

#[component]
pub fn SpeedTool() -> impl IntoView {
    let speed = RwSignal::new(60u32);
    let output_tokens = RwSignal::new(300u32);
    let running = RwSignal::new(false);
    let revealed = RwSignal::new(0usize);

    let started = move || revealed.get() > 0 || running.get();

    let start = move |_| {
        if running.get() {
            return;
        }
        revealed.set(0);
        running.set(true);
        let tokens_per_sec = speed.get().max(1) as f64;
        let total = output_tokens.get() as usize;
        leptos::task::spawn_local(run_ticker(running, revealed, total, tokens_per_sec));
    };
    let stop = move |_| running.set(false);
    let reset = move |_| {
        running.set(false);
        revealed.set(0);
    };

    let words = sample_words();
    let word_count = words.len();

    let streamed_text = move || {
        let n = revealed.get();
        (0..n)
            .map(|i| words[i % word_count])
            .collect::<Vec<_>>()
            .join(" ")
    };

    let progress_pct = move || {
        let total = output_tokens.get().max(1) as f64;
        (revealed.get() as f64 / total * 100.0).min(100.0)
    };
    let elapsed_s = move || revealed.get() as f64 / speed.get().max(1) as f64;
    let total_s = move || output_tokens.get() as f64 / speed.get().max(1) as f64;
    let is_complete = move || {
        !running.get() && revealed.get() > 0 && revealed.get() as u32 >= output_tokens.get()
    };

    view! {
        <Title text="LMOmnibus - Token Speed Simulator"/>
        <div class="tool-head">
            <span class="eyebrow">"Simulator"</span>
            <h1>"Token Speed Simulator"</h1>
            <p class="sub">"Set a throughput and an output length, then watch a response stream at that pace. Streaming speed shapes how a model feels to use in a way its price per token never shows you."</p>
        </div>

        <div class="workload">
            <h2>"Settings"</h2>
            <div class="inputs-row">
                <div class="inp">
                    <span class="il">"Speed - tokens / second"</span>
                    <input type="number" min="5" max="2000" step="5"
                        disabled=move || running.get()
                        prop:value=move || speed.get().to_string()
                        on:input=move |ev| { if let Ok(v) = event_target_value(&ev).parse() { speed.set(v); } }
                    />
                </div>
                <div class="inp">
                    <span class="il">"Output length - tokens"</span>
                    <input type="number" min="20" max="4000" step="20"
                        disabled=move || running.get()
                        prop:value=move || output_tokens.get().to_string()
                        on:input=move |ev| { if let Ok(v) = event_target_value(&ev).parse() { output_tokens.set(v); } }
                    />
                </div>
            </div>

            <div class="cta-row" style="margin-top:18px">
                <Show
                    when=move || running.get()
                    fallback=move || view! {
                        <button class="btn btn-primary" on:click=start>
                            {move || if started() { "Restart" } else { "Start simulation" }}
                        </button>
                    }
                >
                    <button class="btn btn-primary" on:click=stop>"Stop"</button>
                </Show>
                <Show when=move || started()>
                    <button class="btn btn-ghost" on:click=reset>"Reset"</button>
                </Show>
            </div>
        </div>

        <div class="stream-panel">
            <div class="stream-box" class:running=move || running.get()>
                <p>
                    {streamed_text}
                    <Show when=move || running.get()>
                        <span class="stream-cursor"></span>
                    </Show>
                </p>
                <Show when=move || revealed.get() == 0>
                    <p class="stream-placeholder">"Streamed output will appear here."</p>
                </Show>
            </div>

            <div class="progress-track">
                <div class="progress-bar" style:width=move || format!("{}%", progress_pct())></div>
            </div>

            <div class="stream-stats">
                <div class="stat">
                    <span class="il">"Tokens"</span>
                    <span class="stat-v">{move || format!("{} / {}", revealed.get(), output_tokens.get())}</span>
                </div>
                <div class="stat">
                    <span class="il">"Elapsed"</span>
                    <span class="stat-v">{move || format!("{:.1}s", elapsed_s())}</span>
                </div>
                <div class="stat">
                    <span class="il">"Estimated total"</span>
                    <span class="stat-v">{move || format!("{:.1}s", total_s())}</span>
                </div>
                <div class="stat">
                    <span class="il">"Status"</span>
                    <span class="stat-v">
                        {move || if running.get() { "Streaming" } else if is_complete() { "Done" } else if revealed.get() > 0 { "Stopped" } else { "Idle" }}
                    </span>
                </div>
            </div>
        </div>

        <div class="callout-note">
            <p>"This simulates a rate you choose - it doesn't measure any real model's live throughput, which varies by provider load, batch size, and whether a fast-tier variant is in use. Real-world speeds for hosted models commonly range from roughly 15-30 tok/s for large frontier models under load up past 200 tok/s for smaller or speed-optimized variants."</p>
        </div>
    }
}
