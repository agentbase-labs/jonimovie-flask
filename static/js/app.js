const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const errorToast = $("#errorToast");

function showToast(msg, dur = 5000) {
  errorToast.textContent = msg;
  errorToast.classList.remove("hidden");
  requestAnimationFrame(() => errorToast.classList.add("show"));
  setTimeout(() => {
    errorToast.classList.remove("show");
    setTimeout(() => errorToast.classList.add("hidden"), 300);
  }, dur);
}

function setProgress(pct, text) {
  $("#progressSection").classList.remove("hidden");
  $("#progressFill").style.width = pct + "%";
  $("#progressText").textContent = text;
}

function markStep(num, state) {
  const el = $(`.step[data-step="${num}"]`);
  if (!el) return;
  el.classList.remove("active", "done");
  if (state) el.classList.add(state);
}

function showStep(num) {
  for (let i = 1; i <= 4; i++) {
    const s = $(`#step${i}`);
    if (s) s.classList.toggle("hidden", i !== num);
  }
}

// ── Upload (multi-image) ─────────────────────────────────────────────────────
const MAX_REFS = 7;
let selectedFiles = [];
const uploadZone = $("#uploadZone");
const fileInput = $("#fileInput");
const refThumbs = $("#refThumbs");
const conceptInput = $("#conceptInput");
const startBtn = $("#startBtn");
const creationReference = $("#creationReference");
const creationPromptView = $("#creationPromptView");
const creationImageRefs = $("#creationImageRefs");
const waitingSongPlayer = $("#waitingSongPlayer");
const waitingSongAudio = $("#waitingSongAudio");
const waitingSongLabel = $("#waitingSongLabel");
const enableSongGen = $("#enableSongGen");
const songAiBody = $("#songAiBody");
const songPromptInput = $("#songPromptInput");
const songTagsInput = $("#songTagsInput");
let songEnhanceTimer = null;
let songEnhanceRequestId = 0;

function updateStartBtn() {
  startBtn.disabled = !(selectedFiles.length > 0 && conceptInput.value.trim());
}

function updateWaitingSongPlayer(serveUrl = "", label = "Play while rendering") {
  if (!waitingSongPlayer || !waitingSongAudio || !waitingSongLabel) return;
  if (!serveUrl) {
    waitingSongAudio.pause();
    waitingSongAudio.removeAttribute("src");
    waitingSongAudio.load();
    waitingSongLabel.textContent = "Play while rendering";
    waitingSongPlayer.classList.add("hidden");
    return;
  }
  waitingSongAudio.src = serveUrl;
  waitingSongLabel.textContent = label;
  waitingSongPlayer.classList.remove("hidden");
}

function applyGeneratedAudioToUi(serverFilename, serveUrl, displayName = "AI Song") {
  mainAudioFile = { filename: displayName, server_filename: serverFilename, serve_url: serveUrl };

  if ($("#advAudioName")) $("#advAudioName").textContent = displayName;
  if ($("#advAudioPreview")) $("#advAudioPreview").src = serveUrl;
  if ($("#advAudioEmpty")) $("#advAudioEmpty").classList.add("hidden");
  if ($("#advAudioTrack")) $("#advAudioTrack").classList.remove("hidden");

  if ($("#mainAudioName")) $("#mainAudioName").textContent = displayName;
  if ($("#mainAudioPreview")) $("#mainAudioPreview").src = serveUrl;
  if ($("#mainAudioEmpty")) $("#mainAudioEmpty").classList.add("hidden");
  if ($("#mainAudioTrack")) $("#mainAudioTrack").classList.remove("hidden");
  updateWaitingSongPlayer(serveUrl, `${displayName} - play while waiting`);
}

function forceMusicVolume100() {
  mainMusicVol = 100;
  if ($("#advMusicVol")) $("#advMusicVol").value = 100;
  if ($("#advMusicVolVal")) $("#advMusicVolVal").textContent = "100%";
  if ($("#mainMusicVol")) $("#mainMusicVol").value = 100;
  if ($("#mainMusicVolVal")) $("#mainMusicVolVal").textContent = "100%";
}

async function maybeGenerateSongBeforeMovie() {
  if (!enableSongGen || !enableSongGen.checked) return true;

  let songPrompt = (songPromptInput?.value || "").trim();
  const movieScript = conceptInput.value.trim();
  const songTags = (songTagsInput?.value || "").trim();

  if (!movieScript) {
    showToast("Please add your video prompt first.");
    return false;
  }

  try {
    if (!songPrompt) {
      const enhanced = await autoEnhanceSongPrompt(true);
      if (!enhanced) {
        showToast("Song prompt enhance failed.");
        return false;
      }
      songPrompt = (songPromptInput?.value || "").trim();
    }

    if (!songPrompt) {
      showToast("Song prompt is empty.");
      return false;
    }

    setProgress(4, "Generating AI song (this can take 1-3 minutes)…");
    const gfd = new FormData();
    gfd.append("prompt", songPrompt);
    gfd.append("tags", songTagsInput.value.trim() || songTags);
    const gResp = await fetch("/generate-song", { method: "POST", body: gfd });
    const gData = await gResp.json();
    if (gData.error) {
      showToast("Song generation failed: " + gData.error);
      return false;
    }

    const displayName = `AI Song ${new Date().toLocaleTimeString()}.mp3`;
    applyGeneratedAudioToUi(gData.filename, gData.serve_url, displayName);
    forceMusicVolume100();
    return true;
  } catch (err) {
    showToast("Song generation error: " + err.message);
    return false;
  }
}

