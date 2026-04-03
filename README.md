# ADA Vision

**Smart Accessibility Compliance Scanner**

---

## Overview
**ADA Vision** is a handheld smart system that measures ADA compliance for physical spaces. It automatically detects ramp slope and doorway width, generates a detailed inspection report, and uses AI to summarize it in clear, actionable English.

---

## Features
- Measure **ramp slope** using MPU6050 IMU  
- Measure **door width** using ultrasonic sensor  
- **Wireless data transfer** to laptop via Bluetooth  
- **Auto-generated inspection report**  
- **AI-powered plain-English summary** of the report  

---

## How It Works
1. Sensors collect measurements from ramps and doors.  
2. Arduino/ESP32 processes data and sends it to a laptop via Bluetooth.  
3. Laptop generates a long, official-style report.  
4. AI summarizes the report into easy-to-understand English.  
5. Results are displayed on a web dashboard for inspection review and report download.

---

## Demo Flow
1. Tilt device on a ramp → displays pass/fail  
2. Measure doorway width → displays pass/fail  
3. Generate full report → see AI summary in plain English  

---

## Target Users
- Government inspectors  
- Contractors  
- Accessibility auditors  

---

## Tech Stack
- **Hardware:** Arduino / ESP32, MPU6050 IMU, Ultrasonic sensor, Bluetooth module  
- **Software:** Python, HTML/CSS/JS for web dashboard, OpenAI/Gemini API for AI report summary  

<<<<<<< HEAD
---
=======
### Optional OpenAI summary setup

Inside `web/`, create `.env.local` and add:

```bash
VITE_OPENAI_API_KEY=your_openai_key_here
VITE_OPENAI_MODEL=gpt-4.1-mini
```

If the key is missing or invalid, the app automatically falls back to local summary logic.

Then open:
- Login page: `http://localhost:5173/login.html`
- Sign up page: `http://localhost:5173/signup.html`
- Dashboard: `http://localhost:5173/index.html`

## 4) Hardware integration notes (Bluetooth)

- Dashboard includes a **Connect Bluetooth** button using Web Bluetooth API.
- Browser support is best in Chrome/Edge.
- Your ESP32/Arduino can send payloads (JSON or delimited string).  
- Current app supports manual value entry plus Bluetooth device selection; parsing live stream is the next step once your firmware payload format is finalized.

## 5) ADA logic implemented

- Door width compliance: `>= 32 in`
- Ramp slope from IMU angle:
  - `slopeRatio = 1 / tan(theta)`
  - Compliant when `slopeRatio >= 12` (meets `1:12` maximum slope rule)

## 6) Suggested next upgrade

When your hardware payload is ready, add a parser in `web/src/App.jsx` to:
1. Read BLE characteristic notifications
2. Parse values (e.g. `doorWidth`, `rampAngle`)
3. Update dashboard state in real time
4. Auto-log each inspection snapshot
>>>>>>> 64391f2 (Update dashboard tabs and AI summary integration)
