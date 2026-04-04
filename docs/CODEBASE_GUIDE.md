# ADA Vision Codebase Guide (What Actually Matters)

This guide focuses on the code you actually wrote and demoed: hardware parsing, dashboard behavior, and AI generation.

---

## 1) The core idea in one sentence

Arduino sends compact sensor lines, Python parses and normalizes them, the local API stores the latest reading, and the web app turns that into ADA checks + reports + AI explanation.

---

## 2) The only folders you need to present

## `arduino/` - device-side sensor output
- Purpose: collect sensor values and emit serial lines.
- Output format:
  - `*<angle_degrees>|<distance_cm>`
- Why it matters:
  - This is the source signal for your whole pipeline.

## `pyBridge/` - hardware parsing and transport (most important for hardware->software story)
- Purpose: connect to Bluetooth COM port, parse serial text, convert units, push clean JSON to localhost.
- This is where hardware data becomes app-ready data.

## `web/` - product app (frontend + backend)
- `web/src/` is your React UI and report logic.
- `web/server/` is your local backend for AI, scan API, and sensor ingest.

## `docs/`
- Documentation for explaining architecture and demo flow.

---

## 3) Files that are "real project logic" (not dependency plumbing)

Use this exact shortlist during judging.

## Hardware and parsing path (critical)

- `arduino/arduino.ino`
  - Reads IMU + distance sensor.
  - Emits `*angle|distance_cm` lines over serial Bluetooth.

- `pyBridge/bluetooth_to_localhost.py`
  - **Main hardware bridge script**.
  - `parse_line(line)`:
    - Validates `*` prefix and `|` delimiter.
    - Parses angle and distance as numbers.
    - Rejects invalid ranges.
  - `to_door_width_inches(distance_cm, offset_inches)`:
    - Converts cm -> inches.
    - Adds +3.5 inch sensor offset.
  - `post_reading(...)`:
    - Sends normalized JSON to:
      - `POST http://127.0.0.1:8787/api/sensors/ingest`
  - Safe COM logic:
    - Bluetooth port detection and filtering
    - Excluding risky ports
    - Cached last-good port
    - Fails safely when port choice is ambiguous

## Backend logic (AI + sensor endpoints + website scan)

- `web/server/index.js`
  - `POST /api/sensors/ingest`
    - Validates numeric `ramp_angle` and `door_width`
    - Saves latest reading in memory
  - `GET /api/sensors/latest`
    - Returns most recent bridge reading to UI
  - `POST /api/ai/summary`
    - Calls local Ollama
    - Uses strict pass/fail rules in the prompt (door + ramp thresholds)
    - Returns concise summary text
  - `POST /api/websites/scan`
    - Runs Puppeteer + Axe checks for accessibility violations
  - `GET /api/health`
    - Quick verification for backend + AI model wiring

## Frontend logic (what user sees and clicks)

- `web/src/App.jsx`
  - Main app behavior:
    - Home/Overview routing cards
    - Import parsing UI
    - Report generation
    - AI summary trigger
    - Settings thresholds
    - Website scanner UI
  - Polls `/api/sensors/latest` for bridge-fed live readings
  - Builds ADA raw report using latest measurements
  - Applies threshold rules in UI and report text
  - Persists dashboard state to Firestore

- `web/src/services/aiSummary.js`
  - Frontend AI request wrapper for `/api/ai/summary`
  - 30s timeout handling and error propagation
  - Sends threshold + measurement context so AI decisions stay accurate

- `web/src/styles.css`
  - Visual design and layout for your dashboard, home cards, and reports

## Auth + project integration files

- `web/src/firebase.js`
  - Firebase Auth + Firestore initialization
- `web/src/auth.js`
  - Login/logout helper wrappers
- `web/src/pages/LoginPage.jsx`
- `web/src/pages/SignupPage.jsx`
  - Auth UI pages

---

## 4) Hardware -> parsing -> dashboard flow (explain this in demo)

1. Arduino emits: `*6.25|71.40`
2. Python bridge reads serial line from Bluetooth COM port.
3. Bridge parser extracts:
   - `angle = 6.25`
   - `distance_cm = 71.40`
4. Bridge computes:
   - `door_width_inches = (distance_cm / 2.54) + 3.5`
5. Bridge posts:
   - `{ ramp_angle, door_width, source, raw }`
6. Backend validates and stores latest reading.
7. Frontend polls and updates Import/Reports values.
8. Report + AI summary use those exact readings.

This is your strongest engineering story because it proves:
- hardware integration,
- parsing correctness,
- safe transport layer,
- real-time UI update.

---

## 5) AI feature (killer feature) - exact behavior

## Model/runtime
- Local Ollama endpoint:
  - `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`)
- Model:
  - `OLLAMA_MODEL` (default `qwen2.5:0.5b` in current backend)

## Why AI is reliable now
- Backend prompt includes hard pass/fail constraints:
  - Door PASS if `door_width >= minDoorWidth`
  - Ramp PASS if `slope_ratio >= minSlopeRatio`
- Backend also sends computed PASS/FAIL facts into prompt.
- Prompt explicitly forbids contradicting numeric facts.

## Fallback behavior
- If AI is unavailable/timeouts:
  - UI still returns deterministic local summary text.
  - App does not break.

---

## 6) Files you can ignore in explanation

These are mostly framework/build/dependency plumbing:
- `node_modules/`, `package-lock.json`
- `.vite/`, `dist/`
- generated caches (`__pycache__`, `.pyc`)
- most config files unless asked deployment questions

If judges ask "where is your actual logic?", point back to:
- `pyBridge/bluetooth_to_localhost.py`
- `web/server/index.js`
- `web/src/App.jsx`
- `web/src/services/aiSummary.js`

---

## 7) 30-second pitch script

"Our Arduino streams compact lines like `*angle|distance_cm`.  
Our Python bridge safely picks the right Bluetooth RX port, parses and validates each line, converts distance to real door width in inches with sensor offset, and posts clean JSON to our local API.  
The React dashboard reads that live data, applies ADA thresholds, and generates reports.  
Then our local AI layer explains compliance in plain language with strict numeric rules so the summary cannot contradict the measurements."