async function autoEnhanceSongPrompt(showErrors = false) {
  const script = conceptInput.value.trim();
  if (!script) return false;

  const reqId = ++songEnhanceRequestId;
  try {
    if (songPromptInput) songPromptInput.placeholder = "Enhancing with AI...";
    const fd = new FormData();
    fd.append("script", script);
    fd.append("style_hint", conceptInput.value.trim());
    const resp = await fetch("/enhance-song-prompt", { method: "POST", body: fd });
    const data = await resp.json();
    if (reqId !== songEnhanceRequestId) return false;
    if (data.error) {
      if (showErrors) showToast("Enhance failed: " + data.error);
      return false;
    }
    if (songPromptInput) songPromptInput.value = data.enhanced_prompt || "";
    if (songTagsInput && !songTagsInput.value.trim() && Array.isArray(data.suggested_tags)) {
      songTagsInput.value = data.suggested_tags.join(",");
    }
    return true;
  } catch (err) {
    if (showErrors) showToast("Enhance error: " + err.message);
    return false;
  } finally {
    if (songPromptInput) songPromptInput.placeholder = "Enhanced song prompt will appear here (editable).";
  }
}

function scheduleSongEnhance() {
  if (songEnhanceTimer) clearTimeout(songEnhanceTimer);
  songEnhanceTimer = setTimeout(() => {
    autoEnhanceSongPrompt(false);
  }, 800);
}

uploadZone.addEventListener("click", (e) => {
  if (e.target.closest(".thumb-remove")) return;
  if (selectedFiles.length < MAX_REFS) fileInput.click();
});
fileInput.addEventListener("change", () => {
  addFiles(Array.from(fileInput.files));
  fileInput.value = "";
});
uploadZone.addEventListener("dragover", (e) => { e.preventDefault(); uploadZone.classList.add("dragover"); });
uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("dragover"));
uploadZone.addEventListener("drop", (e) => {
  e.preventDefault(); uploadZone.classList.remove("dragover");
  const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
  addFiles(files);
});
conceptInput.addEventListener("input", updateStartBtn);
conceptInput.addEventListener("input", () => {
  if (!enableSongGen || !enableSongGen.checked) return;
  scheduleSongEnhance();
});
if (enableSongGen) {
  enableSongGen.addEventListener("change", () => {
    songAiBody.classList.toggle("hidden", !enableSongGen.checked);
    if (enableSongGen.checked) scheduleSongEnhance();
  });
}

// Scene & per-scene shot steppers
const sceneCount = $("#sceneCount");
const sceneHint = $("#sceneHint");
const sceneMinus = $("#sceneMinus");
const scenePlus = $("#scenePlus");
const perSceneShotsContainer = $("#perSceneShots");
let sceneShotCounts = [4, 4, 4, 4, 4]; // default: 5 scenes × 4 shots

const movieDuration = $("#movieDuration");

function getNumScenes() { return parseInt(sceneCount.value) || 5; }
function getDuration() { return parseInt(movieDuration.value) || 3; }
function getTotalShots() { return sceneShotCounts.slice(0, getNumScenes()).reduce((a, b) => a + b, 0); }

function updateSceneHint() {
  const n = getNumScenes();
  const total = getTotalShots();
  const dur = getDuration();
  sceneHint.textContent = `${n} scene${n > 1 ? "s" : ""} — ${total} shots — ~${dur} min`;
}

movieDuration.addEventListener("change", updateSceneHint);

function renderPerSceneShots() {
  const n = getNumScenes();
  while (sceneShotCounts.length < n) sceneShotCounts.push(4);
  perSceneShotsContainer.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const item = document.createElement("div");
    item.className = "scene-shot-item";
    item.innerHTML = `<span>S${i + 1}</span><input type="number" value="${sceneShotCounts[i]}" min="1" max="10" data-scene="${i}"> shots`;
    item.querySelector("input").addEventListener("input", (e) => {
      sceneShotCounts[i] = Math.max(1, Math.min(10, parseInt(e.target.value) || 4));
      updateSceneHint();
    });
    perSceneShotsContainer.appendChild(item);
  }
  updateSceneHint();
}

sceneMinus.addEventListener("click", () => {
  const v = getNumScenes();
  if (v > 1) { sceneCount.value = v - 1; renderPerSceneShots(); }
});
scenePlus.addEventListener("click", () => {
  const v = getNumScenes();
  if (v < 20) { sceneCount.value = v + 1; renderPerSceneShots(); }
});
sceneCount.addEventListener("input", renderPerSceneShots);
renderPerSceneShots();

// ── Advanced Settings (top) — syncs with Film Settings at step 3 ────────────
function syncAdvToMain() {
  if ($("#mainRatioBtns")) {
    document.querySelectorAll("#mainRatioBtns .ratio-btn").forEach((b) => b.classList.remove("active"));
    const match = document.querySelector(`#mainRatioBtns .ratio-btn[data-ratio="${mainAspectRatio}"]`);
    if (match) match.classList.add("active");
  }
  if ($("#mainFitMode")) $("#mainFitMode").value = mainFitMode;
  if ($("#mainWatermark")) $("#mainWatermark").checked = $("#advWatermark").checked;
  if ($("#mainMusicVol")) { $("#mainMusicVol").value = mainMusicVol; $("#mainMusicVolVal").textContent = mainMusicVol + "%"; }
  if ($("#mainVideoVol")) { $("#mainVideoVol").value = mainVideoVol; $("#mainVideoVolVal").textContent = mainVideoVol + "%"; }
  if (mainAudioFile && $("#mainAudioName")) {
    $("#mainAudioName").textContent = mainAudioFile.filename;
    $("#mainAudioPreview").src = mainAudioFile.serve_url;
    $("#mainAudioEmpty").classList.add("hidden");
    $("#mainAudioTrack").classList.remove("hidden");
  }
}

