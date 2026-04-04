# ADA Vision - Engineering Guide

This guide avoids UI boilerplate and focuses on what makes ADA Vision technically strong. **Website accessibility scanning (axe + headless browser) and the AI narrative layer** are the flagship story for many demos; the physical sensor stack and Python bridge are complementary “real world measurement” depth.

The technical pillars:

1. **Website accessibility checker** (automated WCAG-oriented rules in a real browser context)  
2. **AI layer** (Ollama: grounded building summary + optional website narrative)  
3. Hardware measurement pipeline (Arduino + Bluetooth)  
4. Python parsing bridge (serial → local API)

---

## 1) Website accessibility checker (axe-core + Puppeteer)

### Purpose

Give inspectors a **repeatable, standards-aligned** pass over any public URL: load the page like a user, run **Deque axe-core** rules against the live DOM, and return **structured violations and passes** (not a hand-waved “maybe accessible” guess). That JSON drives the **Websites** UI, **deterministic fallback reports**, and can feed **AI-generated plain-language writeups** when Ollama is enabled.

### Why this matters for judging

- Uses **industry-standard axe-core** (WCAG 2.x-oriented automated checks), not a custom linter.  
- Runs inside **real Chromium** via **Puppeteer**, so results reflect actual layout, ARIA, and dynamic content after load.  
- Output is **machine-readable** (counts, per-rule metadata, affected nodes) — suitable for dashboards, Firestore history, and prompt grounding.

### Where the code lives

| Layer | Path | Role |
|--------|------|------|
| Scan API | `web/server/index.js` | `POST /api/websites/scan` — launch browser, inject axe, return JSON |
| Axe script | Resolved at runtime via `createRequire` + `require.resolve("axe-core/axe.min.js")` | Same engine version as the `axe-core` npm dependency |
| Frontend | `web/src/App.jsx` | `scanWebsiteAccessibility()`, Websites tab, parsing saved inspections |
| Client AI helper | `web/src/services/aiSummary.js` | `generateAiWebsiteReport()` → `POST /api/ai/website-report` |
| Dev proxy | `web/vite.config.js` | Proxies `/api/*` → `http://localhost:8787` so the React app can call the scanner |

### Dependencies (what we actually use)

- **`puppeteer`** — Headless Chrome/Chromium; `page.goto`, `addScriptTag`, `page.evaluate`.  
- **`axe-core`** — Injected into the page; `window.axe.run(document)` returns violations, passes, incomplete, inapplicable.  
- **`express`** — Scanner and AI routes on port **8787** by default.  
- **`@axe-core/puppeteer`** is listed in `package.json`; the current server path uses **manual injection** of `axe.min.js` (equivalent outcome: axe runs in page context).

### How `POST /api/websites/scan` works (step by step)

1. **Validate URL** — Body `{ "url": "..." }`; invalid URLs return `400`.  
2. **Launch Puppeteer** — `headless: true`, with `--no-sandbox` / `--disable-setuid-sandbox` for typical Linux/container compatibility.  
3. **Navigate** — `page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 45000 })` so network-heavy SPAs settle before analysis.  
4. **Inject axe** — `page.addScriptTag({ path: axeScriptPath })` loads the bundled axe engine.  
5. **Run axe** — `page.evaluate(async () => window.axe.run(document))` executes the full rule engine in the page’s JavaScript realm.  
6. **Normalize** — `normalizeViolation` and `normalizeRuleResult` trim each rule to stable fields (id, impact, description, help, helpUrl, nodes / counts) for UI and AI payloads.  
7. **Respond** — JSON includes `url`, `scannedAt`, `counts` (violations, passes, incomplete, inapplicable), `failedChecks`, `passedChecks`, `violations`.  
8. **Cleanup** — Browser closed in `finally`.

### Response shape (conceptual)

- **`counts`** — High-level scorecard for badges and summaries.  
- **`violations`** — Full detail for drill-down (including `nodes` with selectors and snippets).  
- **`failedChecks` / `passedChecks`** — Rule-centric views derived from violations and passes for “what failed / what passed” lists in the UI.

### Frontend flow (`App.jsx`)

- User enters URL → **`fetch("/api/websites/scan", { method: "POST", body: JSON.stringify({ url }) })`**.  
- If the response is not JSON (e.g. static hosting without proxy), the app surfaces a clear error: run **`npm run dev`** so **Vite + Express** run together (`concurrently`: `dev:web` + `dev:scan`).  
- On success, **`generateWebsiteFallbackReport(scanResult)`** builds a **fixed-section plain-text report** (Executive Summary, What Passed, What Failed, Why It Matters, Recommended Fixes) using **only** scan data — **no LLM required** for a usable demo.  
- **`parseWebsiteReportSections`** splits that text (or future AI text using the same headings) into cards in the UI.  
- If the user is signed in, the scan is **auto-saved** to Firestore under `users/{uid}/websiteInspections` with violations, checks, counts, and `reportText` for history and overview stats.

