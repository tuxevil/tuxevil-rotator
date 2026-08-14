var ADMIN_TOKEN =
  new URLSearchParams(window.location.search).get("token") ||
  localStorage.getItem("rotatorAdminToken") ||
  "";
if (ADMIN_TOKEN) localStorage.setItem("rotatorAdminToken", ADMIN_TOKEN);

function authHeaders() {
  return ADMIN_TOKEN ? { "X-Rotator-Admin-Token": ADMIN_TOKEN, "Content-Type": "application/json" } : {};
}

function openModal(id) {
  var m = document.getElementById(id);
  if (m) m.classList.add("open");
}
function closeModal(e, id) {
  if (e && e.target !== e.currentTarget) return;
  var m = document.getElementById(id);
  if (m) m.classList.remove("open");
}
function hideDonationModalPermanently() {
  localStorage.setItem("hideDonationModal", "true");
  closeModal(null, "donationModal");
}
var MASK_MODE = new URLSearchParams(window.location.search).has("mask");
var maskCounter = 0;
var maskMap = {};

function maskText(text) {
  if (!text) return "";
  if (!MASK_MODE) return text;
  if (!maskMap[text]) {
    maskCounter++;
    maskMap[text] = "User " + maskCounter;
  }
  return maskMap[text];
}

function maskKeyAlias(alias) {
  if (!alias) return "";
  if (!MASK_MODE) return alias;
  if (!maskMap["alias_" + alias]) {
    maskCounter++;
    maskMap["alias_" + alias] = "Agent " + maskCounter;
  }
  return maskMap["alias_" + alias];
}

function maskKeyName(keyName) {
  if (!keyName) return "";
  if (!MASK_MODE) return keyName;
  return "rk-***...***";
}

function toggleMask() {
  var url = new URL(window.location);
  if (MASK_MODE) {
    url.searchParams.delete("mask");
  } else {
    url.searchParams.set("mask", "1");
  }
  window.location.href = url.toString();
}

function updateMaskButton() {
  var b = document.getElementById("maskBtn");
  if (b) {
    b.textContent = MASK_MODE ? "PII: Hidden" : "PII: Visible";
  }
}
function formatDuration(ms) {
  if (ms <= 0) return "--";
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  var h = Math.floor(m / 60);
  if (h < 24) return h + "h " + (m % 60) + "m";
  var d = Math.floor(h / 24);
  return d + "d " + (h % 24) + "h " + (m % 60) + "m";
}
function refreshHeaderStats() {
  fetch("/api/status", { headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (document.getElementById("uptime")) document.getElementById("uptime").textContent = formatDuration(data.uptime || 0);
      if (document.getElementById("port")) document.getElementById("port").textContent = data.proxyPort || "51200";
      if (document.getElementById("rotation")) document.getElementById("rotation").textContent = data.requestsPerRotation || "--";
      if (document.getElementById("headerVersion")) document.getElementById("headerVersion").textContent = "v" + (data.version || "2.4.0");
      if (document.getElementById("lastRefresh")) document.getElementById("lastRefresh").textContent = new Date().toLocaleTimeString();
      if (document.getElementById("totalRequests")) document.getElementById("totalRequests").textContent = data.totalRequestsAllAccounts || 0;
    })
    .catch(function() {});
}

var keys = [];
var editingKey = null;

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function timeAgo(dateStr) {
  if (!dateStr) return "Never";
  var diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return "Just now";
  var mins = Math.floor(diff / 60000);
  if (mins < 60) return mins + "m ago";
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  var days = Math.floor(hrs / 24);
  return days + "d ago";
}

function getCheckedModels() {
  var cbs = document.querySelectorAll(".modelCb:checked");
  return Array.from(cbs).map(function(c) { return c.value; });
}