document.querySelectorAll("#advRatioBtns .ratio-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#advRatioBtns .ratio-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    mainAspectRatio = btn.dataset.ratio;
  });
});
$("#advFitMode").addEventListener("change", (e) => { mainFitMode = e.target.value; });
$("#advMusicVol").addEventListener("input", (e) => {
  mainMusicVol = parseInt(e.target.value);
  $("#advMusicVolVal").textContent = mainMusicVol + "%";
});
$("#advVideoVol").addEventListener("input", (e) => {
  mainVideoVol = parseInt(e.target.value);
  $("#advVideoVolVal").textContent = mainVideoVol + "%";
});

const advAudioInput = $("#advAudioInput");
$("#advAddAudioBtn").addEventListener("click", () => advAudioInput.click());
advAudioInput.addEventListener("change", async () => {
  const f = advAudioInput.files[0];
  if (!f) return;
  advAudioInput.value = "";
  const fd = new FormData();
  fd.append("audio", f);
  try {
    const resp = await fetch("/upload-audio", { method: "POST", body: fd });
    const data = await resp.json();
    if (data.error) { showToast(data.error); return; }
    mainAudioFile = { filename: f.name, server_filename: data.filename, serve_url: data.serve_url };
    $("#advAudioName").textContent = f.name;
    $("#advAudioPreview").src = data.serve_url;
    $("#advAudioEmpty").classList.add("hidden");
    $("#advAudioTrack").classList.remove("hidden");
  } catch (err) { showToast("Audio upload failed: " + err.message); }
});
$("#advRemoveAudio").addEventListener("click", () => {
  mainAudioFile = null;
  $("#advAudioPreview").src = "";
  $("#advAudioTrack").classList.add("hidden");
  $("#advAudioEmpty").classList.remove("hidden");
  updateWaitingSongPlayer();
});

// ── Enhance Prompt ──────────────────────────────────────────────────────────
const enhanceBtn = $("#enhanceBtn");
enhanceBtn.addEventListener("click", async () => {
  const text = conceptInput.value.trim();
  if (!text) { conceptInput.focus(); return; }

  enhanceBtn.disabled = true;
  enhanceBtn.querySelector(".enhance-text").classList.add("hidden");
  enhanceBtn.querySelector(".enhance-loader").classList.remove("hidden");

  const fd = new FormData();
  fd.append("prompt", text);
  fd.append("duration_minutes", getDuration());
  selectedFiles.forEach((f) => fd.append("images", f));

  try {
    const resp = await fetch("/enhance-prompt", { method: "POST", body: fd });
    const data = await resp.json();
    if (data.error) {
      alert("Enhance failed: " + data.error);
    } else if (data.enhanced_prompt) {
      conceptInput.value = data.enhanced_prompt;
      conceptInput.style.height = "auto";
      conceptInput.style.height = Math.min(conceptInput.scrollHeight, 400) + "px";

      if (data.scene_count && data.shots_per_scene) {
        sceneCount.value = data.scene_count;
        sceneShotCounts = data.shots_per_scene.map((s) => Math.max(1, Math.min(10, s)));
        renderPerSceneShots();
      }
      updateStartBtn();

      // Keep song prompt in sync whenever movie prompt is AI-enhanced.
      // If song mode is enabled, the user sees the refreshed song prompt immediately.
      await autoEnhanceSongPrompt(false);
    }
  } catch (err) {
    alert("Enhance error: " + err.message);
  } finally {
    enhanceBtn.disabled = false;
    enhanceBtn.querySelector(".enhance-text").classList.remove("hidden");
    enhanceBtn.querySelector(".enhance-loader").classList.add("hidden");
  }
});

function addFiles(files) {
  for (const f of files) {
    if (selectedFiles.length >= MAX_REFS) break;
    if (!f.type.startsWith("image/")) continue;
    selectedFiles.push(f);
  }
  renderThumbs();
  updateStartBtn();
}

function removeFile(index) {
  selectedFiles.splice(index, 1);
  renderThumbs();
  updateStartBtn();
}

function renderThumbs() {
  refThumbs.innerHTML = "";
  selectedFiles.forEach((f, i) => {
    const thumb = document.createElement("div");
    thumb.className = "ref-thumb";
    const img = document.createElement("img");
    img.src = URL.createObjectURL(f);
    const removeBtn = document.createElement("button");
    removeBtn.className = "thumb-remove";
    removeBtn.textContent = "\u00d7";
    removeBtn.addEventListener("click", (e) => { e.stopPropagation(); removeFile(i); });
    const label = document.createElement("span");
    label.className = "thumb-label";
    label.textContent = `#${i + 1}`;
    thumb.append(img, removeBtn, label);
    refThumbs.appendChild(thumb);
  });
  const emptyIcon = $("#comboDropEmpty");
  if (emptyIcon) emptyIcon.style.display = selectedFiles.length > 0 ? "none" : "";
  uploadZone.style.cursor = selectedFiles.length >= MAX_REFS ? "default" : "pointer";
}

// ── State ────────────────────────────────────────────────────────────────────
let storyData = null;
let shotImages = {};   // "scene-shot" → { b64, file_path }
let videoTasks = {};   // "scene-shot" → { task_id, status, video_url, serve_url }
let lockedCreationUrls = [];

function clearCreationPreviewUrls() {
  lockedCreationUrls.forEach((u) => URL.revokeObjectURL(u));
  lockedCreationUrls = [];
}

function renderLockedCreationInput(promptText, files) {
  if (!creationReference || !creationPromptView || !creationImageRefs) return;
  clearCreationPreviewUrls();
  creationPromptView.value = promptText || "";
  creationImageRefs.innerHTML = "";

  (files || []).forEach((f, i) => {
    const item = document.createElement("div");
    item.className = "creation-ref-item";
    const img = document.createElement("img");
    const url = URL.createObjectURL(f);
    lockedCreationUrls.push(url);
    img.src = url;
    img.alt = `Reference ${i + 1}`;
    const label = document.createElement("span");
    label.className = "creation-ref-label";
    label.textContent = `#${i + 1}`;
    item.append(img, label);
    creationImageRefs.appendChild(item);
  });

  if (!files || files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "creation-ref-empty";
    empty.textContent = "No reference images uploaded.";
    creationImageRefs.appendChild(empty);
  }

  creationReference.classList.remove("hidden");
}

