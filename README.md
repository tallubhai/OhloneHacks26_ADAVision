# ADA Vision

Smart accessibility compliance scanner for ADA checks.

## Repository structure

- `arduino/` microcontroller code (sensor capture + serial output)
- `pyBridge/` Python Bluetooth-to-localhost bridge
- `web/` React dashboard + local API server + Firebase config
- `docs/` project documentation

## Web app features

- Firebase login/signup (email/password + Google)
- Overview tab for scan status and saved inspection summaries
- Import tab for JSON/CSV parsing and live bridge-fed readings
- Reports tab with raw report generation, AI summary, and export
- Websites tab for accessibility scanning via Axe-core + Puppeteer
- Settings tab for thresholds, Bluetooth, and theme

## Run web app

```bash
cd web
npm install
npm run dev
```

`npm run dev` starts both:
- Vite frontend (`http://localhost:5173`)
- Scanner API (`http://localhost:8787`)

## Run Python bridge

The browser does not connect directly to Bluetooth. The Python bridge reads serial Bluetooth data and posts normalized readings to the local API.

Install bridge dependency:

```bash
pip install -r pyBridge/requirements.txt
```

Run bridge (example COM5):

```bash
python pyBridge/bluetooth_to_localhost.py --port COM5 --baud 9600
```

Auto-detect mode (safe mode requires either a cache hit or filter when multiple BT ports exist):

```bash
python pyBridge/bluetooth_to_localhost.py --baud 9600 --bt-filter "HC-05"
```

## Local Ollama AI setup (optional)

Install and start Ollama, then pull a lightweight model:

```bash
ollama pull qwen2.5:0.5b
```

Optional environment overrides in `web/.env.local`:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:0.5b
```

If Ollama is unavailable, the app falls back to local non-AI summary logic.
