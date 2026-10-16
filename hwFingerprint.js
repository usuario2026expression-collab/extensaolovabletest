// hwFingerprint v4 — dados 100% cross-browser (sem WebGL/GPU que varia entre Chrome/Firefox/Edge)
// Sempre computado do hardware na hora — nunca lido de storage (cada perfil/browser tem storage separado)

async function generateHardwareFingerprint() {
  const p = [];

  try { p.push("co:" + (navigator.hardwareConcurrency || 0)); } catch (_) {}
  try { p.push("me:" + (navigator.deviceMemory || 0)); } catch (_) {}
  try {
    p.push("sw:" + screen.width);
    p.push("sh:" + screen.height);
    p.push("cd:" + screen.colorDepth);
  } catch (_) {}
  try { p.push("tz:" + Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (_) {}
  try { p.push("pl:" + navigator.platform); } catch (_) {}
  try { p.push("tp:" + (navigator.maxTouchPoints || 0)); } catch (_) {}

  const raw = p.join("||");
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch (_) {
    let h = 0;
    for (let i = 0; i < raw.length; i++) { h = (h << 5) - h + raw.charCodeAt(i); h |= 0; }
    return "fb-" + Math.abs(h).toString(16);
  }
}

let _cachedFingerprint = null;

async function getHardwareFingerprint() {
  if (_cachedFingerprint) return _cachedFingerprint;

  return new Promise(async resolve => {
    const timeout = setTimeout(() => resolve(_cachedFingerprint || "to-" + Date.now()), 5000);

    try {
      const fp = await generateHardwareFingerprint();
      clearTimeout(timeout);
      _cachedFingerprint = fp;
      resolve(fp);
    } catch (err) {
      clearTimeout(timeout);
      const fallback = "err-" + Date.now();
      _cachedFingerprint = fallback;
      resolve(fallback);
    }
  });
}

// ── Mock para ambiente sem extensão (desenvolvimento) ──────────────────────
"undefined" != typeof chrome && chrome.runtime && chrome.runtime.id || (window.chrome = {
  runtime: {
    id: "mock-extension-id",
    sendMessage: (e, t) => { console.log("Mock sendMessage:", e); t && setTimeout(() => t({ status: "ok", data: {} }), 0); },
    lastError: null,
  },
  storage: {
    local: {
      get: (e, t) => {
        const r = {}, n = k => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : undefined; } catch (_) {} };
        if (Array.isArray(e)) e.forEach(k => r[k] = n(k));
        else if ("string" == typeof e) r[e] = n(e);
        else for (let k in e) { const v = n(k); r[k] = v !== undefined ? v : e[k]; }
        t && setTimeout(() => t(r), 0); return Promise.resolve(r);
      },
      set: (e, t) => { for (let k in e) localStorage.setItem(k, JSON.stringify(e[k])); t && setTimeout(t, 0); return Promise.resolve(); },
      remove: (e, t) => { (Array.isArray(e) ? e : [e]).forEach(k => localStorage.removeItem(k)); t && setTimeout(t, 0); return Promise.resolve(); },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    sync: {
      get: (e, t) => {
        const r = {}, n = k => { try { const v = localStorage.getItem("_sync_" + k); return v ? JSON.parse(v) : undefined; } catch (_) {} };
        if (Array.isArray(e)) e.forEach(k => r[k] = n(k));
        else if ("string" == typeof e) r[e] = n(e);
        else for (let k in e) { const v = n(k); r[k] = v !== undefined ? v : e[k]; }
        t && setTimeout(() => t(r), 0); return Promise.resolve(r);
      },
      set: (e, t) => { for (let k in e) localStorage.setItem("_sync_" + k, JSON.stringify(e[k])); t && setTimeout(t, 0); return Promise.resolve(); },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  },
  tabs: { query: (e, t) => (t && setTimeout(() => t([{ id: 1, active: true }]), 0), Promise.resolve([{ id: 1, active: true }])) },
  scripting: { executeScript: () => Promise.resolve([]) },
});
