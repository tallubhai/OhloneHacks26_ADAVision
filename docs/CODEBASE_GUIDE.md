# ADA Vision - Engineering Guide

This guide skips UI boilerplate and focuses on the technical story. **Primary focus: real hardware measurements** (Arduino + Bluetooth) and the **Python bridge** into the app. **Ollama** adds plain-language summaries. **Website scanning with axe** is an extra capability, documented last.

**Pillars (in presentation order):**

1. Hardware measurement pipeline (Arduino + Bluetooth)  
2. Python bridge (serial → local API)  
3. Ollama (local LLM for summaries)  
4. Website checker (axe-core in headless Chromium)

---

## 1) Hardware pipeline (Arduino + Bluetooth)

### Purpose

Capture physical measurements for ADA-style checks: ramp angle (IMU), door/path distances (ultrasonic), with optional button modes for height vs width vs path (see firmware).

### Where the code lives

- `arduino/arduino.ino` — main loop, buttons, LEDs, Bluetooth send  
- `arduino/imu.cpp` + `arduino/imu.h` — MPU6050, complementary filter, angle from level  
- `arduino/distance.cpp` + `arduino/distance.h` — HC-SR04-style ranging (cm)  
- `arduino/bt.cpp` + `arduino/bt.h` — `Serial` line output for the bridge

### Serial format

The **Python bridge** expects a single combined line:

`*<angle_degrees>|<distance_cm>`  
Example: `*6.25|71.40`

Firmware may use **other prefixes** per measurement mode; see comments in `arduino.ino` (continuous `*angle|distance` block is there for testing).

### Why it matters

Real sensors, deterministic strings over Bluetooth, clean split from the web app.

---

## 2) Python parsing bridge (hardware → backend)

### Purpose

Browsers cannot open the Bluetooth COM port. The bridge reads serial like a monitor, validates, converts units, and POSTs JSON to Express.

### Where the code lives

- `pyBridge/bluetooth_to_localhost.py`  
- `pyBridge/requirements.txt` (`pyserial`)

### Core pieces

- **`parse_line`** — Must match `*angle|distance_cm`, sane numeric ranges.  
- **`to_door_width_inches`** — `(distance_cm / 2.54) + offset` (default offset 3.5 in for sensor placement).  
- **`post_reading`** — `POST http://127.0.0.1:8787/api/sensors/ingest` with `ramp_angle`, `door_width`, `raw`, etc.  
- **Port selection** — Prefer real Bluetooth COM ports; avoid USB-upload ports; optional cache and filters when multiple devices exist.

### Flow

Serial line → parse → convert → POST ingest → web polls **`GET /api/sensors/latest`**.

---

## 3) Ollama (local AI)

### What we use

- **Runtime:** [Ollama](https://ollama.com) running on the same machine (or LAN). No paid API keys for demos.  
- **HTTP:** `POST {OLLAMA_BASE_URL}/api/generate` with `stream: false`.  
- **Default base URL:** `http://127.0.0.1:11434` (`OLLAMA_BASE_URL`).  
- **Default model:** `qwen2.5:0.5b` (`OLLAMA_MODEL`) — small and quick; change env to a larger model if you have the RAM/GPU.  
- **Sampling:** `temperature: 0.2` so answers stay closer to the facts.  
- **Timeouts:** server aborts after ~45s; the browser client aborts after ~30s on `/api/ai/*` so the UI does not hang.

### Where the code lives

- **Backend:** `web/server/index.js` — `runOllamaPrompt(prompt)` then:  
  - **`POST /api/ai/summary`** — Building/physical report: thresholds and latest measurements are **recomputed in Node**, written into the prompt as PASS/FAIL facts; the model is told not to contradict them.  
  - **`POST /api/ai/website-report`** — Optional narrative from axe **counts + violations** (see §4).  
- **Frontend:** `web/src/services/aiSummary.js` — `generateAiSummary`, `generateAiWebsiteReport`.  
- **Fallback:** If Ollama is off, `App.jsx` still shows a **rule-based text summary** for building reports; website tab can use a **non-LLM** report from scan data.

### In one sentence

Ollama turns structured data we already computed into short plain English; for buildings, the math is done in code first, not by the model.

---

## 4) Website checker — how axe works (last)

This is **not** a custom accessibility linter. We use **Deque axe-core**: a widely used rules engine aligned with **WCAG 2.x** style checks, run against the **real DOM** after the page loads.

### How it works in our stack

1. **Puppeteer** launches **headless Chromium** and opens the submitted URL (`networkidle2`, 45s cap).  
2. We **inject** the bundled `axe.min.js` from the `axe-core` npm package (`require.resolve` in `web/server/index.js`).  
3. In the page context we call **`axe.run(document)`**. Axe walks the tree and runs its rules.  
4. It returns structured results: **`violations`** (fails), **`passes`**, plus **`incomplete`** / **`inapplicable`** counts. Each violation includes rule id, impact, help text, and **nodes** (selectors/snippets) for devs.  
5. Express **normalizes** that into JSON for the UI and optional AI (`POST /api/websites/scan`).

So: **browser + real page + axe engine** — not static HTML parsing on the server.

### Where the code lives

- `web/server/index.js` — `POST /api/websites/scan`  
- `web/src/App.jsx` — scan button, results, Firestore save of inspections  
- `web/vite.config.js` — dev proxy `/api` → port **8787** (run **`npm run dev`** so Vite and the API run together)

---

## Runtime path (short)

**Hardware path:** Arduino → Bluetooth serial → Python bridge → `/api/sensors/ingest` → app polls `/api/sensors/latest` → thresholds → optional **`/api/ai/summary`**.

**Website path:** URL → Puppeteer → inject axe → `axe.run(document)` → JSON → UI (and optional **`/api/ai/website-report`**).

---

## What to present (and what to ignore)

### Present (hardware first)

- `arduino/arduino.ino`, `arduino/imu.cpp`, `arduino/distance.cpp`, `arduino/bt.cpp`  
- `pyBridge/bluetooth_to_localhost.py`  
- `web/server/index.js` (ingest, sensors, Ollama, scan)  
- `web/src/services/aiSummary.js`, `web/src/App.jsx` (data flow, not CSS)

### Ignore

Layout/CSS, lockfiles, build output, framework boilerplate.

---

## 30-second judge script (hardware-first)

“We measure **real ramps and doors** with an **Arduino**: an **IMU** for slope and an **ultrasonic** sensor for clearance, sent over **Bluetooth** as compact serial lines. A **Python bridge** finds the right COM port, parses and converts units, and POSTs into our **local API** so the dashboard gets live numbers. **Ollama** runs locally to turn those rule-checked results into a short **plain-language summary** without inventing compliance. We also support **website checks**: **headless Chrome** runs **axe-core** on the live page so automated results match what users actually load.”
