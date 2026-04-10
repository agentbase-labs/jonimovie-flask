const $ = (sel) => document.querySelector(sel);
const toast = $("#asmToast");

function showToast(msg, dur = 4000) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.classList.add("hidden"), 300);
  }, dur);
}

// ── State ───────────────────────────────────────────────────────────────────
let clips = []; // { id, url, serve_url, filename, duration }
let dragIdx = null;
let audioFile = null; // { filename, serve_url }
let musicVolume = 80;
let videoVolume = 100;
let aspectRatio = "16:9";
let fitMode = "pad";

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function updateCount() {
  const n = clips.length;
  $("#clipCount").textContent = `${n} clip${n !== 1 ? "s" : ""}`;
  $("#assembleBtn").disabled = n < 2;
  $("#timelineEmpty").classList.toggle("hidden", n > 0);
}

// ── Add clip ────────────────────────────────────────────────────────────────
function addClip(data) {
  clips.push({ id: uid(), ...data, duration: data.duration || 5 });
  renderTimeline();
}

function removeClip(id) {
  clips = clips.filter((c) => c.id !== id);
  renderTimeline();
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderTimeline() {
  const container = $("#timelineClips");
  container.innerHTML = "";
  clips.forEach((clip, i) => {
    const card = document.createElement("div");
    card.className = "tl-clip";
    card.draggable = true;
    card.dataset.idx = i;
    card.innerHTML = `
      <div class="tl-clip-handle" title="Drag to reorder">⠿</div>
      <div class="tl-clip-preview">
        <video src="${clip.serve_url || clip.url}" muted playsinline preload="metadata"></video>
      </div>
      <div class="tl-clip-details">
        <span class="tl-clip-name">${clip.filename || "Video"}</span>
        <div class="tl-clip-dur">
          <label>Duration (s)</label>
          <input type="number" value="${clip.duration}" min="1" max="60" class="dur-input" data-id="${clip.id}">
        </div>
      </div>
      <button class="tl-clip-remove" data-id="${clip.id}" title="Remove">&times;</button>
    `;

    const video = card.querySelector("video");
    video.addEventListener("mouseenter", () => video.play());
    video.addEventListener("mouseleave", () => { video.pause(); video.currentTime = 0; });

    card.querySelector(".tl-clip-remove").addEventListener("click", () => removeClip(clip.id));
    card.querySelector(".dur-input").addEventListener("change", (e) => {
      const c = clips.find((x) => x.id === clip.id);
      if (c) c.duration = Math.max(1, parseInt(e.target.value) || 5);
    });

    card.addEventListener("dragstart", (e) => {
      dragIdx = i;
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => { card.classList.remove("dragging"); dragIdx = null; });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drag-over");
      if (dragIdx === null || dragIdx === i) return;
      const moved = clips.splice(dragIdx, 1)[0];
      clips.splice(i, 0, moved);
      dragIdx = null;
      renderTimeline();
    });

    container.appendChild(card);
  });
  updateCount();
}

// ── Drop zone (files) ───────────────────────────────────────────────────────
const timelineArea = $("#timelineArea");
timelineArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer.types.includes("Files")) timelineArea.classList.add("dragover");
});
timelineArea.addEventListener("dragleave", (e) => {
  if (!timelineArea.contains(e.relatedTarget)) timelineArea.classList.remove("dragover");
});
timelineArea.addEventListener("drop", async (e) => {
  e.preventDefault();
  timelineArea.classList.remove("dragover");
  const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("video/"));
  if (files.length) await uploadFiles(files);
});
timelineArea.addEventListener("click", (e) => {
  if (clips.length === 0 && !e.target.closest("video, button, input")) fileInput.click();
});

// ── Upload files ────────────────────────────────────────────────────────────
const fileInput = $("#fileUploadInput");
$("#addFileBtn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  await uploadFiles(Array.from(fileInput.files));
  fileInput.value = "";
});

async function uploadFiles(files) {
  for (const f of files) {
    const fd = new FormData();
    fd.append("video", f);
    try {
      const resp = await fetch("/upload-video", { method: "POST", body: fd });
      const data = await resp.json();
      if (data.error) { showToast(data.error); continue; }
      addClip({ url: "", serve_url: data.serve_url, filename: f.name, duration: 5 });
    } catch (err) {
      showToast("Upload failed: " + err.message);
    }
  }
}

