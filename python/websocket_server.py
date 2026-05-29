"""websocket_server.py — Earth Guardian AI gesture bridge (entry point).

Runs the webcam + MediaPipe detection loop in a background daemon thread and an
asyncio `websockets` server on the main thread. Confirmed gesture events are
pushed onto a thread-safe queue and broadcast as JSON to every connected client
(Unity is the client). The two sides are decoupled by the queue, so an absent or
slow Unity client can never stall detection — and detection never stalls the
socket.

Run it (no Unity needed):
    python download_model.py                       # one-time: fetch the model
    python websocket_server.py --debug             # webcam + on-screen overlay + console events
    python websocket_server.py --test-client       # also print the wire messages in-process

Protocol (server -> client), all JSON text frames with a "type" field:
    {"type":"gesture","gesture":"rain","confidence":0.93,"timestamp":...,"seq":42,"raw_label":"open_palm","hands":1}
    {"type":"hello","server":"earth-guardian-py","protocol":1,"gestures":[...],"camera_ok":true}
    {"type":"health","camera_ok":true,"fps":28.7,"frames_processed":...,"last_gesture":"rain","uptime_s":...}
"""

from __future__ import annotations

import argparse
import asyncio
import http.server
import json
import logging
import os
import queue
import socketserver
import threading
import time
import webbrowser
from collections import deque

import cv2
import websockets
from websockets.asyncio.server import serve

from gesture_detector import GESTURE_LABELS, GestureConfig, GestureDetector, GestureEvent

LOG = logging.getLogger("earth-guardian")

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL = os.path.join(HERE, "models", "hand_landmarker.task")
WEB_DIR = os.path.normpath(os.path.join(HERE, os.pardir, "web"))

# Standard MediaPipe hand skeleton, for the debug overlay.
_HAND_CONNECTIONS = (
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (5, 9), (9, 10), (10, 11), (11, 12),
    (9, 13), (13, 14), (14, 15), (15, 16),
    (13, 17), (17, 18), (18, 19), (19, 20),
    (0, 17),
)


class CameraOpenError(Exception):
    pass


class Bridge:
    """Shared state between the vision thread and the asyncio server."""

    def __init__(self) -> None:
        self.event_queue: "queue.Queue[GestureEvent]" = queue.Queue(maxsize=64)
        self.clients: set = set()
        self.stop = threading.Event()
        self.camera_ok = False
        self.fps = 0.0
        self.frames = 0
        self.last_gesture = None
        self.seq = 0
        self.start_monotonic = time.monotonic()
        # Latest annotated webcam frame (JPEG bytes) for the browser preview stream.
        self.latest_jpeg = None
        self.jpeg_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# Camera helpers
# --------------------------------------------------------------------------- #
def open_camera(index: int, attempts: int = 5, delay: float = 1.0) -> "cv2.VideoCapture":
    backend = cv2.CAP_DSHOW if hasattr(cv2, "CAP_DSHOW") else 0  # DirectShow is fast/reliable on Windows
    for _ in range(attempts):
        cap = cv2.VideoCapture(index, backend)
        if cap.isOpened():
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
            return cap
        cap.release()
        time.sleep(delay)
    raise CameraOpenError(f"Could not open camera index {index}")


def _enqueue(bridge: Bridge, event: GestureEvent) -> None:
    """Put an event on the queue, dropping the oldest if full (freshest wins)."""
    try:
        bridge.event_queue.put_nowait(event)
    except queue.Full:
        try:
            bridge.event_queue.get_nowait()
        except queue.Empty:
            pass
        try:
            bridge.event_queue.put_nowait(event)
        except queue.Full:
            pass


