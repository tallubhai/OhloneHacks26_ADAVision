# ADA Vision

Smart accessibility compliance scanner for ADA checks.

## Repository structure

- `ADA/` hardware microcontroller code
- `web/` React dashboard + auth + reports
- `docs/` project docs

## Web app features

- Firebase login/signup (email/password + Google)
- Overview tab for live measurements and compliance status
- Import tab for JSON/CSV sensor payload parsing
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

## Local Ollama AI setup (optional)

Install and start Ollama, then pull a lightweight model:

```bash
ollama pull llama3.2:3b
```

Optional environment overrides in `web/.env.local`:

```bash
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2:3b
```

If Ollama is unavailable, the app falls back to local non-AI summary logic.
