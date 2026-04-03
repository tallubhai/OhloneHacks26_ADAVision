# ADA Vision Platform

## Repository structure

- `ADA/` -> microcontroller code and sensor logic
- `web/` -> React + Firebase dashboard application
- `docs/` -> design/support documentation

Professional React + Firebase web platform for ADA inspection workflows:
- Google sign-in and email/password auth
- Separate `login.html` and `signup.html` entry pages
- Themed dashboard (matching the style you requested)
- Door width and ramp slope compliance checks
- Bluetooth connect action for hardware integration
- Inspection logging, raw report generation, and plain-English summary

## 1) What you need to install

### Required
1. **Node.js LTS (v20+)**
   - Download: [https://nodejs.org](https://nodejs.org)
   - Verify after install:
     - `node -v`
     - `npm -v`

2. **Firebase project (console setup)**
   - Open [https://console.firebase.google.com](https://console.firebase.google.com)
   - Create project (or use existing)
   - Add **Web App**
   - Copy Firebase web config values

### Optional but recommended
- **Git**: [https://git-scm.com/downloads](https://git-scm.com/downloads)
- **VS Code / Cursor**

## 2) Firebase setup

In Firebase Console:
1. Go to **Authentication** -> **Sign-in method**
2. Enable:
   - **Email/Password**
   - **Google**
3. Under Project Settings -> General -> Your apps -> Web app config, copy:
   - `apiKey`
   - `authDomain`
   - `projectId`
   - `storageBucket`
   - `messagingSenderId`
   - `appId`

Paste these into `web/src/firebase.js`.

## 3) Install and run

From the web app folder:

```bash
cd web
npm install
npm run dev
```

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
