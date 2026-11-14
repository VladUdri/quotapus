// The promo's soundtrack, composed in code (Web Audio, rendered offline), so there's no licensing question.
// Synced to the scene marks the stage reports: tense pad under the hook, a sting when the limit hits,
// a riser into the logo, then a warm 100 BPM groove (Bm - G - D - A) that resolves on D over the end card.
// marks: { err, logo, desk, trust, cta } in seconds; dur = video length in seconds.
async function renderMusic(dur, marks, sampleRate = 48000) {
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * sampleRate), sampleRate);
  const hz = (m) => 440 * 2 ** ((m - 69) / 12);
  const BEAT = 60 / 100, BAR = 4 * BEAT;
  const T0 = marks.logo ?? 8;                    // the groove's first downbeat lands on the logo
  const END = dur, OUT = marks.cta ?? dur - 5;   // drums stop at the end card

  // ---- mix bus: a little compression, a reverb send, a dotted-8th delay for the plucks ----
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2;
  const master = ctx.createGain(); master.gain.value = 0.9;
  comp.connect(master).connect(ctx.destination);
  const verb = ctx.createConvolver();
  verb.buffer = (() => { // 2.8 s of decaying stereo noise = a soft hall
    const n = Math.floor(2.8 * sampleRate), b = ctx.createBuffer(2, n, sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3.2; }
    return b;
  })();
  const verbIn = ctx.createGain(); verbIn.gain.value = 0.55; verbIn.connect(verb).connect(comp);
  const delay = ctx.createDelay(1); delay.delayTime.value = BEAT * 0.75;
  const fb = ctx.createGain(); fb.gain.value = 0.32;
  const dlp = ctx.createBiquadFilter(); dlp.type = "lowpass"; dlp.frequency.value = 2600;
  delay.connect(dlp).connect(fb).connect(delay);
  const delayOut = ctx.createGain(); delayOut.gain.value = 0.35; dlp.connect(delayOut).connect(comp);
  const bus = (gain, { rev = 0.2, echo = 0, pan = 0 } = {}) => {
    const g = ctx.createGain(); g.gain.value = gain;
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    g.connect(p); p.connect(comp);
    if (rev) { const s = ctx.createGain(); s.gain.value = rev; p.connect(s).connect(verbIn); }
    if (echo) { const s = ctx.createGain(); s.gain.value = echo; p.connect(s).connect(delay); }
    return g;
  };
  const noise = (() => { const n = 2 * sampleRate, b = ctx.createBuffer(1, n, sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; return b; })();
  const env = (g, t, a, peak, hold, rel) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.setValueAtTime(peak, t + a + hold); g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel); };

  // ---- instruments ----
  const padOut = bus(0.16, { rev: 0.5 });
  function pad(notes, t, len, { cutoff = 1400, sweepTo = null, gain = 1 } = {}) {
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.Q.value = 0.7;
    f.frequency.setValueAtTime(cutoff, t); if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + len);
    const g = ctx.createGain(); f.connect(g).connect(padOut);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + Math.min(0.8, len / 3));
    g.gain.setValueAtTime(gain, t + len - 0.3); g.gain.linearRampToValueAtTime(0, t + len + 0.6);
    for (const m of notes) for (const det of [-7, 7]) { // two detuned saws per note
      const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = hz(m); o.detune.value = det;
      const og = ctx.createGain(); og.gain.value = 0.18 / notes.length; o.connect(og).connect(f); o.start(t); o.stop(t + len + 0.7);
    }
  }
  const pluckOut = bus(0.11, { rev: 0.3, echo: 0.6, pan: 0.15 });
  function pluck(m, t, v = 1) {
    const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = hz(m);
    const o2 = ctx.createOscillator(); o2.type = "square"; o2.frequency.value = hz(m); const g2 = ctx.createGain(); g2.gain.value = 0.18;
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.setValueAtTime(4200, t); f.frequency.exponentialRampToValueAtTime(700, t + 0.25);
    const g = ctx.createGain(); env(g, t, 0.004, v, 0, 0.32);
    o.connect(f); o2.connect(g2).connect(f); f.connect(g).connect(pluckOut);
    o.start(t); o2.start(t); o.stop(t + 0.4); o2.stop(t + 0.4);
  }
  const bassOut = bus(0.3, { rev: 0 });
  function bass(m, t, len) {
    const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = hz(m);
    const sub = ctx.createOscillator(); sub.type = "sine"; sub.frequency.value = hz(m - 12);
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(260, t + len);
    const g = ctx.createGain(); env(g, t, 0.006, 0.8, len * 0.5, len * 0.5);
    o.connect(f); sub.connect(f); f.connect(g).connect(bassOut);
    o.start(t); sub.start(t); o.stop(t + len + 0.05); sub.stop(t + len + 0.05);
  }
  const drumOut = bus(0.55, { rev: 0.08 });
  function kick(t, v = 1) {
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain(); env(g, t, 0.002, v, 0.02, 0.32); o.connect(g).connect(drumOut); o.start(t); o.stop(t + 0.4);
  }
  function hiss(t, { type = "highpass", freq = 8000, q = 0.7, v = 0.2, rel = 0.04, out = drumOut } = {}) {
    const s = ctx.createBufferSource(); s.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); env(g, t, 0.002, v, 0, rel); s.connect(f).connect(g).connect(out); s.start(t, Math.random()); s.stop(t + rel + 0.05);
  }
  const clap = (t, v = 0.5) => { for (const d of [0, 0.011, 0.022]) hiss(t + d, { type: "bandpass", freq: 1600, q: 1.2, v, rel: d ? 0.03 : 0.17 }); };

  // ---- 1. hook: dark B minor pad opening up, a soft pulse, a sting at the error, a riser into the logo ----
  pad([47, 54, 59, 62], 0, T0, { cutoff: 320, sweepTo: 1600, gain: 1.7 });
  for (let t = 0.6; t < T0 - 0.3; t += BEAT) hiss(t, { v: 0.05, rel: 0.03, freq: 9000 }); // clock-like ticking
  for (let t = BEAT * 2; t < T0 - BEAT; t += BEAT * 2) kick(t, 0.28);                   // heartbeat
  if (marks.err) { // the limit hits: low thud + dissonant cluster
    kick(marks.err, 0.9);
    pad([46, 53, 59, 60], marks.err, 1.6, { cutoff: 900, gain: 0.7 });
  }
  { // riser: filtered noise sweeping up for the last ~2 s before the logo
    const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 2; f.frequency.setValueAtTime(400, T0 - 2.2); f.frequency.exponentialRampToValueAtTime(7000, T0);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, T0 - 2.2); g.gain.linearRampToValueAtTime(0.22, T0 - 0.02); g.gain.linearRampToValueAtTime(0, T0);
    s.connect(f).connect(g).connect(bus(1, { rev: 0.4 })); s.start(T0 - 2.2); s.stop(T0 + 0.05);
  }
  // impact on the logo
  kick(T0, 1.1); hiss(T0, { freq: 3000, v: 0.25, rel: 1.6, out: bus(0.8, { rev: 0.7 }) });

  // ---- 2. groove ----
  const prog = [ // [bass root, pad voicing, arp tones]
    [35, [62, 66, 71], [71, 74, 78, 83]],   // Bm
    [31, [59, 62, 67], [67, 71, 74, 79]],   // G
    [38, [57, 62, 66], [69, 74, 78, 81]],   // D
    [33, [57, 61, 64], [69, 73, 76, 81]],   // A
  ];
  const ARP = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 3, 1, 2];
  const trust = marks.trust ?? OUT - 4;
  for (let bar = 0, t = T0; t < OUT; bar++, t += BAR) {
    const [root, voicing, tones] = prog[bar % 4];
    const full = t >= (marks.desk ?? T0) - 0.01;      // the logo gets an intro: pad, bass, arp; drums from the demo on
    pad(voicing, t, BAR, { cutoff: full ? 2200 : 1500 });
    for (let i = 0; i < 8; i++) {
      const tt = t + i * BEAT / 2; if (tt >= OUT) break;
      if (i % 2 === 0 || full) bass(i % 4 === 3 ? root + 12 : root, tt, BEAT / 2 * 0.9);
    }
    for (let i = 0; i < 16; i++) {
      const tt = t + i * BEAT / 4; if (tt >= OUT) break;
      if (full || i % 2 === 0) pluck(tones[ARP[i]], tt, i % 4 === 0 ? 1 : 0.65);
    }
    for (let b = 0; b < 4; b++) {
      const tt = t + b * BEAT; if (tt >= OUT) break;
      if (full) {
        kick(tt, b === 0 ? 1 : 0.85);
        if (b % 2 === 1) clap(tt, tt >= trust ? 0.45 : 0.35);
        hiss(tt + BEAT / 2, { v: 0.16, rel: 0.05 });
        hiss(tt, { v: 0.07, rel: 0.03 });
        if (tt >= trust) { hiss(tt + BEAT / 4, { v: 0.06, rel: 0.03 }); hiss(tt + 3 * BEAT / 4, { v: 0.06, rel: 0.03 }); }
      } else if (b === 0) kick(tt, 0.7);
    }
  }
  // ---- 3. end card: resolve on D major, a slow arp, ring out ----
  kick(OUT, 0.9); hiss(OUT, { freq: 3000, v: 0.18, rel: 1.8, out: bus(0.8, { rev: 0.7 }) });
  bass(38, OUT, 2.5);
  pad([50, 57, 62, 66, 69], OUT, END - OUT, { cutoff: 2800, sweepTo: 1100, gain: 3.2 });
  pad([38, 45, 50], OUT, END - OUT, { cutoff: 700, gain: 2 }); // low D drone under it
  [74, 78, 81, 86, 81, 78, 74, 78].forEach((m, i) => { const t = OUT + 0.3 + i * BEAT * 0.75; if (t < END - 1.2) pluck(m, t, 1 - i * 0.07); });
  // fade out over the last 2.5 s
  master.gain.setValueAtTime(0.9, END - 2.5); master.gain.linearRampToValueAtTime(0, END);

  const buf = await ctx.startRendering();
  // normalize to -1 dBFS and fade in the first 30 ms (no click)
  let peak = 0; for (let c = 0; c < 2; c++) for (const x of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(x));
  const k = peak ? 0.89 / peak : 1;
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k * Math.min(1, i / (0.03 * sampleRate)); }
  return buf;
}