function updateModelsCountBadge() {
  var allCbs = document.querySelectorAll(".modelCb");
  var checkedCbs = document.querySelectorAll(".modelCb:checked");
  var badge = document.getElementById("modelsCountBadge");
  if (!badge) return;
  if (checkedCbs.length === 0 || checkedCbs.length === allCbs.length) {
    badge.textContent = "All models allowed (unrestricted)";
    badge.style.color = "var(--accent)";
    badge.style.borderColor = "rgba(124, 92, 252, 0.25)";
  } else {
    badge.textContent = checkedCbs.length + " of " + allCbs.length + " models selected";
    badge.style.color = "var(--yellow)";
    badge.style.borderColor = "rgba(251, 191, 36, 0.3)";
  }
}

function selectAllModels() {
  document.querySelectorAll(".modelCb").forEach(function(c) { c.checked = true; });
  updateModelsCountBadge();
}

function selectNoModels() {
  document.querySelectorAll(".modelCb").forEach(function(c) { c.checked = false; });
  updateModelsCountBadge();
}

function setCheckedModels(models) {
  var cbs = document.querySelectorAll(".modelCb");
  cbs.forEach(function(c) { c.checked = models.length === 0 || models.indexOf(c.value) >= 0; });
  updateModelsCountBadge();
}

// ── Dynamic model grid (fetched from /api/models) ──────────────────
//
// The Generate/Edit Virtual Key modal used to ship with a hardcoded list
// of legacy Gemini/Claude/GPT-OSS models, so adding new providers
// (Ollama, OpenAI Codex, OpenCode Zen, ...) silently hid those models
// from the Allowed Models picker. The grid is now rendered from
// /api/models, which returns every model the rotator can route today
// grouped by `owned_by` provider. A static fallback is used only when
// the API is unreachable (e.g. dashboard served from a stale build).

// Provider id → human-readable group title for the modal UI.
var PROVIDER_LABELS = {
  "tuxevil-rotator": "Google Antigravity",
  "openai-codex": "OpenAI Codex",
  "ollama": "Ollama Cloud",
  "opencode-zen": "OpenCode Zen",
};

function providerLabel(ownedBy) {
  if (PROVIDER_LABELS[ownedBy]) return PROVIDER_LABELS[ownedBy];
  if (typeof ownedBy === "string" && ownedBy.length > 0) {
    return ownedBy.charAt(0).toUpperCase() + ownedBy.slice(1);
  }
  return "Other";
}

function renderModelGridFromCatalog(catalog) {
  var grid = document.getElementById("modelGrid");
  var empty = document.getElementById("modelGridEmpty");
  if (!grid) return false;

  // Group models by `owned_by` provider while preserving the order in
  // which the API returned them (static catalog first, then dynamic
  // provider catalogs in the order they were enabled).
  var groups = [];
  var byKey = {};
  (catalog || []).forEach(function(m) {
    if (!m || !m.id) return;
    var key = m.owned_by || "other";
    if (!byKey[key]) {
      byKey[key] = { key: key, label: providerLabel(key), models: [] };
      groups.push(byKey[key]);
    }
    byKey[key].models.push(m);
  });

  if (groups.length === 0) {
    grid.innerHTML = "";
    if (empty) empty.style.display = "";
    updateModelsCountBadge();
    return false;
  }

  if (empty) empty.style.display = "none";

  grid.innerHTML = groups.map(function(group) {
    var cards = group.models.map(function(m) {
      var id = "model-" + m.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      return '<label class="model-card">' +
        '<input type="checkbox" id="' + escapeHtml(id) + '" value="' + escapeHtml(m.id) + '" class="modelCb" onchange="updateModelsCountBadge()">' +
        '<span class="model-name" title="' + escapeHtml(m.id) + '">' + escapeHtml(m.id) + '</span>' +
        '</label>';
    }).join("");
    return '<div class="model-category">' +
      '<div class="cat-title">' + escapeHtml(group.label) + '</div>' +
      '<div class="cat-grid">' + cards + '</div>' +
      '</div>';
  }).join("");

  updateModelsCountBadge();
  return true;
}

// Last successful catalog (cached so the Edit modal opens instantly
// without re-fetching when the user clicks Edit right after Generate).
var lastModelCatalog = null;
var modelCatalogInflight = null;

