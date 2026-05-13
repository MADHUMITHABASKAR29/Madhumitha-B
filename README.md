# 🛡️ SecureExam — AI Proctoring System

A browser-based online exam proctoring system that detects malpractice using **webcam + microphone** with real-time AI analysis.

---

## 🔍 Features

| Feature | Description |
|---|---|
| **Face Detection** | Detects if no face or multiple faces appear |
| **Head Pose Estimation** | Tracks yaw/pitch — flags turning away from screen |
| **Gaze Tracking** | Eye landmark analysis to detect off-screen gaze |
| **Lip Movement** | Expression detection flags potential whispering |
| **Noise Monitor** | Microphone level monitoring with dB threshold alerts |
| **Tab Switch Detection** | Flags if candidate switches browser tab |
| **Copy/Paste Detection** | Detects Ctrl+C / Ctrl+V attempts |
| **Activity Log** | Live timestamped log of all events |
| **PDF Report** | Downloadable proctoring report at end of exam |
| **Risk Level Scoring** | LOW / MEDIUM / HIGH based on violation count |

---

## 🚀 How to Run in VS Code

### Prerequisites
- [VS Code](https://code.visualstudio.com/)
- [Live Server extension](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) (**required** — face-api.js won't load over `file://`)

### Steps

1. **Open the project folder in VS Code**
   ```
   File → Open Folder → select `exam-proctor/`
   ```

2. **Install Live Server** (if not already)
   - Extensions panel (Ctrl+Shift+X) → search "Live Server" → Install

3. **Launch**
   - Right-click `index.html` → **"Open with Live Server"**
   - OR click **Go Live** in the bottom status bar

4. **Allow Permissions**
   - Browser will ask for **Camera** + **Microphone** access → click Allow

5. **Use the app**
   - Enter a name and Exam ID
   - Click **"Start Proctored Exam"** — models load (~5–10 sec)
   - Take the 5-question exam while being proctored
   - Click **End Exam** or let timer expire to see the report

---

## 📁 Project Structure

```
exam-proctor/
├── index.html          # Main UI
├── css/
│   └── style.css       # All styles
├── js/
│   ├── questions.js    # Exam questions (customise here)
│   ├── proctor.js      # AI proctoring engine
│   └── main.js         # App logic, timer, report
└── README.md
```

---

## ⚙️ Configuration

Open `js/proctor.js` and edit the `CFG` object:

```js
const CFG = {
  detectionInterval : 250,   // ms between AI frames (lower = more CPU)
  noiseThresholdDb  : 55,    // dB above which noise alert fires
  lookAwayThreshold : 0.28,  // head rotation sensitivity (0–1)
  alertCooldown     : 8000,  // ms before same alert can repeat
};
```

---

## 📝 Adding Questions

Edit `js/questions.js`:

```js
const QUESTIONS = [
  {
    topic  : "Your Topic",
    text   : "Your question text?",
    options: ["A", "B", "C", "D"],
    answer : 0   // index of correct answer
  },
  // ...
];
```

---

## 🌐 Models

Face detection models are loaded from the CDN:
```
https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/
```
An internet connection is required on first load. Models are cached by the browser.

---

## ⚠️ Notes

- Works best with **good lighting** facing the camera
- Use **Chrome or Edge** for best Web Audio API compatibility
- The system uses **client-side AI only** — no data is sent to any server
- For production use, integrate with a backend for secure log storage
