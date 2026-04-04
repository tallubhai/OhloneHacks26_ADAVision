#!/usr/bin/env python3
"""Minimal serial → HTTP bridge for Arduino Bluetooth SPP.

Reads simple lines from a COM port, parses the four prefix types documented
in `arduino/arduino.ino` and POSTs a small JSON payload to a web endpoint.

Usage examples:
  python bluetooth_to_localhost.py --port COM5
  python bluetooth_to_localhost.py --list-ports

This file intentionally keeps logic small and readable.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from urllib import request, error

import serial
from serial.tools import list_ports


def list_ports():
    for p in serial.tools.list_ports.comports():
        print(f"{p.device}\t{p.description}")


def parse_and_normalize(line: str, offset_in: float = 3.5) -> dict | None:
    """Parse a line and return a dict payload or None if unrecognized.

    Supported formats from `arduino.ino`:
      - "|<distance_cm>"  (door width)
      - "*<distance_cm>"  (door height)
      - "$<distance_cm>"  (path width)
      - "~<angle>"        (ramp angle)

    Also accepts the combined form `*<angle>|<distance>` if produced.
    """
    s = line.strip()
    if not s:
        return None

    first = s[0]
    # Combined form: *angle|distance
    if first == "*" and "|" in s:
        try:
            angle_text, distance_text = s[1:].split("|", 1)
            angle = float(angle_text)
            dist_cm = float(distance_text)
        except Exception:
            return None
        return {"type": "combined", "ramp_angle": round(angle, 2), "door_width": round(dist_cm / 2.54 + offset_in, 2), "raw": s}

    try:
        value = float(s[1:])
    except Exception:
        return None

    if first in ("|", "*", "$"):
        # distance in cm -> convert to inches and add offset
        inches = round(value / 2.54 + offset_in, 2)
        return {"type": "distance", "door_width": inches, "raw": s}
    if first == "~":
        return {"type": "angle", "ramp_angle": round(value, 2), "raw": s}

    return None


def post_json(endpoint: str, payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(endpoint, data=data, headers={"Content-Type": "application/json"})
    with request.urlopen(req, timeout=8) as resp:
        # read to complete request; ignore content
        resp.read()


def main() -> int:
    p = argparse.ArgumentParser(description="Minimal serial → HTTP bridge")
    p.add_argument("--port", help="COM port (e.g. COM5). If omitted, use --list-ports to inspect available ports.")
    p.add_argument("--baud", type=int, default=9600)
    p.add_argument("--endpoint", default="http://127.0.0.1:8787/api/sensors/ingest")
    p.add_argument("--door-offset-in", type=float, default=3.5)
    p.add_argument("--list-ports", action="store_true")
    args = p.parse_args()

    if args.list_ports:
        list_ports()
        return 0

    if not args.port:
        print("Specify --port COMx or run with --list-ports to discover ports.")
        return 2

    try:
        ser = serial.Serial(args.port, args.baud, timeout=1)
    except serial.SerialException as e:
        print(f"Failed to open {args.port}: {e}")
        return 1

    print(f"Listening on {args.port} @ {args.baud}... Ctrl-C to stop")
    try:
        while True:
            raw = ser.readline()
            if not raw:
                time.sleep(0.01)
                continue
            try:
                line = raw.decode("utf-8", errors="replace").strip()
            except Exception:
                continue

            payload = parse_and_normalize(line, offset_in=args.door_offset_in)
            if payload is None:
                print(f"[skip] Unrecognized: {line}")
                continue

            # Add small metadata and send
            payload.setdefault("source", "arduino-bluetooth-py-simple")
            try:
                post_json(args.endpoint, payload)
                print(f"[sent] {payload}")
            except error.URLError as e:
                print(f"[post-error] {e}; will retry in 1s")
                time.sleep(1)
    except KeyboardInterrupt:
        print("Stopped by user")
    finally:
        ser.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