function fetchModelCatalog() {
  if (modelCatalogInflight) return modelCatalogInflight;
  modelCatalogInflight = fetch("/api/models", { headers: authHeaders() })
    .then(function(r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function(d) {
      var catalog = Array.isArray(d && d.data) ? d.data : [];
      lastModelCatalog = catalog;
      return catalog;
    })
    .finally(function() {
      modelCatalogInflight = null;
    });
  return modelCatalogInflight;
}

// Static fallback used only when /api/models is unreachable. Mirrors
// the pre-refactor hardcoded list so the modal still works against an
// older server build that hasn't been restarted with this change.
var FALLBACK_MODEL_CATALOG = [
  { id: "gemini-3.1-pro-low", owned_by: "tuxevil-rotator" },
  { id: "gemini-3.1-pro-high", owned_by: "tuxevil-rotator" },
  { id: "gemini-3.5-flash-medium", owned_by: "tuxevil-rotator" },
  { id: "gemini-3.5-flash-high", owned_by: "tuxevil-rotator" },
  { id: "gemini-3-flash", owned_by: "tuxevil-rotator" },
  { id: "gemini-3.6-flash-low", owned_by: "tuxevil-rotator" },
  { id: "gemini-3.6-flash-medium", owned_by: "tuxevil-rotator" },
  { id: "gemini-3.6-flash-high", owned_by: "tuxevil-rotator" },
  { id: "gemini-3.6-flash-tiered", owned_by: "tuxevil-rotator" },
  { id: "gemini-3.7-flash-tiered", owned_by: "tuxevil-rotator" },
  { id: "claude-sonnet-4-6", owned_by: "tuxevil-rotator" },
  { id: "claude-opus-4-6-thinking", owned_by: "tuxevil-rotator" },
  { id: "gpt-oss-120b-medium", owned_by: "tuxevil-rotator" },
];

function ensureModelGridRendered(preselectedModels, callback) {
  function applySelection() {
    if (typeof preselectedModels !== "undefined") {
      setCheckedModels(preselectedModels || []);
    } else {
      updateModelsCountBadge();
    }
    if (typeof callback === "function") callback();
  }

  if (lastModelCatalog && lastModelCatalog.length > 0) {
    renderModelGridFromCatalog(lastModelCatalog);
    applySelection();
    return;
  }

  fetchModelCatalog()
    .then(function(catalog) {
      renderModelGridFromCatalog(catalog);
      applySelection();
    })
    .catch(function() {
      // Stale build or network glitch: fall back to the static list so
      // the modal is never empty. The fallback lacks Ollama/Codex/Zen
      // models, but at least existing keys can still be edited.
      renderModelGridFromCatalog(FALLBACK_MODEL_CATALOG);
      applySelection();
    });
}

function loadKeys() {
  fetch("/api/keys", { headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      keys = d.keys || [];
      renderKeys();
    })
    .catch(function(e) { alert("Failed to load keys: " + e.message); });
}

function renderKeys() {
  var totalEl = document.getElementById("statTotalKeys");
  var activeEl = document.getElementById("statActiveKeys");
  var blockedEl = document.getElementById("statBlockedKeys");
  
  var activeCount = 0;
  var blockedCount = 0;
  keys.forEach(function(k) {
    if (k.blocked) blockedCount++;
    else activeCount++;
  });
  
  if (totalEl) totalEl.textContent = keys.length;
  if (activeEl) activeEl.textContent = activeCount;
  if (blockedEl) blockedEl.textContent = blockedCount;

  var tbody = document.getElementById("keysTbody");
  if (!tbody) return;

  var search = (document.getElementById("keySearchInput") ? document.getElementById("keySearchInput").value.trim().toLowerCase() : "");
  var statusFilter = (document.getElementById("keyStatusFilter") ? document.getElementById("keyStatusFilter").value : "all");

  var filtered = keys.filter(function(k) {
    if (statusFilter === "active" && k.blocked) return false;
    if (statusFilter === "blocked" && !k.blocked) return false;
    if (search) {
      var matchAlias = (k.keyAlias || "").toLowerCase().indexOf(search) >= 0;
      var matchName = (k.keyName || "").toLowerCase().indexOf(search) >= 0;
      var matchUser = (k.userId || "").toLowerCase().indexOf(search) >= 0;
      if (!matchAlias && !matchName && !matchUser) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:32px">' +
      (keys.length === 0 ? 'No virtual keys created yet. Click "+ Generate Virtual Key" above.' : 'No virtual keys match your search filters.') +
      '</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(function(k) {
    var statusBadge = k.blocked 
      ? '<span class="status-badge blocked">Blocked</span>' 
      : '<span class="status-badge active">Active</span>';
      
    var modelsHtml = "";
    if (!k.models || k.models.length === 0) {
      modelsHtml = '<span class="model-chip all">All Models</span>';
    } else {
      modelsHtml = k.models.map(function(m) {
        return '<span class="model-chip">' + escapeHtml(m) + '</span>';
      }).join("");
    }

    var displayAlias = maskKeyAlias(k.keyAlias);
    var displayName = maskKeyName(k.keyName);
    var displayUser = k.userId ? maskText(k.userId) : null;

    var userHtml = displayUser 
      ? '<span style="font-weight:500">' + escapeHtml(displayUser) + '</span>' 
      : '<span style="color:var(--text-dim)">-</span>';

    return '<tr>' +
      '<td>' +
        '<div style="font-weight:600;color:var(--text);font-size:0.92rem">' + escapeHtml(displayAlias) + '</div>' +
        '<div class="mono" style="color:var(--text-dim);font-size:0.75rem;margin-top:2px">' + escapeHtml(displayName) + '</div>' +
      '</td>' +
      '<td>' + userHtml + '</td>' +
      '<td><div style="display:flex;flex-wrap:wrap;gap:2px;max-width:280px">' + modelsHtml + '</div></td>' +
      '<td>' + statusBadge + '</td>' +
      '<td><span style="font-size:0.82rem;color:var(--text-dim)" title="' + (k.lastActive ? new Date(k.lastActive).toLocaleString() : 'Never') + '">' + timeAgo(k.lastActive) + '</span></td>' +
      '<td style="text-align:right">' +
        '<div style="display:inline-flex;gap:4px">' +
          '<button class="btn-action" onclick="showEditModal(\'' + k.tokenHash + '\')" title="Edit Models">✎</button>' +
          '<button class="btn-action" onclick="blockKey(\'' + k.tokenHash + '\', ' + !k.blocked + ')" title="' + (k.blocked ? "Unblock Key" : "Block Key") + '">' + (k.blocked ? "▶" : "🚫") + '</button>' +
          '<button class="btn-action" onclick="deleteKey(\'' + k.tokenHash + '\')" title="Delete Key" style="color:var(--red)">🗑</button>' +
        '</div>' +
      '</td>' +
    '</tr>';
  }).join("");
}

function showGenerateModal() {
  editingKey = null;
  document.getElementById("keyFormAlias").value = "";
  document.getElementById("keyFormAlias").disabled = false;
  document.getElementById("keyFormUserId").value = "";
  document.getElementById("keyFormUserId").disabled = false;
  document.getElementById("keyFormError").textContent = "";
  document.getElementById("generatedKeyResult").style.display = "none";
  document.getElementById("submitKeyBtn").textContent = "Generate Key";
  document.getElementById("modelCheckboxes").style.display = "";
  document.getElementById("modalTitle").textContent = "Generate Virtual Key";
  var sub = document.getElementById("modalSubtitle");
  if (sub) sub.textContent = "Configure key access and model restrictions";
  document.getElementById("keyModal").classList.add("open");
  // Render the live provider catalog and default to "all models allowed"
  // (empty selection). ensureModelGridRendered reuses the cached catalog
  // when possible, so this opens instantly on the second open.
  ensureModelGridRendered([]);
}

function showEditModal(hash) {
  var k = null;
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].tokenHash === hash) { k = keys[i]; break; }
  }
  if (!k) return;

  editingKey = k;
  document.getElementById("keyFormAlias").value = k.keyAlias;
  document.getElementById("keyFormAlias").disabled = true;
  document.getElementById("keyFormUserId").value = k.userId || "";
  document.getElementById("keyFormUserId").disabled = true;
  document.getElementById("keyFormError").textContent = "";
  document.getElementById("generatedKeyResult").style.display = "none";
  document.getElementById("submitKeyBtn").textContent = "Save Changes";
  document.getElementById("modelCheckboxes").style.display = "";
  document.getElementById("modalTitle").textContent = "Edit Virtual Key";
  var sub = document.getElementById("modalSubtitle");
  if (sub) sub.textContent = "Updating model restrictions for alias: " + k.keyAlias;
  document.getElementById("keyModal").classList.add("open");
  // Render the live catalog and preselect the key's existing allowlist
  // (or all models when the key is unrestricted).
  ensureModelGridRendered(k.models || []);
}

