import base64
import hashlib
import hmac
import io
import json
import math
import os
import subprocess
import time
import uuid

import requests
from flask import Flask, render_template, request, jsonify
from google import genai
from google.genai import types
from PIL import Image


def _load_env_file_fallback():
    """Minimal .env loader for environments without python-dotenv."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except Exception:
        pass


try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    # Keep app runnable even when python-dotenv is not installed.
    _load_env_file_fallback()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024

# ── API Keys ──────────────────────────────────────────────────────────────────
GEMINI_API_KEY = "AIzaSyDIspXdYFz_R53f1N2j4S-yBClRHiaJdGE"
KLING_ACCESS_KEY = "AByeF9Lgt8rLnFkYgFgaEagCdM88JKMh"
KLING_SECRET_KEY = "9Hrb4JkbdYPYKbQBkHpkDYgDFbLPgbBY"
SHOTSTACK_API_KEY = "g0ATAPxUTitypnxqIblbbeQdzmusJERZV2mXe0u8"
SHOTSTACK_ENV = "v1"  # production
SONAUTO_API_KEY = os.getenv("SONAUTO_API_KEY", "").strip()
SONAUTO_API_BASE = "https://api.sonauto.ai/v1"

# ── Directories ───────────────────────────────────────────────────────────────
GENERATED_DIR = os.path.join(app.root_path, "generated")
STORIES_DIR = os.path.join(GENERATED_DIR, "stories")
VIDEO_DIR = os.path.join(app.root_path, "videos")
AUDIO_DIR = os.path.join(app.root_path, "audio")
WATERMARK_PATH = os.path.join(app.root_path, "static", "img", "watermark.png")
os.makedirs(GENERATED_DIR, exist_ok=True)
os.makedirs(STORIES_DIR, exist_ok=True)
os.makedirs(VIDEO_DIR, exist_ok=True)
os.makedirs(AUDIO_DIR, exist_ok=True)

# ── Clients ───────────────────────────────────────────────────────────────────
gemini_client = genai.Client(api_key=GEMINI_API_KEY)

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif"}


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def prepare_image(file_storage):
    img_bytes = file_storage.read()
    img = Image.open(io.BytesIO(img_bytes))
    if img.mode == "RGBA":
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    buf.seek(0)
    return types.Part.from_bytes(data=buf.read(), mime_type="image/jpeg")


def save_and_encode(inline_data):
    b64 = base64.b64encode(inline_data.data).decode("utf-8")
    mime = inline_data.mime_type or "image/png"
    ext = mime.split("/")[-1]
    fname = f"{uuid.uuid4().hex}.{ext}"
    fpath = os.path.join(GENERATED_DIR, fname)
    with open(fpath, "wb") as f:
        f.write(inline_data.data)
    return b64, mime, fpath


# ── Frame Extraction ─────────────────────────────────────────────────────────
def extract_last_frame(video_path):
    """Extract the last frame from a video file using ffmpeg. Returns JPEG bytes."""
    tmp_path = os.path.join(GENERATED_DIR, f"_lastframe_{uuid.uuid4().hex}.jpg")
    try:
        subprocess.run([
            "ffmpeg", "-y", "-sseof", "-0.5", "-i", video_path,
            "-frames:v", "1", "-q:v", "2", tmp_path,
        ], capture_output=True, timeout=15)
        if os.path.exists(tmp_path):
            with open(tmp_path, "rb") as f:
                data = f.read()
            os.remove(tmp_path)
            return data
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
    return None


# ── Kling JWT ─────────────────────────────────────────────────────────────────
def _b64url(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def build_kling_jwt():
    now = int(time.time())
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}))
    payload = _b64url(json.dumps({"iss": KLING_ACCESS_KEY, "exp": now + 1800, "nbf": now - 5}))
    sig_input = f"{header}.{payload}"
    sig = hmac.new(KLING_SECRET_KEY.encode(), sig_input.encode(), hashlib.sha256).digest()
    return f"{sig_input}.{_b64url(sig)}"


def kling_request(method, url, **kwargs):
    """Call Kling API without inheriting HTTP(S)_PROXY from environment."""
    last_exc = None
    for _ in range(3):
        try:
            with requests.Session() as session:
                session.trust_env = False
                return session.request(method, url, **kwargs)
        except requests.exceptions.RequestException as e:
            last_exc = e
            time.sleep(1.2)
    raise last_exc


def _sonauto_request(method, url, **kwargs):
    """Call Sonauto API with isolated requests session."""
    with requests.Session() as session:
        session.trust_env = False
        return session.request(method, url, **kwargs)


def _normalize_sonauto_tags(raw_tags):
    """Best-effort cleanup so Sonauto is less likely to reject tags."""
    if not raw_tags:
        return ""
    cleaned = []
    for tag in raw_tags.split(","):
        t = " ".join(tag.strip().lower().split())
        if not t:
            continue
        safe = "".join(ch for ch in t if ch.isalnum() or ch in (" ", "-", "_"))
        safe = " ".join(safe.split())
        if len(safe) < 2:
            continue
        # Avoid likely-invalid proper names/specialized labels.
        if safe in {"hans zimmer", "israel", "rescue"}:
            continue
        cleaned.append(safe[:32])
        if len(cleaned) >= 8:
            break
    # unique while preserving order
    deduped = list(dict.fromkeys(cleaned))
    return ",".join(deduped)


def _sonauto_create_generation(prompt, tags="", lyrics="", instrumental=False, model="v3", output_format="mp3"):
    endpoint = f"{SONAUTO_API_BASE}/generations/v2" if model == "v2" else f"{SONAUTO_API_BASE}/generations/v3"
    payload = {"output_format": output_format, "prompt": prompt or ""}

    if tags:
        payload["tags"] = [t.strip() for t in tags.split(",") if t.strip()]
    if instrumental:
        payload["instrumental"] = True
    elif lyrics:
        payload["lyrics"] = lyrics

    resp = _sonauto_request(
        "POST",
        endpoint,
        headers={"Authorization": f"Bearer {SONAUTO_API_KEY}", "Content-Type": "application/json"},
        json=payload,
        timeout=40,
    )
    if not resp.ok:
        raise RuntimeError(f"Sonauto create error {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    task_id = data.get("task_id")
    if not task_id:
        raise RuntimeError(f"Sonauto did not return task_id: {json.dumps(data)[:500]}")
    return task_id


def _sonauto_poll_success(task_id, max_attempts=120, interval_sec=5):
    url = f"{SONAUTO_API_BASE}/generations/status/{task_id}"
    for _ in range(max_attempts):
        resp = _sonauto_request(
            "GET",
            url,
            headers={"Authorization": f"Bearer {SONAUTO_API_KEY}"},
            timeout=20,
        )
        if not resp.ok:
            time.sleep(interval_sec)
            continue

        status_data = resp.json()
        status = status_data.get("status") if isinstance(status_data, dict) else str(status_data)
        status = (status or "").upper()
        if status == "SUCCESS":
            return True
        if status == "FAILURE":
            return False
        time.sleep(interval_sec)
    return False


def _sonauto_fetch_result(task_id):
    url = f"{SONAUTO_API_BASE}/generations/{task_id}"
    resp = _sonauto_request(
        "GET",
        url,
        headers={"Authorization": f"Bearer {SONAUTO_API_KEY}"},
        timeout=25,
    )
    if not resp.ok:
        raise RuntimeError(f"Sonauto result error {resp.status_code}: {resp.text[:500]}")
    return resp.json()


# ── Routes ────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html", cache_bust=int(time.time()))


@app.route("/enhance-song-prompt", methods=["POST"])
def enhance_song_prompt():
    script = request.form.get("script", "").strip()
    if not script:
        return jsonify({"error": "Please provide the song script/idea."}), 400

    style_hint = request.form.get("style_hint", "").strip()

    system_instruction = (
        "You are a professional songwriter and music prompt engineer. "
        "Turn the user's rough script into a strong AI song-generation prompt.\n\n"
        "Return ONLY valid JSON with keys:\n"
        "enhanced_prompt (string),\n"
        "suggested_tags (array of short lowercase strings),\n"
        "suggested_lyrics (string, short preview)\n\n"
        "Rules:\n"
        "- Keep enhanced_prompt under 450 characters\n"
        "- Make it concrete: genre, mood, tempo, instrumentation, vocal style, storyline\n"
        "- tags should be 3-8 items\n"
        "- Write output in English"
    )

    prompt = (
        f"User script:\n{script}\n\n"
        f"Optional style hint:\n{style_hint}\n\n"
        "Create the best prompt for AI song creation."
    )

    try:
        response = gemini_client.models.generate_content(
            model="gemini-2.0-flash",
            contents=[prompt],
            config=types.GenerateContentConfig(response_mime_type="application/json", system_instruction=system_instruction),
        )
        data = json.loads(response.text)
        tags = data.get("suggested_tags") or []
        if isinstance(tags, list):
            tags = [str(t).strip() for t in tags if str(t).strip()]
        return jsonify({
            "enhanced_prompt": (data.get("enhanced_prompt") or "").strip(),
            "suggested_tags": tags,
            "suggested_lyrics": (data.get("suggested_lyrics") or "").strip(),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/generate-song", methods=["POST"])
def generate_song():
    if not SONAUTO_API_KEY:
        return jsonify({"error": "SONAUTO_API_KEY is missing on server."}), 500

    prompt = request.form.get("prompt", "").strip()
    tags = request.form.get("tags", "").strip()
    lyrics = request.form.get("lyrics", "").strip()
    instrumental = request.form.get("instrumental", "").strip().lower() == "true"
    model = request.form.get("model", "v3").strip() or "v3"
    output_format = "mp3"

    if not (prompt or tags or lyrics):
        return jsonify({"error": "Please provide prompt, tags, or lyrics."}), 400

    normalized_tags = _normalize_sonauto_tags(tags)

    try:
        try:
            task_id = _sonauto_create_generation(
                prompt=prompt,
                tags=normalized_tags,
                lyrics=lyrics,
                instrumental=instrumental,
                model=model,
                output_format=output_format,
            )
        except Exception as first_error:
            # Sonauto can reject some generated tags; retry without tags.
            msg = str(first_error)
            if "Invalid tags" in msg and normalized_tags:
                task_id = _sonauto_create_generation(
                    prompt=prompt,
                    tags="",
                    lyrics=lyrics,
                    instrumental=instrumental,
                    model=model,
                    output_format=output_format,
                )
            else:
                raise

        success = _sonauto_poll_success(task_id)
        if not success:
            return jsonify({"error": "Song generation failed or timed out."}), 500

        result = _sonauto_fetch_result(task_id)
        song_paths = result.get("song_paths") or []
        if not song_paths:
            return jsonify({"error": "No song URL returned by Sonauto."}), 500

        song_url = song_paths[0]
        dl = _sonauto_request("GET", song_url, timeout=120)
        if not dl.ok:
            return jsonify({"error": f"Failed to download song ({dl.status_code})."}), 500

        fname = f"sonauto_{uuid.uuid4().hex}.mp3"
        fpath = os.path.join(AUDIO_DIR, fname)
        with open(fpath, "wb") as f:
            f.write(dl.content)

        lyrics_text = result.get("lyrics") or ""
        result_tags = result.get("tags") or []

        return jsonify({
            "status": "done",
            "task_id": task_id,
            "filename": fname,
            "serve_url": f"/audio/{fname}",
            "tags": result_tags,
            "lyrics_preview": lyrics_text[:240],
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/enhance-prompt", methods=["POST"])
def enhance_prompt():
    """Take a simple movie idea and expand it into a detailed production brief."""
    simple_prompt = request.form.get("prompt", "").strip()
    if not simple_prompt:
        return jsonify({"error": "Please provide a movie idea."}), 400

    duration_minutes = int(request.form.get("duration_minutes", 3))

    images = request.files.getlist("images")
    image_parts = []
    for img_file in images:
        if img_file.filename and allowed_file(img_file.filename):
            image_parts.append(prepare_image(img_file))

    num_images = len(image_parts)
    ref_note = ""
    if num_images > 0:
        ref_note = (
            f"\nThe user has uploaded {num_images} reference image(s).\n"
            "CRITICAL — You MUST:\n"
            "1. Look at EACH uploaded image carefully\n"
            "2. Describe EXACTLY what you see in each image: character appearance, species, "
            "clothing, colors, hair, eyes, body type, distinguishing features\n"
            "3. Assign each image a Reference number: Reference #1, Reference #2, etc.\n"
            "4. In your CHARACTER section, write the full description based on what you SEE, not what you imagine\n"
            "5. In each SCENE, specify which Reference # numbers appear (e.g. 'Characters: Reference #1, Reference #2')\n"
            "6. In scene descriptions, ALWAYS refer to characters as 'Reference #1 (name)' so the AI knows which image to use\n"
            "7. If a character should NOT appear in a scene, do NOT mention their Reference #\n\n"
            "Example output for characters:\n"
            "  Reference #1: Lia — Human female. Long wavy brown hair, green eyes, fair skin, wearing a flowing white dress.\n"
            "  Reference #2: Purpel — Small purple octopus creature. Shiny purple body, 8 tentacles, big blue eyes.\n"
            "  Reference #3: Baby — Only appears in Scene 5. Hybrid baby with purple hair and small tentacles.\n"
        )

    system_instruction = (
        "You are a professional film script developer and creative director. "
        "The user will give you a simple movie idea (in any language). "
        "Your job is to expand it into a DETAILED production brief in English that a movie-making AI can use.\n\n"
        "OUTPUT FORMAT — write a structured production brief with these sections:\n\n"
        "1. TITLE — a catchy title\n\n"
        "2. CHARACTERS — for each character:\n"
        "   - Reference #N (if reference images are provided)\n"
        "   - Name\n"
        "   - Type (human/creature/hybrid/etc)\n"
        "   - Exact appearance: face, hair, body, features\n"
        "   - Outfit: exact clothing that stays LOCKED for the entire film\n"
        "   - When they first appear (which scene)\n\n"
        "3. SCENES — for each scene:\n"
        "   - Scene title and time range\n"
        "   - Location, time of day, weather, mood\n"
        "   - What happens (detailed narrative)\n"
        "   - Which characters appear (by Reference #)\n"
        "   - Key visual moments\n\n"
        "4. RULES:\n"
        "   - Outfit locks (who wears what, never changes)\n"
        "   - Character appearance rules (who appears when)\n"
        "   - Style (Pixar/Disney, anime, photorealistic, etc)\n"
        "   - Environment consistency (time of day, weather)\n\n"
        "IMPORTANT:\n"
        "- Write everything in ENGLISH regardless of input language\n"
        "- Be very specific about appearances — colors, textures, features\n"
        "- Lock outfits: each character wears the SAME clothes throughout\n"
        "- Specify which scenes each character appears in\n"
        "- Make the story have a clear narrative arc\n\n"
        f"TARGET DURATION: ~{duration_minutes} minute(s) ({duration_minutes * 60} seconds total).\n"
        "YOU MUST decide:\n"
        "  1. How many SCENES the story needs (typically 3-8 depending on duration)\n"
        "  2. How many SHOTS each scene needs (1-10 per scene)\n"
        "  3. How many SECONDS each shot should be (3-15 seconds per shot)\n\n"
        "Duration guidelines per shot:\n"
        "  - Quick establishing/landscape shots: 3-4s\n"
        "  - Simple character actions (walking, talking): 5-7s\n"
        "  - Key emotional moments (proposal, kiss, reveal): 8-10s\n"
        "  - Complex action sequences: 10-15s\n\n"
        f"The TOTAL of all shot durations must be close to {duration_minutes * 60} seconds.\n"
        "For each shot in your scene descriptions, write its duration like '(5 seconds)'\n"
        "- Add sound/music suggestions per scene\n\n"
        "AT THE VERY END of your output, add these TWO lines (replace with your numbers):\n"
        "SCENE_STRUCTURE: [4, 3, 5, 2, 4]\n"
        "SHOT_DURATIONS: [[5,7,5,3],[8,5,10],[5,5,7,5,5],[3,5],[7,5,10,5]]\n"
        "SCENE_STRUCTURE = array of shot counts per scene (length = number of scenes).\n"
        "SHOT_DURATIONS = nested array — durations in seconds for each shot in each scene.\n"
        f"The sum of ALL durations must be close to {duration_minutes * 60} seconds.\n"
    )

    contents = [simple_prompt] + image_parts

    try:
        response = gemini_client.models.generate_content(
            model="gemini-2.0-flash",
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
            ),
        )
        text = response.text
        scene_structure = None
        shot_durations = None
        enhanced = text
        for line in text.strip().split("\n"):
            line_clean = line.strip()
            if line_clean.startswith("SCENE_STRUCTURE:"):
                try:
                    arr_str = line_clean.split(":", 1)[1].strip()
                    scene_structure = json.loads(arr_str)
                    enhanced = enhanced.replace(line, "").strip()
                except (json.JSONDecodeError, IndexError):
                    pass
            elif line_clean.startswith("SHOT_DURATIONS:"):
                try:
                    arr_str = line_clean.split(":", 1)[1].strip()
                    shot_durations = json.loads(arr_str)
                    enhanced = enhanced.replace(line, "").strip()
                except (json.JSONDecodeError, IndexError):
                    pass

        result = {"enhanced_prompt": enhanced}
        if scene_structure:
            result["scene_count"] = len(scene_structure)
            result["shots_per_scene"] = scene_structure
        if shot_durations:
            result["shot_durations"] = shot_durations
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


ע

@app.route("/generate-shot", methods=["POST"])
def generate_shot():
    images = request.files.getlist("images")
    image_parts = []
    for img_file in images:
        if img_file.filename and allowed_file(img_file.filename):
            image_parts.append(prepare_image(img_file))
    prompt = request.form.get("prompt", "").strip()
    if not prompt:
        return jsonify({"error": "No prompt"}), 400

    is_scene_transition = request.form.get("scene_transition", "").strip() == "true"
    character_labels = request.form.get("character_labels", "").strip()

    try:
        num_refs = len(image_parts)

        if is_scene_transition:
            system_instruction = (
                "You are a cinematic storyboard image generator for a film with MULTIPLE SCENES. "
                "You MUST generate a new image for each request. "
                f"You are given {num_refs} reference image(s). "
                "The LAST image is the final frame from the PREVIOUS SCENE's video. "
                "The OTHER images are CHARACTER REFERENCES — the characters must look IDENTICAL. "
                "RULES FOR SCENE TRANSITIONS: "
                "1. NEVER add text, subtitles, captions, or watermarks. "
                "2. Use a COMPLETELY NEW camera angle and composition — this is a NEW SCENE, not a continuation. "
                "3. CHARACTER LOCK: Characters mentioned in the prompt MUST look exactly like the character references "
                "(same face, body, hair, outfit, style, proportions). Do NOT redesign or reinterpret them. "
                "4. ENVIRONMENT LOCK: Match the time of day, weather, and overall visual style/color grading "
                "from the last frame (the previous scene). If it was sunset, keep it sunset. If night, keep night. "
                "Unless the prompt explicitly says otherwise. "
                "5. ONLY include characters EXPLICITLY MENTIONED in the prompt. "
                "6. Do NOT continue the same framing — use a fresh cinematic composition."
            )
            char_label_block = f"\n\nCHARACTER IDENTITY MAP:\n{character_labels}\n" if character_labels else ""
            full_prompt = (
                "This is a NEW SCENE in the same film.\n"
                "The LAST reference image shows the previous scene's ending — match its time of day and visual style.\n"
                "The OTHER reference images are CHARACTER REFERENCES — match them EXACTLY when they appear.\n"
                f"{char_label_block}"
                "Use a FRESH camera angle and composition.\n\n"
                f"Generate this scene:\n\n{prompt}\n\n"
                "Only show characters mentioned above. Match the visual style/lighting from the previous scene. "
                "No text or watermarks."
            )
        else:
            system_instruction = (
                "You are a cinematic storyboard image generator for a film. "
                "You MUST generate a new image for each request. "
                f"You are given {num_refs} reference image(s) for CHARACTER LOCKING. "
                "RULES: "
                "1. NEVER add text, subtitles, captions, or watermarks. "
                "2. Create the EXACT scene described in the prompt with a FRESH camera angle. "
                "3. CHARACTER LOCK: When a character from the references IS mentioned in the prompt, "
                "use the EXACT same face, body, hair, clothing from the matching reference. "
                "Do NOT create new random characters — only use the ones from references. "
                "Do NOT redesign or reinterpret the characters — they must be IDENTICAL to the references. "
                "4. CRITICAL: ONLY include characters that are EXPLICITLY MENTIONED in the prompt. "
                "If the prompt says 'an empty beach at sunset', do NOT add any characters even though you have references. "
                "If the prompt only mentions one character, only show that one character. "
                "The references are a library — use them ONLY when the prompt calls for that character. "
                "5. Generate a completely NEW composition, camera angle, and environment as described. "
                "6. Do NOT copy any reference image layout or background — only use character appearances when needed."
            )
            ref_label = "Reference images are" if num_refs > 1 else "Reference image is"
            char_label_block = f"\n\nCHARACTER IDENTITY MAP:\n{character_labels}\n" if character_labels else ""
            full_prompt = (
                f"{ref_label} a CHARACTER LIBRARY — use them ONLY when the prompt mentions that character.\n"
                "Characters must look IDENTICAL to their reference — same face, body, outfit.\n"
                f"{char_label_block}"
                f"Do NOT add characters that are not described in this specific shot.\n\n"
                f"Generate this scene:\n\n{prompt}\n\n"
                "IMPORTANT: Only show characters explicitly mentioned above. No extra characters. "
                "Characters must be identical to references. No text or watermarks."
            )
        response = gemini_client.models.generate_content(
            model="gemini-2.5-flash-image",
            contents=[full_prompt] + image_parts,
            config=types.GenerateContentConfig(
                response_modalities=["TEXT", "IMAGE"],
                system_instruction=system_instruction,
            ),
        )
        result_image_b64 = None
        result_text = ""
        mime = "image/png"
        file_path = None

        if response.candidates:
            for part in response.candidates[0].content.parts:
                if part.text:
                    result_text += part.text
                elif part.inline_data:
                    result_image_b64, mime, file_path = save_and_encode(part.inline_data)

        if not result_image_b64:
            return jsonify({"error": "Failed to generate image", "text": result_text}), 422

        return jsonify({
            "image": f"data:{mime};base64,{result_image_b64}",
            "text": result_text,
            "file_path": file_path,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Kling: Image-to-Video (kling-v3) ─────────────────────────────────────────
def _strip_data_url_base64(raw: str) -> str:
    s = (raw or "").strip()
    if s.startswith("data:") and "base64," in s:
        return s.split("base64,", 1)[1].strip()
    return s


def _bytes_to_standard_jpeg(img_bytes: bytes):
    """Decode any supported image bytes and re-encode as baseline RGB JPEG (Kling-friendly)."""
    try:
        img = Image.open(io.BytesIO(img_bytes))
        if img.mode in ("RGBA", "P", "LA"):
            img = img.convert("RGB")
        elif img.mode != "RGB":
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=90)
        return buf.getvalue()
    except Exception:
        return None


def _normalize_raw_base64_to_jpeg_b64(raw: str):
    """Accept raw or data-URL base64; return standard JPEG as ascii base64."""
    s = _strip_data_url_base64(raw)
    if not s:
        return None
    try:
        img_bytes = base64.b64decode(s, validate=False)
    except Exception:
        return None
    out = _bytes_to_standard_jpeg(img_bytes)
    if not out:
        return None
    return base64.b64encode(out).decode("ascii")


def _load_image_b64(image_path="", image_b64_raw=""):
    """Load an image from path or raw base64 and return clean JPEG base64."""
    if image_path and os.path.exists(image_path):
        with open(image_path, "rb") as f:
            img_data = f.read()
    elif image_b64_raw:
        img_data = base64.b64decode(_strip_data_url_base64(image_b64_raw))
    else:
        return None

    img = Image.open(io.BytesIO(img_data))
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode("ascii")


@app.route("/generate-video", methods=["POST"])
def generate_video():
    """Single-shot image-to-video using kling-v3."""
    try:
        image_b64 = _load_image_b64(
            request.json.get("image_path", ""),
            request.json.get("image_b64", ""),
        )
        if not image_b64:
            return jsonify({"error": "No image provided"}), 400
    except Exception as e:
        return jsonify({"error": f"Image conversion failed: {e}"}), 400

    shot_duration = request.json.get("duration", 5)
    shot_duration = max(3, min(15, int(shot_duration)))

    body = {
        "model_name": "kling-v3",
        "image": image_b64,
        "prompt": (request.json.get("motion_prompt") or "subtle camera movement, cinematic")[:2500],
        "duration": str(shot_duration),
        "aspect_ratio": "16:9",
        "mode": "pro",
        "sound": "on",
    }

    token = build_kling_jwt()
    try:
        resp = kling_request(
            "POST",
            "https://api.klingai.com/v1/videos/image2video",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            json=body,
            timeout=30,
        )
        data = resp.json()
        if data.get("code") != 0:
            return jsonify({"error": f"Kling error: {json.dumps(data)}"}), 500

        task_id = data.get("data", {}).get("task_id")
        if not task_id:
            return jsonify({"error": "No task_id returned"}), 500

        return jsonify({"task_id": task_id, "status": "submitted"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/generate-shot-video", methods=["POST"])
def generate_shot_video():
    """Generate video for a single shot. Always uses omni endpoint to support
    last frame + storyboard + character reference images together."""
    last_frame_b64 = request.json.get("last_frame_b64", "")
    storyboard_path = request.json.get("storyboard_path", "")
    storyboard_b64_raw = request.json.get("storyboard_b64", "")
    ref_images_b64 = request.json.get("ref_images_b64", [])
    motion_prompt = (request.json.get("motion_prompt") or "cinematic camera movement")[:2500]
    shot_duration = max(3, min(15, int(request.json.get("duration", 5))))

    try:
        storyboard_img = _load_image_b64(storyboard_path, storyboard_b64_raw)
    except Exception:
        storyboard_img = None

    image_list = []
    prompt_parts = []
    img_idx = 0

    # First frame: last frame from previous shot (continuity within scene)
    if last_frame_b64:
        norm_last = _normalize_raw_base64_to_jpeg_b64(last_frame_b64)
        if not norm_last:
            return jsonify({"error": "Invalid last_frame image (could not normalize to JPEG)."}), 400
        img_idx += 1
        image_list.append({"image_url": norm_last, "type": "first_frame"})
        prompt_parts.append(f"Continue from <<<image_{img_idx}>>> (previous shot ending).")

    # Storyboard image (scene composition reference)
    if storyboard_img:
        img_idx += 1
        image_list.append({"image_url": storyboard_img})
        prompt_parts.append(f"<<<image_{img_idx}>>> shows the target scene composition.")

    # Character reference images (character lock — max 5 to stay within API limits)
    for ref_b64 in ref_images_b64[:5]:
        if len(image_list) >= 7:
            break
        norm_ref = _normalize_raw_base64_to_jpeg_b64(ref_b64)
        if not norm_ref:
            return jsonify({"error": "Invalid reference image (could not normalize to JPEG)."}), 400
        img_idx += 1
        image_list.append({"image_url": norm_ref})
        prompt_parts.append(f"<<<image_{img_idx}>>> is a character/style reference — keep characters identical.")

    if not image_list:
        return jsonify({"error": "No images provided"}), 400

    prompt_parts.append(f"Action: {motion_prompt}")
    prompt_parts.append("CRITICAL: Keep all characters exactly matching the reference images. No new random characters.")

    if len(image_list) == 1 and not last_frame_b64:
        body = {
            "model_name": "kling-v3",
            "image": image_list[0]["image_url"],
            "prompt": motion_prompt[:2500],
            "duration": str(shot_duration),
            "aspect_ratio": "16:9",
            "mode": "pro",
            "sound": "on",
        }
        endpoint = "https://api.klingai.com/v1/videos/image2video"
    else:
        body = {
            "model_name": "kling-v3-omni",
            "prompt": " ".join(prompt_parts)[:2500],
            "image_list": image_list,
            "duration": str(shot_duration),
            "aspect_ratio": "16:9",
            "mode": "pro",
            "sound": "on",
        }
        endpoint = "https://api.klingai.com/v1/videos/omni-video"

    token = build_kling_jwt()
    try:
        resp = kling_request(
            "POST",
            endpoint,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            json=body,
            timeout=30,
        )
        data = resp.json()
        if data.get("code") != 0:
            return jsonify({"error": f"Kling error: {json.dumps(data)}"}), 500

        task_id = data.get("data", {}).get("task_id")
        if not task_id:
            return jsonify({"error": "No task_id returned"}), 500

        return jsonify({"task_id": task_id, "status": "submitted"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/generate-transition", methods=["POST"])
def generate_transition():
    """Create a transition video from last frame of scene N to first image of scene N+1."""
    start_b64 = request.json.get("start_frame_b64", "")
    end_b64 = request.json.get("end_frame_b64", "")
    end_path = request.json.get("end_frame_path", "")
    prompt = request.json.get("prompt", "Smooth cinematic transition, continuous camera movement")
    duration = request.json.get("duration", "3")

    if not start_b64:
        return jsonify({"error": "No start frame"}), 400

    norm_start = _normalize_raw_base64_to_jpeg_b64(start_b64)
    if not norm_start:
        return jsonify({"error": "Invalid start frame image."}), 400

    try:
        end_image_b64 = _load_image_b64(end_path, end_b64) if (end_path or end_b64) else None
    except Exception:
        end_image_b64 = None

    if not end_image_b64:
        return jsonify({"error": "No end frame"}), 400

    body = {
        "model_name": "kling-v3",
        "image": norm_start,
        "image_tail": end_image_b64,
        "prompt": prompt,
        "duration": str(duration),
        "aspect_ratio": "16:9",
        "mode": "pro",
        "sound": "on",
    }

    token = build_kling_jwt()
    try:
        resp = kling_request(
            "POST",
            "https://api.klingai.com/v1/videos/image2video",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            json=body,
            timeout=30,
        )
        data = resp.json()
        if data.get("code") != 0:
            return jsonify({"error": f"Kling error: {json.dumps(data)}"}), 500

        task_id = data.get("data", {}).get("task_id")
        if not task_id:
            return jsonify({"error": "No task_id returned"}), 500

        return jsonify({"task_id": task_id, "status": "submitted", "duration": int(duration)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/generate-scene-video", methods=["POST"])
def generate_scene_video():
    """Multi-shot scene video using kling-v3-omni. Supports last-frame chaining + storyboard refs."""
    shots = request.json.get("shots", [])
    if not shots:
        return jsonify({"error": "No shots provided"}), 400

    shots = shots[:6]  # API max 6 shots

    prev_frame_b64 = request.json.get("prev_last_frame_b64", "")

    first_shot = shots[0]
    try:
        storyboard_b64 = _load_image_b64(
            first_shot.get("image_path", ""),
            first_shot.get("image_b64", ""),
        )
    except Exception:
        storyboard_b64 = None

    image_list = []
    norm_prev = None
    if prev_frame_b64:
        norm_prev = _normalize_raw_base64_to_jpeg_b64(prev_frame_b64)
        if not norm_prev:
            return jsonify({"error": "Invalid prev_last_frame image."}), 400
        image_list.append({"image_url": norm_prev, "type": "first_frame"})
    if storyboard_b64:
        if not norm_prev:
            image_list.append({"image_url": storyboard_b64, "type": "first_frame"})
        else:
            image_list.append({"image_url": storyboard_b64})

    if not image_list:
        return jsonify({"error": "No images available"}), 400

    secs_per_shot = max(2, min(5, 15 // len(shots)))
    total_duration = secs_per_shot * len(shots)

    multi_prompt = []
    for i, shot in enumerate(shots):
        prompt = shot.get("motion_prompt") or "cinematic camera movement"
        if len(prompt) > 512:
            prompt = prompt[:509] + "..."
        multi_prompt.append({
            "index": i + 1,
            "prompt": prompt,
            "duration": str(secs_per_shot),
        })

    if norm_prev and storyboard_b64:
        top_prompt = (
            "Continue from <<<image_1>>> (previous scene's last frame). "
            "Use <<<image_2>>> as character/style reference to keep appearance consistent."
        )
    elif storyboard_b64:
        top_prompt = "Generate a cinematic video matching the character and style from <<<image_1>>>."
    else:
        top_prompt = ""

    body = {
        "model_name": "kling-v3-omni",
        "prompt": top_prompt,
        "image_list": image_list,
        "multi_shot": True,
        "shot_type": "customize",
        "multi_prompt": multi_prompt,
        "duration": str(total_duration),
        "aspect_ratio": "16:9",
        "mode": "pro",
        "sound": "on",
    }

    token = build_kling_jwt()
    try:
        resp = kling_request(
            "POST",
            "https://api.klingai.com/v1/videos/omni-video",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            json=body,
            timeout=30,
        )
        data = resp.json()
        if data.get("code") != 0:
            return jsonify({"error": f"Kling error: {json.dumps(data)}"}), 500

        task_id = data.get("data", {}).get("task_id")
        if not task_id:
            return jsonify({"error": "No task_id returned"}), 500

        return jsonify({
            "task_id": task_id,
            "status": "submitted",
            "duration": total_duration,
            "shots_count": len(shots),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/poll-video/<task_id>", methods=["GET"])
def poll_video(task_id):
    """Poll Kling task status. Tries omni-video first, falls back to image2video."""
    token = build_kling_jwt()
    api_type = request.args.get("api", "")
    try:
        endpoints = (
            [f"https://api.klingai.com/v1/videos/{api_type}/{task_id}"]
            if api_type
            else [
                f"https://api.klingai.com/v1/videos/omni-video/{task_id}",
                f"https://api.klingai.com/v1/videos/image2video/{task_id}",
            ]
        )
        data = None
        for url in endpoints:
            resp = kling_request(
                "GET",
                url,
                headers={"Authorization": f"Bearer {token}"},
                timeout=15,
            )
            data = resp.json()
            if data.get("code") == 0 and data.get("data", {}).get("task_status"):
                break
        status = data.get("data", {}).get("task_status", "unknown")

        if status == "succeed":
            videos = data.get("data", {}).get("task_result", {}).get("videos", [])
            video_url = videos[0]["url"] if videos else None
            if video_url:
                fname = f"{task_id}.mp4"
                fpath = os.path.join(VIDEO_DIR, fname)
                if not os.path.exists(fpath):
                    dl = requests.get(video_url, timeout=60)
                    with open(fpath, "wb") as f:
                        f.write(dl.content)
                url_map_path = os.path.join(VIDEO_DIR, "url_map.json")
                url_map = {}
                if os.path.exists(url_map_path):
                    with open(url_map_path) as mf:
                        url_map = json.load(mf)
                url_map[fname] = video_url
                with open(url_map_path, "w") as mf:
                    json.dump(url_map, mf)
                return jsonify({
                    "status": "succeed",
                    "video_url": video_url,
                    "local_path": fpath,
                    "serve_url": f"/videos/{fname}",
                })
            return jsonify({"status": "succeed", "error": "No video URL"})

        if status == "failed":
            msg = data.get("data", {}).get("task_status_msg", "Unknown failure")
            return jsonify({"status": "failed", "error": msg})

        return jsonify({"status": status})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)})


@app.route("/videos/<path:filename>")
def serve_video(filename):
    from flask import send_from_directory
    return send_from_directory(VIDEO_DIR, filename)


@app.route("/extract-last-frame/<task_id>", methods=["GET"])
def extract_frame_endpoint(task_id):
    """Extract the last frame from a downloaded scene video. Returns base64 JPEG."""
    fpath = os.path.join(VIDEO_DIR, f"{task_id}.mp4")
    if not os.path.exists(fpath):
        return jsonify({"error": "Video not found"}), 404
    frame_data = extract_last_frame(fpath)
    if not frame_data:
        return jsonify({"error": "Failed to extract frame"}), 500
    std = _bytes_to_standard_jpeg(frame_data)
    if std:
        frame_data = std
    return jsonify({"frame_b64": base64.b64encode(frame_data).decode("ascii")})


@app.route("/assembler")
def assembler():
    return render_template("assembler.html", cache_bust=int(time.time()))


@app.route("/list-videos", methods=["GET"])
def list_videos():
    """List all local video files in the videos directory with public URLs."""
    url_map_path = os.path.join(VIDEO_DIR, "url_map.json")
    url_map = {}
    if os.path.exists(url_map_path):
        with open(url_map_path) as mf:
            url_map = json.load(mf)

    vids = []
    for fname in sorted(os.listdir(VIDEO_DIR)):
        if fname.endswith(".mp4"):
            fpath = os.path.join(VIDEO_DIR, fname)
            vids.append({
                "filename": fname,
                "serve_url": f"/videos/{fname}",
                "public_url": url_map.get(fname, ""),
                "size_mb": round(os.path.getsize(fpath) / (1024 * 1024), 1),
            })
    return jsonify(vids)


@app.route("/upload-video", methods=["POST"])
def upload_video():
    """Upload a video file to the server."""
    if "video" not in request.files:
        return jsonify({"error": "No video file"}), 400
    file = request.files["video"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else "mp4"
    if ext not in ("mp4", "mov", "webm"):
        return jsonify({"error": "Unsupported format. Use mp4, mov, or webm."}), 400
    fname = f"{uuid.uuid4().hex}.{ext}"
    fpath = os.path.join(VIDEO_DIR, fname)
    file.save(fpath)
    return jsonify({
        "filename": fname,
        "serve_url": f"/videos/{fname}",
        "size_mb": round(os.path.getsize(fpath) / (1024 * 1024), 1),
    })


@app.route("/upload-audio", methods=["POST"])
def upload_audio():
    """Upload an audio file to the server."""
    if "audio" not in request.files:
        return jsonify({"error": "No audio file"}), 400
    file = request.files["audio"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else "mp3"
    if ext not in ("mp3", "wav", "aac", "m4a", "ogg"):
        return jsonify({"error": "Unsupported format. Use mp3, wav, aac, m4a, or ogg."}), 400
    fname = f"{uuid.uuid4().hex}.{ext}"
    fpath = os.path.join(AUDIO_DIR, fname)
    file.save(fpath)
    return jsonify({
        "filename": fname,
        "serve_url": f"/audio/{fname}",
    })


@app.route("/audio/<path:filename>")
def serve_audio(filename):
    from flask import send_from_directory
    return send_from_directory(AUDIO_DIR, filename)


# ── Local Assembly via FFmpeg ─────────────────────────────────────────────────
@app.route("/assemble-local", methods=["POST"])
def assemble_local():
    """Concatenate local video files using ffmpeg, optionally mix background audio."""
    filenames = request.json.get("filenames", [])
    if len(filenames) < 2:
        return jsonify({"error": "Need at least 2 clips"}), 400

    audio_filename = request.json.get("audio_filename", "")
    music_vol = request.json.get("music_volume", 0.8)
    video_vol = request.json.get("video_volume", 1.0)
    aspect_ratio = request.json.get("aspect_ratio", "16:9")
    fit_mode = request.json.get("fit_mode", "pad")

    ratio_map = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080), "5:4": (1350, 1080)}
    out_w, out_h = ratio_map.get(aspect_ratio, (1920, 1080))

    uid_str = uuid.uuid4().hex
    list_path = os.path.join(VIDEO_DIR, f"_concat_{uid_str}.txt")
    concat_path = os.path.join(VIDEO_DIR, f"_concat_{uid_str}.mp4")
    output_name = f"assembled_{uid_str}.mp4"
    output_path = os.path.join(VIDEO_DIR, output_name)

    try:
        with open(list_path, "w") as f:
            for fname in filenames:
                fpath = os.path.join(VIDEO_DIR, fname)
                if not os.path.exists(fpath):
                    return jsonify({"error": f"Video not found: {fname}"}), 404
                f.write(f"file '{fpath}'\n")

        result = subprocess.run([
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", list_path, "-c", "copy", concat_path,
        ], capture_output=True, text=True, timeout=120)

        os.remove(list_path)

        if result.returncode != 0:
            return jsonify({"error": f"FFmpeg concat error: {result.stderr[-500:]}"}), 500

        has_audio = audio_filename and os.path.exists(os.path.join(AUDIO_DIR, audio_filename))
        watermark_enabled = request.json.get("watermark", True)
        has_watermark = watermark_enabled and os.path.exists(WATERMARK_PATH)

        if fit_mode == "crop":
            scale_filter = f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h}"
        elif fit_mode == "stretch":
            scale_filter = f"scale={out_w}:{out_h}"
        else:
            scale_filter = f"scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:black"

        needs_processing = has_audio or has_watermark or aspect_ratio != "16:9" or fit_mode != "pad"

        if not needs_processing:
            os.rename(concat_path, output_path)
        else:
            inputs = ["-i", concat_path]
            vf_chain = [scale_filter]
            audio_filters = []
            maps = []
            video_codec = ["-c:v", "libx264", "-preset", "fast", "-crf", "18"]

            if has_audio:
                audio_path = os.path.join(AUDIO_DIR, audio_filename)
                inputs += ["-stream_loop", "-1", "-i", audio_path]

            if has_watermark:
                # Loop watermark image so overlay persists across the whole video.
                inputs += ["-loop", "1", "-i", WATERMARK_PATH]
                wm_idx = 2 if has_audio else 1
                vf_chain_str = ",".join(vf_chain)
                filter_parts = [f"[0:v]{vf_chain_str}[scaled]"]
                filter_parts.append(f"[scaled][{wm_idx}:v]overlay=W-w-10:H-h-10[vout]")
                maps += ["-map", "[vout]"]
            else:
                vf_chain_str = ",".join(vf_chain)
                filter_parts = [f"[0:v]{vf_chain_str}[vout]"]
                maps += ["-map", "[vout]"]

            if has_audio:
                filter_parts.append(f"[0:a]volume={video_vol}[va]")
                filter_parts.append(f"[1:a]volume={music_vol}[ma]")
                filter_parts.append("[va][ma]amix=inputs=2:duration=shortest[aout]")
                maps += ["-map", "[aout]"]
            else:
                maps += ["-map", "0:a?"]

            cmd = ["ffmpeg", "-y"] + inputs
            cmd += ["-filter_complex", ";".join(filter_parts)]
            cmd += maps + video_codec + ["-c:a", "aac", "-b:a", "192k", "-shortest", output_path]

            result2 = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            os.remove(concat_path)

            if result2.returncode != 0:
                return jsonify({"error": f"FFmpeg post-process error: {result2.stderr[-500:]}"}), 500

        return jsonify({
            "status": "done",
            "serve_url": f"/videos/{output_name}",
            "filename": output_name,
        })
    except Exception as e:
        for tmp in [list_path, concat_path]:
            if os.path.exists(tmp):
                os.remove(tmp)
        return jsonify({"error": str(e)}), 500


# ── Shotstack: Assemble Final Video ──────────────────────────────────────────
@app.route("/assemble-video", methods=["POST"])
def assemble_video():
    """Build Shotstack timeline from clips and submit render."""
    clips = request.json.get("clips", [])
    if not clips:
        return jsonify({"error": "No clips provided"}), 400

    track_clips = []
    current_start = 0
    for clip in clips:
        video_url = clip.get("url", "")
        duration = clip.get("duration", 5)
        if not video_url:
            continue
        track_clips.append({
            "asset": {"type": "video", "src": video_url},
            "start": current_start,
            "length": duration,
        })
        current_start += duration

    timeline_json = {
        "timeline": {
            "background": "#000000",
            "tracks": [{"clips": track_clips}],
        },
        "output": {
            "format": "mp4",
            "resolution": "hd",
            "aspectRatio": "16:9",
        },
    }

    try:
        resp = requests.post(
            f"https://api.shotstack.io/{SHOTSTACK_ENV}/render",
            headers={
                "Content-Type": "application/json",
                "x-api-key": SHOTSTACK_API_KEY,
            },
            json=timeline_json,
            timeout=30,
        )
        data = resp.json()
        render_id = data.get("response", {}).get("id")
        if not render_id:
            return jsonify({"error": f"Shotstack error: {json.dumps(data)}"}), 500
        return jsonify({"render_id": render_id, "status": "submitted"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/poll-render/<render_id>", methods=["GET"])
def poll_render(render_id):
    """Poll Shotstack render status."""
    try:
        resp = requests.get(
            f"https://api.shotstack.io/{SHOTSTACK_ENV}/render/{render_id}",
            headers={"x-api-key": SHOTSTACK_API_KEY},
            timeout=15,
        )
        data = resp.json()
        status = data.get("response", {}).get("status", "unknown")

        if status == "done":
            url = data.get("response", {}).get("url", "")
            return jsonify({"status": "done", "url": url})
        if status == "failed":
            return jsonify({"status": "failed", "error": data.get("response", {}).get("error", "Unknown")})

        return jsonify({"status": status})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)})


# ── Single Image Edit (kept) ─────────────────────────────────────────────────
@app.route("/generate", methods=["POST"])
def generate():
    if "image" not in request.files:
        return jsonify({"error": "No image uploaded"}), 400
    file = request.files["image"]
    if file.filename == "" or not allowed_file(file.filename):
        return jsonify({"error": "Invalid file type"}), 400
    prompt = request.form.get("prompt", "").strip()
    if not prompt:
        return jsonify({"error": "Please provide a prompt."}), 400

    try:
        image_part = prepare_image(file)
        system_instruction = (
            "You are an image editing assistant. "
            "RULES: "
            "1. NEVER add text, subtitles, captions, or watermarks. "
            "2. Make significant visible changes based on the prompt. "
            "3. Only include elements explicitly mentioned in the prompt. "
            "4. Always output a generated image."
        )
        response = gemini_client.models.generate_content(
            model="gemini-2.5-flash-image",
            contents=[f"Edit this image: {prompt}. No text on image.", image_part],
            config=types.GenerateContentConfig(
                response_modalities=["TEXT", "IMAGE"],
                system_instruction=system_instruction,
            ),
        )
        result_text = ""
        result_image_b64 = None
        mime = "image/png"
        if response.candidates:
            for part in response.candidates[0].content.parts:
                if part.text:
                    result_text += part.text
                elif part.inline_data:
                    result_image_b64, mime, _ = save_and_encode(part.inline_data)
        if not result_image_b64:
            return jsonify({"error": "Model did not return an image.", "text": result_text}), 422
        return jsonify({"image": f"data:{mime};base64,{result_image_b64}", "text": result_text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5001"))
    app.run(debug=True, port=port)
