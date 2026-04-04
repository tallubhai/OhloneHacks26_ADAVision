#!/usr/bin/env python3
"""
@file bluetooth_to_localhost.py
@brief Hardware → JSON bridge: read Arduino lines from Bluetooth serial, validate, POST to local API.

@section purpose Purpose
The browser cannot open arbitrary Bluetooth serial ports. This script acts like a serial monitor:
it reads lines from the paired COM port, parses the hardware format, converts units, and forwards
normalized readings to the Node ingest endpoint.

@section format Expected line format (strict parser)
The function parse_line() accepts the compact combined form:
    `*<angle_degrees>|<distance_cm>`

Example:
    `*6.25|71.40`

@section door_width Door width correction
Ultrasonic sensor placement is offset from the true door edge. Inches are computed as:
    `door_width_inches = (distance_cm / 2.54) + offset_inches`
Default offset is 3.5 inches (CLI: `--door-offset-in`).

@section flow End-to-end flow
  1. Resolve COM port (`--port` or safe Bluetooth auto-discovery).
  2. Read lines until one matches parse_line().
  3. POST JSON to `http://127.0.0.1:8787/api/sensors/ingest` (default).
  4. Web app polls `/api/sensors/latest`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from urllib import error, request

import serial
from serial.tools import list_ports


def parse_line(line: str) -> tuple[float, float]:
    """
    @brief Parse a single serial line into ramp angle and distance.

    @param line Raw UTF-8 line; must look like `*<angle>|<distance_cm>`.

    @return (angle_degrees, distance_cm), each rounded to 2 decimal places.

    @raises ValueError: empty line, bad prefix, missing '|', non-numeric fields, or out-of-range values.

    @note Angle must be in (0, 89.9); distance must be positive. These checks match server validation.
    """
    raw = line.strip()
    if not raw:
        raise ValueError("Empty line")
    if not raw.startswith("*"):
        raise ValueError("Line does not start with '*'")
    if "|" not in raw:
        raise ValueError("Line missing '|' separator")

    angle_text, distance_text = raw[1:].split("|", 1)
    angle = float(angle_text.strip())
    distance_cm = float(distance_text.strip())

    if angle <= 0 or angle >= 89.9:
        raise ValueError("Angle out of expected range (0, 89.9)")
    if distance_cm <= 0:
        raise ValueError("Distance must be positive")

    return round(angle, 2), round(distance_cm, 2)


def to_door_width_inches(distance_cm: float, offset_inches: float) -> float:
    """
    @brief Convert sensor distance (cm) to clear door width in inches including mount offset.

    @param distance_cm Raw ranging result in centimeters.
    @param offset_inches Fixed correction from sensor face to measurable door plane (default 3.5).

    @return Door width in inches, 2 decimal places.
    """
    inches = (distance_cm / 2.54) + offset_inches
    return round(inches, 2)


def post_reading(endpoint: str, angle: float, door_width_inches: float, raw_line: str) -> None:
    """
    @brief POST one normalized reading to the local ingest API.

    @param endpoint Full URL (e.g. http://127.0.0.1:8787/api/sensors/ingest).
    @param angle Ramp angle in degrees.
    @param door_width_inches Corrected width in inches.
    @param raw_line Original serial line for audit/debug in the dashboard.

    @raises RuntimeError: HTTP status >= 300 after read.
    @raises urllib.error.URLError: connection errors, timeouts, etc.
    """
    payload = {
        "ramp_angle": round(angle, 2),
        "door_width": round(door_width_inches, 2),
        "source": "arduino-bluetooth-python",
        "raw": raw_line.strip()
    }
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with request.urlopen(req, timeout=8) as resp:
        _ = resp.read()
        if resp.status >= 300:
            raise RuntimeError(f"Endpoint responded with status {resp.status}")


def is_bluetooth_port(port_info: list_ports.ListPortInfo) -> bool:
    """
    @brief Heuristic: is this COM port likely the Bluetooth SPP link (not USB-FTDI upload)?

    @param port_info pySerial port metadata.

    @return True if description/hwid/manufacturer suggests Bluetooth.
    """
    desc = (port_info.description or "").lower()
    hwid = (port_info.hwid or "").lower()
    manu = (port_info.manufacturer or "").lower()
    return any(keyword in desc for keyword in ["bluetooth", "standard serial over bluetooth"]) or "bthenum" in hwid or "bluetooth" in manu


def is_likely_upload_usb_port(port_info: list_ports.ListPortInfo) -> bool:
    """
    @brief Heuristic: USB serial used for Arduino sketch upload (avoid mistaking for BT RX).

    @param port_info pySerial port metadata.

    @return True if this looks like a typical USB-UART cable/chip.
    """
    desc = (port_info.description or "").lower()
    hwid = (port_info.hwid or "").lower()
    manu = (port_info.manufacturer or "").lower()
    return any(
        key in desc or key in hwid or key in manu
        for key in ["arduino", "ch340", "cp210", "usb serial", "usb-serial", "ftdi"]
    )


def normalize_port_name(value: str) -> str:
    """
    @brief Normalize COM port name for comparison (strip, upper).
    @param value Raw port string from user or cache.
    @return Normalized name suitable for set membership checks.
    """
    return value.strip().upper()


def port_matches_filter(port_info: list_ports.ListPortInfo, filter_text: str) -> bool:
    """
    @brief Optional substring filter when several Bluetooth COM ports exist.

    @param port_info Candidate port.
    @param filter_text Case-insensitive substring matched against device, desc, hwid, manufacturer.

    @return True if filter is empty or substring matches.
    """
    needle = filter_text.lower().strip()
    if not needle:
        return True
    haystack = " ".join(
        [
            port_info.device or "",
            port_info.description or "",
            port_info.hwid or "",
            port_info.manufacturer or ""
        ]
    ).lower()
    return needle in haystack


def list_ports_with_labels() -> None:
    """
    @brief Print all COM ports with bridge labels (diagnostic / setup helper).
    """
    ports = list(list_ports.comports())
    if not ports:
        print("[bridge] No COM ports detected.")
        return
    print("[bridge] Detected COM ports:")
    for p in ports:
        labels = []
        if is_bluetooth_port(p):
            labels.append("bluetooth")
        if is_likely_upload_usb_port(p):
            labels.append("usb-upload-likely")
        label_text = ", ".join(labels) if labels else "unclassified"
        print(
            f"  - {p.device:<6} [{label_text}] "
            f"desc='{p.description or ''}' hwid='{p.hwid or ''}' manufacturer='{p.manufacturer or ''}'"
        )


def try_open_and_match(port_name: str, baud: int, timeout_s: float) -> bool:
    """
    @brief Open port briefly and return True if a valid parse_line() frame appears.

    Used to validate cached port without staying connected.

    @param port_name e.g. COM5.
    @param baud Serial speed.
    @param timeout_s Per-read timeout and outer time budget for sniffing.

    @return True if at least one line parsed successfully.
    """
    try:
        with serial.Serial(port_name, baud, timeout=timeout_s) as ser:
            start = time.time()
            while time.time() - start < timeout_s:
                line_bytes = ser.readline()
                if not line_bytes:
                    continue
                line = line_bytes.decode("utf-8", errors="replace").strip()
                try:
                    parse_line(line)
                    return True
                except ValueError:
                    continue
    except serial.SerialException:
        return False
    return False


def load_cached_port(cache_path: str) -> str | None:
    """
    @brief Load last known-good COM port from JSON cache.

    @param cache_path Filesystem path to cache file.

    @return Normalized port name or None if missing/invalid.
    """
    if not os.path.exists(cache_path):
        return None
    try:
        with open(cache_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        port = data.get("port")
        if isinstance(port, str) and port.strip():
            return normalize_port_name(port)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return None


def save_cached_port(cache_path: str, port_name: str) -> None:
    """
    @brief Persist successful port choice so next run can try it first.

    Failures are swallowed so a read-only filesystem does not kill the bridge.
    """
    try:
        cache_dir = os.path.dirname(cache_path)
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as fh:
            json.dump({"port": normalize_port_name(port_name), "savedAt": int(time.time())}, fh)
    except OSError:
        # Cache write failure should not break data bridge.
        pass


def discover_rx_port(
    baud: int,
    timeout_s: float,
    sniff_s: float,
    exclude_ports: set[str],
    bt_filter: str,
    cache_path: str
) -> str:
    """
    @brief Auto-select a Bluetooth COM port that emits parseable `*angle|distance` lines.

    @param baud Serial baud rate.
    @param timeout_s read timeout per Serial read.
    @param sniff_s Total time window to try candidates.
    @param exclude_ports COM ports user asked to skip (e.g. wired USB).
    @param bt_filter Optional substring to disambiguate multiple BT modules.
    @param cache_path Path for last-good-port JSON.

    @return Device name of chosen port (e.g. COM7).

    @raises RuntimeError: no ports, no BT match, ambiguous multi-BT without filter, or sniff timeout.
    """
    ports = list(list_ports.comports())
    if not ports:
        raise RuntimeError("No COM ports found.")

    normalized_excludes = {normalize_port_name(p) for p in exclude_ports}
    bluetooth_ports = [
        p
        for p in ports
        if is_bluetooth_port(p)
        and normalize_port_name(p.device) not in normalized_excludes
        and port_matches_filter(p, bt_filter)
    ]
    if not bluetooth_ports:
        raise RuntimeError(
            "No matching Bluetooth COM port found. Pair device first, then use --list-ports or pass --port."
        )

    cached_port = load_cached_port(cache_path)
    if cached_port and any(normalize_port_name(p.device) == cached_port for p in bluetooth_ports):
        print(f"[bridge] Trying cached port {cached_port} first...")
        if try_open_and_match(cached_port, baud, timeout_s):
            print(f"[bridge] Selected cached RX port: {cached_port}")
            return cached_port
        print(f"[bridge] Cached port {cached_port} did not produce valid data, falling back.")

    print("[bridge] Bluetooth candidates:")
    for p in bluetooth_ports:
        print(f"  - {p.device}: {p.description}")

    # Safety: opening the wrong BT port could grab a headset or another device — force user disambiguation.
    if len(bluetooth_ports) > 1 and not bt_filter and not cached_port:
        raise RuntimeError(
            "Multiple Bluetooth ports found and none cached. "
            "To avoid opening the wrong port, run with --list-ports then pass --port COMx "
            "or use --bt-filter <device-name-fragment>."
        )

    sniff_deadline = time.time() + sniff_s
    while time.time() < sniff_deadline:
        for p in bluetooth_ports:
            try:
                with serial.Serial(p.device, baud, timeout=timeout_s) as ser:
                    start = time.time()
                    while time.time() - start < timeout_s:
                        line_bytes = ser.readline()
                        if not line_bytes:
                            continue
                        line = line_bytes.decode("utf-8", errors="replace").strip()
                        try:
                            parse_line(line)
                            print(f"[bridge] Selected RX port: {p.device} (matched line '{line}')")
                            save_cached_port(cache_path, p.device)
                            return p.device
                        except ValueError:
                            continue
            except serial.SerialException:
                continue

    raise RuntimeError(
        "Could not detect a streaming Bluetooth RX port automatically. Use --port COMx."
    )


def main() -> int:
    """
    @brief CLI entry: list ports, discover, or stream-parse to HTTP ingest.
    @return Process exit code (0 success, 1 fatal error).
    """
    parser = argparse.ArgumentParser(description="Bluetooth serial to localhost bridge for ADA Vision.")
    parser.add_argument(
        "--port",
        help="Serial COM port (e.g., COM5). If omitted, auto-discovers Bluetooth RX port."
    )
    parser.add_argument("--baud", type=int, default=9600, help="Serial baud rate (default: 9600)")
    parser.add_argument(
        "--endpoint",
        default="http://127.0.0.1:8787/api/sensors/ingest",
        help="Local API endpoint for sensor ingest"
    )
    parser.add_argument(
        "--door-offset-in",
        type=float,
        default=3.5,
        help="Offset in inches from sensor to door edge (default: 3.5)"
    )
    parser.add_argument(
        "--read-timeout",
        type=float,
        default=1.0,
        help="Serial read timeout in seconds (default: 1.0)"
    )
    parser.add_argument(
        "--sniff-timeout",
        type=float,
        default=8.0,
        help="Seconds to auto-detect a Bluetooth RX stream when --port is omitted (default: 8.0)"
    )
    parser.add_argument(
        "--bt-filter",
        default="",
        help="Filter Bluetooth candidate ports by device/description fragment (recommended when multiple BT ports exist)"
    )
    parser.add_argument(
        "--cache-file",
        default=os.path.join(os.path.dirname(__file__), ".last_good_port.json"),
        help="Cache file storing last known-good RX port"
    )
    parser.add_argument(
        "--exclude-port",
        action="append",
        default=[],
        help="COM port to exclude (can be used multiple times), e.g. --exclude-port COM3"
    )
    parser.add_argument(
        "--list-ports",
        action="store_true",
        help="List COM ports with bridge labels and exit"
    )
    args = parser.parse_args()

    if args.list_ports:
        list_ports_with_labels()
        return 0

    exclude_ports = {item.upper() for item in args.exclude_port}
    selected_port = args.port.upper() if args.port else None
    if selected_port and selected_port in exclude_ports:
        print(f"[fatal] Selected --port {selected_port} is also excluded.")
        return 1

    try:
        if not selected_port:
            selected_port = discover_rx_port(
                baud=args.baud,
                timeout_s=args.read_timeout,
                sniff_s=args.sniff_timeout,
                exclude_ports=exclude_ports,
                bt_filter=args.bt_filter,
                cache_path=args.cache_file
            )
    except RuntimeError as discover_err:
        print(f"[fatal] {discover_err}")
        return 1

    print(f"[bridge] Opening serial port {selected_port} @ {args.baud}...")
    try:
        with serial.Serial(selected_port, args.baud, timeout=args.read_timeout) as ser:
            print("[bridge] Connected. Reading lines...")
            while True:
                line_bytes = ser.readline()
                if not line_bytes:
                    continue

                try:
                    line = line_bytes.decode("utf-8", errors="replace").strip()
                    angle, distance_cm = parse_line(line)
                    door_width_inches = to_door_width_inches(distance_cm, args.door_offset_in)
                    post_reading(args.endpoint, angle, door_width_inches, line)
                    print(
                        f"[ok] raw='{line}' -> angle={angle:.2f} deg, "
                        f"door={door_width_inches:.2f} in -> sent"
                    )
                except ValueError as parse_err:
                    print(f"[skip] {parse_err}")
                except (error.URLError, error.HTTPError, TimeoutError, RuntimeError) as post_err:
                    print(f"[post-error] {post_err}")
                    time.sleep(1.0)
    except serial.SerialException as serial_err:
        print(f"[fatal] Serial error: {serial_err}")
        return 1
    except KeyboardInterrupt:
        print("\n[bridge] Stopped by user.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
