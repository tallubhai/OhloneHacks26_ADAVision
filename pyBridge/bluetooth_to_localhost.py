#!/usr/bin/env python3
"""Minimal serial → HTTP bridge for Arduino Bluetooth SPP.

Reads simple lines from a COM port, parses the four prefix types documented
in `arduino/arduino.ino` and POSTs a small JSON payload to a web endpoint.

Usage examples:
  python bluetooth_to_localhost.py --port COM5
  python bluetooth_to_localhost.py --list-ports

This file intentionally keeps logic small and readable.
"""

import argparse
import json
import sys
import time
from urllib import request, error

import serial
from serial.tools import list_ports


def list_ports():
    for p in list_ports.comports():
        print(f"{p.device}\t{p.description}")


def parse_and_normalize(line, offset_in=3.5):
    s = line.strip()
    if not s:
        return None
    first = s[0]
    if first == "*" and "|" in s:
        try:
            a, d = s[1:].split("|", 1)
            return {"type": "combined", "ramp_angle": round(float(a), 2), "door_width": round(float(d) / 2.54 + offset_in, 2), "raw": s}
        except Exception:
            return None
    try:
        v = float(s[1:])
    except Exception:
        return None
    if first in ("|", "*", "$"):
        return {"type": "distance", "door_width": round(v / 2.54 + offset_in, 2), "raw": s}
    if first == "~":
        return {"type": "angle", "ramp_angle": round(v, 2), "raw": s}
    return None


def post_json(endpoint: str, payload: dict) -> None:
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(endpoint, data=data, headers={"Content-Type": "application/json"})
    with request.urlopen(req, timeout=8) as resp:
        # read to complete request; ignore content
        resp.read()


def try_open_and_match(port_name, baud, sniff_s, offset_in):
    try:
        with serial.Serial(port_name, baud, timeout=0.5) as ser:
            end = time.time() + sniff_s
            while time.time() < end:
                b = ser.readline()
                if not b:
                    continue
                try:
                    t = b.decode("utf-8", errors="replace").strip()
                except Exception:
                    continue
                if parse_and_normalize(t, offset_in=offset_in) is not None:
                    return True
    except Exception:
        return False
    return False


def discover_rx_port(baud, sniff_s, bt_filter, exclude_ports, offset_in):
    ports = list(list_ports.comports())
    if not ports:
        raise RuntimeError("No COM ports found")
    excl = {p.upper() for p in exclude_ports}
    candidates = []
    for p in ports:
        if p.device.upper() in excl:
            continue
        d = (p.description or "").lower()
        h = (p.hwid or "").lower()
        m = (getattr(p, "manufacturer", "") or "").lower()
        # skip USB-upload/programming ports
        if any(x in d or x in h or x in m for x in ("arduino", "ch340", "cp210", "ftdi", "usb serial")):
            continue
        if bt_filter and bt_filter.lower() not in (" ".join([p.device or "", p.description or "", p.hwid or "", getattr(p, "manufacturer", "") or ""]).lower()):
            continue
        candidates.append(p)
    if not candidates:
        raise RuntimeError("No candidate ports after filtering; run --list-ports")
    # prefer ones mentioning bluetooth
    for p in candidates:
        if any("bluetooth" in s for s in ((p.description or "").lower(), (p.hwid or "").lower(), (getattr(p, "manufacturer", "") or "").lower())):
            if try_open_and_match(p.device, baud, sniff_s, offset_in):
                return p.device
    for p in candidates:
        if try_open_and_match(p.device, baud, sniff_s, offset_in):
            return p.device
    raise RuntimeError("Could not detect RX port automatically; pass --port")


def main() -> int:
    p = argparse.ArgumentParser(description="Minimal serial → HTTP bridge")
    p.add_argument("--port", help="COM port (e.g. COM5). If omitted, auto-detects the RX port when safe.")
    p.add_argument("--baud", type=int, default=9600)
    p.add_argument("--endpoint", default="http://127.0.0.1:8787/api/sensors/ingest")
    p.add_argument("--door-offset-in", type=float, default=3.5)
    p.add_argument("--list-ports", action="store_true")
    p.add_argument("--sniff-timeout", type=float, default=3.0, help="Seconds to sniff each candidate port when auto-detecting")
    p.add_argument("--bt-filter", default="", help="Optional substring to filter Bluetooth candidates by device/description")
    p.add_argument("--exclude-port", action="append", default=[], help="COM port to exclude when auto-detecting (can be used multiple times)")
    args = p.parse_args()

    if args.list_ports:
        list_ports()
        return 0

    selected_port = args.port
    if not selected_port:
        try:
            selected_port = discover_rx_port(
                baud=args.baud,
                sniff_s=args.sniff_timeout,
                bt_filter=args.bt_filter,
                exclude_ports=set(args.exclude_port),
                offset_in=args.door_offset_in,
            )
            print(f"[bridge] Auto-selected RX port: {selected_port}")
        except RuntimeError as e:
            print(f"[fatal] {e}")
            return 2

    try:
        ser = serial.Serial(selected_port, args.baud, timeout=1)
    except serial.SerialException as e:
        print(f"Failed to open {selected_port}: {e}")
        return 1
    print(f"Listening on {selected_port} @ {args.baud}... Ctrl-C to stop")
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