// ── Add by URL ──────────────────────────────────────────────────────────────
const urlModal = $("#urlModal");
$("#addUrlBtn").addEventListener("click", () => { $("#urlInput").value = ""; urlModal.classList.remove("hidden"); $("#urlInput").focus(); });
$("#urlCancel").addEventListener("click", () => urlModal.classList.add("hidden"));
$("#urlAdd").addEventListener("click", () => {
  const url = $("#urlInput").value.trim();
  if (!url) return;
  urlModal.classList.add("hidden");
  const name = url.split("/").pop().split("?")[0] || "video.mp4";
  addClip({ url, serve_url: url, filename: name, duration: 5 });
});
$("#urlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#urlAdd").click(); });

// ── Library ─────────────────────────────────────────────────────────────────
const libraryModal = $("#libraryModal");
$("#loadLibraryBtn").addEventListener("click", async () => {
  libraryModal.classList.remove("hidden");
  const grid = $("#libraryGrid");
  grid.innerHTML = '<p class="text-muted">Loading…</p>';
  try {
    const resp = await fetch("/list-videos");
    const vids = await resp.json();
    if (!vids.length) { grid.innerHTML = '<p class="text-muted">No videos yet. Generate some in the Movie Studio first.</p>'; return; }
    grid.innerHTML = "";
    vids.forEach((v) => {
      const card = document.createElement("div");
      card.className = "lib-card";
      card.innerHTML = `
        <video src="${v.serve_url}" muted playsinline preload="metadata"></video>
        <div class="lib-info">
          <span>${v.filename}</span>
          <span class="text-muted">${v.size_mb} MB</span>
        </div>
      `;
      const video = card.querySelector("video");
      video.addEventListener("mouseenter", () => video.play());
      video.addEventListener("mouseleave", () => { video.pause(); video.currentTime = 0; });
      card.addEventListener("click", () => {
        addClip({ url: v.public_url || "", serve_url: v.serve_url, filename: v.filename, duration: 5 });
        showToast(`Added ${v.filename}`);
      });
      grid.appendChild(card);
    });
  } catch (err) {
    grid.innerHTML = `<p class="text-muted">Error: ${err.message}</p>`;
  }
});
$("#libraryClose").addEventListener("click", () => libraryModal.classList.add("hidden"));

// ── Output Settings ─────────────────────────────────────────────────────────
document.querySelectorAll(".ratio-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".ratio-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    aspectRatio = btn.dataset.ratio;
  });
});
$("#fitMode").addEventListener("change", (e) => { fitMode = e.target.value; });

// ── Audio Track ─────────────────────────────────────────────────────────────
const audioFileInput = $("#audioFileInput");
$("#addAudioBtn").addEventListener("click", () => audioFileInput.click());
audioFileInput.addEventListener("change", async () => {
  const f = audioFileInput.files[0];
  if (!f) return;
  audioFileInput.value = "";

  const fd = new FormData();
  fd.append("audio", f);
  try {
    const resp = await fetch("/upload-audio", { method: "POST", body: fd });
    const data = await resp.json();
    if (data.error) { showToast(data.error); return; }
    audioFile = { filename: f.name, serve_url: data.serve_url, server_filename: data.filename };
    $("#audioName").textContent = f.name;
    $("#audioPreview").src = data.serve_url;
    $("#audioEmpty").classList.add("hidden");
    $("#audioTrack").classList.remove("hidden");
    showToast(`Added ${f.name}`);
  } catch (err) {
    showToast("Audio upload failed: " + err.message);
  }
});

$("#removeAudioBtn").addEventListener("click", () => {
  audioFile = null;
  $("#audioPreview").src = "";
  $("#audioTrack").classList.add("hidden");
  $("#audioEmpty").classList.remove("hidden");
});

$("#musicVolume").addEventListener("input", (e) => {
  musicVolume = parseInt(e.target.value);
  $("#musicVolVal").textContent = musicVolume + "%";
});
$("#videoVolume").addEventListener("input", (e) => {
  videoVolume = parseInt(e.target.value);
  $("#videoVolVal").textContent = videoVolume + "%";
});

// ── Assemble ────────────────────────────────────────────────────────────────
function showResult(videoUrl) {
  const result = $("#asmResult");
  result.classList.remove("hidden");
  $("#asmVideoWrap").innerHTML = `<video src="${videoUrl}" controls autoplay></video>`;
  $("#asmDownloadLink").href = videoUrl;
}

