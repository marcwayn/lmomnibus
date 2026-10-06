import { useEffect, useMemo, useRef, useState } from "react";
import { NumberField, U32_MAX } from "../NumberField.tsx";

/**
 * On-topic filler for the streamed preview. Repeats (cycled by index) if the
 * requested output length exceeds its word count. This simulator does not
 * measure any real model — see the copy below the panel.
 */
const SAMPLE_TEXT =
  "Every response from a language model arrives one token at a time. A token is not quite a word and not quite a character — it might be a whole common word, a fragment of a longer one, or a single punctuation mark, and the exact boundary depends on the model's own tokenizer. What you experience as smooth streaming text is really a rapid sequence of small decode steps, each one producing the next token and appending it to what came before. The rate at which those steps happen is throughput, usually reported in tokens per second, and it is one of the most consequential and least visible numbers in choosing a model. A model that costs less per token but streams at a third of the speed can still finish a long response slower and feel less responsive in a live chat, even though the bill at the end of the month is smaller. Throughput depends on more than the model itself: batch size, hardware, quantization, and whether a provider is running a fast-tier variant or a standard one all move the number meaningfully. A model publishing thirty tokens a second under load and a fast-mode variant of the same model publishing eighty are, from a user's chair, two different products. Set a rate below, press start, and watch a paragraph assemble itself at that pace. Fifty tokens a second reads like a person typing quickly. Two hundred reads like the words are already there and merely being unveiled. Five reads like waiting. Once a rate has a feel attached to it, the number on a pricing page stops being abstract.";

const WORDS = SAMPLE_TEXT.split(/\s+/).filter(Boolean);

/**
 * Checks in every 50ms and sets `revealed` from *measured* elapsed time times
 * the requested rate, rather than firing one timer per token. A per-token
 * timer would need sub-5ms intervals at the higher end of the speed range,
 * well below what JS timers reliably deliver (they clamp, especially in
 * backgrounded tabs); driving the reveal off real elapsed time keeps total
 * completion time correct even when individual ticks fire late or coarsely.
 */
const TICK_MS = 50;

export function SpeedTool() {
  const [speed, setSpeed] = useState(60);
  const [outputTokens, setOutputTokens] = useState(300);
  const [running, setRunning] = useState(false);
  const [revealed, setRevealed] = useState(0);
  // The pending tick of the current run. Clearing it is what ends a run, so a
  // quick Stop-then-Start can never leave an old run driving `revealed`.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelRun = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancelRun, []);

  const start = () => {
    if (running) return;
    cancelRun();
    setRevealed(0);
    setRunning(true);
    const tokensPerSec = Math.max(speed, 1);
    const total = outputTokens;
    const startedAt = performance.now();
    const tick = () => {
      const elapsedS = (performance.now() - startedAt) / 1000;
      const target = Math.min(Math.floor(elapsedS * tokensPerSec), total);
      setRevealed(target);
      if (target >= total) {
        timer.current = null;
        setRunning(false);
      } else {
        timer.current = setTimeout(tick, TICK_MS);
      }
    };
    timer.current = setTimeout(tick, TICK_MS);
  };
  const stop = () => {
    cancelRun();
    setRunning(false);
  };
  const reset = () => {
    cancelRun();
    setRunning(false);
    setRevealed(0);
  };

  const streamedText = useMemo(
    () => Array.from({ length: revealed }, (_, i) => WORDS[i % WORDS.length]).join(" "),
    [revealed],
  );

  const started = revealed > 0 || running;
  const rate = Math.max(speed, 1);
  const progressPct = Math.min((revealed / Math.max(outputTokens, 1)) * 100, 100);
  const elapsedS = revealed / rate;
  const totalS = outputTokens / rate;
  const isComplete = !running && revealed > 0 && revealed >= outputTokens;
  const status = running ? "Streaming" : isComplete ? "Done" : revealed > 0 ? "Stopped" : "Idle";

  return (
    <>
      <title>LMOmnibus - Token Speed Simulator</title>
      <div className="tool-head">
        <span className="eyebrow">Simulator</span>
        <h1>Token Speed Simulator</h1>
        <p className="sub">
          Set a throughput and an output length, then watch a response stream at that pace. Streaming speed shapes how a
          model feels to use in a way its price per token never shows you.
        </p>
      </div>

      <section className="section" aria-label="Settings">
        <div className="section-title">
          <h2>Settings</h2>
        </div>
        <div className="inputs-row">
          <NumberField label="Speed · tokens / second" value={speed} onChange={setSpeed} min={5} max={2000} step={5} limit={U32_MAX} disabled={running} />
          <NumberField label="Output length · tokens" value={outputTokens} onChange={setOutputTokens} min={20} max={4000} step={20} limit={U32_MAX} disabled={running} />
        </div>

        <div className="cta-row" style={{ marginTop: 18 }}>
          {running ? (
            <button className="btn btn-primary" onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="btn btn-primary" onClick={start}>
              {started ? "Restart" : "Start simulation"}
            </button>
          )}
          {started && (
            <button className="btn btn-ghost" onClick={reset}>
              Reset
            </button>
          )}
        </div>
      </section>

      <div className="meter section-break" aria-hidden="true" />

      <div className="stream-panel">
        <div className={`stream-box${running ? " running" : ""}`}>
          <p>
            {streamedText}
            {running && <span className="stream-cursor"></span>}
          </p>
          {revealed === 0 && <p className="stream-placeholder">Streamed output will appear here.</p>}
        </div>

        <div className="progress-track">
          <div className="progress-bar" style={{ width: `${progressPct}%` }}></div>
        </div>

        <div className="stream-stats">
          <Stat label="Tokens" value={`${revealed} / ${outputTokens}`} />
          <Stat label="Elapsed" value={`${elapsedS.toFixed(1)}s`} />
          <Stat label="Estimated total" value={`${totalS.toFixed(1)}s`} />
          <Stat label="Status" value={status} />
        </div>
      </div>

      <div className="callout-note">
        <p>
          This simulates a rate you choose — it doesn't measure any real model's live throughput, which varies by
          provider load, batch size, and whether a fast-tier variant is in use. Real-world speeds for hosted models
          commonly range from roughly 15–30 tok/s for large frontier models under load up past 200 tok/s for smaller or
          speed-optimized variants.
        </p>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="il">{label}</span>
      <span className="stat-v">{value}</span>
    </div>
  );
}
