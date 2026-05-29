/* game.js — Bhumi · AI environmental experience.
 * Renders a dying -> healing -> thriving Earth driven by four restorative
 * powers: Rain, Forest, Wind (carbon-zero), Crop/Warm. Trees and crops grow
 * persistently on the rotating globe.
 *
 * 100% browser — no server. Hand gestures are detected IN THE BROWSER with
 * MediaPipe HandLandmarker (Tasks Vision), fed straight from getUserMedia.
 * Keys 1-4 (or R/F/W/A) work as a fallback when no camera is available.
 */
import {
  HandLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs";

(() => {
  "use strict";

  const audio = window.audio; // engine defined by audio.js (classic script)

  // ----------------------------------------------------------------- canvas
  const canvas = document.getElementById("scene");
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, DPR = 1;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
  }
  window.addEventListener("resize", resize);
  resize();

  // ----------------------------------------------------------------- utils
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const E = () => ({ cx: W / 2, cy: H * 0.46, R: Math.min(W, H) * 0.17 });

  // ----------------------------------------------------------------- state
  const state = {
    phase: "start",     // start | playing | ending
    started: false,
    health: 5,          // start lower → heavier initial pollution feel
    time: 0,
    elapsed: 0,
    shake: 0,
    flash: 0,           // lightning flash alpha
    moodTimer: 0,
    crack: 0,           // 0..1 cracked-atmosphere intensity (rises as health falls)
    birdT: 0,           // bird spawn accumulator (healthy state)
    sunPulse: 0,        // sunlight bloom pulse (healthy state)
    seq: 0,             // per-gesture sequence (for HUD #N)
    lastGesture: null,
    lastConf: 0,
    // Carbon emission readout: a smooth value tied to inverse vitality, in ppm.
    // Wind blast briefly forces it to 0 ("CARBON EMISSION: ZERO") for cinematic effect.
    carbonPpm: 480,
    carbonOverride: 0,  // seconds remaining on a wind-forced zero override
    // Living forest/crop sprites painted on the globe (latlon + size + kind)
    flora: [],
  };

  let earthRot = 0, cloudRot = 0, smokeAcc = 0;

  // ----------------------------------------------------------------- scenery data
  const stars = [];
  for (let i = 0; i < 220; i++) {
    stars.push({ x: Math.random(), y: Math.random(), r: rand(0.4, 1.6), tw: rand(0, TAU), sp: rand(0.5, 2) });
  }
  const land = [];
  for (let i = 0; i < 18; i++) {
    land.push({ lon: rand(0, TAU), lat: rand(-1.2, 1.2), size: rand(0.18, 0.4) });
  }
  const fireSpots = [];
  for (let i = 0; i < 6; i++) {
    fireSpots.push({ lon: rand(0, TAU), lat: rand(-0.9, 0.9), size: rand(0.12, 0.22) });
  }
  const clouds = [];
  for (let i = 0; i < 7; i++) {
    clouds.push({ lon: rand(0, TAU), lat: rand(-0.8, 0.8), size: rand(0.25, 0.5) });
  }
  // cracked-atmosphere fissures, only drawn when health < 25%
  const cracks = [];
  for (let i = 0; i < 9; i++) {
    const segs = [];
    let a = rand(0, TAU);
    for (let j = 0; j < 6; j++) {
      segs.push({ a, r: 1.02 + j * 0.06 + rand(-0.03, 0.03) });
      a += rand(-0.18, 0.18);
    }
    cracks.push({ start: rand(0, TAU), segs });
  }
  // birds (V flocks) drawn when Earth is thriving
  const birds = [];

  // ----------------------------------------------------------------- particles
  const P = [];
  const MAX_P = 520;
  function push(p) { if (P.length < MAX_P) P.push(p); }

  function spawnRain() {
    state.flash = 0.85;
    state.shake = Math.max(state.shake, 9);
    audio.thunder();
    for (let i = 0; i < 150; i++) {
      push({ type: "rain", x: rand(0, W), y: rand(-H, 0), vx: -30, vy: rand(950, 1350),
             life: 2.2, max: 2.2, size: rand(9, 20), col: [150, 200, 255] });
    }
    const g = E();
    clouds.forEach((c) => (c.boost = 1));
    for (let i = 0; i < 18; i++) {
      push({ type: "cloudpuff", x: g.cx + rand(-g.R, g.R), y: g.cy - g.R * rand(1.0, 1.5),
             vx: rand(-10, 10), vy: rand(-4, 4), life: rand(2, 4), max: 4, size: rand(20, 46), col: [180, 210, 235] });
    }
  }

  function spawnForest() {
    audio.forest();
    const g = E();
    for (let i = 0; i < 70; i++) {
      const a = rand(0, TAU), rr = rand(0.2, 1) * g.R;
      push({ type: "leaf", x: g.cx + Math.cos(a) * rr, y: g.cy + Math.sin(a) * rr * 0.6 + g.R * 0.2,
             vx: rand(-40, 40), vy: rand(-160, -70), life: rand(1.6, 2.8), max: 2.8,
             size: rand(4, 10), rot: rand(0, TAU), vr: rand(-4, 4), col: [70 + rand(0, 60), 200 + rand(0, 40), 90 + rand(0, 50)] });
    }
    push({ type: "ring", x: g.cx, y: g.cy, life: 0.8, max: 0.8, size: g.R, col: [90, 240, 130] });
  }

  function spawnWind() {
    audio.wind();
    state.shake = Math.max(state.shake, 5);
    for (let i = 0; i < 46; i++) {
      push({ type: "wind", x: rand(W * 0.25, W * 1.1), y: rand(0, H), vx: rand(-1500, -950), vy: rand(-30, 30),
             life: 0.9, max: 0.9, size: rand(70, 190), col: [200, 240, 255] });
    }
    // blow existing smoke away to the left
    for (const p of P) {
      if (p.type === "smoke") { p.vx -= 700; p.life *= 0.45; }
    }
  }

  function emitBirds(dt, hf) {
    if (hf < 0.65) return;
    state.birdT += dt * (hf - 0.6) * 0.9;
    if (state.birdT < 1) return;
    state.birdT = 0;
    const fromLeft = Math.random() < 0.5;
    const y = rand(H * 0.18, H * 0.4);
    const vx = (fromLeft ? 1 : -1) * rand(90, 160);
    const x = fromLeft ? -60 : W + 60;
    const size = rand(7, 12);
    const n = 3 + (Math.random() * 4 | 0);
    for (let i = 0; i < n; i++) {
      birds.push({
        x: x - (fromLeft ? i * 22 : -i * 22),
        y: y + Math.abs(i - (n - 1) / 2) * 10,
        vx, vy: 0, size, flap: rand(0, TAU), dir: fromLeft ? 1 : -1,
      });
    }
  }

  function emitSmoke(dt) {
    const hf = state.health / 100;
    // Heavy pollution at start, decays as the world heals.
    if (hf >= 0.82) return;
    smokeAcc += dt * (1 - hf) * 38;
    const g = E();
    while (smokeAcc >= 1) {
      smokeAcc -= 1;
      const a = rand(-0.7, 0.7) - Math.PI / 2;
      push({
        type: "smoke",
        x: g.cx + Math.cos(a) * g.R * rand(0.2, 0.95),
        y: g.cy + Math.sin(a) * g.R * rand(0.2, 0.95),
        vx: rand(-12, 12), vy: rand(-55, -22),
        life: rand(2.4, 5), max: 5,
        size: rand(16, 36),
        col: [55, 48, 45],
        // "Smoke worm" — each puff has its own sine wiggle so trails meander
        wig: rand(0, TAU), wigAmp: rand(20, 44), wigSp: rand(1.6, 3.2),
      });
    }
  }

  // ----------------------------------------------------------------- gestures
  // No boss / no strike. Four powers, each restorative.
  //   Open Palm   → Rain Power     (also disperses smoke)
  //   Both Hands Up → Forest Power (trees grow on the surface)
  //   Swipe Left  → Wind Blast     (clears smog, shows CARBON EMISSION · ZERO)
  //   Fist        → Crop / Warm    (golden fields bloom, big heal)
  const NICE = { rain: "RAIN", forest: "FOREST", wind: "WIND", attack: "CROP" };

  function applyGesture(g, conf = 1) {
    if (state.phase !== "playing") return;
    if (!NICE[g]) return;
    state.lastGesture = g;
    state.lastConf = conf;
    state.seq++;
    pulseLegend(g);
    flashGesture(NICE[g]);
    updateGestureIndicator(g, conf);
    speakPower(g);

    if (g === "rain") {
      spawnRain();
      // rain dissolves existing smoke quickly
      for (const p of P) if (p.type === "smoke") { p.life *= 0.35; p.size *= 0.9; }
      state.health += 3;
    } else if (g === "forest") {
      spawnForest();
      growFlora("tree", 7 + (Math.random() * 4 | 0));
      state.health += 5;
    } else if (g === "wind") {
      spawnWind();
      state.health += 3;
      // Hard reset the carbon readout to ZERO for a beat, then it decays back to the truth
      state.carbonOverride = 1.6;
    } else if (g === "attack") {
      // CROP / WARM Power — golden fields bloom across the surface
      spawnCrop();
      growFlora("crop", 6 + (Math.random() * 4 | 0));
      state.health += 4;
    }
    state.health = clamp(state.health, 0, 100);
  }

  /** Add persistent flora (trees / crops) at random rotating-globe positions. */
  function growFlora(kind, n) {
    for (let i = 0; i < n; i++) {
      state.flora.push({
        kind,
        lon: rand(0, TAU),
        lat: rand(-1.0, 1.0),
        size: kind === "tree" ? rand(0.025, 0.05) : rand(0.022, 0.04),
        grow: 0, // 0..1 grows over a couple of seconds
      });
    }
    // Cap so memory stays bounded
    while (state.flora.length > 220) state.flora.shift();
  }

  function spawnCrop() {
    // golden warm particles puffing upward — "warm the earth"
    audio.forest();
    const g = E();
    for (let i = 0; i < 60; i++) {
      const a = rand(0, TAU), rr = rand(0.2, 1) * g.R;
      push({
        type: "leaf",
        x: g.cx + Math.cos(a) * rr,
        y: g.cy + Math.sin(a) * rr * 0.6 + g.R * 0.2,
        vx: rand(-30, 30), vy: rand(-130, -50),
        life: rand(1.4, 2.4), max: 2.4,
        size: rand(3, 7), rot: rand(0, TAU), vr: rand(-3, 3),
        col: [255, 200 + rand(0, 40), 90 + rand(0, 50)], // golden
      });
    }
    push({ type: "ring", x: g.cx, y: g.cy, life: 0.7, max: 0.7, size: g.R, col: [255, 200, 90] });
  }

  // ----------------------------------------------------------------- update
  function update(dt) {
    state.time += dt;
    if (state.phase === "playing") state.elapsed += dt;
    earthRot += dt * 0.16;
    cloudRot += dt * 0.05;
    state.flash = Math.max(0, state.flash - dt * 2.2);
    state.shake = Math.max(0, state.shake - dt * 28);

    const hf = state.health / 100;
    // Cracked atmosphere intensity grows as health drops below 25
    const targetCrack = hf < 0.25 ? (0.25 - hf) / 0.25 : 0;
    state.crack += (targetCrack - state.crack) * Math.min(1, dt * 2.5);
    // Sun pulse only when thriving
    state.sunPulse = hf > 0.6 ? state.sunPulse + dt : 0;

    // Carbon emission readout — heavy pollution at start, fades as Earth heals.
    // Wind blast briefly forces it to ZERO.
    state.carbonOverride = Math.max(0, state.carbonOverride - dt);
    const carbonTarget = Math.round((1 - hf) * 520);
    state.carbonPpm += (carbonTarget - state.carbonPpm) * Math.min(1, dt * 1.4);

    // Flora grow-in animation
    for (const f of state.flora) if (f.grow < 1) f.grow = Math.min(1, f.grow + dt * 0.7);

    emitSmoke(dt);
    emitBirds(dt, hf);

    // particles
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.type === "ember") p.vy += 520 * dt;
      if (p.type === "leaf") { p.rot += p.vr * dt; p.vy += 60 * dt; }
      if (p.type === "smoke") {
        p.size += 14 * dt;
        p.vy -= 4 * dt;
        // Wormy sideways wiggle — sinuous smoke trails per spec
        if (p.wig !== undefined) {
          p.wig += dt * p.wigSp;
          p.x += Math.sin(p.wig) * p.wigAmp * dt;
        }
      }
      p.life -= dt;
      if (p.life <= 0 || p.y > H + 60 || p.x < -260) P.splice(i, 1);
    }

    // birds (V-flocks gliding across the sky when world is healthy)
    for (let i = birds.length - 1; i >= 0; i--) {
      const b = birds[i];
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.flap += dt * 8;
      if (b.x < -120 || b.x > W + 120) birds.splice(i, 1);
    }

    state.health = clamp(state.health, 0, 100);

    // mood / audio
    state.moodTimer += dt;
    if (state.moodTimer > 0.3) { state.moodTimer = 0; audio.setMood(state.health / 100); }

    // ending condition: world fully restored
    if (state.phase === "playing" && state.health >= 95) endGame();

    tweenHUD(dt);
    updateHUD();
  }

  // ----------------------------------------------------------------- render
  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // Sky / cosmic backdrop. As the world heals, the night sky brightens
    // into a soft sunlit daylight blue.
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    const hf = state.health / 100;
    bg.addColorStop(0, rgb(mix([8, 6, 14], [120, 180, 230], hf)));
    bg.addColorStop(1, rgb(mix([1, 2, 6],   [40,  90, 150], hf)));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    if (state.shake > 0.2) ctx.translate(rand(-state.shake, state.shake), rand(-state.shake, state.shake));

    drawStars(hf);
    drawNebula(hf);
    drawAurora(hf);
    drawSun(hf);
    drawEarth(hf);
    drawBirds();
    drawParticles();
    ctx.restore();

    // lightning flash (full screen)
    if (state.flash > 0.01) {
      ctx.fillStyle = `rgba(210,230,255,${state.flash * 0.5})`;
      ctx.fillRect(0, 0, W, H);
    }
    // pollution tint when the world is sick
    if (hf < 0.7) {
      const t = ctx.createLinearGradient(0, 0, 0, H);
      const a = (0.7 - hf) * 0.5;
      t.addColorStop(0, `rgba(90,60,30,${a * 0.7})`);
      t.addColorStop(1, `rgba(40,15,10,${a})`);
      ctx.fillStyle = t;
      ctx.fillRect(0, 0, W, H);
    }
    // Cinematic chromatic aberration when carbon is high (toxic feel) —
    // tiny RGB-split overlay on the edges of the frame.
    if (hf < 0.35) {
      const a = (0.35 - hf) * 0.45;
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = `rgba(227,84,58,${a})`;
      ctx.fillRect(0, 0, 6, H);
      ctx.fillStyle = `rgba(240,140,60,${a})`;
      ctx.fillRect(W - 6, 0, 6, H);
      ctx.restore();
    }
    // Bloom flash at full restoration — soft white-out over the whole screen.
    if (hf > 0.92) {
      const a = (hf - 0.92) / 0.08 * 0.16;
      ctx.fillStyle = `rgba(255,250,235,${a})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  function drawStars(hf) {
    // Stars fade out as the daytime sky brightens
    const visible = clamp(1 - hf * 1.4, 0, 1);
    if (visible < 0.05) return;
    for (const s of stars) {
      const tw = 0.5 + 0.5 * Math.sin(state.time * s.sp + s.tw);
      ctx.fillStyle = `rgba(255,255,255,${(0.2 + tw * 0.7) * visible})`;
      ctx.beginPath();
      ctx.arc(s.x * W, s.y * H, s.r, 0, TAU);
      ctx.fill();
    }
  }

  function drawSun(hf) {
    // "The source" — a soft sun disc fades in past ~55% vitality, then grows
    // dramatically into a full sunrise as the world is fully restored.
    if (hf < 0.55) return;
    const a = clamp((hf - 0.55) / 0.45, 0, 1);
    // Extra bloom in the last 10% so the ending reads as "sunlit".
    const final = clamp((hf - 0.9) / 0.1, 0, 1);
    const sx = W * 0.16, sy = H * 0.22;
    const rad = Math.min(W, H) * (0.04 + 0.025 * a + 0.04 * final);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // Outer halo
    const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad * (6 + 2 * final));
    halo.addColorStop(0, `rgba(255,235,180,${(0.32 + 0.2 * final) * a})`);
    halo.addColorStop(0.5, `rgba(255,210,130,${(0.12 + 0.12 * final) * a})`);
    halo.addColorStop(1, "rgba(255,200,100,0)");
    ctx.fillStyle = halo;
    const hr = rad * (6 + 2 * final);
    ctx.fillRect(sx - hr, sy - hr, hr * 2, hr * 2);
    // Hot core
    const core = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
    core.addColorStop(0, `rgba(255,250,235,${0.95 * a})`);
    core.addColorStop(0.6, `rgba(255,230,170,${0.7 * a})`);
    core.addColorStop(1, "rgba(255,200,120,0)");
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(sx, sy, rad, 0, TAU); ctx.fill();
    // Soft sun rays at full restoration
    if (final > 0.05) {
      ctx.strokeStyle = `rgba(255,235,170,${0.25 * final})`;
      ctx.lineWidth = 2;
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * TAU + state.time * 0.05;
        const r1 = rad * 1.3, r2 = rad * (4 + 1.5 * Math.sin(state.time * 0.6 + i));
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(ang) * r1, sy + Math.sin(ang) * r1);
        ctx.lineTo(sx + Math.cos(ang) * r2, sy + Math.sin(ang) * r2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawNebula(hf) {
    const col = mix([60, 20, 30], [20, 60, 80], hf);
    ctx.globalCompositeOperation = "lighter";
    const ng = ctx.createRadialGradient(W * 0.7, H * 0.25, 10, W * 0.7, H * 0.25, Math.max(W, H) * 0.5);
    ng.addColorStop(0, rgb(col, 0.10));
    ng.addColorStop(1, rgb(col, 0));
    ctx.fillStyle = ng;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
  }

  /** Aurora ribbons — soft green/cyan curtains that drift across the upper sky
   *  while Earth is healing (Magic UI / React Bits ambient-layer pattern). */
  function drawAurora(hf) {
    // Peak intensity in the healing window 0.25–0.85.
    const a = clamp(Math.min((hf - 0.2) / 0.25, (0.95 - hf) / 0.2), 0, 1);
    if (a < 0.05) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const ribbons = 3;
    for (let r = 0; r < ribbons; r++) {
      const yBase = H * (0.10 + r * 0.06);
      const amp = H * (0.05 + r * 0.02);
      const phase = state.time * (0.25 + r * 0.08) + r * 1.7;
      const hue = r === 0 ? [80, 240, 170] : r === 1 ? [120, 200, 255] : [180, 255, 200];
      const g = ctx.createLinearGradient(0, yBase - amp, 0, yBase + amp * 1.6);
      g.addColorStop(0,   `rgba(${hue[0]},${hue[1]},${hue[2]},0)`);
      g.addColorStop(0.5, `rgba(${hue[0]},${hue[1]},${hue[2]},${0.18 * a})`);
      g.addColorStop(1,   `rgba(${hue[0]},${hue[1]},${hue[2]},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, yBase);
      for (let x = 0; x <= W; x += 30) {
        const y = yBase + Math.sin(x * 0.0042 + phase) * amp + Math.sin(x * 0.013 + phase * 0.7) * amp * 0.35;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, yBase + amp * 1.6);
      ctx.lineTo(0, yBase + amp * 1.6);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawEarth(hf) {
    const { cx, cy, R } = E();
    const beat = 1 + 0.012 * Math.sin(state.time * (2.4 - hf));

    // atmosphere glow — lighter so the planet body stays readable at low vitality
    const aCol = mix([255, 70, 40], [90, 200, 255], hf);
    ctx.globalCompositeOperation = "lighter";
    const ag = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.7);
    ag.addColorStop(0, rgb(aCol, 0));
    ag.addColorStop(0.5, rgb(aCol, 0.14 + 0.04 * Math.sin(state.time * 2)));
    ag.addColorStop(1, rgb(aCol, 0));
    ctx.fillStyle = ag;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.7, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = "source-over";

    const r = R * beat;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();

    // base ocean / surface
    const base = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
    base.addColorStop(0, rgb(mix([58, 28, 16], [26, 96, 165], hf)));
    base.addColorStop(1, rgb(mix([12, 6, 4], [6, 34, 78], hf)));
    ctx.fillStyle = base;
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);

    // land masses (rotating globe projection) — brighter so continents read at low vitality
    const landCol = mix([120, 86, 42], [56, 188, 86], hf);
    for (const b of land) {
      const a = b.lon + earthRot;
      const z = Math.cos(b.lat) * Math.cos(a);
      if (z <= 0.02) continue;
      const x = cx + Math.cos(b.lat) * Math.sin(a) * r;
      const y = cy + Math.sin(b.lat) * r;
      const sz = b.size * r * (0.5 + z);
      const lg = ctx.createRadialGradient(x, y, 0, x, y, sz);
      lg.addColorStop(0, rgb(landCol, 0.95 * z));
      lg.addColorStop(1, rgb(landCol, 0));
      ctx.fillStyle = lg;
      ctx.beginPath(); ctx.arc(x, y, sz, 0, TAU); ctx.fill();
    }

    // Growing flora (trees + crops) painted on the surface, rotating with the globe.
    // Trees are dark-green dots with a tiny shadow; crops are gold patches.
    for (const f of state.flora) {
      const a = f.lon + earthRot;
      const z = Math.cos(f.lat) * Math.cos(a);
      if (z <= 0.04) continue;
      const x = cx + Math.cos(f.lat) * Math.sin(a) * r;
      const y = cy + Math.sin(f.lat) * r;
      const sz = f.size * r * (0.5 + z) * f.grow;
      if (sz < 0.5) continue;
      if (f.kind === "tree") {
        const tg = ctx.createRadialGradient(x, y, 0, x, y, sz);
        tg.addColorStop(0, `rgba(46,180,80,${0.95 * z})`);
        tg.addColorStop(1, `rgba(20,80,40,0)`);
        ctx.fillStyle = tg;
        ctx.beginPath(); ctx.arc(x, y, sz, 0, TAU); ctx.fill();
      } else {
        const cg = ctx.createRadialGradient(x, y, 0, x, y, sz);
        cg.addColorStop(0, `rgba(255,210,90,${0.9 * z})`);
        cg.addColorStop(1, `rgba(180,130,40,0)`);
        ctx.fillStyle = cg;
        ctx.beginPath(); ctx.ellipse(x, y, sz * 1.2, sz * 0.7, 0, 0, TAU); ctx.fill();
      }
    }

    // fire / molten scars when sick
    if (hf < 0.6) {
      ctx.globalCompositeOperation = "lighter";
      for (const f of fireSpots) {
        const a = f.lon + earthRot;
        const z = Math.cos(f.lat) * Math.cos(a);
        if (z <= 0.02) continue;
        const x = cx + Math.cos(f.lat) * Math.sin(a) * r;
        const y = cy + Math.sin(f.lat) * r;
        const sz = f.size * r * (0.5 + z) * (1 + 0.2 * Math.sin(state.time * 6 + f.lon));
        const fg = ctx.createRadialGradient(x, y, 0, x, y, sz);
        const inten = (0.6 - hf) * z;
        fg.addColorStop(0, `rgba(255,120,30,${inten})`);
        fg.addColorStop(1, "rgba(255,60,10,0)");
        ctx.fillStyle = fg;
        ctx.beginPath(); ctx.arc(x, y, sz, 0, TAU); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    }

    // clouds when recovering+
    if (hf > 0.35) {
      for (const c of clouds) {
        const a = c.lon + cloudRot;
        const z = Math.cos(c.lat) * Math.cos(a);
        if (z <= 0.05) continue;
        const x = cx + Math.cos(c.lat) * Math.sin(a) * r;
        const y = cy + Math.sin(c.lat) * r;
        const sz = c.size * r * (0.5 + z);
        const cg = ctx.createRadialGradient(x, y, 0, x, y, sz);
        cg.addColorStop(0, `rgba(255,255,255,${0.30 * z * (hf - 0.3)})`);
        cg.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = cg;
        ctx.beginPath(); ctx.arc(x, y, sz, 0, TAU); ctx.fill();
      }
    }

    // ice caps when healthy
    if (hf > 0.55) {
      const ia = (hf - 0.55) * 1.6;
      ctx.fillStyle = `rgba(235,250,255,${ia})`;
      ctx.beginPath(); ctx.ellipse(cx, cy - r * 0.92, r * 0.5, r * 0.18, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.92, r * 0.5, r * 0.18, 0, 0, TAU); ctx.fill();
    }

    // spherical shading — softer terminator so the dark hemisphere doesn't swallow the planet
    const sh = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.4, r * 0.2, cx, cy, r * 1.05);
    sh.addColorStop(0, "rgba(0,0,0,0)");
    sh.addColorStop(1, "rgba(0,0,0,0.38)");
    ctx.fillStyle = sh;
    ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
    ctx.restore();

    // cracked atmosphere — only when world is critical
    if (state.crack > 0.02) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = `rgba(255,120,40,${0.55 * state.crack})`;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = "rgba(255,80,30,0.8)";
      ctx.shadowBlur = 10 * state.crack;
      for (let i = 0; i < cracks.length; i++) {
        const ck = cracks[i];
        ctx.beginPath();
        for (let j = 0; j < ck.segs.length; j++) {
          const s = ck.segs[j];
          const ang = s.a + ck.start + state.time * 0.02;
          const px = cx + Math.cos(ang) * r * s.r;
          const py = cy + Math.sin(ang) * r * s.r;
          j === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // sunlight bloom — only when world is thriving
    if (hf > 0.6) {
      const bloom = (hf - 0.6) / 0.4;
      const pulse = 0.5 + 0.5 * Math.sin(state.sunPulse * 1.3);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const sg = ctx.createRadialGradient(cx - r * 0.5, cy - r * 0.6, 0, cx - r * 0.5, cy - r * 0.6, r * 1.6);
      sg.addColorStop(0, `rgba(255,240,200,${0.35 * bloom + 0.1 * pulse * bloom})`);
      sg.addColorStop(1, "rgba(255,240,200,0)");
      ctx.fillStyle = sg;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  function drawBirds() {
    if (!birds.length) return;
    ctx.save();
    ctx.strokeStyle = "rgba(20,30,40,0.85)";
    ctx.lineWidth = 1.8;
    for (const b of birds) {
      const wing = Math.sin(b.flap) * 0.6 + 0.2;
      ctx.beginPath();
      ctx.moveTo(b.x - b.size, b.y + wing * b.size * 0.6);
      ctx.lineTo(b.x, b.y - wing * b.size * 0.3);
      ctx.lineTo(b.x + b.size, b.y + wing * b.size * 0.6);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawParticles() {
    for (const p of P) {
      const lf = clamp(p.life / p.max, 0, 1);
      if (p.type === "rain") {
        ctx.strokeStyle = rgb(p.col, 0.5 * lf + 0.2);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.vx * 0.02, p.y - p.size); ctx.stroke();
      } else if (p.type === "leaf") {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = rgb(p.col, 0.85 * lf);
        ctx.beginPath(); ctx.ellipse(0, 0, p.size, p.size * 0.5, 0, 0, TAU); ctx.fill();
        ctx.restore();
      } else if (p.type === "smoke" || p.type === "cloudpuff") {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
        g.addColorStop(0, rgb(p.col, 0.4 * lf));
        g.addColorStop(1, rgb(p.col, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
      } else if (p.type === "wind") {
        ctx.strokeStyle = rgb(p.col, 0.18 * lf);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.size, p.y); ctx.stroke();
      } else if (p.type === "ember") {
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = rgb(p.col, lf);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, TAU); ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      } else if (p.type === "ring") {
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = rgb(p.col, lf * 0.8);
        ctx.lineWidth = 4 * lf + 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - lf) + p.size * 0.2, 0, TAU); ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
      }
    }
  }

  // ----------------------------------------------------------------- HUD
  const $ = (id) => document.getElementById(id);
  // Smooth-tweened display values so the HUD never snaps — pure UX polish.
  const display = { health: 0, carbon: 480 };
  function tweenHUD(dt) {
    const k = Math.min(1, dt * 6);
    display.health += (state.health - display.health) * k;
    const carbonTarget = state.carbonOverride > 0 ? 0 : state.carbonPpm;
    display.carbon += (carbonTarget - display.carbon) * k;
  }
  function updateHUD() {
    const h = Math.round(display.health);
    const fill = $("earth-health-fill");
    fill.style.width = h + "%";
    let label, grad, tier;
    if (h < 25) { label = "CRITICAL"; tier = "critical"; grad = "linear-gradient(90deg,#e3543a,#f08a3c)"; }
    else if (h < 60) { label = "RECOVERING"; tier = "recovering"; grad = "linear-gradient(90deg,#e8a13a,#f2c45a)"; }
    else { label = "THRIVING"; tier = "thriving"; grad = "linear-gradient(90deg,#46c08a,#5fd6cf)"; }
    fill.style.background = grad;
    // Drive the "living accent": every accented HUD element reads var(--accent),
    // which the [data-tier] rules in style.css remap as the planet heals.
    document.documentElement.dataset.tier = tier;
    $("earth-state").textContent = label;
    $("earth-health-num").textContent = h + "%";
    // Carbon emission readout — tween smoothly, wind forces 0 briefly
    const carbon = Math.max(0, Math.round(display.carbon));
    const cn = $("carbon-num");
    if (cn) {
      const isZero = state.carbonOverride > 0 || carbon <= 1;
      cn.textContent = isZero ? "ZERO" : carbon + " ppm";
      const carbonEl = $("carbon");
      carbonEl.classList.toggle("zero", isZero);
      carbonEl.classList.toggle("danger", !isZero && carbon >= 280);
    }
  }

  let legendTimers = {};
  function pulseLegend(g) {
    const card = document.querySelector(`.card[data-g="${g}"]`);
    if (!card) return;
    card.classList.add("active");
    clearTimeout(legendTimers[g]);
    legendTimers[g] = setTimeout(() => card.classList.remove("active"), 650);
  }

  function flashGesture(name) {
    const fl = $("flash");
    fl.textContent = name;
    fl.classList.remove("show");
    void fl.offsetWidth; // restart animation
    fl.classList.add("show");
  }

  // narration queue — text + AI voice (Web Speech)
  let narrQ = [], narrBusy = false;
  function narrate(text, ms) {
    narrQ.push([text, ms]);
    if (!narrBusy) nextNarr();
  }
  function nextNarr() {
    if (!narrQ.length) { narrBusy = false; $("speak-ind").classList.remove("show"); return; }
    narrBusy = true;
    const [t, ms] = narrQ.shift();
    const el = $("narration");
    el.textContent = t;
    el.classList.add("show");
    $("speak-ind").classList.add("show");
    audio.speak(t); // deep cinematic AI voice through speakers
    setTimeout(() => { el.classList.remove("show"); setTimeout(nextNarr, 650); }, ms);
  }

  // ----------------------------------------------------------------- gesture indicator
  const GX_ICON = { rain: "🖐️", forest: "☝️", wind: "✌️", attack: "✊" };
  const GX_NAME = { rain: "RAIN POWER", forest: "FOREST GROWTH", wind: "WIND BLAST · CARBON ZERO", attack: "CROP / WARM POWER" };
  let gxFade = null;
  function updateGestureIndicator(g, conf) {
    const wrap = $("gx");
    $("gx-icon").textContent = GX_ICON[g] || "·";
    $("gx-name").textContent = GX_NAME[g] || "AWAITING GESTURE";
    const pct = Math.round(clamp(conf, 0, 1) * 100);
    $("gx-conf").style.width = pct + "%";
    $("gx-conf-num").textContent = pct + "%";
    wrap.classList.remove("active"); void wrap.offsetWidth;
    wrap.classList.add("active");
    clearTimeout(gxFade);
    gxFade = setTimeout(() => wrap.classList.remove("active"), 1400);
  }

  // ----------------------------------------------------------------- flow
  function beginGame() {
    audio.start();
    audio.unlockVoice();   // unlock TTS within this user-gesture (Chrome requirement)
    initCamera();          // request the webcam inside the user gesture (guarded)
    $("start").classList.add("hidden");
    $("ending").classList.add("hidden");
    // Calibration intro — quick cinematic pause that frames the experience.
    // The three messages each show for ~900 ms, then we drop into gameplay.
    const calib = $("calibrate");
    const msg = $("calib-msg");
    calib.classList.remove("hidden");
    const lines = [
      "Linking to environmental sensors…",
      "Calibrating hand recognition…",
      "Bhumi AI online.",
    ];
    let i = 0;
    msg.textContent = lines[0];
    const tick = setInterval(() => {
      i++;
      if (i < lines.length) { msg.textContent = lines[i]; }
      else {
        clearInterval(tick);
        calib.classList.add("hidden");
        $("hud").classList.remove("hidden");
        resetWorld();
        state.started = true;
        state.phase = "playing";
        // Climate language is grounded (warming oceans, vanishing forests,
        // rising carbon) — never apocalyptic.
        narrate("I am Bhumi. The voice of your living world.", 3800);
        narrate("My oceans are warming. My forests are vanishing. The carbon rises.", 4800);
        narrate("With your hands… bring me back to balance.", 4000);
      }
    }, 900);
  }

  // Per-power narration — soft Bhumi reactions, throttled so she doesn't talk over herself
  const POWER_LINES = {
    rain:   ["Rain… cleansing my skies.",         "Yes. Let the storms come.",          "The smog clears."],
    forest: ["Forests are rising again.",         "My lungs grow green.",                "Life returns to the soil."],
    wind:   ["Carbon emission… zero.",            "The wind carries it away.",           "I can breathe again."],
    attack: ["Golden fields warm my surface.",    "Crops bloom. Life feeds life.",       "The harvest of a new age."],
  };
  let lastPowerSpoken = 0;
  function speakPower(g) {
    const now = state.time;
    if (now - lastPowerSpoken < 2.8) return; // throttle so Bhumi stays cinematic
    const lines = POWER_LINES[g];
    if (!lines) return;
    lastPowerSpoken = now;
    narrate(lines[(Math.random() * lines.length) | 0], 2600);
  }

  function resetWorld() {
    state.health = 5; state.elapsed = 0; state.phase = "playing";
    state.crack = 0; state.birdT = 0; state.sunPulse = 0; state.seq = 0;
    state.carbonPpm = 480; state.carbonOverride = 0;
    state.flora.length = 0;
    P.length = 0; birds.length = 0;
    $("gx-icon").textContent = "·"; $("gx-name").textContent = "AWAITING GESTURE";
    $("gx-conf").style.width = "0%"; $("gx-conf-num").textContent = "0%";
    narrQ = []; narrBusy = false;
    audio.stopSpeak();
  }

  function endGame() {
    state.phase = "ending";
    audio.restore();
    // Final restored-Earth flourish: max out vitality, paint a full flora canopy,
    // start a gentle ambient rain so the sky + sun + rain coexist (the user
    // explicitly asked for "sun, rain and sky" at the end).
    state.health = 100;
    state.carbonOverride = 99999;     // lock carbon at ZERO for the rest of the run
    growFlora("tree", 24);
    growFlora("crop", 16);
    spawnGentleRain();

    const sec = Math.round(state.elapsed);
    const mm = Math.floor(sec / 60), ss = ("0" + (sec % 60)).slice(-2);
    // Score: vitality × 8, plus a time bonus for healing faster, plus flora bonus
    const score = Math.round(state.health * 8 + Math.max(0, 420 - sec) + state.flora.length * 6);
    $("ending-title").textContent = "EARTH RESTORED";
    $("ending-sub").textContent = "Forests breathe. The sky is clear. The carbon is gone.";
    $("score").textContent = `SCORE ${score} · TIME ${mm}:${ss} · CARBON · ZERO`;
    pendingScore = { score, sec };
    const lastName = localStorage.getItem("eg.guardian.name") || "";
    $("name-input").value = lastName;
    renderLeaderboard();
    $("ending").classList.remove("hidden");
    startNatureAnimations();
    // Three-beat ending narration ending on the explicit "Thank you"
    narrate("My oceans are cool. My forests breathe.", 3600);
    narrate("The carbon is gone. The sun rises again.", 3800);
    narrate("Thank you, Guardian. Bhumi lives again.", 4500);
  }

  /** Start nature animations when Earth is restored */
  function startNatureAnimations() {
    const birdsContainer = $("birds-container");
    if (!birdsContainer) return;
    
    // Clear existing birds
    birdsContainer.innerHTML = '';
    
    // Create bird emojis and add them with staggered animations
    const birds = ['🦅', '🕊️', '🦜', '🦆', '🐦'];
    const peacocks = ['🦚'];
    const deers = ['🦌'];
    
    // Add birds with animation delays
    for (let i = 0; i < 5; i++) {
      const bird = document.createElement('div');
      bird.className = 'bird';
      bird.textContent = birds[i % birds.length];
      bird.style.animationDelay = (i * 0.8) + 's';
      birdsContainer.appendChild(bird);
    }
    
    // Add peacock
    const peacock = $("nature-animations").querySelector('.deer');
    if (peacock) {
      peacock.textContent = '🦚';
    }
  }

  /** Soft, sparse rain that runs while the ending overlay is up. */
  function spawnGentleRain() {
    for (let i = 0; i < 60; i++) {
      push({
        type: "rain",
        x: rand(0, W), y: rand(-H, 0),
        vx: -10, vy: rand(700, 950),
        life: 3.5, max: 3.5,
        size: rand(8, 14),
        col: [180, 220, 255],
      });
    }
  }

  // ----------------------------------------------------------------- leaderboard
  let pendingScore = null;
  const LB_KEY = "eg.leaderboard.v1";
  function loadLB() {
    try { return JSON.parse(localStorage.getItem(LB_KEY) || "[]"); } catch { return []; }
  }
  function saveLB(list) {
    try { localStorage.setItem(LB_KEY, JSON.stringify(list.slice(0, 5))); } catch {}
  }
  function renderLeaderboard() {
    const list = loadLB();
    const ol = $("lb-list");
    ol.innerHTML = "";
    if (!list.length) {
      const li = document.createElement("li");
      li.className = "lb-empty";
      li.textContent = "— no Guardians yet · save your score below —";
      ol.appendChild(li);
      return;
    }
    list.forEach((e, i) => {
      const li = document.createElement("li");
      const mm = Math.floor(e.time / 60), ss = ("0" + (e.time % 60)).slice(-2);
      li.innerHTML = `<span class="lb-rank">${i + 1}</span>
                      <span class="lb-name">${escapeHTML(e.name)}</span>
                      <span class="lb-time">${mm}:${ss}</span>
                      <span class="lb-score">${e.score}</span>`;
      ol.appendChild(li);
    });
  }
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }
  function saveCurrentScore() {
    if (!pendingScore) return;
    const raw = ($("name-input").value || "").trim().slice(0, 14).toUpperCase();
    const name = raw || "GUARDIAN";
    localStorage.setItem("eg.guardian.name", name);
    const list = loadLB();
    list.push({ name, score: pendingScore.score, time: pendingScore.sec, ts: Date.now() });
    list.sort((a, b) => b.score - a.score);
    saveLB(list);
    pendingScore = null;
    $("save-score-btn").disabled = true;
    $("save-score-btn").textContent = "SAVED";
    renderLeaderboard();
  }

  // ===================================================================
  // IN-BROWSER HAND VISION  (MediaPipe HandLandmarker — no server)
  // ===================================================================
  // We grab the webcam with getUserMedia, run the 21-point HandLandmarker on
  // each video frame, then classify the spec's four STATIC gestures with the
  // exact same geometry + scoring + stability/cooldown state machine the old
  // Python detector used. Confirmed gestures flow into applyGesture().

  // --- MediaPipe landmark indices (21 per hand) ----------------------------
  const WRIST = 0, THUMB_TIP = 4, INDEX_MCP = 5, MIDDLE_MCP = 9;
  const LONG_FINGERS = [[8, 6], [12, 10], [16, 14], [20, 18]]; // [tip, pip]
  const FINGERTIPS = [8, 12, 16, 20];
  const EPS = 1e-6;

  // --- tuning surface (ported 1:1 from GestureConfig) ----------------------
  const CFG = {
    confidence_threshold: 0.65,
    stable_seconds: 0.16,
    stability_frac: 0.50,
    curl_lo: -0.30, curl_hi: 0.60,
    thumb_lo: 0.25, thumb_hi: 0.70,
    palm_min_ext: 0.46, fist_max_ext: 0.42, spread_norm: 0.60,
    cooldown: { rain: 1.1, forest: 1.6, wind: 0.8, attack: 1.0 },
  };

  // --- geometry helpers ----------------------------------------------------
  const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const handScale = (lm) => d2(lm[WRIST], lm[MIDDLE_MCP]) + EPS;

  function fingerExt(lm, tip, pip, scale) {
    const ratio = (d2(lm[tip], lm[WRIST]) - d2(lm[pip], lm[WRIST])) / scale;
    return c01((ratio - CFG.curl_lo) / (CFG.curl_hi - CFG.curl_lo));
  }
  function thumbExt(lm, scale) {
    const spread = d2(lm[THUMB_TIP], lm[INDEX_MCP]) / scale;
    return c01((spread - CFG.thumb_lo) / (CFG.thumb_hi - CFG.thumb_lo));
  }
  function extensions(lm) {
    const s = handScale(lm);
    const e = [thumbExt(lm, s)];
    for (const [t, p] of LONG_FINGERS) e.push(fingerExt(lm, t, p, s));
    return e; // [thumb, index, middle, ring, pinky]
  }
  function palmSpread(lm) {
    const s = handScale(lm);
    let sum = 0;
    for (let i = 0; i < FINGERTIPS.length - 1; i++) sum += d2(lm[FINGERTIPS[i]], lm[FINGERTIPS[i + 1]]);
    const avg = (sum / (FINGERTIPS.length - 1)) / s;
    return c01(avg / CFG.spread_norm);
  }
  // One finger — index extended, middle + ring + pinky curled (thumb ignored).
  function oneFinger(ext) {
    const idx = ext[1], mid = ext[2], ring = ext[3], pinky = ext[4];
    if (idx < 0.5) return 0;
    if (mid > 0.5 || ring > 0.5 || pinky > 0.5) return 0;
    const curled = 1 - (mid + ring + pinky) / 3;
    return c01(0.5 * idx + 0.5 * curled);
  }
  // Peace sign / V — index + middle extended, ring + pinky curled (thumb ignored).
  function twoFingers(ext) {
    const idx = ext[1], mid = ext[2], ring = ext[3], pinky = ext[4];
    if (idx < 0.5 || mid < 0.5) return 0;
    if (ring > 0.5 || pinky > 0.5) return 0;
    const extended = (idx + mid) / 2;
    const curled = 1 - (ring + pinky) / 2;
    return c01(0.5 * extended + 0.5 * curled);
  }
  const sum5 = (e) => (e[0] + e[1] + e[2] + e[3] + e[4]);

  // --- detector state (time-based stability ring + per-gesture cooldown) ---
  const det = { stab: [], lastEmit: {}, lastTs: -1 };

  function classify(handsLm, handedness, now) {
    const hands = handsLm || [];
    let trackQ = 0;
    if (handedness && handedness.length) {
      trackQ = Math.min(...handedness.map((c) => (c && c[0] ? c[0].score : 0)));
    }
    const ext = hands.map(extensions);

    // Static gesture confidences — evaluate EVERY hand, keep the best.
    // All four are single-hand gestures and their finger gates are mutually
    // exclusive: open palm, one finger, two fingers (V), fist.
    let confPalm = 0, confFist = 0, confOne = 0, confTwo = 0;
    for (let i = 0; i < ext.length; i++) {
      const e = ext[i];
      const meanExt = sum5(e) / 5;
      let p = trackQ * meanExt * (0.8 + 0.2 * palmSpread(hands[i]));
      if (Math.min(...e) < CFG.palm_min_ext) p = 0;
      let f = trackQ * (e.reduce((a, x) => a + (1 - x), 0) / 5);
      if (Math.max(...e) > CFG.fist_max_ext) f = 0;
      const o = oneFinger(e) * trackQ;
      const t = twoFingers(e) * trackQ;
      if (p > confPalm) confPalm = p;
      if (f > confFist) confFist = f;
      if (o > confOne) confOne = o;
      if (t > confTwo) confTwo = t;
    }

    // Collect every gesture above threshold; the strongest wins.
    //   One Finger → forest · Two Fingers → wind · Palm → rain · Fist → attack
    const cands = [];
    if (confOne > CFG.confidence_threshold) cands.push(["forest", confOne]);
    if (confTwo > CFG.confidence_threshold) cands.push(["wind", confTwo]);
    if (confPalm > CFG.confidence_threshold) cands.push(["rain", confPalm]);
    if (confFist > CFG.confidence_threshold) cands.push(["attack", confFist]);
    let best = null, bestC = 0;
    for (const [l, c] of cands) if (c > bestC) { best = l; bestC = c; }

    // Time-based stability ring.
    det.stab.push([now, best, bestC]);
    while (det.stab.length && now - det.stab[0][0] > CFG.stable_seconds) det.stab.shift();

    const [sl, sc] = stableWinner(now);
    if (sl && canEmit(sl, now)) {
      det.lastEmit[sl] = now;
      det.stab.length = 0;          // one gesture == one event
      applyGesture(sl, sc);
    }
  }

  function stableWinner(now) {
    const r = det.stab;
    if (!r.length) return [null, 0];
    if (r[r.length - 1][0] - r[0][0] < CFG.stable_seconds * 0.8) return [null, 0];
    const total = r.length;
    const counts = {}, confs = {};
    for (const [, l, c] of r) {
      if (l == null) continue;
      counts[l] = (counts[l] || 0) + 1;
      (confs[l] = confs[l] || []).push(c);
    }
    let lbl = null, mx = 0;
    for (const k in counts) if (counts[k] > mx) { mx = counts[k]; lbl = k; }
    if (lbl && counts[lbl] / total >= CFG.stability_frac) {
      const arr = confs[lbl];
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      if (mean > CFG.confidence_threshold) return [lbl, mean];
    }
    return [null, 0];
  }
  const canEmit = (l, now) => now - (det.lastEmit[l] ?? -1e9) >= (CFG.cooldown[l] || 1);

  // --- camera + landmarker lifecycle ---------------------------------------
  let handLandmarker = null, drawUtils = null, camStream = null, detecting = false;
  const camVideo = $("cam-video");
  const camCanvas = $("cam-canvas");
  const camCtx = camCanvas ? camCanvas.getContext("2d") : null;

  function setConn(ok, txt) {
    const dot = $("conn-dot"); if (dot) dot.className = "dot" + (ok ? "" : " off");
    const t = $("conn-text"); if (t) t.textContent = txt;
  }
  function setCam(ok, msg) {
    const lab = $("cam-label"); if (!lab) return;
    if (ok) { lab.textContent = "● LIVE · YOUR HANDS"; lab.style.color = "var(--green)"; }
    else { lab.textContent = "○ " + (msg || "NO CAMERA"); lab.style.color = "var(--red)"; }
  }

  // Load the HandLandmarker once, up front (covered by the calibration intro).
  async function initLandmarker() {
    setConn(false, "loading AI…");
    try {
      const fileset = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
      );
      const opts = {
        baseOptions: { modelAssetPath: "./hand_landmarker.task", delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      };
      try {
        handLandmarker = await HandLandmarker.createFromOptions(fileset, opts);
      } catch (e) {
        // Fall back to CPU if the GPU/WebGL delegate is unavailable.
        opts.baseOptions.delegate = "CPU";
        handLandmarker = await HandLandmarker.createFromOptions(fileset, opts);
      }
      if (camCtx) drawUtils = new DrawingUtils(camCtx);
      setConn(false, camStream ? "camera live · AI online" : "AI ready · press BEGIN");
    } catch (e) {
      console.error("HandLandmarker failed to load:", e);
      setConn(false, "AI offline · use keys 1-4");
    }
  }

  // Request the webcam (called inside the BEGIN user-gesture). Idempotent.
  async function initCamera() {
    if (camStream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCam(false, "NO CAMERA API"); setConn(false, "no camera · use keys 1-4"); return;
    }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      camVideo.srcObject = camStream;
      await camVideo.play();
      setCam(true);
      setConn(true, handLandmarker ? "camera live · AI online" : "camera live · AI loading");
      startDetection();
    } catch (e) {
      console.warn("camera unavailable:", e);
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      setCam(false, denied ? "CAMERA BLOCKED" : "NO CAMERA");
      setConn(false, denied ? "camera blocked · use keys 1-4" : "no camera · use keys 1-4");
    }
  }

  function startDetection() {
    if (detecting) return;
    detecting = true;
    const fit = () => {
      if (camVideo.videoWidth) {
        camCanvas.width = camVideo.videoWidth;
        camCanvas.height = camVideo.videoHeight;
      }
    };
    fit();
    camVideo.addEventListener("loadedmetadata", fit);
    // requestVideoFrameCallback keeps detection perfectly synced to decoded
    // camera frames (smooth, no busy-poll). Fall back to a 30 fps timer.
    if ("requestVideoFrameCallback" in camVideo) {
      const cb = (now, meta) => { detectFrame(now, meta); camVideo.requestVideoFrameCallback(cb); };
      camVideo.requestVideoFrameCallback(cb);
    } else {
      setInterval(() => detectFrame(performance.now(), null), 1000 / 30);
    }
  }

  function detectFrame(now, meta) {
    if (!handLandmarker || camVideo.readyState < 2) { drawPreview(null); return; }
    // VIDEO mode needs strictly-increasing ms timestamps.
    let ts = meta && meta.mediaTime != null ? meta.mediaTime * 1000 : now;
    if (ts <= det.lastTs) ts = det.lastTs + 1;
    det.lastTs = ts;
    let res;
    try { res = handLandmarker.detectForVideo(camVideo, ts); }
    catch (e) { return; }
    drawPreview(res);
    classify(res.landmarks, res.handedness, performance.now() / 1000);
  }

  // Mirrored webcam preview + neon hand skeleton in the corner.
  function drawPreview(res) {
    if (!camCtx) return;
    const w = camCanvas.width, h = camCanvas.height;
    if (!w || !h) return;
    camCtx.save();
    camCtx.setTransform(-1, 0, 0, 1, w, 0); // mirror horizontally
    camCtx.drawImage(camVideo, 0, 0, w, h);
    if (res && res.landmarks && drawUtils) {
      for (const lm of res.landmarks) {
        drawUtils.drawConnectors(lm, HandLandmarker.HAND_CONNECTIONS, { color: "rgba(120,230,255,0.9)", lineWidth: 3 });
        drawUtils.drawLandmarks(lm, { color: "rgba(87,255,154,0.95)", lineWidth: 1, radius: 3 });
      }
    }
    camCtx.restore();
  }

  // ----------------------------------------------------------------- input
  $("start-btn").addEventListener("click", beginGame);
  $("restart-btn").addEventListener("click", () => {
    $("save-score-btn").disabled = false;
    $("save-score-btn").textContent = "SAVE";
    beginGame();
  });
  $("save-score-btn").addEventListener("click", saveCurrentScore);
  $("name-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveCurrentScore(); }
  });
  window.addEventListener("keydown", (e) => {
    // don't hijack typing in the name field
    if (document.activeElement && document.activeElement.id === "name-input") return;
    const map = { "1": "rain", "2": "forest", "3": "wind", "4": "attack",
                  r: "rain", f: "forest", w: "wind", a: "attack" };
    const g = map[e.key.toLowerCase()];
    if (g) {
      if (!state.started) beginGame();
      applyGesture(g, 1);
    }
    if (e.key === "Enter" && !state.started) beginGame();
  });

  // ----------------------------------------------------------------- main loop
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (state.started) update(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Preload the hand-tracking model immediately; the webcam itself is requested
  // when the player presses BEGIN (a user gesture, required for getUserMedia).
  initLandmarker();
})();
