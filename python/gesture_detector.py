"""gesture_detector.py — pure hand-gesture detection for Earth Guardian AI.

No networking, no asyncio, no camera I/O. Feed it BGR frames; it returns a
`GestureEvent` exactly once when one of the spec's four gestures is *confirmed*
(confidence > threshold, held stable for the stability window, not in cooldown).

The four gestures:
    Open Palm     -> "rain"    (Rain Power)
    Both Hands Up -> "forest"  (Forest Growth)
    Two Fingers   -> "wind"    (Wind Blast / Carbon-Zero)   ← peace sign (V)
    Fist          -> "attack"  (Crop / Warm Power)

All four are static gestures recognised on EITHER hand (left or right).

Built on the MediaPipe **Tasks API** (`HandLandmarker`, VIDEO mode) because the
legacy `mp.solutions.hands` module has been removed from recent mediapipe wheels.

This module is deliberately self-contained and unit-testable: construct a
`GestureDetector`, then call `update(frame_bgr, now_monotonic)` once per frame.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

import mediapipe as mp
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core.base_options import BaseOptions


# --------------------------------------------------------------------------- #
# MediaPipe hand landmark indices (21 points per hand)
# --------------------------------------------------------------------------- #
WRIST = 0
THUMB_TIP = 4
INDEX_MCP, INDEX_PIP, INDEX_TIP = 5, 6, 8
MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP = 9, 10, 12
RING_MCP, RING_PIP, RING_TIP = 13, 14, 16
PINKY_MCP, PINKY_PIP, PINKY_TIP = 17, 18, 20

# (tip, pip) pairs for the four long fingers (thumb handled separately)
_LONG_FINGERS = (
    (INDEX_TIP, INDEX_PIP),
    (MIDDLE_TIP, MIDDLE_PIP),
    (RING_TIP, RING_PIP),
    (PINKY_TIP, PINKY_PIP),
)
_FINGERTIPS = (INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP)

# The wire-facing gesture labels (single source of truth, shared with the server).
GESTURE_LABELS = ("rain", "forest", "wind", "attack")

EPS = 1e-6


# --------------------------------------------------------------------------- #
# Configuration — the single tuning surface
# --------------------------------------------------------------------------- #
@dataclass
class GestureConfig:
    # Global emit gate. Lowered to 0.65 — the post-emit cooldown plus a ~3-frame
    # stability buffer below is enough to suppress flickers without making the
    # player wait.
    confidence_threshold: float = 0.65

    # Stability for STATIC gestures — 0.12 s is ~3 frames at 30 fps. Recognition
    # feels essentially instant ("show palm → rain") while still rejecting
    # single-frame misclassifications.
    stable_seconds: float = 0.12
    stability_frac: float = 0.50          # bare majority of the window must agree

    # Finger extension mapping (raw signed ratio -> [0, 1])
    curl_lo: float = -0.30
    curl_hi: float = 0.60
    thumb_lo: float = 0.25
    thumb_hi: float = 0.70

    # Open Palm / Fist gates — relaxed so partially-spread palms still count.
    palm_min_ext: float = 0.46            # every finger must exceed this for a palm
    fist_max_ext: float = 0.50            # no finger may exceed this for a fist
    spread_norm: float = 0.60             # normalizer for the palm fan-out bonus

    # Both Hands Up (forest) — raise_y widened: hands count as "up" lower in the
    # frame, which is more forgiving on shorter players / closer cameras.
    raise_y: float = 0.55
    forest_open_floor: float = 0.32       # min openness contribution per hand

    # Wind / Carbon-Zero is now a static "two fingers" (V) sign — see
    # `_two_fingers_score`. No swipe motion parameters needed.

    # Per-gesture cooldown (seconds) after an emit
    cooldown: dict = field(default_factory=lambda: {
        "rain": 1.1, "forest": 1.6, "wind": 0.8, "attack": 1.0,
    })

    # MediaPipe HandLandmarker — looser confidences for smoother tracking on
    # imperfect lighting.
    max_num_hands: int = 2                # 2 required for "Both Hands Up"
    min_detection_confidence: float = 0.5
    min_presence_confidence: float = 0.5
    min_tracking_confidence: float = 0.5


# --------------------------------------------------------------------------- #
# Output / debug data
# --------------------------------------------------------------------------- #
@dataclass
class GestureEvent:
    gesture: str          # one of GESTURE_LABELS
    confidence: float     # smoothed score at confirmation, in [0, 1]
    timestamp: float      # monotonic seconds at confirmation (server stamps wall-clock)
    raw_label: str        # internal label, e.g. "open_palm" (diagnostic)
    hands: int            # number of hands detected at confirmation


@dataclass
class DebugState:
    candidate: Optional[str] = None
    confidence: float = 0.0
    stability: float = 0.0                       # 0..1 progress toward a confirmed emit
    cooldowns: dict = field(default_factory=dict)  # label -> seconds remaining
    num_hands: int = 0
    landmarks: list = field(default_factory=list)  # [[(x, y), ...per landmark], ...per hand]
    last_emit: Optional[str] = None


# --------------------------------------------------------------------------- #
# Small geometry helpers
# --------------------------------------------------------------------------- #
def _dist(a, b) -> float:
    return math.hypot(a.x - b.x, a.y - b.y)


def _clamp01(v: float) -> float:
    if v < 0.0:
        return 0.0
    if v > 1.0:
        return 1.0
    return v


def _hand_scale(lm) -> float:
    """Palm size = wrist -> middle-finger MCP. Normalizes for distance from camera."""
    return _dist(lm[WRIST], lm[MIDDLE_MCP]) + EPS


def _finger_extension(lm, tip_i: int, pip_i: int, scale: float, cfg: GestureConfig) -> float:
    """Continuous [0,1] extension for a long finger (orientation-invariant).

    Extended  => tip is farther from the wrist than its PIP joint.
    Curled    => tip is closer to the wrist than its PIP joint.
    """
    ratio = (_dist(lm[tip_i], lm[WRIST]) - _dist(lm[pip_i], lm[WRIST])) / scale
    return _clamp01((ratio - cfg.curl_lo) / (cfg.curl_hi - cfg.curl_lo))


def _thumb_extension(lm, scale: float, cfg: GestureConfig) -> float:
    """Thumb extends sideways: measure thumb-tip <-> index-MCP spread (mirror-safe)."""
    spread = _dist(lm[THUMB_TIP], lm[INDEX_MCP]) / scale
    return _clamp01((spread - cfg.thumb_lo) / (cfg.thumb_hi - cfg.thumb_lo))


def _extensions(lm, cfg: GestureConfig):
    """Return [thumb, index, middle, ring, pinky] extension ratios in [0,1]."""
    scale = _hand_scale(lm)
    ext = [_thumb_extension(lm, scale, cfg)]
    for tip_i, pip_i in _LONG_FINGERS:
        ext.append(_finger_extension(lm, tip_i, pip_i, scale, cfg))
    return ext


def _palm_spread(lm, cfg: GestureConfig) -> float:
    """How fanned-out the fingers are (rewards a deliberate, large open palm)."""
    scale = _hand_scale(lm)
    gaps = [_dist(lm[_FINGERTIPS[i]], lm[_FINGERTIPS[i + 1]]) for i in range(len(_FINGERTIPS) - 1)]
    avg = (sum(gaps) / len(gaps)) / scale
    return _clamp01(avg / cfg.spread_norm)


def _two_fingers_score(ext) -> float:
    """Peace sign / V — index + middle extended, ring + pinky curled.

    Thumb position is ignored so both tucked-thumb and out-thumb versions count.
    Returns 0 if the shape isn't clearly a "V".
    """
    _thumb, idx, mid, ring, pinky = ext
    if idx < 0.55 or mid < 0.55:
        return 0.0
    if ring > 0.42 or pinky > 0.42:
        return 0.0
    extended = (idx + mid) / 2.0
    curled = 1.0 - (ring + pinky) / 2.0
    return extended * curled


# --------------------------------------------------------------------------- #
# The detector
# --------------------------------------------------------------------------- #
class GestureDetector:
    """Stateful per-frame gesture detector built on MediaPipe HandLandmarker."""

    def __init__(self, model_path: str, config: Optional[GestureConfig] = None):
        self.cfg = config or GestureConfig()

        options = vision.HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=model_path),
            running_mode=vision.RunningMode.VIDEO,
            num_hands=self.cfg.max_num_hands,
            min_hand_detection_confidence=self.cfg.min_detection_confidence,
            min_hand_presence_confidence=self.cfg.min_presence_confidence,
            min_tracking_confidence=self.cfg.min_tracking_confidence,
        )
        self._landmarker = vision.HandLandmarker.create_from_options(options)

        self._stab: deque = deque()            # (t, label_or_None, conf, raw)
        self._last_emit: dict = {}             # label -> monotonic time of last emit
        self._last_ts_ms: int = -1             # strictly-increasing timestamp for VIDEO mode
        self._debug = DebugState()

    # -- public API -------------------------------------------------------- #
    def update(self, frame_bgr: np.ndarray, now: float) -> Optional[GestureEvent]:
        """Process one BGR frame at monotonic time `now`. Returns an event or None.

        The caller is responsible for mirroring the frame (cv2.flip) so that the
        user's "left" maps to decreasing x.
        """
        cfg = self.cfg

        # MediaPipe wants contiguous RGB uint8; convert without an OpenCV dependency.
        rgb = np.ascontiguousarray(frame_bgr[:, :, ::-1])
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

        # VIDEO mode requires strictly increasing integer millisecond timestamps.
        ts_ms = int(now * 1000)
        if ts_ms <= self._last_ts_ms:
            ts_ms = self._last_ts_ms + 1
        self._last_ts_ms = ts_ms

        result = self._landmarker.detect_for_video(mp_image, ts_ms)

        hands_lm = result.hand_landmarks or []
        num_hands = len(hands_lm)
        track_q = 0.0
        if result.handedness:
            track_q = min(cat[0].score for cat in result.handedness if cat)

        ext_hands = [_extensions(lm, cfg) for lm in hands_lm]

        # --- static gesture confidences (evaluate EVERY hand, take the best)
        # The detector treats left and right hands symmetrically — whichever
        # hand shows the clearest gesture wins.
        conf_palm = conf_fist = conf_two = 0.0
        for i, e in enumerate(ext_hands):
            mean_ext = sum(e) / 5.0
            p = track_q * mean_ext * (0.8 + 0.2 * _palm_spread(hands_lm[i], cfg))
            # Relax thumb check for open palm: long fingers must be open, thumb can be relaxed
            if min(e[1:]) < cfg.palm_min_ext:
                p = 0.0
            f = track_q * (sum(1.0 - x for x in e) / 5.0)
            # Relax thumb check for fist: long fingers must be curled, thumb can be up to 0.65 open
            if max(e[1:]) > cfg.fist_max_ext or e[0] > 0.65:
                f = 0.0
            t = _two_fingers_score(e) * track_q
            if p > conf_palm: conf_palm = p
            if f > conf_fist: conf_fist = f
            if t > conf_two:  conf_two  = t

        conf_forest = 0.0
        if num_hands == 2:
            h0, h1 = hands_lm[0], hands_lm[1]
            height = min(self._height_score(h0), self._height_score(h1))
            openness = min(sum(ext_hands[0]) / 5.0, sum(ext_hands[1]) / 5.0)
            openness = min(max(openness, cfg.forest_open_floor), 1.0)
            conf_forest = track_q * height * openness

        # --- conflict resolution: Forest > Two-fingers > (Palm | Fist) -----
        # Two-fingers is checked before palm/fist because the gating in
        # _two_fingers_score already excludes both — but listing it explicitly
        # makes the priority obvious.
        candidates = {}
        if num_hands == 2 and conf_forest > cfg.confidence_threshold:
            candidates["forest"] = (conf_forest, "both_hands_up")
        else:
            if conf_two > cfg.confidence_threshold:
                candidates["wind"] = (conf_two, "two_fingers")
            if conf_palm > cfg.confidence_threshold:
                candidates["rain"] = (conf_palm, "open_palm")
            if conf_fist > cfg.confidence_threshold:
                candidates["attack"] = (conf_fist, "fist")

        best_label, best_conf, best_raw = None, 0.0, ""
        for lbl, (c, raw) in candidates.items():
            if c > best_conf:
                best_label, best_conf, best_raw = lbl, c, raw

        # --- stability buffer (time-based ring) ----------------------------
        self._stab.append((now, best_label, best_conf, best_raw))
        while self._stab and now - self._stab[0][0] > cfg.stable_seconds:
            self._stab.popleft()

        self._refresh_debug(best_label, best_conf, num_hands, hands_lm, now)

        stable_label, stable_conf, stable_raw = self._stable_winner()
        if stable_label and self._can_emit(stable_label, now):
            return self._emit(stable_label, stable_conf, stable_raw, num_hands, now)
        return None

    @property
    def debug_state(self) -> DebugState:
        return self._debug

    def reset(self) -> None:
        """Clear stability history (e.g. after a camera dropout). Keeps cooldowns."""
        self._stab.clear()

    def close(self) -> None:
        try:
            self._landmarker.close()
        except Exception:  # noqa: BLE001
            pass

    # -- internals --------------------------------------------------------- #
    def _height_score(self, lm) -> float:
        # y grows downward; a small wrist.y means the hand is high in the frame.
        return _clamp01((self.cfg.raise_y - lm[WRIST].y) / self.cfg.raise_y)

    def _stable_winner(self):
        recent = list(self._stab)
        if not recent:
            return (None, 0.0, "")
        # Need a near-full window of history before we trust it.
        if recent[-1][0] - recent[0][0] < self.cfg.stable_seconds * 0.8:
            return (None, 0.0, "")

        total = len(recent)
        counts, confs, raws = {}, {}, {}
        for _t, lbl, c, raw in recent:
            if lbl is None:
                continue
            counts[lbl] = counts.get(lbl, 0) + 1
            confs.setdefault(lbl, []).append(c)
            raws[lbl] = raw
        if not counts:
            return (None, 0.0, "")

        lbl = max(counts, key=counts.get)
        if counts[lbl] / total >= self.cfg.stability_frac:
            mean_c = sum(confs[lbl]) / len(confs[lbl])
            if mean_c > self.cfg.confidence_threshold:
                return (lbl, mean_c, raws[lbl])
        return (None, 0.0, "")

    def _can_emit(self, label: str, now: float) -> bool:
        return now - self._last_emit.get(label, -1e9) >= self.cfg.cooldown.get(label, 1.0)

    def _emit(self, label, conf, raw, num_hands, now) -> GestureEvent:
        self._last_emit[label] = now
        # One gesture == one event: clear the stability buffer that produced it.
        self._stab.clear()
        self._debug.last_emit = label
        return GestureEvent(
            gesture=label,
            confidence=round(float(conf), 4),
            timestamp=now,
            raw_label=raw,
            hands=num_hands,
        )

    def _refresh_debug(self, candidate, conf, num_hands, hands_lm, now) -> None:
        d = self._debug
        d.candidate = candidate
        d.confidence = conf
        d.num_hands = num_hands

        recent = list(self._stab)
        if candidate and recent:
            match = sum(1 for r in recent if r[1] == candidate)
            span = recent[-1][0] - recent[0][0]
            d.stability = _clamp01(min(span / self.cfg.stable_seconds, 1.0) * (match / len(recent)))
        else:
            d.stability = 0.0

        d.cooldowns = {
            lbl: max(0.0, self.cfg.cooldown.get(lbl, 1.0) - (now - self._last_emit.get(lbl, -1e9)))
            for lbl in GESTURE_LABELS
        }
        d.landmarks = [[(p.x, p.y) for p in lm] for lm in hands_lm]
