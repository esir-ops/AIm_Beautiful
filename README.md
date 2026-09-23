# AI'm Beautiful: AI-Assisted Smart Mirror for Real-Time Makeup Mapping and Personalized Feedback

AI'm Beautiful is a smart-mirror makeup guide that runs in the browser and focuses on the Soft & Natural look. It maps where makeup should go on your face in real time and gives you feedback while you apply it. It reads your skin tone, recommends matching products from Squad Cosmetics, Detail Cosmetics and Chuchu Beauty, and lets you try them on virtually before you start. Then it guides you through four steps (lips, blush, eyebrows and contour) with AR outlines and checks each step for placement and quality.

We built it with HTML, CSS and JavaScript. Face tracking uses MediaPipe FaceMesh, which follows 468 points on the face, and our trained models run with TensorFlow.js. There's no build step and no server framework, and everything runs on the device itself, so no photos or data are sent anywhere.

Developed by Group 11, BS Computer Engineering, School of Engineering and Architecture.

---

## Project Structure

```
AIm_Beautiful/
├── index.html          All the app screens
├── app.js              Main app logic
├── saved-looks.js      Saving and viewing favourite looks
├── face-crop.js        Face crop shared by the app and the trainer
├── style.css           Styling
├── trainer.html        Page for training and testing the models
├── trainer.js          Trainer logic
├── serve.ps1           Runs a local server on Windows
│
├── data/               The product and style data
│   ├── shades.json           Squad and Detail shades for each skin tone and step
│   ├── chuchu-beauty.json    Chuchu Beauty shades for each skin tone and step
│   ├── foundations.json      Foundation shade for each skin tone
│   ├── makeup-looks.json     The four makeup looks (Professional, Date, Party, School)
│   ├── focal-points.json     The four focal points
│   └── style-variations.json Three coverage levels for each focal point
│
├── models/             Trained AI models
│   ├── HOW-TO-TRAIN.md        How to train and add a model
│   ├── glasses/               Detects glasses (trained)
│   ├── occlusion/             Detects a covered face (trained)
│   └── application-quality/   Checks smudging, evenness and amount (not trained yet)
│
└── README.md
```

To change the products, looks or styles, just edit the JSON files in `data/`. No code changes are needed.

The glasses and face-covered models are trained and included. The makeup quality model isn't trained yet, so for now the app checks quality with image analysis instead. Once a model is trained with `trainer.html` and its files are put in its folder, the app uses it automatically.

## How to Run

The app has to be opened through `http://`, not straight from the file (`file://`), because it loads the JSON files and uses the camera, which browsers only allow on a served page.

You can run it either way:

1. **VS Code Live Server:** right-click `index.html` and choose *Open with Live Server*.
2. **PowerShell script (Windows):** run the command below, then open `http://localhost:8765` in your browser.
```
powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1
```

Allow camera access when the browser asks. Use good, even lighting, since skin tone and face detection are less accurate in a dim room.

The mirror display is a TV standing upright, so the app is designed for a portrait screen.

## How the App Works

1. **Welcome:** tap Let's Begin. Saved looks can also be opened from here.
2. **Makeup look:** pick what you're getting ready for (Professional, Date / Casual Glam, Party / Glam or School). This sets how soft or defined the guidance is.
3. **Focal point:** pick the feature to highlight (lips, eyebrows, cheeks or contour).
4. **Camera:** tap Capture Photo for a 3, 2, 1 countdown. Capture only works when your whole face is visible and uncovered, you're not wearing glasses, and you're facing the mirror. If you move during the countdown, the photo is cancelled. Afterwards you can keep the photo or retake it.
5. **Shades:** the app recommends one product per category from the three brands, based on your skin tone, with a live try-on.
6. **Style:** compare three coverage levels (sheer, balanced and full) on your own photo.
7. **Foundation:** the app suggests a foundation shade before you start.
8. **Guide:** go through the four steps with AR outlines. Each step shows how much product to use, lets you preview it live, and checks your placement and quality.
9. **Summary:** see your results for each step and save the look if you want.