// ── Helpers for pipeline ─────────────────────────────────────────────────────
function addVideoCard(container, key, thumbSrc, label, extraClass) {
  const card = document.createElement("div");
  card.className = `video-clip-card${extraClass ? " " + extraClass : ""}`;
  card.id = `vclip-${key}`;
  card.innerHTML = `
    <div class="shot-image-wrap"><img src="${thumbSrc}" alt="${label}"></div>
    <div class="scene-progress-bar"><div class="scene-progress-fill" id="spf-${key}"></div></div>
    <div class="video-clip-info">
      <span class="video-clip-label">${label}</span>
      <span class="video-clip-status status-pending">Pending</span>
    </div>
  `;
  container.appendChild(card);
}

async function pollVideoTask(taskId, key, label, basePct, pctRange, onProgress) {
  let pollRounds = 0;
  const maxPollRounds = 240;
  while (pollRounds < maxPollRounds) {
    await sleep(10000);
    pollRounds++;
    const elapsed = pollRounds * 10;
    const pct = Math.min(10 + (pollRounds / 40) * 85, 95);
    setSceneProgress(key, pct);
    if (onProgress) onProgress(pct / 100);
    setProgress(basePct + (Math.min(pollRounds, 40) / 40) * pctRange * 0.9,
      `${label}: Rendering… (${elapsed}s)`);
    try {
      const pr = await fetch(`/poll-video/${taskId}`);
      const pd = await pr.json();
      if (pd.status === "succeed") {
        videoTasks[key].status = "succeed";
        videoTasks[key].video_url = pd.video_url;
        videoTasks[key].serve_url = pd.serve_url;
        setClipStatus(key, "succeed", "Done");
        return true;
      }
      if (pd.status === "failed") {
        videoTasks[key].status = "failed";
        setClipStatus(key, "failed", pd.error || "Failed");
        return false;
      }
      setClipStatus(key, "processing", `Rendering… ${elapsed}s`);
    } catch { /* keep polling */ }
  }
  videoTasks[key].status = "failed";
  setClipStatus(key, "failed", "Timeout");
  return false;
}

