pyBridge Bluetooth → Localhost Bridge

Purpose
- A minimal Python bridge that reads serial lines from a Bluetooth SPP COM port (as produced by the Arduino sketch in `arduino/arduino.ino`) and POSTs simple JSON payloads to a local ingest endpoint.

Quick usage
- Install dependency:

```bash
pip install pyserial
```

- List COM ports:

```bash
python pyBridge/bluetooth_to_localhost.py --list-ports
```

- Run the bridge (replace `COM5`):

```bash
python pyBridge/bluetooth_to_localhost.py --port COM5
```

Default endpoint: `http://127.0.0.1:8787/api/sensors/ingest`
Default door offset: `3.5` inches (use `--door-offset-in` to change)

How it works (overview)
- The Arduino firmware emits short lines whose format is one of:
  - `|<distance_cm>`  (door width)
  - `*<distance_cm>`  (door height)
  - `$<distance_cm>`  (path width)
  - `~<angle>`        (ramp angle)
  - or the combined form `*<angle>|<distance>` (optional unified stream)

- The bridge reads each line, parses the prefix and numeric value(s), converts distances from cm → inches and adds the configured offset, then sends a compact JSON object to the HTTP endpoint.

File and function reference
- `pyBridge/bluetooth_to_localhost.py` — main bridge script. Key functions:
  - `list_ports()`
    - Prints available COM ports (device and description). Useful to discover the Bluetooth COM port to use with `--port`.
  - `parse_and_normalize(line: str, offset_in: float = 3.5) -> dict | None`
    - Parses a single serial `line` from the Arduino and returns a normalized `dict` payload or `None` if the line is unrecognized.
    - Handles the four single-prefix formats (`|`, `*`, `$`, `~`) and the combined `*angle|distance` form.
    - For distance formats it converts centimeters → inches and applies `offset_in` (default 3.5 in).
    - Returned payload examples:
      - Distance: `{"type":"distance","door_width": 28.34, "raw":"|72.0"}`
      - Angle:    `{"type":"angle","ramp_angle": 6.25, "raw":"~6.25"}`
      - Combined: `{"type":"combined","ramp_angle":6.25,"door_width":28.34,"raw":"*6.25|72.0"}`
  - `post_json(endpoint: str, payload: dict) -> None`
    - Performs a blocking HTTP POST (JSON) to the configured `endpoint`.
    - Uses a short timeout and ignores response body (treats non-network errors as retryable by caller).
  - `main()`
    - CLI entrypoint: parses flags (`--port`, `--baud`, `--endpoint`, `--door-offset-in`, `--list-ports`) and runs the read → parse → post loop.
    - On each valid parse, it augments payload with `source` and posts it.

Payload and server expectations
- The bridge sends small JSON objects with fields like `ramp_angle`, `door_width`, `type`, `raw`, and `source` depending on the parsed line.
- The server ingest endpoint should accept these fields; the bridge does not perform strict server-side validation itself.

Notes and next steps
- The parser is intentionally simple and permissive: invalid or unrecognized lines are skipped and logged.
- Recommended next steps: add a small unit test for `parse_and_normalize()` (I can add this if you want), and run a dry-run with a simulated serial input or the real device to confirm behavior.

Reference: Arduino sketch serial formats in `arduino/arduino.ino`