### Operational note

Each scan **spawns a browser instance** — appropriate for demos and moderate use; production at scale would want queuing, pooling, or an external scan service.

---

## 2) AI pipeline (Ollama) — building compliance + website narrative

### Purpose

- **Building / physical inspection path:** Turn the structured report plus **numeric thresholds** into a short, judge-friendly **plain-language summary** without contradicting measured pass/fail.  
- **Website path:** Turn **axe results** (counts + top violations) into a **readable narrative** with consistent section headings for the product UI.

Both paths share the same **local LLM stack** so the project stays offline-capable and free of third-party API keys for demos.

### Where AI code lives

- **Frontend:** `web/src/services/aiSummary.js` — `postAiRequest` (timeout, error handling), `generateAiSummary`, `generateAiWebsiteReport`.  
- **Backend:** `web/server/index.js` — `runOllamaPrompt`, `POST /api/ai/summary`, `POST /api/ai/website-report`.  
- **UI wiring:** `web/src/App.jsx` — building summary calls `generateAiSummary` after report data exists; website tab currently emphasizes **fallback** text; **`generateAiWebsiteReport` is implemented** for callers that want the LLM version of the website report.

### Runtime / model

- **Provider:** **Ollama** (local HTTP API).  
- **`OLLAMA_BASE_URL`** — Default `http://127.0.0.1:11434`.  
- **`OLLAMA_MODEL`** — Default `qwen2.5:0.5b` (small, fast on laptops; swap for larger models when available).  
- **HTTP:** `POST ${OLLAMA_BASE_URL}/api/generate` with `stream: false`, **`temperature: 0.2`** (more deterministic, less hallucination).  
- **Timeouts:** Server aborts Ollama calls after **45s**; browser client aborts after **30s** for `/api/ai/*` so the UI never hangs indefinitely.

### Shared backend helper: `runOllamaPrompt(prompt)`

- Builds the JSON body for Ollama’s generate API.  
- Surfaces actionable errors (timeout, **ECONNREFUSED**, hint to run `ollama pull <model>`).  
- Returns trimmed `response` text from Ollama’s JSON response.

### Endpoint A: `POST /api/ai/summary` (building / ramp / door grounding)

**Goal:** The model must **not** invent compliance — it explains what the app already computed.

**Request body (key fields):**

- `rawReport` (string, required) — Full inspection text from the app.  
- `buildingName`, `verbosity` (`concise` | `standard` | `detailed`) — Length and tone.  
- Thresholds: `minDoorWidth`, `minSlopeRatio`, `minDoorHeight`, `minPathwayWidth`.  
- Latest observations: `latestDoorWidth`, `latestRampAngle`, `latestSlopeRatio`, `latestDoorHeight`, `latestPathwayWidth` (nullable when not captured).

**Server logic:**

1. Parse numbers with a small **`toNumberOrNull`** guard.  
2. **Recompute** booleans on the server (same idea as the UI):  
   - Door width: PASS if observed ≥ minimum.  
   - Ramp: PASS if **run:rise ratio 1:X** (derived from angle) ≥ minimum ratio (flatter is better).  
   - Door height / pathway: PASS if observed ≥ minimum when both rule and observation exist.  
3. Inject **explicit lines** into the prompt: minimums, observed values, and **“Computed … result: PASS/FAIL/unknown”** for each dimension.  
4. System instructions: do **not** contradict those facts; say **“Compliant”** / **“Non-compliant”** in line with failures.

**Response:** `{ "text": "..." }` or `500` with `error` + `details`.

**Frontend fallback:** If the fetch fails or times out, `App.jsx` shows **`summarizeReport(...)`** output plus an “AI fallback notice” — the demo still works without Ollama.

### Endpoint B: `POST /api/ai/website-report` (accessibility narrative)

**Goal:** Produce **120–180 words** of plain text, **no markdown**, using **fixed section headers** so `parseWebsiteReportSections` can reuse the same parser:

- Executive Summary:  
- What Passed:  
- What Failed:  
- Why It Matters:  
- Recommended Fixes:  

**Request body:** `url`, `violations` (array, capped to **15** on the server for prompt size), `counts` (object).

The prompt casts the model as an **accessibility consultant** and passes **stringified** JSON for counts and violations so the narrative stays tied to **actual axe output**.

**Response:** `{ "text": "..." }` or `500` with details.

**Pairing with the checker:** The **deterministic** `generateWebsiteFallbackReport` in `App.jsx` mirrors those headings without Ollama — same UX contract, LLM optional.

### Why this AI design is defensible

- **Building path:** Numeric **grounding** is computed in code and **copied into the prompt**; the LLM explains, it does not re-decide math.  
- **Website path:** Prompt is **filled with axe payloads**, not “please rate this site.”  
- **Low temperature + timeouts** reduce rambling and hung requests.  
- **Fallbacks** exist on both product surfaces when Ollama is off.

