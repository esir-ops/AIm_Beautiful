# AI'm Beautiful: AI-Assisted Smart Mirror for Real-Time Makeup Mapping and Personalized Feedback

AI'm Beautiful is a smart-mirror makeup guide that runs in the browser and focuses on the Soft & Natural look. It maps where makeup should go on the user's face in real time and gives personalized feedback as they apply it. The system detects the user's skin tone, suggests matching shades, and lets the user preview them through a virtual try-on. It then guides the user through four steps (lips, blush, eyebrows, and contour) using AR overlays and checks each step for placement and quality.

We built it using HTML, CSS, and JavaScript. For face tracking we used MediaPipe FaceMesh, which tracks 468 points on the face, and we used TensorFlow.js for the application-quality model. The app doesn't need a build step or a server framework, and all processing happens on the user's device, so no data is sent anywhere.

Developed by Group 11, BS Computer Engineering, School of Engineering and Architecture.

---

## Project Structure

```
AI-M-BEAUTIFUL-main/
├── index.html          Main page and all app screens
├── app.js              Application logic
├── style.css           Styling
├── serve.ps1           Script for running a local server
│
├── data/               JSON files used by the app
│   ├── shades.json           Shade suggestions for each skin tone and step
│   ├── focal-points.json     The four focal point choices
│   ├── style-variations.json Three coverage levels for each focal point
│   └── foundations.json      Foundation shade for each skin tone
│
├── models/             Optional trained models (Teachable Machine / TF.js)
│   ├── HOW-TO-TRAIN.md        Guide for training and adding the models
│   ├── application-quality/   Checks for smudging, uneven application, and amount
│   ├── glasses/               Detects if the user is wearing glasses
│   └── occlusion/             Detects if part of the face is covered
│
└── README.md
```

The models in the `models/` folder are optional. If a folder doesn't have a `model.json` file, the app uses a simpler pixel-based check instead and shows this in the interface. This means the app still works without the trained models, and each model can be added later without editing the code.

## How to Run

The app needs to be opened through `http://` and not directly as a file (`file://`). This is because it loads the JSON files and uses the camera, and browsers only allow these when the page is served.

You can run it in one of two ways:

1. **VS Code Live Server:** Right-click `index.html` and choose *Open with Live Server*.
2. **Included PowerShell script (Windows):** Run the command below, then open `http://localhost:8765` in your browser.
```
   powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1
```

Allow camera access when the browser asks. Make sure the room has good and even lighting, since skin tone detection and face detection are less accurate in poor lighting.

## How the App Works

1. **Welcome screen**
2. **Focal point:** The user picks which feature to highlight (lips, eyebrows, cheeks, or contour). This can be changed later without scanning the face again.
3. **Camera:** The user takes a photo using the Capture Photo button. The button only works when the whole face is visible, with no glasses, mask, or anything covering it, and the face is properly positioned.
4. **Shades:** The app shows suggested shades based on the detected skin tone, with a live try-on.
5. **Variation:** The user can compare three coverage levels (sheer, balanced, and full) of the same shades on their own photo.
6. **Foundation check:** The app suggests a foundation shade and checks if the user is ready to start.
7. **Guide:** The app walks the user through the four steps with AR overlays, shows how much product to apply, and gives feedback on placement and quality.
8. **Summary:** The app shows the final look along with the score for each step.

## Notes for Developers

- All the logic is in `app.js`. The file is divided into commented sections for data loading, camera, detection, drawing, skin tone, shades, variations, guide, quality feedback, and try-on.
- To change the shades, variations, foundations, or focal points, edit the JSON files in the `data/` folder. There's no need to change the code.
- The current checks for skin tone, glasses, face coverage, and application quality work best in good lighting and aren't always accurate. Adding trained models to the `models/` folder will make detection more reliable. See `models/HOW-TO-TRAIN.md` for the steps.
