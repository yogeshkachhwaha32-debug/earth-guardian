# Earth Guardian AI — Python Gesture Layer

Real-time webcam hand-gesture detection that streams **gesture events** to Unity
(or any client) over a WebSocket. This is the foundation of the Earth Guardian AI
experience — built and runnable **without Unity** so you can tune detection first.

It detects the spec's **four** gestures and maps each to a power:

| Gesture        | Event      | Power               |
|----------------|------------|---------------------|
| Open Palm      | `rain`     | Rain Power          |
| Both Hands Up  | `forest`   | Forest Growth       |
| Swipe Left     | `wind`     | Wind Blast          |
| Fist           | `attack`   | Attack Pollution Boss |

A gesture only fires when **confidence > 0.8**, held **stable for ~0.5 s**, and
the per-gesture **cooldown** has elapsed (the swipe is its own 0.4 s motion window).

## Requirements

- **Python 3.12** (verified). A webcam.
- Packages (already present in your global env; reinstall elsewhere with):
  ```
  pip install -r requirements.txt
  ```
  Built on the MediaPipe **Tasks API** (`HandLandmarker`) — the legacy
  `mp.solutions.hands` API is removed in mediapipe ≥ 0.10.35.

## Setup

```powershell
# 1) Fetch the hand-tracking model once (~7 MB) into models/hand_landmarker.task
python download_model.py
```

## ▶ Play the cinematic game (one command)

```powershell
python websocket_server.py --web
```

This launches everything: webcam gesture detection **and** the full cinematic
browser game (it auto-opens at `http://localhost:8000/`). Click **BEGIN**,
then heal the dying Earth with your hands:

- 🖐️ **Open Palm** → Rain (heal)
- 🙌 **Both Hands Up** → Forest growth (heal more)
- 👈 **Swipe Left** → Wind blast (clear smog / hit the Titan)
- ✊ **Fist** → Strike the **Pollution Titan** (appears at 50% vitality)

A small live webcam preview (corner) shows your hand skeleton so you can see
gestures register. No camera? Keyboard **1/2/3/4** (or R/F/W/A) trigger the
powers for testing. `Ctrl-C` in the terminal shuts everything down cleanly.

## Other run modes (detection only / tuning)

```powershell
# Tune gestures: OpenCV window with landmarks, live confidence, stability bar,
# cooldown readout; every confirmed gesture is logged to the console.
python websocket_server.py --debug

# Both at once — game in the browser AND the tuning overlay window:
python websocket_server.py --web --debug

# Verify the WebSocket wire path in-process (prints hello/health/gesture):
python websocket_server.py --debug --test-client
```

The browser game is the WebSocket **client**; a Unity client can connect to the
same `ws://127.0.0.1:8765` later. In the `--debug` window press **q** to quit.

## Test without Unity (second terminal)

```powershell
# Terminal 1
python websocket_server.py

# Terminal 2 — connect and print everything the server sends
python test_client.py
```

You can also use the bundled CLI client from the `websockets` package:
```powershell
python -m websockets ws://127.0.0.1:8765
```

## WebSocket protocol (server → client)

All messages are JSON text frames with a `type` field.

```jsonc
// emitted once per confirmed gesture
{"type":"gesture","gesture":"rain","confidence":0.93,"timestamp":1769612345.12,"seq":42,"raw_label":"open_palm","hands":1}

// sent immediately on connect
{"type":"hello","server":"earth-guardian-py","protocol":1,"gestures":["rain","forest","wind","attack"],"camera_ok":true}

// broadcast every 5 s
{"type":"health","camera_ok":true,"fps":28.7,"frames_processed":8123,"last_gesture":"rain","uptime_s":287.4}
```

`gesture` is always one of `rain | forest | wind | attack` — that string is the
contract Unity's `GameEventManager` switches on. Transport keep-alive uses the
WebSocket ping/pong (`ping_interval=20`); the `health` message is app-level status.

The server keeps running with **zero clients** and survives client
disconnect/reconnect and webcam unplug/replug (it reports `camera_ok:false`
while the camera is gone, then recovers).

## CLI options

| Flag | Default | Purpose |
|------|---------|---------|
| `--host` | `127.0.0.1` | bind host; use `0.0.0.0` if Unity is on another machine |
| `--port` | `8765` | server port |
| `--camera` | `0` | webcam index (try `1`, `2`, ... if `0` is a virtual cam) |
| `--model` | `models/hand_landmarker.task` | model path |
| `--web` | off | serve the cinematic browser game + webcam preview, auto-open it |
| `--web-port` | `8000` | port for the web game |
| `--no-open` | off | don't auto-open the browser |
| `--debug` | off | show the OpenCV overlay window |
| `--test-client` | off | spawn an in-process client that prints messages |
| `--require-camera` | off | exit if the camera can't open (default: keep retrying) |
| `--selftest-seconds N` | `0` | auto-stop after N seconds (headless self-tests) |
| `--verbose` | off | DEBUG logging |

## Tuning

Every threshold lives in `GestureConfig` (`gesture_detector.py`) — a single
tuning surface. Watch the `--debug` overlay and adjust:
- Gesture won't fire → lower `confidence_threshold` or `palm_min_ext`, or raise
  the relevant window.
- Cross-triggering (palm vs fist) → widen the `palm_min_ext` / `fist_max_ext`
  dead-zone.
- Swipe too eager/sluggish → tune `swipe_min_dx`, `swipe_min_vx`, `swipe_max_vx`.

## Files

| File | Role |
|------|------|
| `gesture_detector.py` | Pure detection: `HandLandmarker`, landmark geometry, confidence, stability + cooldown state machine. No networking. |
| `websocket_server.py` | Entry point: vision thread + asyncio WebSocket server + protocol + debug overlay. |
| `download_model.py` | One-time model download into `models/`. |
| `test_client.py` | Standalone WebSocket client for testing. |
| `requirements.txt` | Pinned-loose, verified-working dependency set. |
| `../web/` | The cinematic browser game (`index.html`, `game.js`, `audio.js`, `style.css`) — served by `--web`. |

## Troubleshooting

- **`Model file not found`** → run `python download_model.py`.
- **`ModuleNotFoundError: mediapipe.solutions`** → expected; this project uses the
  Tasks API, not the removed legacy API.
- **Black/wrong camera** → pass `--camera 1` (or 2). Index 0 may be a virtual cam
  (OBS, Iriun) if one is installed.
- **Two OpenCV builds** → keep only one of `opencv-python` / `opencv-contrib-python`
  installed to avoid a `cv2` clash.