// ── STEP 1 → 3: Full Pipeline (shot-by-shot: image → video → extract → next) ─
startBtn.addEventListener("click", async () => {
  if (!selectedFiles.length || !conceptInput.value.trim()) return;
  const lockedPrompt = conceptInput.value.trim();
  const lockedFiles = [...selectedFiles];
  renderLockedCreationInput(lockedPrompt, lockedFiles);

  startBtn.disabled = true;
  startBtn.querySelector(".btn-text").classList.add("hidden");
  startBtn.querySelector(".btn-loader").classList.remove("hidden");
  shotImages = {};
  videoTasks = {};

  setProgress(3, "Developing story…");
  markStep(1, "active");

  const numScenes = getNumScenes();
  const shotsList = sceneShotCounts.slice(0, numScenes);

  const fd = new FormData();
  fd.append("concept", lockedPrompt);
  fd.append("scenes", numScenes);
  fd.append("duration_minutes", getDuration());
  fd.append("shots_per_scene_list", JSON.stringify(shotsList));
  lockedFiles.forEach((f) => fd.append("images", f));

  try {
    const songReady = await maybeGenerateSongBeforeMovie();
    if (!songReady) {
      resetStartBtn();
      return;
    }

    const res = await fetch("/develop-story", { method: "POST", body: fd });
    const story = await res.json();
    if (story.error) { showToast(story.error); resetStartBtn(); return; }

    storyData = story;
    markStep(1, "done");
    markStep(2, "active");
    showStep(2);

    $("#storyTitle").textContent = story.title || "Storyboard";
    $("#scenesContainer").innerHTML = "";

    const allShots = [];
    story.scenes.forEach((sc) => sc.shots.forEach((sh) =>
      allShots.push({ sceneNum: sc.scene_number, sceneTitle: sc.scene_title, ...sh })
    ));
    const totalSteps = allShots.length;
    let prevTaskId = null;
    let lastFrameBlob = null;
    let currentSceneNum = null;
    let characterLockBlob = null; // first generated image used as character ref when no uploads
    let abortPipeline = false;

    const videoContainer = $("#videoClipsContainer");
    videoContainer.innerHTML = "";

    // Convert user reference files to blobs for reuse
    const refBlobs = [...lockedFiles];

    for (let i = 0; i < totalSteps; i++) {
      if (abortPipeline) break;
      const shot = allShots[i];
      const key = `${shot.sceneNum}-${shot.shot_number}`;
      const pct = (i / totalSteps) * 100;

      const isNewScene = shot.sceneNum !== currentSceneNum;
      const isFirstShot = i === 0;
      let envFrameBlob = null; // last frame kept as environment/style reference between scenes

      // ── Show scene card when entering a new scene ──
      if (isNewScene) {
        currentSceneNum = shot.sceneNum;
        const sc = story.scenes.find((s) => s.scene_number === currentSceneNum);
        if (sc) renderSingleScene(sc);

        if (!isFirstShot && lastFrameBlob) {
          envFrameBlob = lastFrameBlob; // save as environment reference
          lastFrameBlob = null; // break direct continuity
        }
      }

      // ── 1. Decide image source based on context ──

      if (!isNewScene && lastFrameBlob) {
        // WITHIN SCENE: use last frame directly for smooth continuity
        setProgress(pct, `Shot ${i + 1}/${totalSteps}: Using last frame…`);
        const lastFrameUrl = URL.createObjectURL(lastFrameBlob);
        setShotImage(shot.sceneNum, shot.shot_number, lastFrameUrl, null);
        shotImages[key].blob = lastFrameBlob;
      } else {
        // NEW SCENE or FIRST SHOT: generate fresh image
        setProgress(pct, `Shot ${i + 1}/${totalSteps}: Generating image…`);

        const sfd = new FormData();
        const neededRefs = shot.ref_images || [];
        const charLabels = [];
        if (neededRefs.length > 0 && refBlobs.length > 0) {
          neededRefs.forEach((refNum, idx) => {
            const refIdx = refNum - 1;
            if (refIdx >= 0 && refIdx < refBlobs.length) {
              sfd.append("images", refBlobs[refIdx]);
              const charInfo = (story.character_map || []).find((c) => c.ref_number === refNum);
              if (charInfo) {
                charLabels.push(`Image #${idx + 1} = Reference #${refNum}: ${charInfo.name} (${charInfo.type}) — ${charInfo.appearance}. Outfit: ${charInfo.outfit}`);
              }
            }
          });
        } else if (refBlobs.length === 0 && characterLockBlob) {
          sfd.append("images", characterLockBlob, "character_lock.jpg");
        }
        if (charLabels.length > 0) sfd.append("character_labels", charLabels.join("\n"));
        // Between scenes: pass last frame as environment/style reference
        if (envFrameBlob) {
          sfd.append("images", envFrameBlob, "prev_scene_env.jpg");
          sfd.append("scene_transition", "true");
        }
        sfd.append("prompt", shot.prompt);

        try {
          const sr = await fetch("/generate-shot", { method: "POST", body: sfd });
          const sd = await sr.json();
          if (sd.image) {
            setShotImage(shot.sceneNum, shot.shot_number, sd.image, sd.file_path);
            // Lock character from first generated image if no user refs
            if (!characterLockBlob && refBlobs.length === 0 && sd.file_path) {
              try {
                const lockResp = await fetch(shotImages[key].b64);
                characterLockBlob = await lockResp.blob();
              } catch { /* ok */ }
            }
          } else {
            setShotError(shot.sceneNum, shot.shot_number, shot.prompt);
            continue;
          }
        } catch {
          setShotError(shot.sceneNum, shot.shot_number, shot.prompt);
          continue;
        }
      }

      if (!shotImages[key]) continue;

      // ── 2. Generate video ──
      markStep(3, "active");
      const shotDuration = Math.max(3, Math.min(15, parseInt(shot.duration) || 5));

      addVideoCard(videoContainer, key, shotImages[key].b64,
        `Shot ${shot.sceneNum}.${shot.shot_number} (${shotDuration}s): ${shot.action || ""}`);

      setShotProgress(shot.sceneNum, shot.shot_number, 30);
      setProgress(pct + 30 / totalSteps, `Shot ${i + 1}/${totalSteps}: Submitting video…`);
      setClipStatus(key, "processing", "Submitting…");
      setSceneProgress(key, 5);

      const imgData = getImageB64(key);
      const videoPrompt = shot.video_prompt || shot.motion_prompt || "cinematic camera movement";

      // Convert current frame blob to b64 if exists
      let currentFrameB64 = null;
      if (shotImages[key].blob) {
        const buf = await shotImages[key].blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let b = 0; b < bytes.length; b++) bin += String.fromCharCode(bytes[b]);
        currentFrameB64 = btoa(bin);
      }

      // Convert only the needed ref images to b64 for video generation
      let refImagesB64 = [];
      const neededVideoRefs = shot.ref_images || [];
      const refsToSend = neededVideoRefs.length > 0
        ? neededVideoRefs.map((n) => refBlobs[n - 1]).filter(Boolean)
        : [];
      for (const rf of refsToSend) {
        const buf = await rf.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let b = 0; b < bytes.length; b++) bin += String.fromCharCode(bytes[b]);
        refImagesB64.push(btoa(bin));
      }

      try {
        const payload = { motion_prompt: videoPrompt, duration: shotDuration };
        if (currentFrameB64) {
          payload.last_frame_b64 = currentFrameB64;
          payload.storyboard_b64 = imgData.image_b64 || "";
          payload.storyboard_path = imgData.image_path || "";
        } else {
          payload.storyboard_path = imgData.image_path;
          payload.storyboard_b64 = imgData.image_b64;
        }
        if (refImagesB64.length > 0) {
          payload.ref_images_b64 = refImagesB64;
        }

        const vResp = await fetch("/generate-shot-video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const vData = await vResp.json();

        if (!vData.task_id) {
          videoTasks[key] = { status: "failed" };
          setClipStatus(key, "failed", vData.error || "Failed");
          setShotProgress(shot.sceneNum, shot.shot_number, 0);
          prevTaskId = null;
          lastFrameBlob = null;
          abortPipeline = true;
          showToast("Video generation failed. Stopped pipeline to avoid extra costs.", 7000);
          break;
        }

        videoTasks[key] = { task_id: vData.task_id, status: "processing", duration: shotDuration };
        setClipStatus(key, "processing", "Rendering…");
        setSceneProgress(key, 10);
        setShotProgress(shot.sceneNum, shot.shot_number, 35);

        const ok = await pollVideoTask(vData.task_id, key,
          `Shot ${i + 1}/${totalSteps}`, pct + 30 / totalSteps, 60 / totalSteps,
          (pollPct) => setShotProgress(shot.sceneNum, shot.shot_number, 35 + pollPct * 0.6));

        if (ok) {
          setShotProgress(shot.sceneNum, shot.shot_number, 100);
          prevTaskId = vData.task_id;
          setShotVideo(shot.sceneNum, shot.shot_number, videoTasks[key].serve_url);
          $("#downloadVideosBtn").classList.remove("hidden");

          // ── 3. Extract last frame for next shot ──
          setProgress(pct + 95 / totalSteps, `Shot ${i + 1}/${totalSteps}: Extracting last frame…`);
          lastFrameBlob = null;
          try {
            const frameResp = await fetch(`/extract-last-frame/${vData.task_id}`);
            const frameData = await frameResp.json();
            if (frameData.frame_b64) {
              const byteStr = atob(frameData.frame_b64);
              const bytes = new Uint8Array(byteStr.length);
              for (let b = 0; b < byteStr.length; b++) bytes[b] = byteStr.charCodeAt(b);
              lastFrameBlob = new Blob([bytes], { type: "image/jpeg" });
            }
          } catch { /* next shot won't have continuity */ }
        } else {
          prevTaskId = null;
          lastFrameBlob = null;
          abortPipeline = true;
          showToast("Video render failed. Stopped pipeline to avoid extra costs.", 7000);
          break;
        }

      } catch (err) {
        videoTasks[key] = { status: "failed" };
        setClipStatus(key, "failed", "Error");
        prevTaskId = null;
        lastFrameBlob = null;
        abortPipeline = true;
        showToast("Video request error. Stopped pipeline to avoid extra costs.", 7000);
        break;
      }
    }

    markStep(2, "done");
    markStep(3, "done");
    $("#step2").classList.remove("hidden");
    $("#step3").classList.remove("hidden");
    syncAdvToMain();
    const doneCount = Object.values(videoTasks).filter((v) => v.status === "succeed").length;
    setProgress(100, `${doneCount} of ${totalSteps} shot videos ready!`);
    $("#assembleBtn").disabled = doneCount < 1;
    if (enableSongGen && enableSongGen.checked && doneCount > 0 && mainAudioFile) {
      forceMusicVolume100();
      setTimeout(() => {
        if (!$("#assembleBtn").disabled) $("#assembleBtn").click();
      }, 400);
    }
    setTimeout(() => $("#progressSection").classList.add("hidden"), 2000);

  } catch (err) {
    showToast("Error: " + err.message);
  } finally {
    resetStartBtn();
  }
});

