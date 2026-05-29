/* audio.js — procedural cinematic sound for Bhumi.
 * No audio files: everything is synthesized with the Web Audio API.
 * - ambient drone whose mood tracks Earth health
 * - Earth heartbeat (fast & anxious when dying, slow & calm when healthy)
 * - one-shot SFX: thunder, wind, forest chime, impact, boss roar, restore
 * Degrades silently if Web Audio is unavailable.
 */
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.droneNodes = null;
    this.heartTimer = null;
    this.heartRate = 1.1;      // seconds between beats
    this.enabled = false;
    this.voice = null;
    this.voiceReady = false;
    this._loadVoice();
  }

  start() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.0;
      this.master.connect(this.ctx.destination);
      this.master.gain.linearRampToValueAtTime(0.9, this.ctx.currentTime + 2.0);
      this.noiseBuffer = this._makeNoise(2.0);
      this.enabled = true;
      this._startDrone();
      this._scheduleHeartbeat();
    } catch (e) {
      console.warn("Audio unavailable:", e);
      this.enabled = false;
    }
  }

  // ---- AI voice narration (Web Speech API, FEMALE) -------------------------
  // Picks a warm, cinematic female English voice. Voices load asynchronously
  // so we re-query on `voiceschanged`.
  //
  // IMPORTANT (Chrome on Windows): network-backed "Google …" voices are often
  // SILENT on a local page — they were preferred first, which is why narration
  // never spoke. We now strongly prefer LOCAL voices (localService === true,
  // e.g. "Microsoft Aria/Jenny/Zira"), which always play offline.
  _loadVoice() {
    if (!("speechSynthesis" in window)) return;
    const pick = () => {
      const voices = speechSynthesis.getVoices();
      if (!voices.length) return;
      const isEn = (v) => /^en\b/i.test(v.lang) || /english/i.test(v.name);
      const isFemale = (v) => /(female|aria|jenny|michelle|ana|sonia|libby|emma|clara|olivia|zira|hazel|samantha|karen|tessa|moira|fiona|susan|allison|ava|serena|victoria)/i.test(v.name);
      const local = voices.filter((v) => v.localService);
      // Best → worst: local English female, local English, any English female,
      // any English, any local voice, anything at all.
      const ranked = [
        ...local.filter((v) => isEn(v) && isFemale(v)),
        ...local.filter((v) => isEn(v)),
        ...voices.filter((v) => isEn(v) && isFemale(v)),
        ...voices.filter((v) => isEn(v)),
        ...local,
        ...voices,
      ];
      this.voice = ranked[0] || voices[0];
      this.voiceReady = true;
    };
    pick();
    speechSynthesis.onvoiceschanged = pick;
  }

  /** Unlock TTS from inside a real user gesture (the BEGIN click).
   * Chrome blocks speechSynthesis that isn't kicked off by a user gesture; the
   * first narration line fires seconds later (during calibration) and would be
   * silently dropped. Speaking a near-silent priming utterance here unlocks it. */
  unlockVoice() {
    if (!("speechSynthesis" in window)) return;
    try {
      speechSynthesis.resume();
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      if (this.voice) u.voice = this.voice;
      speechSynthesis.speak(u);
    } catch (e) { /* silent fail */ }
  }

  /** Speak a narration line with a warm, cinematic female delivery. */
  speak(text) {
    if (!("speechSynthesis" in window)) return;
    try {
      // cancel any in-flight line so the latest narration always wins
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.rate = 0.90;     // slow, deliberate
      u.pitch = 1.05;    // gentle female register, not chirpy
      u.volume = 1.0;
      // Chrome sometimes leaves the queue paused/stalled — resume before AND
      // shortly after speaking so the utterance actually plays.
      speechSynthesis.resume();
      speechSynthesis.speak(u);
      setTimeout(() => { try { speechSynthesis.resume(); } catch (e) {} }, 120);
    } catch (e) { /* silent fail */ }
  }

  stopSpeak() {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  _makeNoise(seconds) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _noiseSource() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuffer;
    s.loop = true;
    return s;
  }

  // ---- continuous ambient drone -------------------------------------------
  _startDrone() {
    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.value = 0.18;
    out.connect(this.master);

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    filter.connect(out);

    const base = 55; // A1
    const oscs = [];
    [1, 1.5, 2.01, 2.5].forEach((mult, i) => {
      const o = this.ctx.createOscillator();
      o.type = i % 2 ? "sawtooth" : "sine";
      o.frequency.value = base * mult;
      o.detune.value = (i - 1.5) * 6;
      const g = this.ctx.createGain();
      g.gain.value = i === 0 ? 0.5 : 0.22;
      o.connect(g).connect(filter);
      o.start(t);
      oscs.push(o);
    });

    // slow shimmer LFO on the filter
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start(t);

    this.droneNodes = { out, filter, oscs, lfo };
  }

  /** mood in [0,1]: 0 = dying/ominous, 1 = healthy/warm. */
  setMood(frac) {
    if (!this.enabled || !this.droneNodes) return;
    const t = this.ctx.currentTime;
    const f = 320 + frac * 1100;
    this.droneNodes.filter.frequency.setTargetAtTime(f, t, 1.5);
    this.droneNodes.oscs.forEach((o, i) => {
      const lift = frac * 12; // brighten as the world heals
      o.detune.setTargetAtTime((i - 1.5) * 6 + lift, t, 1.5);
    });
    // healthy world -> slow calm beat (~1.4s); dying world -> fast anxious beat (~0.55s)
    this.heartRate = 0.55 + frac * 0.85;
  }

  // ---- Earth heartbeat -----------------------------------------------------
  _scheduleHeartbeat() {
    if (!this.enabled) return;
    const beat = () => {
      this._thump(70, 0.5);
      setTimeout(() => this._thump(58, 0.32), 170); // double-thump
      this.heartTimer = setTimeout(beat, this.heartRate * 1000);
    };
    beat();
  }

  _thump(freq, gain) {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.18);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.34);
  }

  // ---- one-shot SFX --------------------------------------------------------
  thunder() {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const src = this._noiseSource();
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 1.1);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.85, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 1.4);
  }

  wind() {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const src = this._noiseSource();
    const f = this.ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(500, t);
    f.frequency.linearRampToValueAtTime(1400, t + 0.5);
    f.frequency.linearRampToValueAtTime(400, t + 1.1);
    f.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.25);
    g.gain.linearRampToValueAtTime(0.0001, t + 1.1);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 1.2);
  }

  forest() {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const notes = [330, 440, 550, 660, 880]; // rising, hopeful arpeggio
    notes.forEach((n, i) => {
      const o = this.ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = n;
      const g = this.ctx.createGain();
      const st = t + i * 0.08;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.25, st + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.5);
      o.connect(g).connect(this.master);
      o.start(st);
      o.stop(st + 0.55);
    });
  }

  impact() {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    // low boom
    const o = this.ctx.createOscillator();
    o.type = "square";
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.7, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.32);
    // noise crack
    const src = this._noiseSource();
    const f = this.ctx.createBiquadFilter();
    f.type = "highpass"; f.frequency.value = 900;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.5, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    src.connect(f).connect(ng).connect(this.master);
    src.start(t); src.stop(t + 0.22);
  }

  bossRoar() {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const o1 = this.ctx.createOscillator();
    const o2 = this.ctx.createOscillator();
    o1.type = "sawtooth"; o2.type = "sawtooth";
    o1.frequency.setValueAtTime(90, t);
    o2.frequency.setValueAtTime(94, t);
    o1.frequency.exponentialRampToValueAtTime(45, t + 1.4);
    o2.frequency.exponentialRampToValueAtTime(47, t + 1.4);
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 600;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    o1.connect(f); o2.connect(f); f.connect(g).connect(this.master);
    o1.start(t); o2.start(t); o1.stop(t + 1.7); o2.stop(t + 1.7);
  }

  restore() {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const chord = [261.6, 329.6, 392.0, 523.3]; // C major, triumphant
    chord.forEach((n) => {
      const o = this.ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = n;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.1);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + 2.5);
    });
  }
}

const audio = new AudioEngine();
// audio.js is a classic script; game.js is an ES module with its own scope.
// Expose the engine on window so the module can reach it.
window.audio = audio;
