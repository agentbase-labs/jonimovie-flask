# AI Movie Maker

End-to-end AI video production pipeline: Reference image → Storyboard → Video clips → Final film.

## Pipeline

| Step | What | API |
|------|------|-----|
| 1. Story | Develop concept into scenes & shots | Gemini 2.0 Flash |
| 2. Storyboard | Generate cinematic frames | Gemini 2.5 Flash Image |
| 3. Video Clips | Image-to-video with motion prompts | Kling API |
| 4. Final Film | Assemble clips into one video | Shotstack API |

## Run Locally

```bash
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
python3 app.py
```

Open `http://127.0.0.1:5000` in your browser.

If `python` or `pip` is not available on your machine, always use `python3` and `python3 -m pip`.
pkill -f "python3 app.py"
python3 app.py