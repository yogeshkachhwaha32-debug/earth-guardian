"""Download the MediaPipe HandLandmarker model once and cache it locally.

The Tasks API (HandLandmarker) needs a `.task` model file that is NOT bundled
with the mediapipe wheel. For a museum/installation build we ship it locally so
the experience never depends on a live network at runtime.

Usage:
    python download_model.py
"""

import os
import sys
import urllib.request

# Official Google-hosted MediaPipe hand_landmarker model (float16, bundle v1).
MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
)

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(HERE, "models", "hand_landmarker.task")


def main() -> int:
    os.makedirs(os.path.dirname(DEST), exist_ok=True)

    if os.path.exists(DEST) and os.path.getsize(DEST) > 0:
        print(f"Model already present: {DEST} ({os.path.getsize(DEST):,} bytes)")
        return 0

    print("Downloading hand_landmarker.task ...")
    print(f"  from {MODEL_URL}")
    print(f"  to   {DEST}")
    try:
        urllib.request.urlretrieve(MODEL_URL, DEST)
    except Exception as exc:  # noqa: BLE001 - report any network/IO failure plainly
        # Clean up a partial file so a retry starts fresh.
        if os.path.exists(DEST):
            try:
                os.remove(DEST)
            except OSError:
                pass
        print(f"ERROR: download failed: {exc}", file=sys.stderr)
        print(
            "If you are offline, download the file manually from the URL above\n"
            f"and place it at: {DEST}",
            file=sys.stderr,
        )
        return 1

    size = os.path.getsize(DEST)
    if size == 0:
        print("ERROR: downloaded file is empty.", file=sys.stderr)
        return 1
    print(f"Done. Saved {size:,} bytes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