---

## 3) Hardware pipeline (Arduino + Bluetooth)

### Purpose

Capture real physical measurements for ADA checks:

- Ramp steepness (angle from level)  
- Door distance / width (ultrasonic)  
- (Firmware may also expose other modes; see `arduino/arduino.ino` comments.)

### Where the hardware code lives

- `arduino/arduino.ino` (main runtime loop)  
- `arduino/imu.cpp` + `arduino/imu.h` (IMU angle reading/filtering)  
- `arduino/distance.cpp` + `arduino/distance.h` (distance sensor reads)  
- `arduino/bt.cpp` + `arduino/bt.h` (serial/Bluetooth transport)

### Data format (contract for the Python bridge)

The docs and bridge parser expect a **combined** line:

`*<angle_degrees>|<distance_cm>`

Example:

`*6.25|71.40`

The live firmware may use **mode-specific** prefixes per button; see comments in `arduino.ino` and uncomment the continuous stream for unified testing.

### Why this is important in judging

- Real sensor integration, not mock data.  
- Deterministic machine-readable output.  
- Clean separation from web and AI layers.

---

## 4) Python parsing bridge (hardware → backend)

### Purpose

The browser does **not** open Bluetooth serial. A Python script reads the UART like a serial monitor, validates/parses, normalizes units, and **POST**s to the local API.

### Where this code lives

- `pyBridge/bluetooth_to_localhost.py`  
- `pyBridge/requirements.txt` (`pyserial`)

### Core implementation details

#### A) Serial parsing

- Function: `parse_line(line)`  
- Validates: leading `*`, `|`, numeric angle and distance, sane ranges.

#### B) Unit conversion + hardware offset

- Function: `to_door_width_inches(distance_cm, offset_inches)`  
- Formula: `door_width_inches = (distance_cm / 2.54) + 3.5` (offset configurable).

#### C) Forwarding

- Function: `post_reading(...)`  
- `POST http://127.0.0.1:8787/api/sensors/ingest` with `ramp_angle`, `door_width`, source, raw line.

#### D) Safe COM port handling

Bluetooth vs USB-upload heuristics, optional filters, cache file for last good port, fail closed on ambiguous multi-BT setups.

### End-to-end bridge flow

1. Read line from Bluetooth COM port  
2. Parse `*angle|distance_cm`  
3. Convert + offset  
4. POST JSON to ingest  
5. Web app polls `/api/sensors/latest`

---

## Runtime path (full product)

**Website**

1. User submits URL → `POST /api/websites/scan`  
2. Puppeteer + axe produce JSON  
3. UI shows violations/passes; optional Firestore save; report text via fallback (or AI via `/api/ai/website-report` if wired)

**Building + sensors**

1. Arduino emits serial measurements (format per firmware)  
2. Python bridge parses and posts `/api/sensors/ingest`  
3. Web app polls `/api/sensors/latest`  
4. Report generator applies thresholds (door, ramp, height, pathway)  
5. `POST /api/ai/summary` explains results in plain language when enabled

---

## What to present (and what to ignore)

### Present these files

- **Website checker + AI server:** `web/server/index.js` (scan route, normalization, both AI routes, Ollama client)  
- **Website + report UI flow:** `web/src/App.jsx` (Websites tab, `scanWebsiteAccessibility`, `generateWebsiteFallbackReport`, `parseWebsiteReportSections`, Firestore inspections; building report + `generateAiSummary`)  
- **AI client:** `web/src/services/aiSummary.js`  
- **Proxy / dev wiring:** `web/vite.config.js`, `web/package.json` scripts (`npm run dev`)  
- **Hardware / bridge (if showing physical layer):** `arduino/arduino.ino`, `arduino/imu.cpp`, `arduino/distance.cpp`, `arduino/bt.cpp`, `pyBridge/bluetooth_to_localhost.py`

### Ignore during explanation

- CSS/layout polish  
- Lockfiles unless asked  
- Framework bootstrap boilerplate  
- Build artifacts  

---

## Judge scripts

### ~30 seconds (website-first)

“Our main technical story is **automated web accessibility**: we spin up **headless Chromium** with **Puppeteer**, inject **Deque axe-core**, and run the full rule engine on the live page after load. We return **structured violations and passes**, persist scans for history, and generate **human-readable reports** with fixed sections. Optionally we send those axe results to a **local Ollama** model for a narrative, while keeping a **deterministic fallback** so the demo works offline. We also integrate **real ramp and door measurements** over Bluetooth with a **Python bridge** into the same app for a complete ADA story.”

### ~30 seconds (full stack)

“We combine four layers: **axe in a real browser** for websites, **grounded LLM summaries** via Ollama for both building and web reports, **Arduino sensors** for physical measurements, and a **Python serial bridge** into our **Express API** — all tied together in one dashboard.”