$("#assembleBtn").addEventListener("click", async () => {
  if (clips.length < 2) return;

  $("#assembleBtn").disabled = true;
  const prog = $("#asmProgress");
  prog.classList.remove("hidden");
  $("#asmProgressFill").style.width = "10%";

  const allLocal = clips.every((c) => {
    const url = c.url || c.serve_url;
    return url.startsWith("/videos/");
  });

  const allHavePublic = clips.every((c) => c.url && !c.url.startsWith("/videos/"));

  if (allLocal || !allHavePublic) {
    // Try local ffmpeg assembly first
    const localFiles = clips.map((c) => {
      const url = c.serve_url || c.url;
      return url.replace("/videos/", "");
    });
    const allExist = localFiles.every((f) => f && !f.startsWith("http"));

    if (allExist) {
      $("#asmProgressText").textContent = "Assembling locally with FFmpeg…";
      $("#asmProgressFill").style.width = "50%";

      try {
        const payload = {
          filenames: localFiles,
          aspect_ratio: aspectRatio,
          fit_mode: fitMode,
        };
        if (audioFile) {
          payload.audio_filename = audioFile.server_filename;
          payload.music_volume = musicVolume / 100;
          payload.video_volume = videoVolume / 100;
        }
        const resp = await fetch("/assemble-local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await resp.json();

        if (data.status === "done") {
          $("#asmProgressFill").style.width = "100%";
          $("#asmProgressText").textContent = "Done!";
          showResult(data.serve_url);
          setTimeout(() => prog.classList.add("hidden"), 2000);
          $("#assembleBtn").disabled = false;
          return;
        } else {
          showToast(data.error || "Local assembly failed, trying Shotstack…", 3000);
        }
      } catch (err) {
        showToast("Local assembly error: " + err.message, 3000);
      }
    }

    // Fallback: try resolving public URLs for Shotstack
    try {
      const resp = await fetch("/list-videos");
      const vids = await resp.json();
      const urlMap = {};
      vids.forEach((v) => { if (v.public_url) urlMap[v.serve_url] = v.public_url; });
      clips.forEach((c) => {
        const url = c.url || c.serve_url;
        if (url.startsWith("/videos/") && urlMap[url]) c.url = urlMap[url];
      });
    } catch { /* continue with what we have */ }
  }

  const assembleClips = clips.map((c) => ({
    url: c.url || c.serve_url,
    duration: c.duration,
  }));

  const stillLocal = assembleClips.some((c) => c.url.startsWith("/videos/"));
  if (stillLocal) {
    showToast("Some clips couldn't be resolved. Try local assembly or use Kling videos.", 5000);
    $("#assembleBtn").disabled = false;
    prog.classList.add("hidden");
    return;
  }

  $("#asmProgressText").textContent = "Submitting to Shotstack…";

  try {
    const resp = await fetch("/assemble-video", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clips: assembleClips }),
    });
    const data = await resp.json();
    if (!data.render_id) {
      showToast(data.error || "Assembly failed");
      $("#assembleBtn").disabled = false;
      prog.classList.add("hidden");
      return;
    }

    $("#asmProgressFill").style.width = "30%";
    $("#asmProgressText").textContent = "Rendering…";

    let rounds = 0;
    while (rounds < 120) {
      await new Promise((r) => setTimeout(r, 5000));
      rounds++;
      $("#asmProgressFill").style.width = Math.min(30 + rounds, 90) + "%";
      $("#asmProgressText").textContent = `Rendering… (${rounds * 5}s)`;

      try {
        const pr = await fetch(`/poll-render/${data.render_id}`);
        const pd = await pr.json();
        if (pd.status === "done") {
          $("#asmProgressFill").style.width = "100%";
          $("#asmProgressText").textContent = "Done!";
          showResult(pd.url);
          setTimeout(() => prog.classList.add("hidden"), 2000);
          $("#assembleBtn").disabled = false;
          return;
        }
        if (pd.status === "failed") {
          showToast(pd.error || "Render failed");
          break;
        }
      } catch { /* keep polling */ }
    }
  } catch (err) {
    showToast("Error: " + err.message);
  }

  prog.classList.add("hidden");
  $("#assembleBtn").disabled = false;
});

renderTimeline();
