# ADA Vision — Smart Compliance Scanner

## Overview
**ADA Vision** is a hackathon project designed to make ADA compliance inspections faster, easier, and more consistent. The system uses sensors to measure ramp slope and door width, then sends the data to a laptop via Bluetooth. The website parses the data, generates a report, and can even summarize it using AI.

---

## Features

### Target (MVP) Features
- Hardware sensor readings:
  - Ramp slope using IMU
  - Door width using ultrasonic/laser distance sensors
- Bluetooth data transmission from Arduino/ESP32 to laptop
- Basic web dashboard to view live measurements
- Reports tab to compile measurements into raw reports

### AI Feature
- AI module summarizes raw reports into **plain English** for easier understanding

### Future/Stretch Features
- Store reports and user settings in Firebase database
- Multi-user support with Firebase Authentication
- Export reports as PDF or CSV
- Historical trends and compliance analytics

---

## Tech Stack
- **Hardware:** Arduino / ESP32, HC-05 Bluetooth, IMU sensor, Ultrasonic / Laser sensor  
- **Software:** Web dashboard (React), AI summary (OpenAI), Firebase Auth & Firestore  
- **Collaboration:** Cursor for live coding

---

## Usage
1. Arduino reads sensor data and sends it via Bluetooth  
2. Laptop receives data and displays it on the website (Overview tab)  
3. Reports tab compiles measurements and AI summarizes the report  
4. Users can log in via Google sign-in (Firebase Auth)  
5. Future: Save and retrieve reports from Firebase Firestore

---
