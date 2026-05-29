"""test_client.py — standalone WebSocket client for the Earth Guardian gesture server.

Connects to the running server and pretty-prints every JSON message. Use it to
verify the full wire path (hello / health / gesture) without Unity.

Usage:
    python test_client.py                  # connects to ws://127.0.0.1:8765
    python test_client.py --host 0.0.0.0 --port 8765
"""

from __future__ import annotations

import argparse
import asyncio
import json

from websockets.asyncio.client import connect


async def run(uri: str) -> None:
    print(f"Connecting to {uri} ...")
    async with connect(uri) as ws:
        print("Connected. Waiting for messages (Ctrl-C to quit).\n")
        async for msg in ws:
            try:
                data = json.loads(msg)
            except (ValueError, TypeError):
                print("RAW:", msg)
                continue

            kind = data.get("type")
            if kind == "gesture":
                print(f"  GESTURE  {data.get('gesture',''):7} "
                      f"conf={data.get('confidence', 0):.2f}  "
                      f"seq={data.get('seq')}  hands={data.get('hands')}")
            elif kind == "health":
                print(f"  health   cam={data.get('camera_ok')}  fps={data.get('fps')}  "
                      f"frames={data.get('frames_processed')}  last={data.get('last_gesture')}")
            elif kind == "hello":
                print(f"  hello    gestures={data.get('gestures')}  cam_ok={data.get('camera_ok')}")
            else:
                print("  ", msg)


def main() -> None:
    p = argparse.ArgumentParser(description="Earth Guardian WebSocket test client")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    args = p.parse_args()

    connect_host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
    try:
        asyncio.run(run(f"ws://{connect_host}:{args.port}"))
    except KeyboardInterrupt:
        print("\nBye.")


if __name__ == "__main__":
    main()
