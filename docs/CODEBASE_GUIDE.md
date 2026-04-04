# ADA Vision - Engineering Guide (3 Core Parts)

This guide intentionally avoids UI boilerplate details and focuses only on the three parts that make ADA Vision technically strong:

1. Hardware measurement pipeline  
2. Python parsing/bridge pipeline  
3. AI compliance summary pipeline

---

## 1) Hardware pipeline (Arduino + Bluetooth)

## Purpose
Capture real physical measurements for ADA checks:
- Ramp steepness (angle from level)
- Door distance/width input

## Where the hardware code lives
- `arduino/arduino.ino` (main runtime loop)
- `arduino/imu.cpp` + `arduino/imu.h` (IMU angle reading/filtering)
- `arduino/distance.cpp` + `arduino/distance.h` (distance sensor reads)
- `arduino/bt.cpp` + `arduino/bt.h` (serial/Bluetooth transport)

## Data format emitted by hardware
The Arduino sends one compact line over serial Bluetooth:

`*<angle_degrees>|<distance_cm>`

Example:

`*6.25|71.40`

This format is the hardware contract used by the rest of the system.

## Why this is important in judging
- Demonstrates real sensor integration, not mock data.
- Produces deterministic machine-readable output.
- Cleanly separates measurement capture from higher-level app logic.

---

## 2) Python parsing bridge (hardware -> website/backend)

## Purpose
The browser does **not** connect to Bluetooth directly.  
Instead, a Python bridge reads serial data like a serial monitor, validates/parses it, normalizes units, and forwards it to the local API.

## Where this code lives
- `pyBridge/bluetooth_to_localhost.py`
- `pyBridge/requirements.txt` (`pyserial`)

## Core implementation details

### A) Serial parsing
- Function: `parse_line(line)`
- Validates:
  - starts with `*`
  - contains `|`
  - numeric angle and numeric distance
  - value sanity checks (positive ranges)

### B) Unit conversion + hardware offset
- Function: `to_door_width_inches(distance_cm, offset_inches)`
- Formula:
  - `door_width_inches = (distance_cm / 2.54) + 3.5`
- Why:
  - Sensor is mounted about 3.5 inches from the true door edge.

### C) Forwarding to website/backend
- Function: `post_reading(...)`
- Sends normalized JSON to:
  - `POST http://127.0.0.1:8787/api/sensors/ingest`
- Payload includes:
  - `ramp_angle`
  - `door_width`
  - source metadata
  - raw line (for debugging traceability)

### D) Safe COM port handling (important reliability feature)
The bridge includes safety logic to avoid connecting to wrong ports:
- Detect likely Bluetooth ports
- Detect likely USB upload ports
- Optional filters and exclusions
- Cache last known good port
- Fail safely when multiple ambiguous BT ports exist

## End-to-end bridge flow
1. Read serial line from Bluetooth COM port
2. Parse `*angle|distance_cm`
3. Convert + apply offset
4. POST clean JSON to local ingest endpoint
5. Web app polls latest sensor reading and updates UI/report data

---

## 3) AI summary pipeline (compliance reasoning)

## Purpose
Turn technical measurements/report text into clear natural-language compliance explanation for judges/users.

## Where AI code lives
- Frontend caller: `web/src/services/aiSummary.js`
- Backend AI orchestration: `web/server/index.js` (`POST /api/ai/summary`)

## Model/runtime
- Provider: Local Ollama
- Endpoint: `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- Model: `OLLAMA_MODEL` (current default: `qwen2.5:0.5b`)

## How the AI call is implemented

### Frontend
- Builds/uses the latest raw inspection report
- Sends thresholds + latest numeric measurements to backend
- Uses timeout protection for failed/stuck calls

### Backend
- Constructs a strict prompt with explicit ADA pass/fail constraints:
  - Door PASS if `door_width >= minDoorWidth`
  - Ramp PASS if `slope_ratio >= minSlopeRatio`
- Injects computed pass/fail facts directly into prompt
- Instructs model not to contradict numeric facts

## Why this AI implementation is strong
- AI is grounded in numeric rules, not free-form guessing.
- Prompt logic prevents contradictory conclusions.
- Fail-safe behavior exists: if AI is unavailable, app falls back to deterministic local summary text.

---

## Runtime path (all 3 parts together)

1. Arduino emits `*angle|distance_cm`
2. Python bridge parses and normalizes data
3. Bridge posts to `/api/sensors/ingest`
4. Web app consumes latest reading from `/api/sensors/latest`
5. Report generator applies ADA threshold rules
6. AI endpoint explains results in plain language

---

## What to present (and what to ignore)

## Present these files
- `arduino/arduino.ino`
- `arduino/imu.cpp`
- `arduino/distance.cpp`
- `arduino/bt.cpp`
- `pyBridge/bluetooth_to_localhost.py`
- `web/server/index.js`
- `web/src/services/aiSummary.js`
- `web/src/App.jsx` (only for report/threshold data flow, not styling)

## Ignore during explanation
- CSS/layout polish
- package/dependency lock files
- framework bootstrap boilerplate
- generated caches/build artifacts

---

## 30-second judge script

"Our project has three real engineering layers.  
First, Arduino firmware reads ramp angle and door distance and emits compact Bluetooth serial data.  
Second, our Python bridge safely identifies the correct COM port, parses and validates that serial format, converts units with sensor offset correction, and forwards clean JSON to the local API.  
Third, our AI pipeline takes the rule-checked report and generates a plain-language ADA summary using strict numeric constraints, so the explanation stays consistent with measured data."

