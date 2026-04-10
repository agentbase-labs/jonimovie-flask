(function () {
  function render(el, d) {
    const statusEl = el.querySelector(".vbd-status");
    const bodyEl = el.querySelector(".vbd-body");
    const backend = (d.video_backend || "?").toLowerCase();
    const isSeed = backend === "seedance";
    const isKling = backend === "kling";
    el.classList.toggle("vbd-seedance", isSeed);
    el.classList.toggle("vbd-kling", isKling);
    if (statusEl) {
      statusEl.textContent = isSeed ? "Seedance" : isKling ? "Kling" : backend;
      statusEl.className =
        "vbd-status " +
        (isSeed ? "vbd-pill-seed" : isKling ? "vbd-pill-kling" : "vbd-pill-other");
    }
    if (!bodyEl) return;
    const parts = [`Provider: <strong>${backend}</strong>`];
    if (isSeed) {
      parts.push(`Region: <strong>${escapeHtml(d.ark_region || "?")}</strong>`);
      if (d.ark_base_url) {
        parts.push(`Base: <code>${escapeHtml(d.ark_base_url)}</code>`);
      }
      parts.push(`Model: ${escapeHtml(d.seedance_model || "—")}`);
      parts.push(`Multi-ref: ${escapeHtml(d.seedance_ref_model || "—")}`);
      parts.push(
        `ARK key: ${d.ark_key_configured ? "<span class=\"vbd-ok\">loaded</span>" : "<span class=\"vbd-warn\">missing</span>"}`,
      );
      parts.push(`Task ids: <code>${escapeHtml(d.seedance_task_id_prefix || "cgt-")}…</code>`);
    } else {
      parts.push("<span class=\"vbd-muted\">Poll uses Kling endpoints</span>");
    }
    bodyEl.innerHTML = parts.join("<br>");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function refresh() {
    const el = document.getElementById("videoBackendDebug");
    if (!el) return;
    const statusEl = el.querySelector(".vbd-status");
    const bodyEl = el.querySelector(".vbd-body");
    if (statusEl) {
      statusEl.textContent = "…";
      statusEl.className = "vbd-status vbd-pill-wait";
    }
    if (bodyEl) bodyEl.textContent = "Loading…";
    try {
      const r = await fetch("/api/client-config");
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText || "Request failed");
      render(el, d);
    } catch (e) {
      if (statusEl) {
        statusEl.textContent = "Error";
        statusEl.className = "vbd-status vbd-pill-err";
      }
      if (bodyEl) bodyEl.textContent = e.message || String(e);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("videoBackendDebugRefresh");
    if (btn) btn.addEventListener("click", () => refresh());
    refresh();
  });
})();
