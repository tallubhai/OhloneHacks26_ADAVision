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

---