function resetStartBtn() {
  startBtn.disabled = false;
  startBtn.querySelector(".btn-text").classList.remove("hidden");
  startBtn.querySelector(".btn-loader").classList.add("hidden");
  updateStartBtn();
}

function renderSingleScene(scene) {
  const container = $("#scenesContainer");
  const card = document.createElement("div");
  card.className = "scene-card";
  card.id = `scene-card-${scene.scene_number}`;
  card.innerHTML = `
    <div class="scene-header">
      <span class="scene-number">SCENE ${scene.scene_number}</span>
      <span class="scene-title">${scene.scene_title || ""}</span>
    </div>
    <p class="scene-desc">${scene.description || ""}</p>
    <div class="shots-grid">
      ${scene.shots.map((sh) => `
        <div class="shot-card" id="shot-${scene.scene_number}-${sh.shot_number}">
          <div class="shot-image-wrap">
            <span class="shot-number">${scene.scene_number}.${sh.shot_number}${sh.duration ? " · " + sh.duration + "s" : ""}</span>
            <button class="shot-expand-btn" title="Expand" onclick="expandShot(this)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            </button>
            <div class="shot-placeholder"><div class="spinner"></div><span>Waiting…</span></div>
          </div>
          <div class="shot-progress-bar"><div class="shot-progress-fill" id="shotpf-${scene.scene_number}-${sh.shot_number}"></div></div>
          <div class="shot-info"><p class="shot-action">${sh.action || ""}</p></div>
        </div>
      `).join("")}
    </div>
  `;
  container.appendChild(card);
}

function setShotImage(sceneNum, shotNum, imageSrc, filePath) {
  const key = `${sceneNum}-${shotNum}`;
  shotImages[key] = { b64: imageSrc, file_path: filePath };

  const card = $(`#shot-${key}`);
  if (!card) return;
  const wrap = card.querySelector(".shot-image-wrap");
  const ph = wrap.querySelector(".shot-placeholder");
  if (ph) ph.remove();
  const img = document.createElement("img");
  img.src = imageSrc;
  wrap.appendChild(img);
}

function setShotVideo(sceneNum, shotNum, serveUrl) {
  const key = `${sceneNum}-${shotNum}`;
  const card = $(`#shot-${key}`);
  if (!card) return;
  const wrap = card.querySelector(".shot-image-wrap");
  const existingPlay = wrap.querySelector(".shot-play-overlay");
  if (existingPlay) existingPlay.remove();

  const overlay = document.createElement("button");
  overlay.className = "shot-play-overlay";
  overlay.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
  overlay.addEventListener("click", (e) => {
    e.stopPropagation();
    const existingVideo = wrap.querySelector("video");
    if (existingVideo) {
      existingVideo.remove();
      overlay.classList.remove("playing");
      const img = wrap.querySelector("img");
      if (img) img.style.display = "";
      return;
    }
    const img = wrap.querySelector("img");
    if (img) img.style.display = "none";
    overlay.classList.add("playing");
    const video = document.createElement("video");
    video.src = serveUrl;
    video.controls = true;
    video.autoplay = true;
    video.style.cssText = "width:100%;height:100%;object-fit:cover;position:absolute;inset:0;z-index:1";
    video.addEventListener("ended", () => {
      video.remove();
      overlay.classList.remove("playing");
      if (img) img.style.display = "";
    });
    wrap.appendChild(video);
  });
  wrap.appendChild(overlay);
}