function hideModal() {
  document.getElementById("keyModal").classList.remove("open");
}

function submitKeyForm() {
  if (editingKey) {
    submitEditKey();
    return;
  }

  var alias = document.getElementById("keyFormAlias").value.trim();
  if (!alias) {
    document.getElementById("keyFormError").textContent = "Alias is required";
    return;
  }
  var userId = document.getElementById("keyFormUserId").value.trim() || null;
  var models = getCheckedModels();

  document.getElementById("keyFormError").textContent = "";

  fetch("/api/keys/generate", { method: "POST", headers: authHeaders(), body: JSON.stringify({ alias: alias, userId: userId, models: models }) })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) { document.getElementById("keyFormError").textContent = d.error; return; }
      document.getElementById("generatedRawKey").textContent = d.rawKey;
      document.getElementById("generatedKeyResult").style.display = "block";
      document.getElementById("modelCheckboxes").style.display = "none";
      loadKeys();
    })
    .catch(function(e) { document.getElementById("keyFormError").textContent = e.message; });
}

function submitEditKey() {
  if (!editingKey) return;
  var models = getCheckedModels();

  document.getElementById("keyFormError").textContent = "";

  fetch("/api/keys/" + editingKey.tokenHash, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ models: models })
  })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) { document.getElementById("keyFormError").textContent = d.error; return; }
      hideModal();
      loadKeys();
    })
    .catch(function(e) { document.getElementById("keyFormError").textContent = e.message; });
}