# --------------------------------------------------------------------------- #
# Vision thread
# --------------------------------------------------------------------------- #
def vision_loop(bridge: Bridge, args: argparse.Namespace) -> None:
    try:
        detector = GestureDetector(args.model, GestureConfig())
    except Exception as exc:  # noqa: BLE001
        LOG.error("Failed to create HandLandmarker (%s). Did you run download_model.py?", exc)
        bridge.stop.set()
        return

    cap = None
    try:
        cap = open_camera(args.camera)
        bridge.camera_ok = cap.isOpened()
    except CameraOpenError as exc:
        LOG.warning("%s", exc)
        if args.require_camera:
            bridge.stop.set()
            detector.close()
            return
        bridge.camera_ok = False

    # Warm up the camera + one inference so the first "live" frame isn't slow.
    if bridge.camera_ok and cap is not None:
        for _ in range(5):
            cap.read()
        LOG.info("Camera %d open (%.0fx%.0f).", args.camera,
                 cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    frame_times: deque = deque(maxlen=30)
    consec_fail = 0
    next_retry = 0.0

    try:
        while not bridge.stop.is_set():
            if not bridge.camera_ok or cap is None:
                now = time.monotonic()
                if now >= next_retry:
                    next_retry = now + 2.0
                    try:
                        cap = open_camera(args.camera, attempts=1, delay=0)
                        bridge.camera_ok = cap.isOpened()
                        if bridge.camera_ok:
                            LOG.info("Camera recovered.")
                            detector.reset()
                    except CameraOpenError:
                        bridge.camera_ok = False
                time.sleep(0.1)
                continue

            ok, frame = cap.read()
            if not ok:
                consec_fail += 1
                if consec_fail >= 10:
                    LOG.warning("Camera dropout; will reopen.")
                    cap.release()
                    cap = None
                    bridge.camera_ok = False
                    detector.reset()
                    consec_fail = 0
                continue
            consec_fail = 0

            frame = cv2.flip(frame, 1)               # mirror once -> user-left = decreasing x
            now = time.monotonic()
            try:
                event = detector.update(frame, now)
            except Exception as exc:  # noqa: BLE001
                LOG.exception("detector.update failed: %s", exc)
                event = None

            bridge.frames += 1
            frame_times.append(now)
            if len(frame_times) >= 2:
                span = frame_times[-1] - frame_times[0]
                if span > 0:
                    bridge.fps = (len(frame_times) - 1) / span

            if event is not None:
                bridge.last_gesture = event.gesture
                LOG.info("GESTURE  %-7s conf=%.2f hands=%d", event.gesture, event.confidence, event.hands)
                _enqueue(bridge, event)

            if args.web:
                _update_preview(bridge, frame, detector.debug_state)

            if args.debug:
                _draw_overlay(frame, detector.debug_state, bridge)
                cv2.imshow("Earth Guardian - Debug", frame)
                if (cv2.waitKey(1) & 0xFF) == ord("q"):
                    bridge.stop.set()
    finally:
        if cap is not None:
            cap.release()
        detector.close()
        if args.debug:
            cv2.destroyAllWindows()
        LOG.info("Vision thread stopped.")


def _draw_overlay(frame, dbg, bridge: Bridge) -> None:
    h, w = frame.shape[:2]
    for hand in dbg.landmarks:
        pts = [(int(x * w), int(y * h)) for (x, y) in hand]
        for a, b in _HAND_CONNECTIONS:
            if a < len(pts) and b < len(pts):
                cv2.line(frame, pts[a], pts[b], (0, 230, 0), 2)
        for p in pts:
            cv2.circle(frame, p, 4, (0, 200, 255), -1)

    cv2.putText(frame, f"candidate: {dbg.candidate or '-'}  conf: {dbg.confidence:.2f}",
                (10, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

    # Stability bar (fills toward a confirmed emit).
    bx, by, bw = 10, 40, 200
    cv2.rectangle(frame, (bx, by), (bx + bw, by + 14), (70, 70, 70), 1)
    cv2.rectangle(frame, (bx, by), (bx + int(bw * dbg.stability), by + 14), (0, 230, 0), -1)
    cv2.putText(frame, "stability", (bx + bw + 8, by + 12),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 200, 200), 1)

    yy = 80
    for lbl in GESTURE_LABELS:
        rem = dbg.cooldowns.get(lbl, 0.0)
        text = f"{lbl}: " + (f"cooldown {rem:.1f}s" if rem > 0 else "ready")
        color = (0, 0, 255) if rem > 0 else (0, 230, 0)
        cv2.putText(frame, text, (10, yy), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
        yy += 20

    if dbg.last_emit:
        cv2.putText(frame, f"last: {dbg.last_emit}", (10, yy + 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)

    cam = "ok" if bridge.camera_ok else "NO CAMERA"
    cv2.putText(frame, f"fps:{bridge.fps:.0f}  clients:{len(bridge.clients)}  cam:{cam}",
                (10, h - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 0), 1)


def _draw_landmarks(frame, dbg) -> None:
    """Light overlay (skeleton only) for the small in-browser webcam preview."""
    h, w = frame.shape[:2]
    for hand in dbg.landmarks:
        pts = [(int(x * w), int(y * h)) for (x, y) in hand]
        for a, b in _HAND_CONNECTIONS:
            if a < len(pts) and b < len(pts):
                cv2.line(frame, pts[a], pts[b], (0, 255, 180), 2)
        for p in pts:
            cv2.circle(frame, p, 4, (0, 220, 255), -1)


def _update_preview(bridge: Bridge, frame, dbg) -> None:
    """Encode a downscaled frame with a skeleton overlay to JPEG for the MJPEG browser stream.

    This draws the hand landmarks on the in-game preview so the player has immediate visual feedback
    about whether the AI is tracking their hands.
    """
    try:
        small = cv2.resize(frame, (480, 270))
        _draw_landmarks(small, dbg)
        ok, buf = cv2.imencode(".jpg", small, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        if ok:
            with bridge.jpeg_lock:
                bridge.latest_jpeg = buf.tobytes()
    except Exception:  # noqa: BLE001 - preview must never crash the vision loop
        pass


# --------------------------------------------------------------------------- #
# Static web server + MJPEG webcam stream (serves the cinematic browser game)
# --------------------------------------------------------------------------- #
class _WebServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


class _WebHandler(http.server.SimpleHTTPRequestHandler):
    bridge: "Bridge" = None
    directory_path: str = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=self.directory_path, **kwargs)

    def log_message(self, *args):  # silence per-request console spam
        pass

    def do_GET(self):
        if self.path.split("?")[0] == "/stream":
            self._serve_stream()
            return
        super().do_GET()

    def _serve_stream(self):
        b = type(self).bridge
        self.send_response(200)
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()
        try:
            while b is not None and not b.stop.is_set():
                with b.jpeg_lock:
                    data = b.latest_jpeg
                if not data:
                    time.sleep(0.05)
                    continue
                self.wfile.write(b"--frame\r\n")
                self.wfile.write(b"Content-Type: image/jpeg\r\n")
                self.wfile.write(f"Content-Length: {len(data)}\r\n\r\n".encode())
                self.wfile.write(data)
                self.wfile.write(b"\r\n")
                time.sleep(1 / 20)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


def start_web_server(bridge: Bridge, web_dir: str, port: int) -> "_WebServer":
    handler = type("BoundWebHandler", (_WebHandler,),
                   {"bridge": bridge, "directory_path": web_dir})
    httpd = _WebServer(("", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True, name="web").start()
    return httpd


# --------------------------------------------------------------------------- #
# WebSocket server (asyncio, main thread)
# --------------------------------------------------------------------------- #
def _hello(bridge: Bridge) -> str:
    return json.dumps({
        "type": "hello",
        "server": "earth-guardian-py",
        "version": "1.0.0",
        "protocol": 1,
        "gestures": list(GESTURE_LABELS),
        "camera_ok": bridge.camera_ok,
        "timestamp": time.time(),
    })


def _health(bridge: Bridge) -> str:
    return json.dumps({
        "type": "health",
        "camera_ok": bridge.camera_ok,
        "fps": round(bridge.fps, 1),
        "frames_processed": bridge.frames,
        "last_gesture": bridge.last_gesture,
        "clients": len(bridge.clients),
        "uptime_s": round(time.monotonic() - bridge.start_monotonic, 1),
        "timestamp": time.time(),
    })


def _event_to_wire(bridge: Bridge, event: GestureEvent) -> str:
    bridge.seq += 1
    return json.dumps({
        "type": "gesture",
        "gesture": event.gesture,
        "confidence": event.confidence,
        "timestamp": time.time(),          # wall-clock so Unity can age out stale triggers
        "seq": bridge.seq,
        "raw_label": event.raw_label,
        "hands": event.hands,
    })


async def _handler(bridge: Bridge, ws) -> None:
    bridge.clients.add(ws)
    peer = getattr(ws, "remote_address", None)
    LOG.info("Client connected: %s (total %d)", peer, len(bridge.clients))
    try:
        await ws.send(_hello(bridge))
        async for msg in ws:                # inbound is optional; handle a couple of control msgs
            try:
                data = json.loads(msg)
            except (ValueError, TypeError):
                continue
            if data.get("type") == "ping":
                await ws.send(json.dumps({"type": "pong", "timestamp": time.time()}))
    except websockets.ConnectionClosed:
        pass
    finally:
        bridge.clients.discard(ws)
        LOG.info("Client disconnected: %s (total %d)", peer, len(bridge.clients))


async def _broadcast(bridge: Bridge, text: str) -> None:
    if not bridge.clients:
        return
    dead = []

    async def _send(ws):
        try:
            await ws.send(text)
        except Exception:  # noqa: BLE001 - prune any client that errors on send
            dead.append(ws)

    await asyncio.gather(*[_send(ws) for ws in list(bridge.clients)])
    for ws in dead:
        bridge.clients.discard(ws)


async def _queue_drain(bridge: Bridge) -> None:
    while not bridge.stop.is_set():
        try:
            event = bridge.event_queue.get_nowait()
        except queue.Empty:
            await asyncio.sleep(0.005)
            continue
        await _broadcast(bridge, _event_to_wire(bridge, event))


async def _heartbeat(bridge: Bridge) -> None:
    while not bridge.stop.is_set():
        await _broadcast(bridge, _health(bridge))
        await asyncio.sleep(5.0)


async def _run_test_client(host: str, port: int) -> None:
    from websockets.asyncio.client import connect
    connect_host = "127.0.0.1" if host == "0.0.0.0" else host
    uri = f"ws://{connect_host}:{port}"
    await asyncio.sleep(0.5)
    try:
        async with connect(uri) as ws:
            LOG.info("[test-client] connected to %s", uri)
            async for msg in ws:
                LOG.info("[test-client] %s", msg)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        LOG.warning("[test-client] error: %s", exc)


async def _auto_stop(bridge: Bridge, seconds: float) -> None:
    await asyncio.sleep(seconds)
    LOG.info("Self-test window elapsed (%.1fs); stopping.", seconds)
    bridge.stop.set()


async def _main_async(bridge: Bridge, args: argparse.Namespace) -> None:
    vt = threading.Thread(target=vision_loop, args=(bridge, args), daemon=True, name="vision")
    vt.start()

    async with serve(lambda ws: _handler(bridge, ws), args.host, args.port,
                     ping_interval=20, ping_timeout=20):
        LOG.info("WebSocket server on ws://%s:%d (Unity connects here).", args.host, args.port)
        tasks = [
            asyncio.create_task(_queue_drain(bridge)),
            asyncio.create_task(_heartbeat(bridge)),
        ]
        if args.test_client:
            tasks.append(asyncio.create_task(_run_test_client(args.host, args.port)))
        if args.selftest_seconds > 0:
            tasks.append(asyncio.create_task(_auto_stop(bridge, args.selftest_seconds)))

        try:
            while not bridge.stop.is_set():
                await asyncio.sleep(0.2)
        finally:
            bridge.stop.set()
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Earth Guardian AI - gesture WebSocket server")
    p.add_argument("--host", default="127.0.0.1", help="bind host (use 0.0.0.0 for Unity on another machine)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--camera", type=int, default=0, help="webcam index")
    p.add_argument("--model", default=DEFAULT_MODEL, help="path to hand_landmarker.task")
    p.add_argument("--debug", action="store_true", help="show the OpenCV overlay window")
    p.add_argument("--log-only", dest="log_only", action="store_true",
                   help="(default behavior) run without a client; events go to the console")
    p.add_argument("--test-client", dest="test_client", action="store_true",
                   help="spawn an in-process WS client that prints every message")
    p.add_argument("--require-camera", dest="require_camera", action="store_true",
                   help="exit if the camera cannot be opened (default: keep running, retry)")
    p.add_argument("--web", action="store_true",
                   help="serve the cinematic browser game (+ webcam preview) and open it")
    p.add_argument("--web-port", dest="web_port", type=int, default=8000,
                   help="port for the web UI (default 8000)")
    p.add_argument("--no-open", dest="no_open", action="store_true",
                   help="do not auto-open the browser when using --web")
    p.add_argument("--selftest-seconds", dest="selftest_seconds", type=float, default=0.0,
                   help="auto-stop after N seconds (for headless self-tests)")
    p.add_argument("--verbose", action="store_true")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    if not os.path.exists(args.model):
        LOG.error("Model file not found: %s", args.model)
        LOG.error("Run:  python download_model.py")
        return

    bridge = Bridge()

    httpd = None
    if args.web:
        if not os.path.isdir(WEB_DIR):
            LOG.error("Web directory not found: %s", WEB_DIR)
        else:
            try:
                httpd = start_web_server(bridge, WEB_DIR, args.web_port)
                # Use 127.0.0.1 (not "localhost") so the browser hits the IPv4
                # server directly and never trips an IPv6 ::1 resolution miss.
                url = f"http://127.0.0.1:{args.web_port}/"
                LOG.info("Cinematic web game on %s", url)
                if not args.no_open:
                    webbrowser.open(url)
            except OSError as exc:
                LOG.error("Could not start web server on port %d: %s", args.web_port, exc)

    try:
        asyncio.run(_main_async(bridge, args))
    except KeyboardInterrupt:
        LOG.info("Interrupted.")
    finally:
        bridge.stop.set()
        if httpd is not None:
            httpd.shutdown()
        time.sleep(0.3)   # let the daemon vision thread release the camera cleanly
    LOG.info("Shut down cleanly.")


if __name__ == "__main__":
    main()