// ── Expand/Lightbox ─────────────────────────────────────────────────────────
function expandShot(btn) {
  const wrap = btn.closest(".shot-image-wrap");
  const media = wrap.querySelector("video") || wrap.querySelector("img");
  if (!media) return;
  const overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  const clone = media.cloneNode(true);
  clone.style.cssText = "max-width:90vw;max-height:85vh;border-radius:12px;object-fit:contain";
  if (clone.tagName === "VIDEO") { clone.controls = true; clone.autoplay = true; clone.muted = false; clone.style.display = "block"; clone.style.position = "static"; clone.style.zIndex = "auto"; }
  overlay.appendChild(clone);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) { if (clone.tagName === "VIDEO") clone.pause(); overlay.remove(); } });
  document.body.appendChild(overlay);
}

function setShotProgress(sceneNum, shotNum, pct) {
  const fill = $(`#shotpf-${sceneNum}-${shotNum}`);
  if (fill) fill.style.width = pct + "%";
}

function setShotError(sceneNum, shotNum, prompt) {
  const card = $(`#shot-${sceneNum}-${shotNum}`);
  if (!card) return;
  const wrap = card.querySelector(".shot-image-wrap");
  const ph = wrap.querySelector(".shot-placeholder");
  if (ph) ph.remove();
  const existing = wrap.querySelector(".shot-error-wrap");
  if (existing) existing.remove();
  const errWrap = document.createElement("div");
  errWrap.className = "shot-error-wrap";
  errWrap.innerHTML = `<span class="shot-error">Failed</span>`;
  const retryBtn = document.createElement("button");
  retryBtn.className = "shot-retry";
  retryBtn.textContent = "Retry";
  retryBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    errWrap.remove();
    const spinner = document.createElement("div");
    spinner.className = "shot-placeholder";
    spinner.innerHTML = '<div class="spinner"></div><span>Retrying…</span>';
    wrap.appendChild(spinner);

    const sfd = new FormData();
    selectedFiles.forEach((f) => sfd.append("images", f));
    sfd.append("prompt", prompt);

    try {
      const sr = await fetch("/generate-shot", { method: "POST", body: sfd });
      const sd = await sr.json();
      spinner.remove();
      if (sd.image) {
        setShotImage(sceneNum, shotNum, sd.image, sd.file_path);
      } else {
        setShotError(sceneNum, shotNum, prompt);
      }
    } catch {
      spinner.remove();
      setShotError(sceneNum, shotNum, prompt);
    }
  });
  errWrap.appendChild(retryBtn);
  wrap.appendChild(errWrap);
}

// Download images
$("#downloadImagesBtn").addEventListener("click", () => {
  Object.entries(shotImages).forEach(([key, data], i) => {
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = data.b64;
      a.download = `storyboard-${key}.png`;
      a.click();
    }, i * 200);
  });
});

$("#downloadVideosBtn").addEventListener("click", () => {
  const ready = Object.entries(videoTasks)
    .filter(([, t]) => t.status === "succeed" && t.serve_url)
    .sort(([a], [b]) => a.localeCompare(b));
  ready.forEach(([key, task], i) => {
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = task.serve_url;
      a.download = `shot-${key}.mp4`;
      a.click();
    }, i * 300);
  });
});

// ── STEP 2 → 3: Generate Scene Videos (multi-shot per scene) ────────────────
function getImageB64(key) {
  const data = shotImages[key];
  if (!data) return { image_path: "", image_b64: "" };
  if (data.file_path) return { image_path: data.file_path, image_b64: "" };
  const raw = data.b64.includes(",") ? data.b64.split(",")[1] : data.b64;
  return { image_path: "", image_b64: raw };
}

// Old standalone video generation removed — now integrated into the main pipeline above.

function setSceneProgress(key, pct) {
  const fill = $(`#spf-${key}`);
  if (fill) fill.style.width = pct + "%";
}

function setClipStatus(key, state, text) {
  const card = $(`#vclip-${key}`);
  if (!card) return;
  const badge = card.querySelector(".video-clip-status");
  badge.className = `video-clip-status status-${state === "succeed" ? "done" : state}`;
  badge.textContent = text;

  const oldRetry = card.querySelector(".scene-retry-btn");
  if (oldRetry) oldRetry.remove();

  if (state === "succeed") {
    setSceneProgress(key, 100);
    if (videoTasks[key]?.serve_url) {
      const wrap = card.querySelector(".shot-image-wrap");
      wrap.innerHTML = `<video src="${videoTasks[key].serve_url}" controls muted playsinline></video>`;
    }
  } else if (state === "failed") {
    setSceneProgress(key, 0);
    const info = card.querySelector(".video-clip-info");
    const retryBtn = document.createElement("button");
    retryBtn.className = "scene-retry-btn";
    retryBtn.textContent = "Retry";
    retryBtn.addEventListener("click", () => retryScene(key));
    info.appendChild(retryBtn);
  }
}

async function retryScene(key) {
  const sceneNum = parseInt(key.replace("scene-", ""));
  const sc = storyData.scenes.find((s) => s.scene_number === sceneNum);
  if (!sc) return;

  setClipStatus(key, "processing", "Submitting…");
  setSceneProgress(key, 5);

  const shots = sc.shots.slice(0, 6).map((sh) => {
    const imgData = getImageB64(`${sc.scene_number}-${sh.shot_number}`);
    return { ...imgData, motion_prompt: sh.video_prompt || sh.motion_prompt || "cinematic camera movement" };
  });

  try {
    const resp = await fetch("/generate-scene-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shots }),
    });
    const data = await resp.json();

    if (!data.task_id) {
      videoTasks[key] = { status: "failed" };
      setClipStatus(key, "failed", data.error || "Failed");
      return;
    }

    const sceneDuration = data.duration || (shots.length * 3);
    videoTasks[key] = { task_id: data.task_id, status: "processing", duration: sceneDuration };
    setClipStatus(key, "processing", "Rendering…");

    let pollRounds = 0;
    const maxPollRounds = 240;

    while (pollRounds < maxPollRounds) {
      await sleep(10000);
      pollRounds++;
      const elapsed = pollRounds * 10;
      setSceneProgress(key, Math.min(5 + (pollRounds / 40) * 90, 95));
      setClipStatus(key, "processing", `Rendering… ${elapsed}s`);

      try {
        const pr = await fetch(`/poll-video/${data.task_id}`);
        const pd = await pr.json();

        if (pd.status === "succeed") {
          videoTasks[key].status = "succeed";
          videoTasks[key].video_url = pd.video_url;
          videoTasks[key].serve_url = pd.serve_url;
          setClipStatus(key, "succeed", "Done");
          if (!$("#assembleBtn").disabled) return;
          const doneCount = Object.values(videoTasks).filter((v) => v.status === "succeed").length;
          if (doneCount > 0) $("#assembleBtn").disabled = false;
          return;
        }
        if (pd.status === "failed") {
          videoTasks[key].status = "failed";
          setClipStatus(key, "failed", pd.error || "Failed");
          return;
        }
      } catch { /* keep polling */ }
    }

    videoTasks[key].status = "failed";
    setClipStatus(key, "failed", "Timeout");
  } catch (err) {
    videoTasks[key] = { status: "failed" };
    setClipStatus(key, "failed", "Error");
  }
}