function copyRawKey() {
  var txt = document.getElementById("generatedRawKey").textContent;
  navigator.clipboard.writeText(txt).then(function() {
    var btn = document.getElementById("copyKeyBtn");
    btn.textContent = "Copied!";
    setTimeout(function() { btn.textContent = "Copy Key"; }, 2000);
  });
}

function blockKey(hash, blocked) {
  if (!confirm(blocked ? "Block this key? Requests using it will be rejected." : "Unblock this key?")) return;
  fetch("/api/keys/" + hash, { method: "PUT", headers: authHeaders(), body: JSON.stringify({ blocked: blocked }) })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) { alert("Failed: " + d.error); return; }
      loadKeys();
    });
}

function deleteKey(hash) {
  if (!confirm("Delete this virtual key? This CANNOT be undone. Spend logs are retained.")) return;
  fetch("/api/keys/" + hash, { method: "DELETE", headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) { alert("Failed: " + d.error); return; }
      loadKeys();
    });
}

function initKeysPage() {
  updateMaskButton();
  loadKeys();
  refreshHeaderStats();
  setInterval(refreshHeaderStats, 10000);

  var modal = document.getElementById("keyModal");
  if (modal) {
    modal.addEventListener("click", function(e) {
      if (e.target === modal) hideModal();
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initKeysPage);
} else {
  initKeysPage();
}