// ── Film Settings Controls ───────────────────────────────────────────────────
let mainAspectRatio = "16:9";
let mainFitMode = "pad";
let mainAudioFile = null;
let mainMusicVol = 80;
let mainVideoVol = 100;

document.querySelectorAll("#mainRatioBtns .ratio-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#mainRatioBtns .ratio-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    mainAspectRatio = btn.dataset.ratio;
  });
});
$("#mainFitMode").addEventListener("change", (e) => { mainFitMode = e.target.value; });
$("#mainMusicVol").addEventListener("input", (e) => {
  mainMusicVol = parseInt(e.target.value);
  $("#mainMusicVolVal").textContent = mainMusicVol + "%";
});
$("#mainVideoVol").addEventListener("input", (e) => {
  mainVideoVol = parseInt(e.target.value);
  $("#mainVideoVolVal").textContent = mainVideoVol + "%";
});

const mainAudioInput = $("#mainAudioInput");
$("#mainAddAudioBtn").addEventListener("click", () => mainAudioInput.click());
mainAudioInput.addEventListener("change", async () => {
  const f = mainAudioInput.files[0];
  if (!f) return;
  mainAudioInput.value = "";
  const fd = new FormData();
  fd.append("audio", f);
  try {
    const resp = await fetch("/upload-audio", { method: "POST", body: fd });
    const data = await resp.json();
    if (data.error) { showToast(data.error); return; }
    mainAudioFile = { filename: f.name, server_filename: data.filename, serve_url: data.serve_url };
    $("#mainAudioName").textContent = f.name;
    $("#mainAudioPreview").src = data.serve_url;
    $("#mainAudioEmpty").classList.add("hidden");
    $("#mainAudioTrack").classList.remove("hidden");
  } catch (err) { showToast("Audio upload failed: " + err.message); }
});
$("#mainRemoveAudio").addEventListener("click", () => {
  mainAudioFile = null;
  $("#mainAudioPreview").src = "";
  $("#mainAudioTrack").classList.add("hidden");
  $("#mainAudioEmpty").classList.remove("hidden");
  updateWaitingSongPlayer();
});

// ── STEP 3 → 4: Assemble Final Film ────────────────────────────────────────
$("#assembleBtn").addEventListener("click", async () => {
  $("#assembleBtn").disabled = true;
  markStep(3, "done");
  markStep(4, "active");
  $("#step4").classList.remove("hidden");

  const localFiles = [];
  const sortedKeys = Object.keys(videoTasks).sort();
  for (const key of sortedKeys) {
    const task = videoTasks[key];
    if (task.status === "succeed" && task.serve_url) {
      localFiles.push(task.serve_url.replace("/videos/", ""));
    }
  }

  if (localFiles.length === 0) {
    showToast("No videos available for assembly.");
    $("#assembleBtn").disabled = false;
    return;
  }

  setProgress(10, "Assembling final film…");
  $("#progressSection").classList.remove("hidden");

  const payload = {
    filenames: localFiles,
    aspect_ratio: mainAspectRatio,
    fit_mode: mainFitMode,
    watermark: $("#mainWatermark").checked,
  };
  if (mainAudioFile) {
    payload.audio_filename = mainAudioFile.server_filename;
    payload.music_volume = mainMusicVol / 100;
    payload.video_volume = mainVideoVol / 100;
  }

  try {
    setProgress(40, "Processing with FFmpeg…");
    const resp = await fetch("/assemble-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();

    if (data.status === "done") {
      $("#finalPlaceholder").classList.add("hidden");
      const video = document.createElement("video");
      video.src = data.serve_url;
      video.controls = true;
      video.autoplay = true;
      $("#finalVideoWrap").appendChild(video);

      $("#finalDownloadLink").href = data.serve_url;
      $("#finalActions").classList.remove("hidden");
      markStep(4, "done");
      setProgress(100, "Film complete!");
    } else {
      showToast(data.error || "Assembly failed.");
    }
  } catch (err) {
    showToast("Assembly error: " + err.message);
  } finally {
    setTimeout(() => $("#progressSection").classList.add("hidden"), 2000);
    $("#assembleBtn").disabled = false;
  }
});

async function pollRender(renderId) {
  let rounds = 0;
  const maxRounds = 120;

  while (rounds < maxRounds) {
    await sleep(5000);
    rounds++;
    setProgress(30 + Math.min(rounds, 60), `Rendering… (${rounds * 5}s)`);

    try {
      const resp = await fetch(`/poll-render/${renderId}`);
      const data = await resp.json();

      if (data.status === "done") return data.url;
      if (data.status === "failed") { showToast(data.error || "Render failed"); return null; }
    } catch { /* keep polling */ }
  }
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
