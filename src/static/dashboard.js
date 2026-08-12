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

function formatTime(ts) {
  if (!ts) return "--";
  return new Date(ts).toLocaleTimeString();
}

function quotaBarColor(pct) {
  if (pct >= 60) return "var(--green)";
  if (pct >= 30) return "var(--yellow)";
  return "var(--red)";
}

function timerDisplayLabel(timerType) {
  return timerType === "fresh" ? "idle" : timerType;
}

// A pool is "idle" (worth kickstarting) when either:
//   1. The server reports timerType === "fresh" (no active timer at all), or
//   2. Google is showing a "rolling" timer: 100% quota AND remaining time is
//      very close to a full 5h or 7d window (the timer exists but hasn't been
//      touched yet — a kickstart request will start consuming from it).
function isIdleForKickstart(q, now) {
  if (q.timerType === "fresh") return true;
  if (!q.resetTime || q.percentRemaining !== 100) return false;
  var remaining = new Date(q.resetTime).getTime() - now;
  if (remaining <= 0) return false;
  var isRolling5h = Math.abs(remaining - 5 * 3600000) < 600000;
  var isRolling7d = Math.abs(remaining - 7 * 86400000) < 600000;
  return isRolling5h || isRolling7d;
}

function isKickstartSupported(q) {
  if (!q) return false;
  if (q.providerId === "openai-codex") return false;
  var key = String(q.modelKey || "");
  return (
    key !== "openai-codex" &&
    key !== "openai-codex-spark" &&
    key.indexOf("openai-codex:") !== 0
  );
}

function getQuotaItemProviderRank(q) {
  var p = q.providerId;
  if (!p) {
    var k = String(q.modelKey || "");
    if (k === "claude" || k === "gemini") p = "google-antigravity";
    else if (k === "session" || k === "weekly") p = "ollama";
    else if (k.indexOf("opencode") === 0 || k === "opencode-zen") p = "opencode-zen";
    else if (k.indexOf("codex") === 0 || k.indexOf("openai-codex") === 0) p = "openai-codex";
    else p = "google-antigravity";
  }
  var ranks = {
    "google-antigravity": 1,
    "ollama": 2,
    "opencode-zen": 3,
    "openai-codex": 4
  };
  return ranks[p] || 99;
}

function renderQuotaBars(account) {
  var quota = account.quota;
  if (!quota || quota.length === 0) return "";
  var sortedQuota = quota.slice().sort(function (a, b) {
    return getQuotaItemProviderRank(a) - getQuotaItemProviderRank(b);
  });
  var now = Date.now();
  var rows = sortedQuota
    .map(function (q) {
      var inFlightForModel = (account.inFlightByModel || {})[q.modelKey] || 0;
      var clearButton =
        inFlightForModel > 0
          ? '<button class="btn-clear-flight" title="Clear in-flight counter for ' +
            escapeHtml(q.displayName) +
            '" onclick="clearInFlight(\'' +
            jsString(account.email) +
            "', '" +
            jsString(q.modelKey) +
            "')\">" +
            "Clear</button>"
          : '<button class="btn-clear-flight" title="No in-flight requests for ' +
            escapeHtml(q.displayName) +
            '" disabled>Clear</button>';
      var idle = isKickstartSupported(q) && isIdleForKickstart(q, now);
      var kickstartBtn = "";
      var color = quotaBarColor(q.percentRemaining);
      var timerClass = "timer-" + q.timerType;
      var resetLabel = "";
      if (idle && q.resetTime && q.timerType !== "fresh") {
        // Rolling idle timer already has resetTime set; show "idle" label
        resetLabel = '<span style="color:var(--text-dim)">idle</span>';
      } else if (q.resetTime && q.timerType !== "fresh") {
        var remaining = new Date(q.resetTime).getTime() - Date.now();
        if (remaining > 0) {
          resetLabel = formatDuration(remaining);
        }
      }
      return (
        '<div class="quota-row">' +
        '<span class="quota-model">' +
        escapeHtml(q.displayName) +
        "</span>" +
        '<div class="quota-bar-bg"><div class="quota-bar-fill" style="width:' +
        q.percentRemaining +
        "%;background:" +
        color +
        '"></div></div>' +
        '<span class="quota-pct" style="color:' +
        color +
        '">' +
        q.percentRemaining +
        "%</span>" +
        '<span class="quota-reset">' +
        (resetLabel || "--") +
        "</span>" +
        '<span class="quota-action">' +
        clearButton +
        kickstartBtn +
        "</span>" +
        "</div>"
      );
    })
    .join("");
  return (
    '<div class="quota-section"><div class="quota-section-title">Quota (per model)</div>' +
    rows +
    "</div>"
  );
}

function renderAccounts(data) {
  window.__lastData = data;
  var now = Date.now();
  document.getElementById("uptime").textContent = formatDuration(data.uptime);
  document.getElementById("port").textContent = data.proxyPort;
  document.getElementById("rotation").textContent = data.requestsPerRotation;
  document.getElementById("headerVersion").textContent =
    "v" + escapeHtml(data.version || "unknown");
  document.getElementById("lastRefresh").textContent = new Date(
    now,
  ).toLocaleTimeString();
  document.getElementById("totalRequests").textContent =
    data.totalRequestsAllAccounts;

  var routingHealth = document.getElementById("routingHealth");
  var health = data.routingHealth || {};
  var controls = data.operatorControls || {};
  var state = health.state || "stopped";
  var stateColor = {
    healthy: "var(--green)",
    paused: "var(--red)",
    cooldown_wait: "var(--yellow)",
    busy: "var(--blue)",
    stopped: "var(--red)",
  }[state];
  routingHealth.className = "routing-panel state-" + state;
  var nextRetry =
    health.nextRetryIn > 0
      ? '<div style="margin-top:6px;">Next retry window: <span style="font-family:JetBrains Mono, monospace;">' +
        formatDuration(health.nextRetryIn) +
        "</span></div>"
      : "";
  var pauseWindow =
    data.protectivePauseRemaining > 0
      ? '<div style="margin-top:6px;">Protective pause: <span style="font-family:JetBrains Mono, monospace;">' +
        formatDuration(data.protectivePauseRemaining) +
        "</span> remaining</div>"
      : "";
  var freshPolicy = controls.allowFreshWindowStarts
    ? '<div style="margin-top:6px;">Fresh windows: <span style="font-family:JetBrains Mono, monospace;color:var(--green)">allowed</span></div>'
    : '<div style="margin-top:6px;">Fresh windows: <span style="font-family:JetBrains Mono, monospace;color:var(--yellow)">blocked</span></div>';
  var freshPolicyHint = controls.allowFreshWindowStarts
    ? "The rotator may start fresh windows when they are the best available option."
    : "Fresh windows are being held back. Timed 5h buckets still win first, timed 7d buckets still run, but the rotator will not open fresh windows until you re-enable them.";
  var autoWarmupHint = controls.autoWarmupEnabled
    ? "Auto-warmup is enabled. Accounts with the fresh-window override will automatically receive minimal kickstart requests each quota poll cycle."
    : "Auto-warmup is disabled. Use the per-account \u25b6 Start buttons or the per-account Start Idle Timers button to kickstart timers manually.";
  var healthGrid =
    '<div class="health-grid">' +
    renderHealthPill("Available", health.availableCount || 0) +
    renderHealthPill("Active", health.activeCount || 0) +
    renderHealthPill("Ready", health.readyCount || 0) +
    renderHealthPill("Cooldown", health.cooldownCount || 0) +
    renderHealthPill("Busy", health.busyCount || 0) +
    renderHealthPill("Flagged", health.flaggedCount || 0) +
    renderHealthPill("Disabled", health.disabledCount || 0) +
    renderHealthPill("Error", health.errorCount || 0) +
    "</div>";
  routingHealth.innerHTML =
    '<div class="routing-summary">' +
    '<strong style="color:' +
    stateColor +
    '">Routing: ' +
    escapeHtml(String(health.state || "unknown").replace(/_/g, " ")) +
    "</strong>" +
    "<div>" +
    escapeHtml(health.reason || "No routing health information available") +
    "</div>" +
    (nextRetry
      ? "<div>" +
        nextRetry
          .replace('<div style="margin-top:6px;">', "")
          .replace("</div>", "") +
        "</div>"
      : "") +
    (pauseWindow
      ? "<div>" +
        pauseWindow
          .replace('<div style="margin-top:6px;">', "")
          .replace("</div>", "") +
        "</div>"
      : "") +
    '<div class="routing-inline-note">' +
    freshPolicy
      .replace('<div style="margin-top:6px;">', "")
      .replace("</div>", "") +
    "</div>" +
    "</div>" +
    (data.protectivePauseReason && data.protectivePauseRemaining > 0
      ? '<div style="margin-top:6px;color:var(--text-dim);font-family:JetBrains Mono, monospace;">' +
        escapeHtml(data.protectivePauseReason.slice(0, 220)) +
        "</div>"
      : "") +
    healthGrid +
    '<div class="ops-buttons">' +
    '<button class="btn-secondary" onclick="refresh()">Refresh</button>' +
    '<button class="btn-secondary" onclick="openCliLogin()">Add Account</button>' +
    '<button class="btn-secondary" onclick="openRoutingInspectorModal()">Routing Inspector</button>' +
    '<button class="btn-secondary" onclick="openConfigEditorModal()">Config Editor</button>' +
    '<button class="btn-secondary" onclick="toggleFlagged()">' +
    (window.__hideFlagged ? "Show Flagged" : "Hide Flagged") +
    "</button>" +
    '<button class="btn-secondary" onclick="setFreshWindowStarts(' +
    !controls.allowFreshWindowStarts +
    ')">' +
    (controls.allowFreshWindowStarts
      ? "Block Fresh Windows"
      : "Allow Fresh Windows") +
    "</button>" +
    '<button class="btn-secondary" onclick="setAutoWarmup(' +
    !controls.autoWarmupEnabled +
    ')">' +
    (controls.autoWarmupEnabled ? "Disable Auto-Warmup" : "Enable Auto-Warmup") +
    "</button>" +
    (Object.keys(data.circuitBreakers.model || {}).length > 0 ||
    Object.keys(data.circuitBreakers.project || {}).length > 0
      ? '<button class="btn-secondary" style="border-color:var(--red);color:var(--red)" onclick="clearCircuitBreaker()">Reset All Circuit Breakers</button>'
      : "") +
    "</div>" +
    '<div class="ops-warning">' +
    freshPolicyHint +
    "</div>" +
    '<div class="ops-warning">' +
    autoWarmupHint +
    "</div>";

  if (
    Object.keys(data.circuitBreakers.model || {}).length > 0 ||
    Object.keys(data.circuitBreakers.project || {}).length > 0
  ) {
    var breakerHtml =
      '<div style="margin-top:12px;padding:12px;border:1px solid rgba(248, 113, 113, 0.3);border-radius:8px;background:rgba(248, 113, 113, 0.05);">';
    breakerHtml +=
      '<strong style="color:var(--red);display:block;margin-bottom:8px">Active Circuit Breakers</strong>';
    for (var key in data.circuitBreakers.model) {
      breakerHtml +=
        '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;margin-bottom:4px;color:var(--text-dim)">' +
        '<span>Model <span style="font-family:monospace;color:var(--text)">' +
        escapeHtml(key) +
        "</span></span>" +
        '<div style="display:flex;gap:8px;align-items:center">' +
        '<span style="color:var(--yellow)">' +
        formatDuration(data.circuitBreakers.model[key].remainingMs) +
        " left</span>" +
        '<button class="btn-clear-flight" style="border-color:var(--red);color:var(--red)" onclick="clearCircuitBreaker(\'' +
        jsString(key) +
        "')\">Reset</button>" +
        "</div></div>";
    }
    for (var pkey in data.circuitBreakers.project) {
      breakerHtml +=
        '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;margin-bottom:4px;color:var(--text-dim)">' +
        '<span>Project/Model <span style="font-family:monospace;color:var(--text)">' +
        escapeHtml(pkey) +
        "</span></span>" +
        '<span style="color:var(--yellow)">' +
        formatDuration(data.circuitBreakers.project[pkey].remainingMs) +
        " left</span>" +
        "</div>";
    }
    breakerHtml += "</div>";
    routingHealth.innerHTML += breakerHtml;
  }

  renderUpdateBanner(data.updateInfo);
  renderNotifications(data.notifications);
  renderAttentionPanel(data);
  renderRoutingInspector(data);
  renderAutoRouting(data.autoRouting);
  renderTokenChart(data.tokenUsage);
  renderHeatmap(data.tokenUsage);
  renderLatencyPanel(data.latencyStats);
  renderForecastPanel(data);
  renderRequestLog(data.requestLog);
  renderRecentEvents(data.recentEvents);

  var container = document.getElementById("accounts");
  var hideFlagged = window.__hideFlagged || false;
  var sorted = data.accounts
    .slice()
    .filter(function (a) {
      return (
        !hideFlagged || (a.status !== "flagged" && a.status !== "disabled")
      );
    })
    .sort(function (a, b) {
      var aFlagged = a.status === "flagged" || a.status === "disabled" ? 1 : 0;
      var bFlagged = b.status === "flagged" || b.status === "disabled" ? 1 : 0;
      if (aFlagged !== bFlagged) return aFlagged - bFlagged;
      var aQuota = (a.quota || []).reduce(function (s, q) {
        return s + q.percentRemaining;
      }, 0);
      var bQuota = (b.quota || []).reduce(function (s, q) {
        return s + q.percentRemaining;
      }, 0);
      return bQuota - aQuota;
    });
  container.innerHTML = sorted
    .map(function (a) {
      var isActive = a.status === "active";
      var isCooldown = a.status === "cooldown" || a.status === "exhausted";
      var now = Date.now();
      var cooldowns = Object.values(a.cooldownsByModel || {});
      var maxCooldownUntil =
        cooldowns.length > 0 ? Math.max.apply(null, cooldowns) : 0;
      var cooldownRemaining = Math.max(0, maxCooldownUntil - now);
      var cooldownPercent = 0;
      if (isCooldown && cooldownRemaining > 0) {
        var totalCooldown = maxCooldownUntil - (a.lastUsed || now);
        cooldownPercent = Math.max(
          0,
          Math.min(100, (cooldownRemaining / Math.max(totalCooldown, 1)) * 100),
        );
      }
      var modelBadges = (a.activeForModels || [])
        .map(function (m) {
          if (m.startsWith("claude")) {
            return '<span class="badge badge-model">CLAUDE</span>';
          }
          if (m === "gemini-3.1-pro") {
            return '<span class="badge badge-model">PRO</span>';
          }
          if (m === "gemini-3.5-flash") {
            return '<span class="badge badge-model">FLASH</span>';
          }
          return "";
        })
        .join("");
      var tierLabel = a.tier ? String(a.tier).toUpperCase() : "UNKNOWN";

      return (
        '<div class="account-card ' +
        escapeHtml(a.status) +
        '" data-account-email="' +
        escapeHtml(a.email) +
        '">' +
        '<div class="card-header">' +
        '<div class="card-label">' +
        escapeHtml(maskText(a.label)) +
        "</div>" +
        '<div class="card-badges">' +
        '<span class="badge badge-' +
        escapeHtml(a.status) +
        (isActive ? " pulse" : "") +
        '">' +
        escapeHtml(a.status) +
        "</span>" +
        '<div style="position:relative;display:inline-block">' +
        '<span class="badge badge-model" onclick="toggleTierDropdown(this, \'' +
        jsString(a.email) +
        '\')" style="cursor:pointer" title="Click to change tier">' +
        escapeHtml(tierLabel) +
        " ▾</span>" +
        '<div class="tier-dropdown" style="display:none;position:absolute;top:100%;right:0;z-index:100;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-top:4px;min-width:100px;box-shadow:0 8px 24px rgba(0,0,0,0.4)">' +
        '<div class="tier-option" onclick="setAccountTier(\'' +
        jsString(a.email) +
        "', 'unknown')\">" +
        "UNKNOWN</div>" +
        '<div class="tier-option" onclick="setAccountTier(\'' +
        jsString(a.email) +
        "', 'free')\">" +
        "FREE</div>" +
        '<div class="tier-option" onclick="setAccountTier(\'' +
        jsString(a.email) +
        "', 'plus')\">" +
        "PLUS</div>" +
        '<div class="tier-option" onclick="setAccountTier(\'' +
        jsString(a.email) +
        "', 'pro')\">" +
        "PRO</div>" +
        '<div class="tier-option" onclick="setAccountTier(\'' +
        jsString(a.email) +
        "', 'ultra')\">" +
        "ULTRA</div>" +
        "</div>" +
        "</div>" +
        modelBadges +
        "</div>" +
        "</div>" +
        '<div class="card-email">' +
        escapeHtml(maskEmail(a.email)) +
        "</div>" +
        (a.quota && a.quota.length > 0 ? renderQuotaBars(a) : "") +
        '<div class="card-stats">' +
        '<div class="card-stat"><div class="stat-label">Requests</div><div class="stat-value">' +
        a.requestsSinceRotation +
        " / " +
        a.totalRequests +
        " total</div></div>" +
        '<div class="card-stat"><div class="stat-label">Last Used</div><div class="stat-value">' +
        (a.lastUsed ? formatTime(a.lastUsed) : "--") +
        "</div></div>" +
        (isCooldown
          ? '<div class="card-stat"><div class="stat-label">Cooldown</div><div class="stat-value" style="color:var(--yellow)">' +
            formatDuration(cooldownRemaining) +
            "</div></div>"
          : "") +
        (a.inFlightRequests > 0
          ? '<div class="card-stat"><div class="stat-label">In Flight</div><div class="stat-value" style="color:var(--blue)">' +
            a.inFlightRequests +
            "</div></div>"
          : "") +
        '<div class="card-stat"><div class="stat-label">Token</div><div class="stat-value" style="color:' +
        (a.hasValidToken ? "var(--green)" : "var(--text-dim)") +
        '">' +
        (a.hasValidToken ? "Valid" : "Expired") +
        "</div></div>" +
        '<div class="card-stat"><div class="stat-label">Health</div><div class="stat-value">' +
        Math.round((a.healthScore || 0) * 100) +
        "%</div></div>" +
        '<div class="card-stat"><div class="stat-label">Fresh Policy</div><div class="stat-value" style="color:' +
        (a.effectiveFreshWindowStartsAllowed
          ? "var(--green)"
          : "var(--yellow)") +
        '">' +
        (a.allowFreshWindowStartsOverride
          ? "Override ON"
          : a.effectiveFreshWindowStartsAllowed
            ? "Global ON"
            : "Blocked") +
        "</div></div>" +
        "</div>" +
        (a.lastError
          ? '<div class="card-error">' +
            escapeHtml(a.lastError.slice(0, 150)) +
            "</div>" +
            (a.lastError.toLowerCase().includes("verif")
              ? '<div class="card-hint">Open Antigravity IDE, sign in with this account, and resolve the verification prompt outside the rotator. Keep the account quarantined until that is complete.</div>'
              : a.lastError.toLowerCase().includes("terms of service")
                ? '<div class="card-hint">This account was suspended by Google. Submit an appeal at <a href="https://support.google.com/accounts/troubleshooter/2402620" target="_blank" style="color:var(--blue)">Google Account Recovery</a> and keep it out of rotation unless Google explicitly restores access.</div>'
                : "")
          : "") +
        (isCooldown
          ? '<div class="card-hint">Cooling down after a provider rate-limit response. The rotator will wait for the retry window instead of forcing more traffic into this account.</div>'
          : "") +
        '<div class="card-actions">' +
        (a.status === "disabled"
          ? '<button class="btn-enable" onclick="enableAccount(\'' +
            jsString(a.email) +
            "')\">Re-enable</button>"
          : "") +
        (a.status !== "disabled"
          ? '<button class="btn-enable" onclick="disableAccount(\'' +
            jsString(a.email) +
            "')\">Disable</button>"
          : "") +
        (a.status !== "flagged"
          ? '<button class="btn-enable" onclick="quarantineAccount(\'' +
            jsString(a.email) +
            "')\">Quarantine</button>"
          : "") +
        (a.status === "flagged" || a.status === "disabled"
          ? '<button class="btn-enable" onclick="restoreAccount(\'' +
            jsString(a.email) +
            "')\">Restore</button>"
          : "") +
        '<button class="btn-enable" onclick="setAccountFreshWindowOverride(\'' +
        jsString(a.email) +
        "', " +
        !a.allowFreshWindowStartsOverride +
        ')">' +
        (a.allowFreshWindowStartsOverride
          ? "Use Global Fresh Policy"
          : "Allow Fresh On This Account") +
        "</button>" +
        ((a.quota || []).some(function (q) {
          return isKickstartSupported(q) && isIdleForKickstart(q, Date.now());
        })
          ? '<button class="btn-enable" onclick="kickstartAllTimers(\'' +
            jsString(a.email) +
            "'\")>Start Idle Timers</button>"
          : "") +
        '<button class="btn-enable" style="border-color:var(--red);color:var(--red)" onclick="confirmRemoveAccount(\'' +
        jsString(a.email) +
        "')\">Remove</button>" +
        "</div>" +
        (isCooldown && cooldownPercent > 0
          ? '<div class="cooldown-bar" style="width:' +
            cooldownPercent +
            '%"></div>'
          : "") +
        "</div>"
      );
    })
    .join("");
}

function renderAutoRouting(stats) {
  var panel = document.getElementById("autoRoutingPanel");
  if (!panel) return;
  if (!stats) {
    panel.style.display = "none";
    panel.innerHTML = "";
    return;
  }
  panel.style.display = "block";
  var targets = Object.keys(stats.byTarget || {}).sort(function (a, b) {
    return (stats.byTarget[b] || 0) - (stats.byTarget[a] || 0);
  });
  var sources = Object.keys(stats.bySource || {}).sort(function (a, b) {
    return (stats.bySource[b] || 0) - (stats.bySource[a] || 0);
  });
  var targetText = targets.length
    ? targets.map(function (target) { return escapeHtml(target) + " (" + stats.byTarget[target] + ")"; }).join(", ")
    : "--";
  var sourceText = sources.length
    ? sources.map(function (source) { return escapeHtml(source) + " (" + stats.bySource[source] + ")"; }).join(", ")
    : "--";
  panel.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">' +
    '<strong>Auto Routing</strong>' +
    '<span style="font-family:JetBrains Mono,monospace;color:var(--text-dim);font-size:0.8rem">' +
    escapeHtml(String(stats.decisions || 0)) + " decisions</span></div>" +
    '<div class="health-grid" style="margin-top:10px">' +
    renderHealthPill("Fallbacks", stats.fallbacks || 0) +
    renderHealthPill("Judge calls", stats.judgeCalls || 0) +
    renderHealthPill("Judge failures", stats.judgeFailures || 0) +
    renderHealthPill("Escalations", stats.escalations || 0) +
    "</div>" +
    '<div style="margin-top:10px;color:var(--text-dim);font-size:0.8rem;line-height:1.7">' +
    "Targets: <span style=\"color:var(--text)\">" + targetText + "</span><br>" +
    "Sources: <span style=\"color:var(--text)\">" + sourceText + "</span><br>" +
    "Judge latency: <span style=\"color:var(--text)\">" + Math.round(stats.judgeLatencyMs || 0) + " ms</span> · " +
    "Judge tokens: <span style=\"color:var(--text)\">" + (stats.judgeTokens || 0) + "</span> · " +
    "Model tokens: <span style=\"color:var(--text)\">" + (stats.modelTokens || 0) + "</span>" +
    "</div>";
}

// ── List View ─────────────────────────────────────────────────────────────
var CURRENT_VIEW = "grid";
var LIST_SORT = "requests";
var LIST_SORT_DIR = -1; // -1 = desc, 1 = asc

function switchView(view) {
  CURRENT_VIEW = view;
  document.getElementById("viewTabGrid").className =
    "view-tab" + (view === "grid" ? " active" : "");
  document.getElementById("viewTabList").className =
    "view-tab" + (view === "list" ? " active" : "");
  document.getElementById("accounts").style.display =
    view === "grid" ? "" : "none";
  document.getElementById("listPanel").style.display =
    view === "list" ? "" : "none";
  if (view === "list" && window.__lastData) renderListView();
}

function setListSort(col) {
  if (LIST_SORT === col) {
    LIST_SORT_DIR = -LIST_SORT_DIR;
  } else {
    LIST_SORT = col;
    LIST_SORT_DIR = -1;
  }
  ["requests", "quota", "tokens", "status"].forEach(function (c) {
    var btn = document.getElementById("lsort-" + c);
    if (btn)
      btn.className = "list-sort-btn" + (c === LIST_SORT ? " active" : "");
  });
  renderListView();
}

function renderListView() {
  if (!window.__lastData) return;
  var data = window.__lastData;
  var wrap = document.getElementById("listTableWrap");
  var query = (
    (document.getElementById("listSearch") || {}).value || ""
  ).toLowerCase();

  var rows = data.accounts.slice();

  // Filter by search
  if (query) {
    rows = rows.filter(function (a) {
      return (
        (a.label || "").toLowerCase().indexOf(query) !== -1 ||
        (a.email || "").toLowerCase().indexOf(query) !== -1 ||
        (a.status || "").toLowerCase().indexOf(query) !== -1
      );
    });
  }

  // Aggregate token totals per account (from tokensByAccount in usage data if present,
  // otherwise fall back to account-level totalTokens if server exposes it)
  var tokensByAccount = {};
  var tokenUsage = data.tokenUsage || {};
  ["minutes", "hours", "days", "months"].forEach(function (tier) {
    (tokenUsage[tier] || []).forEach(function (b) {
      if (!b.byAccount) return;
      Object.keys(b.byAccount).forEach(function (acct) {
        var d = b.byAccount[acct] || {};
        if (!tokensByAccount[acct])
          tokensByAccount[acct] = { input: 0, output: 0 };
        tokensByAccount[acct].input += d.inputTokens || 0;
        tokensByAccount[acct].output += d.outputTokens || 0;
      });
    });
  });

  // Fallback: use per-account token fields exposed directly on the account object
  rows.forEach(function (a) {
    if (
      !tokensByAccount[a.email] &&
      (a.totalInputTokens || a.totalOutputTokens)
    ) {
      tokensByAccount[a.email] = {
        input: a.totalInputTokens || 0,
        output: a.totalOutputTokens || 0,
      };
    }
  });

  // Sort
  rows.sort(function (a, b) {
    var av, bv;
    if (LIST_SORT === "requests") {
      av = a.totalRequests || 0;
      bv = b.totalRequests || 0;
    } else if (LIST_SORT === "quota") {
      av =
        a.quota && a.quota.length
          ? a.quota.reduce(function (s, q) {
              return s + q.percentRemaining;
            }, 0) / a.quota.length
          : -1;
      bv =
        b.quota && b.quota.length
          ? b.quota.reduce(function (s, q) {
              return s + q.percentRemaining;
            }, 0) / b.quota.length
          : -1;
    } else if (LIST_SORT === "tokens") {
      var ta = tokensByAccount[a.email] || { input: 0, output: 0 };
      var tb = tokensByAccount[b.email] || { input: 0, output: 0 };
      av = ta.input + ta.output;
      bv = tb.input + tb.output;
    } else if (LIST_SORT === "status") {
      var statusOrder = {
        active: 0,
        ready: 1,
        cooldown: 2,
        exhausted: 3,
        error: 4,
        disabled: 5,
        flagged: 6,
      };
      av = statusOrder[a.status] !== undefined ? statusOrder[a.status] : 9;
      bv = statusOrder[b.status] !== undefined ? statusOrder[b.status] : 9;
    } else {
      av = 0;
      bv = 0;
    }
    if (av < bv) return LIST_SORT_DIR;
    if (av > bv) return -LIST_SORT_DIR;
    return 0;
  });

  if (rows.length === 0) {
    wrap.innerHTML =
      '<div class="list-empty">No accounts match the filter.</div>';
    return;
  }

  var arrowFor = function (col) {
    if (LIST_SORT !== col) return '<span class="sort-arrow">↕</span>';
    return (
      '<span class="sort-arrow">' +
      (LIST_SORT_DIR === -1 ? "↓" : "↑") +
      "</span>"
    );
  };

  var html =
    '<table class="list-table"><thead><tr>' +
    "<th>Account</th>" +
    '<th onclick="setListSort(&apos;status&apos;)" class="' +
    (LIST_SORT === "status" ? "sort-active" : "") +
    '">Status' +
    arrowFor("status") +
    "</th>" +
    '<th onclick="setListSort(&apos;requests&apos;)" class="' +
    (LIST_SORT === "requests" ? "sort-active" : "") +
    '">Total Reqs' +
    arrowFor("requests") +
    "</th>" +
    "<th>This Rotation</th>" +
    '<th onclick="setListSort(&apos;quota&apos;)" class="' +
    (LIST_SORT === "quota" ? "sort-active" : "") +
    '">Avg Quota' +
    arrowFor("quota") +
    "</th>" +
    '<th onclick="setListSort(&apos;tokens&apos;)" class="' +
    (LIST_SORT === "tokens" ? "sort-active" : "") +
    '">Tokens (in/out)' +
    arrowFor("tokens") +
    "</th>" +
    "<th>Last Used</th>" +
    "</tr></thead><tbody>";

  rows.forEach(function (a) {
    var avgQuota =
      a.quota && a.quota.length > 0
        ? Math.round(
            a.quota.reduce(function (s, q) {
              return s + q.percentRemaining;
            }, 0) / a.quota.length,
          )
        : null;
    var quotaColor =
      avgQuota === null
        ? "var(--text-dim)"
        : avgQuota > 50
          ? "var(--green)"
          : avgQuota > 20
            ? "var(--yellow)"
            : "var(--red)";

    var statusColors = {
      active: "var(--green)",
      ready: "var(--text-dim)",
      cooldown: "var(--yellow)",
      exhausted: "var(--red)",
      error: "var(--orange)",
      disabled: "#888",
      flagged: "#ff4444",
    };
    var statusColor = statusColors[a.status] || "var(--text-dim)";

    var ta = tokensByAccount[a.email] || { input: 0, output: 0 };
    var totalTokens = ta.input + ta.output;

    var lastUsed = a.lastUsed ? formatTime(a.lastUsed) : "--";

    var quotaCell =
      avgQuota === null
        ? '<span style="color:var(--text-dim)">--</span>'
        : '<div class="list-quota-bar">' +
          '<div class="list-quota-bar-bg"><div class="list-quota-bar-fill" style="width:' +
          avgQuota +
          "%;background:" +
          quotaColor +
          '"></div></div>' +
          '<span style="font-family:JetBrains Mono,monospace;font-size:11px;color:' +
          quotaColor +
          '">' +
          avgQuota +
          "%</span>" +
          "</div>";

    var tokensCell =
      totalTokens > 0
        ? '<span style="font-family:JetBrains Mono,monospace">' +
          formatTokenCount(ta.input) +
          " / " +
          formatTokenCount(ta.output) +
          "</span>"
        : '<span style="color:var(--text-dim)">--</span>';

    html +=
      '<tr class="list-row" onclick="jumpToAccount(&apos;' +
      jsString(a.email) +
      '&apos;)">' +
      "<td>" +
      '<div class="list-row-label">' +
      escapeHtml(maskText(a.label)) +
      "</div>" +
      '<div class="list-row-email">' +
      escapeHtml(maskEmail(a.email)) +
      "</div>" +
      "</td>" +
      '<td><span style="color:' +
      statusColor +
      ';font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.4px">' +
      escapeHtml(a.status) +
      "</span></td>" +
      '<td style="font-family:JetBrains Mono,monospace;font-weight:700">' +
      (a.totalRequests || 0) +
      "</td>" +
      '<td style="font-family:JetBrains Mono,monospace;color:var(--text-dim)">' +
      (a.requestsSinceRotation || 0) +
      "</td>" +
      "<td>" +
      quotaCell +
      "</td>" +
      "<td>" +
      tokensCell +
      "</td>" +
      '<td style="font-family:JetBrains Mono,monospace;font-size:11px;color:var(--text-dim)">' +
      lastUsed +
      "</td>" +
      "</tr>";
  });

  html += "</tbody></table>";
  wrap.innerHTML = html;
}

function jumpToAccount(email) {
  // Switch to grid first
  switchView("grid");
  setTimeout(function () {
    var target = Array.prototype.find.call(
      document.querySelectorAll("[data-account-email]"),
      function (element) {
        return element.getAttribute("data-account-email") === email;
      },
    );
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("list-highlight");
      setTimeout(function () {
        target.classList.remove("list-highlight");
      }, 2000);
    }
  }, 80);
}

function renderHealthPill(label, value) {
  return (
    '<div class="health-pill"><span class="label">' +
    escapeHtml(label) +
    '</span><span class="value">' +
    escapeHtml(value) +
    "</span></div>"
  );
}

function renderAttentionPanel(data) {
  var panel = document.getElementById("attentionPanel");
  var button = document.getElementById("attentionBtn");
  var badge = document.getElementById("attentionBadge");
  var accounts = data.accounts || [];
  var security = data.security || {};
  var routingDiagnostics = data.routingDiagnostics || {};
  var flagged = accounts.filter(function (a) {
    return a.status === "flagged";
  });
  var disabled = accounts.filter(function (a) {
    return a.status === "disabled";
  });
  var errors = accounts.filter(function (a) {
    return a.status === "error";
  });
  var unroutableModels = Object.keys(routingDiagnostics)
    .map(function (modelKey) {
      return routingDiagnostics[modelKey];
    })
    .filter(function (diag) {
      return diag && !diag.selectedEmail;
    });
  var tokenBucketExhausted = accounts.filter(function (a) {
    return (
      a.tokenBucket &&
      a.tokenBucket.enabled &&
      Number(a.tokenBucket.tokens || 0) < 1
    );
  });
  var cooldown = accounts
    .filter(function (a) {
      return a.status === "cooldown";
    })
    .map(function (a) {
      var ts = Object.values(a.cooldownsByModel || {});
      var max = ts.length > 0 ? Math.max.apply(null, ts) : 0;
      return { account: a, remaining: Math.max(0, max - Date.now()) };
    })
    .sort(function (a, b) {
      return a.remaining - b.remaining;
    })
    .slice(0, 4);
  var items = [];

  if (security.warning) {
    items.push(
      renderAttentionItem(
        "Security warning",
        security.warning,
        [
          "Dashboard and admin APIs require the admin token.",
          "Native and /v1 proxy routes do not require a token.",
          "For local-only usage, set bindHost to 127.0.0.1 or bind the Docker port to 127.0.0.1.",
        ],
        "warning",
      ),
    );
  }

  if (flagged.length > 0) {
    items.push(
      renderAttentionItem(
        "Flagged by provider",
        flagged.length +
          " account(s) are quarantined after a provider enforcement signal. Keep them out of rotation until the provider explicitly restores access.",
        flagged.map(function (a) {
          return maskText(a.label);
        }),
        "flagged",
      ),
    );
  }
  if (cooldown.length > 0) {
    items.push(
      renderAttentionItem(
        "Cooling down",
        "These are the next accounts expected to come back. Routing waits for their retry windows instead of forcing traffic into them.",
        cooldown.map(function (c) {
          return maskText(c.account.label) + " " + formatDuration(c.remaining);
        }),
        "cooldown",
      ),
    );
  }
  if (disabled.length > 0) {
    items.push(
      renderAttentionItem(
        "Disabled accounts",
        "These accounts hit repeated operational errors and were taken out of service. Re-enable only after the underlying problem is fixed.",
        disabled.map(function (a) {
          return maskText(a.label);
        }),
        "disabled",
      ),
    );
  }
  if (errors.length > 0) {
    items.push(
      renderAttentionItem(
        "Recent errors",
        "These accounts are still visible but currently erroring. Review the per-account error details below before they escalate to disabled.",
        errors.map(function (a) {
          return maskText(a.label);
        }),
        "error",
      ),
    );
  }
  if (unroutableModels.length > 0) {
    items.push(
      renderAttentionItem(
        "No routing candidate",
        "These models currently have no selected account. The inspector shows which checks are blocking routing right now.",
        unroutableModels.map(function (diag) {
          return diag.modelKey + ": " + (diag.reason || "No reason available");
        }),
        "warning",
      ),
    );
  }
  if (tokenBucketExhausted.length > 0) {
    items.push(
      renderAttentionItem(
        "Token bucket exhausted",
        "Hybrid routing is holding these accounts briefly to avoid hammering the provider before the local refill window resets.",
        tokenBucketExhausted.map(function (a) {
          return (
            maskText(a.label) +
            " " +
            formatDuration(a.tokenBucket.nextRefillInMs || 0)
          );
        }),
        "cooldown",
      ),
    );
  }

  var freeTierAccounts = accounts.filter(function (a) {
    return a.tier === "free" || a.tier === "unknown";
  });
  var modelTierAccess = data.modelTierAccess || null;
  if (freeTierAccounts.length > 0 && modelTierAccess) {
    var freeModels = [];
    var paidModels = [];
    Object.keys(modelTierAccess).forEach(function (model) {
      if (modelTierAccess[model] === "free") freeModels.push(model);
      else paidModels.push(model);
    });
    items.push(
      renderAttentionItem(
        "Free tier model access",
        freeTierAccounts.length +
          " account(s) are configured on the free tier (or unset). Only the ✓ models below respond on that tier; the ✗ ones return HTTP 403 \u201crequires a subscription\u201d until an account is upgraded.",
        freeModels
          .map(function (m) {
            return "\u2713 " + m;
          })
          .concat(
            paidModels.map(function (m) {
              return "\u2717 " + m;
            }),
          ),
        "info",
      ),
    );
  }

  if (items.length === 0) {
    panel.innerHTML =
      '<div class="modal-empty">No operator action items right now.</div>';
    badge.style.display = "none";
    button.classList.remove("has-items");
    return;
  }

  panel.innerHTML =
    '<div class="operator-list" style="display:flex;flex-direction:column;gap:12px;">' +
    items.join("") +
    "</div>";
  badge.style.display = "inline-flex";
  badge.textContent = String(items.length);
  button.classList.add("has-items");
}

function renderAttentionItem(title, description, tags, type) {
  var icon = "";
  var colorClass = "";

  if (type === "flagged") {
    icon =
      '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
    colorClass = "operator-red";
  } else if (type === "cooldown") {
    icon =
      '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>';
    colorClass = "operator-yellow";
  } else if (type === "disabled") {
    icon =
      '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z"/></svg>';
    colorClass = "operator-gray";
  } else if (type === "info") {
    icon =
      '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
    colorClass = "operator-green";
  } else {
    icon =
      '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';
    colorClass = "operator-orange";
  }

  var tagsHtml = tags
    .map(function (t) {
      return '<span class="operator-tag">' + escapeHtml(t) + "</span>";
    })
    .join("");

  return (
    '<div class="operator-item ' +
    colorClass +
    '">' +
    '<div class="operator-icon">' +
    icon +
    "</div>" +
    '<div class="operator-content">' +
    "<strong>" +
    escapeHtml(title) +
    "</strong>" +
    "<p>" +
    escapeHtml(description) +
    "</p>" +
    '<div class="operator-tags">' +
    tagsHtml +
    "</div>" +
    "</div>" +
    "</div>"
  );
}

var TOKEN_MODEL_COLORS = {
  // Claude Pool (Rojos) — de más caro a más barato
  "claude-opus-4-6-thinking": "#b91c1c", // Opus (Rojo intenso/oscuro)
  "claude-opus-4-5-thinking": "#b91c1c",
  "claude-opus-4-5": "#b91c1c",
  "claude-sonnet-4-6": "#ef4444", // Sonnet (Rojo vivo)
  "claude-sonnet-4-6-thinking": "#ef4444",
  "claude-sonnet-4-5": "#ef4444",
  "claude-sonnet-4-5-thinking": "#ef4444",
  "gpt-oss-120b-medium": "#f87171", // GPT-OSS Antigravity (Rojo claro/coral)
  "gpt-oss-120b": "#f87171",

  // Gemini Pool (Azules) — de más caro a más barato
  "gemini-3.1-pro": "#1d4ed8", // Gemini 3.1 Pro (Azul rey oscuro/intenso)
  "gemini-3.1-pro-high": "#1d4ed8",
  "gemini-3.1-pro-low": "#1d4ed8",
  "gemini-3-pro-high": "#1d4ed8",
  "gemini-3-pro-low": "#1d4ed8",
  "gemini-3.5-flash": "#2563eb", // Gemini 3.5 Flash (Azul rey medio)
  "gemini-3.5-flash-high": "#2563eb",
  "gemini-3.5-flash-medium": "#2563eb",
  "gemini-3.5-flash-low": "#2563eb",
  "gemini-3-flash-agent": "#2563eb",
  "gemini-3.6-flash": "#38bdf8", // Gemini 3.6 Flash (Azul cielo brillante)
  "gemini-3.6-flash-high": "#38bdf8",
  "gemini-3.6-flash-medium": "#38bdf8",
  "gemini-3.6-flash-low": "#38bdf8",
  "gemini-3.6-flash-tiered": "#38bdf8",
  "gemini-3-flash": "#93c5fd", // Gemini 3 Flash (Azul pastel claro)

  // Codex Pool (Amarillos) — de más caro a más barato
  "gpt-5.6-sol": "#a16207", // GPT-5.6 Sol (Amarillo oscuro/marrón mostaza)
  "gpt-5.6-terra": "#eab308", // GPT-5.6 Terra (Amarillo vivo)
  "gpt-5.6-luna": "#fde047", // GPT-5.6 Luna (Amarillo pastel suave)

  // Ollama Pool (Verdes) — de más caro a más barato por familia
  "kimi-k3": "#047857", // Familia Kimi (Verde bosque/esmeralda oscuro)
  "kimi-k2.7-code": "#047857",
  "kimi-k2.6": "#047857",
  "qwen3.5:397b": "#0f766e", // Familia Qwen (Verde pino/teal oscuro)
  "glm-5.2": "#10b981", // Familia GLM (Verde esmeralda)
  "glm-5.1": "#10b981",
  "nemotron-3-ultra": "#15803d", // Nemotron Super/Ultra (Verde intenso)
  "nemotron-3-super": "#15803d",
  "mistral-large-3:675b": "#22c55e", // Mistral / Nemotron Nano (Verde brillante)
  "nemotron-3-nano:30b": "#22c55e",
  "gemma4:31b": "#65a30d", // Gemma 4 (Verde oliva/lima)
  "minimax-m3": "#84cc16", // Familia MiniMax (Verde lima)
  "minimax-m2.7": "#84cc16",
  "deepseek-v4-pro": "#2dd4bf", // DeepSeek Pro (Verde menta/teal claro)
  "gpt-oss:120b": "#86efac", // GPT-OSS 120B Ollama (Verde claro)
  "deepseek-v4-flash:preview": "#5eead4", // DeepSeek Flash (Verde menta suave)
  "deepseek-v4-flash:0731": "#5eead4",
  "gpt-oss:20b": "#dcfce7", // GPT-OSS 20B Ollama (Verde pastel muy claro)

  __other__: "#10b981",
};

function getModelColor(model) {
  if (!model) return TOKEN_MODEL_COLORS["__other__"];
  if (TOKEN_MODEL_COLORS[model]) return TOKEN_MODEL_COLORS[model];

  var lower = model.toLowerCase();
  // Family fallback resolution
  // Claude pool (Rojos)
  if (lower.indexOf("opus") !== -1) return "#b91c1c";
  if (lower.indexOf("sonnet") !== -1 || lower.indexOf("claude") !== -1) return "#ef4444";
  if (lower === "gpt-oss-120b" || lower === "gpt-oss-120b-medium") return "#f87171";

  // Gemini pool (Azules)
  if (lower.indexOf("3.1-pro") !== -1 || lower.indexOf("3-pro") !== -1) return "#1d4ed8";
  if (lower.indexOf("3.5-flash") !== -1) return "#2563eb";
  if (lower.indexOf("3.6-flash") !== -1) return "#38bdf8";
  if (lower.indexOf("gemini") !== -1 || lower.indexOf("3-flash") !== -1) return "#93c5fd";

  // Codex pool (Amarillos)
  if (lower.indexOf("gpt-5.6-sol") !== -1) return "#a16207";
  if (lower.indexOf("gpt-5.6-terra") !== -1) return "#eab308";
  if (lower.indexOf("gpt-5.6-luna") !== -1) return "#fde047";

  // Ollama pool (Verdes)
  if (lower.indexOf("kimi") !== -1) return "#047857";
  if (lower.indexOf("qwen") !== -1) return "#0f766e";
  if (lower.indexOf("glm") !== -1) return "#10b981";
  if (lower.indexOf("nemotron-3-super") !== -1 || lower.indexOf("nemotron-3-ultra") !== -1) return "#15803d";
  if (lower.indexOf("mistral") !== -1 || lower.indexOf("nemotron") !== -1) return "#22c55e";
  if (lower.indexOf("gemma") !== -1) return "#65a30d";
  if (lower.indexOf("minimax") !== -1) return "#84cc16";
  if (lower.indexOf("deepseek-v4-pro") !== -1) return "#2dd4bf";
  if (lower.indexOf("deepseek") !== -1) return "#5eead4";
  if (lower.indexOf("gpt-oss:120b") !== -1) return "#86efac";
  if (lower.indexOf("gpt-oss") !== -1) return "#dcfce7";

  return "#10b981";
}

function formatTokenCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

// Pricing per 1M tokens (USD) — mirrors server-side MODEL_PRICING in types.ts
var MODEL_PRICING_CLIENT = {
  "claude-opus-4-6-thinking": { input: 5.0, output: 25.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "gemini-3.1-pro": { input: 2.0, output: 12.0 },
  "gemini-3.1-pro-low": { input: 2.0, output: 12.0 },
  "gemini-3.1-pro-high": { input: 2.0, output: 12.0 },
  "gemini-3-flash": { input: 0.5, output: 3.0 },
  "gemini-3.5-flash": { input: 1.5, output: 9.0 },
  "gemini-3.5-flash-low": { input: 1.5, output: 9.0 },
  "gemini-3.5-flash-medium": { input: 1.5, output: 9.0 },
  "gemini-3.5-flash-high": { input: 1.5, output: 9.0 },
  "gemini-3.6-flash": { input: 1.5, output: 7.5 },
  "gemini-3.6-flash-high": { input: 1.5, output: 7.5 },
  "gemini-3.6-flash-medium": { input: 1.5, output: 7.5 },
  "gemini-3.6-flash-low": { input: 1.5, output: 7.5 },
  "gemini-3.6-flash-tiered": { input: 1.5, output: 7.5 },
  "gpt-oss-120b-medium": { input: 2.0, output: 10.0 },
  // OpenAI Codex GPT-5.6 models — mirrors MODEL_PRICING in types.ts.
  "gpt-5.6-sol": { input: 5.0, output: 30.0 },
  "gpt-5.6-terra": { input: 2.0, output: 12.0 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  // Ollama Cloud models — mirrors MODEL_PRICING in src/types.ts
  "gpt-oss:20b": { input: 0.075, output: 0.3 },
  "gpt-oss:120b": { input: 0.15, output: 0.6 },
  "deepseek-v4-flash:preview": { input: 0.14, output: 0.28 },
  "deepseek-v4-flash:0731": { input: 0.14, output: 0.28 },
  "deepseek-v4-pro": { input: 0.435, output: 0.87 },
  "qwen3.5:397b": { input: 0.6, output: 3.6 },
  "glm-5.1": { input: 0.8, output: 2.56 },
  "glm-5.2": { input: 0.8, output: 2.56 },
  "gemma4:31b": { input: 0.38, output: 1.15 },
  "kimi-k2.6": { input: 0.95, output: 4.0 },
  "kimi-k2.7-code": { input: 0.95, output: 4.0 },
  "kimi-k3": { input: 0.95, output: 4.0 },
  "minimax-m2.7": { input: 0.3, output: 1.2 },
  "minimax-m3": { input: 0.3, output: 1.2 },
  "mistral-large-3:675b": { input: 0.5, output: 1.5 },
  "nemotron-3-nano:30b": { input: 0.5, output: 1.5 },
  "nemotron-3-super": { input: 0.6, output: 1.8 },
  "nemotron-3-ultra": { input: 0.6, output: 1.8 },
  // OpenCode Zen free models — mirrors MODEL_PRICING in src/types.ts
  "deepseek-v4-flash-free": { input: 0.14, output: 0.28 },
  "nemotron-3.5-lightning-free": { input: 0.35, output: 1.05 },
  "nemotron-3-ultra-free": { input: 0.6, output: 1.8 },
  "mimo-v2.5-free": { input: 0.15, output: 0.6 },
  "hy3-free": { input: 0.25, output: 1.0 },
  "ling-3.0-tiny-free": { input: 0.05, output: 0.2 },
  "laguna-s-2.1-free": { input: 0.2, output: 0.8 },
};

function getModelPricingClient(m) {
  if (MODEL_PRICING_CLIENT[m]) return MODEL_PRICING_CLIENT[m];
  var lower = (m || "").toLowerCase();
  if (lower.indexOf("opus") !== -1) return MODEL_PRICING_CLIENT["claude-opus-4-6-thinking"];
  if (lower.indexOf("sonnet") !== -1) return MODEL_PRICING_CLIENT["claude-sonnet-4-6"];
  if (lower.indexOf("3.6-flash") !== -1) return MODEL_PRICING_CLIENT["gemini-3.6-flash-high"];
  if (lower.indexOf("3.5-flash") !== -1) return MODEL_PRICING_CLIENT["gemini-3.5-flash-high"];
  if (lower.indexOf("flash") !== -1) return MODEL_PRICING_CLIENT["gemini-3-flash"];
  if (lower.indexOf("pro") !== -1) return MODEL_PRICING_CLIENT["gemini-3.1-pro"];
  return null;
}

function calcSavingsFromBuckets(buckets) {
  var byModel = {};
  var totalUsd = 0;
  (buckets || []).forEach(function (b) {
    Object.keys(b.byModel || {}).forEach(function (m) {
      var d = b.byModel[m];
      var p = getModelPricingClient(m);
      if (!p) return;
      var usd =
        (d.inputTokens / 1e6) * p.input + (d.outputTokens / 1e6) * p.output;
      if (!byModel[m]) byModel[m] = { inputUsd: 0, outputUsd: 0, totalUsd: 0 };
      byModel[m].inputUsd += (d.inputTokens / 1e6) * p.input;
      byModel[m].outputUsd += (d.outputTokens / 1e6) * p.output;
      byModel[m].totalUsd += usd;
      totalUsd += usd;
    });
  });
  return { totalUsd: totalUsd, byModel: byModel };
}

function formatSavingsUsd(usd) {
  if (!(usd > 0)) return "";
  if (usd >= 0.01) return usd.toFixed(2);
  if (usd >= 0.0001) return usd.toFixed(4);
  if (usd >= 0.000001) return usd.toFixed(6);
  return usd.toFixed(8);
}

function formatModelSavingsLabel(modelSavings) {
  if (!modelSavings || !(modelSavings.totalUsd > 0)) return "";
  return (
    ' <span style="color:var(--green)">$' +
    formatSavingsUsd(modelSavings.totalUsd) +
    "</span>"
  );
}

window.__tokenView = "1h";

function exportData(format) {
  if (!window.__lastData || !window.__lastData.tokenUsage) return;
  var usage = window.__lastData.tokenUsage;

  if (format === "json") {
    var dataStr =
      "data:text/json;charset=utf-8," +
      encodeURIComponent(JSON.stringify(usage, null, 2));
    var a = document.createElement("a");
    a.href = dataStr;
    a.download = "rotator-token-usage.json";
    a.click();
  } else if (format === "csv") {
    var csv = "Tier,Period,Model,InputTokens,OutputTokens,Requests\n";
    ["months", "days", "hours", "minutes"].forEach(function (tier) {
      (usage[tier] || []).forEach(function (b) {
        if (!b.byModel) return;
        Object.keys(b.byModel).forEach(function (m) {
          var d = b.byModel[m];
          csv +=
            tier +
            "," +
            b.period +
            "," +
            m +
            "," +
            d.inputTokens +
            "," +
            d.outputTokens +
            "," +
            d.requests +
            "\n";
        });
      });
    });
    var dataStrCSV = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    var a2 = document.createElement("a");
    a2.href = dataStrCSV;
    a2.download = "rotator-token-usage.csv";
    a2.click();
  }
}

function setTokenView(view) {
  window.__tokenView = view;
  refresh();
}

function formatBucketLabel(period, view) {
  try {
    if (view.endsWith("h") && view !== "1d") {
      var d;
      if (period.length === 16) d = new Date(period + ":00Z");
      else d = new Date(period);
      if (!isNaN(d.getTime())) {
        if (view === "1h") return ":" + String(d.getMinutes()).padStart(2, "0");
        return (
          String(d.getHours()).padStart(2, "0") +
          ":" +
          String(d.getMinutes()).padStart(2, "0")
        );
      }
    }
    if (view === "1d") return period.slice(11, 13) + "h";
    if (view === "7d" || view === "1m") return period.slice(5, 10);
  } catch (e) {}
  return period;
}

function renderTokenChart(tokenUsage) {
  var panel = document.getElementById("tokenUsagePanel");
  var chart = document.getElementById("tokenChart");
  var legend = document.getElementById("tokenLegend");
  var totals = document.getElementById("tokenTotals");
  var view = window.__tokenView || "1h";

  // Highlight active button
  ["1h", "2h", "4h", "8h", "12h", "1d", "7d", "1m"].forEach(function (v) {
    var btn = document.getElementById("tbtn-" + v);
    if (btn)
      btn.className = "btn-secondary btn-sm" + (v === view ? " active" : "");
  });

  if (!tokenUsage) {
    panel.style.display = "none";
    return;
  }

  // Helper: merge buckets into a map by a grouping key
  function mergeBucketsBy(sources, keyFn, limit) {
    var map = {};
    sources.forEach(function (b) {
      var key = keyFn(b.period);
      if (!key) return;
      if (!map[key])
        map[key] = {
          period: key,
          inputTokens: 0,
          outputTokens: 0,
          requests: 0,
          byModel: {},
        };
      map[key].inputTokens += b.inputTokens;
      map[key].outputTokens += b.outputTokens;
      map[key].requests += b.requests;
      Object.keys(b.byModel || {}).forEach(function (m) {
        if (!map[key].byModel[m])
          map[key].byModel[m] = {
            inputTokens: 0,
            outputTokens: 0,
            requests: 0,
          };
        map[key].byModel[m].inputTokens +=
          (b.byModel[m] || {}).inputTokens || 0;
        map[key].byModel[m].outputTokens +=
          (b.byModel[m] || {}).outputTokens || 0;
        map[key].byModel[m].requests += (b.byModel[m] || {}).requests || 0;
      });
    });
    return Object.keys(map)
      .sort()
      .map(function (k) {
        return map[k];
      })
      .slice(-limit);
  }

  function getLocalKey(periodStr, type) {
    try {
      var d;
      if (periodStr.length === 10) d = new Date(periodStr + "T00:00:00Z");
      else if (periodStr.length === 13) d = new Date(periodStr + ":00:00Z");
      else if (periodStr.length === 16) d = new Date(periodStr + ":00Z");
      else d = new Date(periodStr);
      if (isNaN(d.getTime())) return periodStr;

      var y = d.getFullYear();
      var mo = String(d.getMonth() + 1).padStart(2, "0");
      var da = String(d.getDate()).padStart(2, "0");
      var h = String(d.getHours()).padStart(2, "0");
      var mi = d.getMinutes();

      if (type === "day") return y + "-" + mo + "-" + da;
      if (type === "hour") return y + "-" + mo + "-" + da + "T" + h;
      if (type === "5min")
        return (
          y +
          "-" +
          mo +
          "-" +
          da +
          "T" +
          h +
          ":" +
          String(Math.floor(mi / 5) * 5).padStart(2, "0")
        );
      if (type === "4min")
        return (
          y +
          "-" +
          mo +
          "-" +
          da +
          "T" +
          h +
          ":" +
          String(Math.floor(mi / 4) * 4).padStart(2, "0")
        );
      if (type === "2min")
        return (
          y +
          "-" +
          mo +
          "-" +
          da +
          "T" +
          h +
          ":" +
          String(Math.floor(mi / 2) * 2).padStart(2, "0")
        );
    } catch (e) {}
    return periodStr;
  }

  // Pad buckets with zeroes up to current time.
  // keyFn: optional function(isoString) -> key used for the fill loop.
  //        When provided, dataMap is keyed by b.period directly (already normalized).
  //        When omitted, type determines both the dataMap key and the fill key.
  function padBuckets(data, view, keyFn) {
    if (!data) data = [];
    var now = new Date();
    var stepMs = 60000;
    var count = 60;
    var type = "raw";

    if (view === "1h") {
      stepMs = 60000;
      count = 60;
    } else if (view === "2h") {
      stepMs = 60000;
      count = 120;
    } else if (view === "4h") {
      stepMs = 120000;
      count = 120;
      type = "2min";
    } else if (view === "8h") {
      stepMs = 240000;
      count = 120;
      type = "4min";
    } else if (view === "12h") {
      stepMs = 300000;
      count = 144;
      type = "5min";
    } else if (view === "1d") {
      stepMs = 3600000;
      count = 24;
      type = "hour";
    } else if (view === "7d") {
      stepMs = 86400000;
      count = 7;
      type = "day";
    } else {
      stepMs = 86400000;
      count = 30;
      type = "day";
    }

    var dataMap = {};
    if (keyFn) {
      // Data already normalized by mergeBucketsBy — use period as-is
      data.forEach(function (b) {
        dataMap[b.period] = b;
      });
    } else {
      data.forEach(function (b) {
        var k = type === "raw" ? b.period : getLocalKey(b.period, type);
        dataMap[k] = b;
      });
    }

    var result = [];
    for (var i = count - 1; i >= 0; i--) {
      var d = new Date(now.getTime() - i * stepMs);
      var k = keyFn
        ? keyFn(d.toISOString())
        : type === "raw"
          ? d.toISOString().slice(0, 16)
          : getLocalKey(d.toISOString(), type);
      result.push(
        dataMap[k] || {
          period: k,
          inputTokens: 0,
          outputTokens: 0,
          requests: 0,
          byModel: {},
        },
      );
    }
    return result;
  }

  var allTiers = (tokenUsage.months || [])
    .concat(tokenUsage.days || [])
    .concat(tokenUsage.hours || [])
    .concat(tokenUsage.minutes || []);

  // Pick tier based on view
  var buckets;
  if (view === "1h") {
    buckets = padBuckets(tokenUsage.minutes || [], view);
  } else if (view === "2h") {
    buckets = padBuckets(tokenUsage.minutes || [], view);
  } else if (view === "4h") {
    var src4h = (tokenUsage.hours || []).concat(tokenUsage.minutes || []);
    var kfn4h = function (p) {
      return getLocalKey(p, "2min");
    };
    buckets = padBuckets(mergeBucketsBy(src4h, kfn4h, 120), view, kfn4h);
  } else if (view === "8h") {
    var src8h = (tokenUsage.hours || []).concat(tokenUsage.minutes || []);
    var kfn8h = function (p) {
      return getLocalKey(p, "4min");
    };
    buckets = padBuckets(mergeBucketsBy(src8h, kfn8h, 120), view, kfn8h);
  } else if (view === "12h") {
    var src12h = (tokenUsage.hours || []).concat(tokenUsage.minutes || []);
    var kfn12h = function (p) {
      return getLocalKey(p, "5min");
    };
    buckets = padBuckets(mergeBucketsBy(src12h, kfn12h, 144), view, kfn12h);
  } else if (view === "1d") {
    var kfn1d = function (p) {
      return getLocalKey(p, "hour");
    };
    buckets = padBuckets(
      mergeBucketsBy(
        (tokenUsage.hours || []).concat(tokenUsage.minutes || []),
        kfn1d,
        24,
      ),
      view,
      kfn1d,
    );
  } else if (view === "7d") {
    buckets = padBuckets(
      mergeBucketsBy(
        allTiers,
        function (p) {
          return getLocalKey(p, "day");
        },
        7,
      ),
      view,
    );
  } else {
    buckets = padBuckets(
      mergeBucketsBy(
        allTiers,
        function (p) {
          return getLocalKey(p, "day");
        },
        30,
      ),
      view,
    );
  }

  if (!buckets || buckets.length === 0) {
    chart.innerHTML =
      '<div style="color:var(--text-dim);padding:20px;text-align:center">No data for this range yet</div>';
    totals.innerHTML = "";
    legend.innerHTML = "";
    return;
  }
  panel.style.display = "";

  // Collect all models
  var allModels = {};
  buckets.forEach(function (b) {
    Object.keys(b.byModel || {}).forEach(function (m) {
      allModels[m] = true;
    });
  });
  var models = Object.keys(allModels).sort();

  // Max tokens for Y scale
  var maxTokens = 0;
  buckets.forEach(function (b) {
    var total = b.inputTokens + b.outputTokens;
    if (total > maxTokens) maxTokens = total;
  });
  if (maxTokens === 0) maxTokens = 1;

  var chartWidth = chart.clientWidth || 800;
  var minSvgWidth = buckets.length * 16 + 40;
  var svgWidth = Math.max(chartWidth, minSvgWidth);
  var availableWidth = svgWidth - 50;
  var step = availableWidth / Math.max(1, buckets.length);
  var barWidth = Math.min(36, step * 0.8);
  var chartHeight = 140;

  var bars = "";
  buckets.forEach(function (b, i) {
    var x = 40 + i * step + (step - barWidth) / 2;

    // Stack by model
    var yOffset = chartHeight;
    models.forEach(function (model) {
      var md = (b.byModel || {})[model];
      if (!md) return;
      var modelTokens = md.inputTokens + md.outputTokens;
      var segHeight = Math.max(
        0,
        (modelTokens / maxTokens) * (chartHeight - 20),
      );
      yOffset -= segHeight;
      bars +=
        '<rect x="' +
        x +
        '" y="' +
        yOffset +
        '" width="' +
        barWidth +
        '" height="' +
        segHeight +
        '" fill="' +
        getModelColor(model) +
        '" rx="2" opacity="0.85"><title>' +
        escapeHtml(model) +
        ": " +
        formatTokenCount(modelTokens) +
        " tokens (" +
        (md.requests || 0) +
        " reqs)</title></rect>";
    });

    // X-axis label
    var lbl = formatBucketLabel(b.period, view);
    bars +=
      '<text x="' +
      (x + barWidth / 2) +
      '" y="' +
      (chartHeight + 14) +
      '" text-anchor="middle" fill="#888" font-size="9" font-family="JetBrains Mono,monospace">' +
      escapeHtml(lbl) +
      "</text>";
  });

  // Y-axis
  var yLabels = "";
  for (var yi = 0; yi <= 3; yi++) {
    var yVal = (maxTokens / 3) * yi;
    var yPos = chartHeight - ((chartHeight - 20) / 3) * yi;
    yLabels +=
      '<text x="36" y="' +
      (yPos + 3) +
      '" text-anchor="end" fill="#666" font-size="9" font-family="JetBrains Mono,monospace">' +
      formatTokenCount(Math.round(yVal)) +
      "</text>";
    yLabels +=
      '<line x1="38" y1="' +
      yPos +
      '" x2="' +
      svgWidth +
      '" y2="' +
      yPos +
      '" stroke="#333" stroke-dasharray="2,4"/>';
  }

  chart.innerHTML =
    '<svg width="' +
    svgWidth +
    '" height="' +
    (chartHeight + 20) +
    '" style="min-width:100%">' +
    yLabels +
    bars +
    "</svg>";

  var savings = calcSavingsFromBuckets(buckets);
  var savingsText =
    savings.totalUsd > 0
      ? ' · <span style="color:var(--green);font-weight:700">Savings: $' +
        savings.totalUsd.toFixed(2) +
        "</span>"
      : "";

  totals.innerHTML =
    "In: " +
    formatTokenCount(tokenUsage.totalInputTokens) +
    " · Out: " +
    formatTokenCount(tokenUsage.totalOutputTokens) +
    " · Reqs: " +
    tokenUsage.totalRequests +
    savingsText;

  legend.innerHTML = models
    .map(function (m) {
      var modelSavings = (savings.byModel || {})[m];
      var savingsLabel = formatModelSavingsLabel(modelSavings);
      return (
        '<div style="display:flex;align-items:center;gap:4px">' +
        '<div style="width:10px;height:10px;border-radius:2px;background:' +
        getModelColor(m) +
        '"></div>' +
        '<span style="color:var(--text-dim)">' +
        escapeHtml(m) +
        savingsLabel +
        "</span></div>"
      );
    })
    .join("");
}

function formatMs(ms) {
  if (ms >= 60000) return (ms / 60000).toFixed(1) + "m";
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
  return ms + "ms";
}

function renderHeatmap(tokenUsage) {
  var panel = document.getElementById("heatmapPanel");
  var grid = document.getElementById("heatmapGrid");
  if (!tokenUsage) {
    panel.style.display = "none";
    return;
  }

  var hours = tokenUsage.hours || [];
  var minutes = tokenUsage.minutes || [];
  var now = new Date();
  var daysCount = 60;
  var days = [];
  for (var i = daysCount - 1; i >= 0; i--) {
    var d = new Date(now);
    d.setDate(now.getDate() - i);
    var key =
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0");
    // show label only for every 7th day to avoid crowding
    days.push({ key: key, label: i % 7 === 0 ? key.slice(5) : "" });
  }

  var cellMap = {}; // day|hour -> requests
  function addBucket(dayKey, hour, reqs) {
    var k = dayKey + "|" + hour;
    if (!cellMap[k]) cellMap[k] = 0;
    cellMap[k] += reqs || 0;
  }

  function parseLocal(periodStr) {
    var d;
    if (periodStr.length === 10) d = new Date(periodStr + "T00:00:00Z");
    else if (periodStr.length === 13) d = new Date(periodStr + ":00:00Z");
    else if (periodStr.length === 16) d = new Date(periodStr + ":00Z");
    else d = new Date(periodStr);

    if (isNaN(d.getTime())) return null;
    return {
      dayKey:
        d.getFullYear() +
        "-" +
        String(d.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(d.getDate()).padStart(2, "0"),
      hour: d.getHours(),
    };
  }

  hours.forEach(function (b) {
    if (!b.period) return;
    var loc = parseLocal(b.period);
    if (loc) addBucket(loc.dayKey, loc.hour, b.requests);
  });

  minutes.forEach(function (b) {
    if (!b.period) return;
    var loc = parseLocal(b.period);
    if (loc) addBucket(loc.dayKey, loc.hour, b.requests);
  });

  var max = 0;
  for (var h = 0; h < 24; h++) {
    for (var c = 0; c < days.length; c++) {
      var v = cellMap[days[c].key + "|" + h] || 0;
      if (v > max) max = v;
    }
  }

  function colorFor(v) {
    if (v <= 0 || max <= 0) return "rgba(255,255,255,0.05)";
    var t = v / max;
    if (t < 0.2) return "rgba(56,189,248,0.25)";
    if (t < 0.4) return "rgba(56,189,248,0.40)";
    if (t < 0.6) return "rgba(56,189,248,0.55)";
    if (t < 0.8) return "rgba(56,189,248,0.72)";
    return "rgba(56,189,248,0.92)";
  }

  var html =
    '<div style="overflow-x:auto"><table style="width:100%;min-width:800px;border-collapse:separate;border-spacing:2px;table-layout:fixed;font-family:JetBrains Mono,monospace;font-size:0.6rem">';
  html +=
    '<tr><th style="color:var(--text-dim);padding-right:6px;width:20px">h</th>';
  days.forEach(function (d) {
    html +=
      '<th style="color:var(--text-dim);font-weight:500;text-align:left;white-space:nowrap;overflow:visible">' +
      escapeHtml(d.label) +
      "</th>";
  });
  html += "</tr>";

  for (var hour = 0; hour < 24; hour++) {
    html +=
      '<tr><td style="color:var(--text-dim);padding-right:6px;text-align:right">' +
      String(hour).padStart(2, "0") +
      "</td>";
    for (var j = 0; j < days.length; j++) {
      var day = days[j].key;
      var val = cellMap[day + "|" + hour] || 0;
      html +=
        '<td title="' +
        escapeHtml(day) +
        " " +
        String(hour).padStart(2, "0") +
        ":00 · " +
        escapeHtml(val) +
        ' req" style="height:14px;border-radius:2px;background:' +
        colorFor(val) +
        ';border:1px solid rgba(255,255,255,0.05)"></td>';
    }
    html += "</tr>";
  }

  html += "</table></div>";
  grid.innerHTML = html;
  panel.style.display = "";
}

function renderForecastPanel(data) {
  var panel = document.getElementById("forecastPanel");
  var grid = document.getElementById("forecastGrid");
  var accounts = data.accounts || [];
  var tokenUsage = data.tokenUsage || {};

  // Helper to get capacity weight by tier (empirical request capacity per 100% window)
  function getTierCapacity(tier) {
    switch (tier) {
      case "ultra":
        return 2000;
      case "pro":
        return 1500;
      case "plus":
        return 1000;
      case "free":
        return 250;
      default:
        return 250; // unknown
    }
  }

  // Aggregate quota per model across all healthy accounts
  var modelQuota = {}; // { modelKey: { totalCapacityRemaining, totalCapacityMax, accountCount, entries[] } }
  accounts.forEach(function (a) {
    if (a.status === "flagged" || a.status === "disabled") return;
    var tierCapacity = getTierCapacity(a.tier);
    (a.quota || []).forEach(function (q) {
      if (!modelQuota[q.modelKey]) {
        modelQuota[q.modelKey] = {
          totalCapacityRemaining: 0,
          totalCapacityMax: 0,
          accountCount: 0,
          entries: [],
        };
      }
      modelQuota[q.modelKey].totalCapacityRemaining +=
        (q.percentRemaining / 100) * tierCapacity;
      modelQuota[q.modelKey].totalCapacityMax += tierCapacity;
      modelQuota[q.modelKey].accountCount += 1;
      modelQuota[q.modelKey].entries.push(q);
    });
  });

  // Calculate burn rate per model from last hour of token usage
  var minutes = tokenUsage.minutes || [];
  var now = Date.now();
  var oneHourAgo = now - 3600000;
  function parsePeriodUtc(p) {
    if (!p) return 0;
    var str = String(p);
    if (str.length === 16) return new Date(str + ":00Z").getTime();
    if (str.length === 13) return new Date(str + ":00:00Z").getTime();
    if (str.length === 10) return new Date(str + "T00:00:00Z").getTime();
    return new Date(str).getTime();
  }

  var recentMinutes = minutes.filter(function (b) {
    try {
      var t = parsePeriodUtc(b.period);
      return t > 0 && t > oneHourAgo;
    } catch (e) {
      return false;
    }
  });
  var burnByModel = {}; // requests per hour
  recentMinutes.forEach(function (b) {
    Object.keys(b.byModel || {}).forEach(function (m) {
      if (!burnByModel[m]) burnByModel[m] = 0;
      burnByModel[m] += (b.byModel[m] || {}).requests || 0;
    });
  });
  // Scale to per-hour if we have less than 60 min of data
  var minuteSpan = recentMinutes.length || 1;
  Object.keys(burnByModel).forEach(function (m) {
    burnByModel[m] = (burnByModel[m] / minuteSpan) * 60; // reqs/hour
  });

  // Collapse display model burn rates into quota pool keys for forecast
  function resolveQuotaPoolKey(displayKey) {
    var lower = String(displayKey).toLowerCase();
    if (lower.indexOf("gemini-3.6-flash") !== -1) return "gemini-3.6-flash";
    if (lower.indexOf("gemini-3.5-flash") !== -1 || lower === "gemini-3-flash") return "gemini-3.5-flash";
    if (lower.indexOf("gemini-3.1-pro") !== -1 || lower.indexOf("gemini-pro") !== -1) return "gemini-3.1-pro";
    if (lower.indexOf("claude") !== -1 || lower.indexOf("gpt-oss") !== -1) return "claude-opus-4-6-thinking";
    return displayKey;
  }

  var burnByPool = {};
  Object.keys(burnByModel).forEach(function (displayKey) {
    var poolKey = resolveQuotaPoolKey(displayKey);
    if (!burnByPool[poolKey]) burnByPool[poolKey] = 0;
    burnByPool[poolKey] += burnByModel[displayKey];
  });

  var models = Object.keys(modelQuota).sort();
  if (models.length === 0) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "";

  var html =
    '<table style="width:100%;border-collapse:collapse;font-family:JetBrains Mono,monospace;font-size:0.8rem">' +
    '<tr style="color:var(--text-dim);text-align:left">' +
    '<th style="padding:4px 8px">Model</th>' +
    '<th style="padding:4px 8px">Pool Quota</th>' +
    '<th style="padding:4px 8px">Accounts</th>' +
    '<th style="padding:4px 8px">Burn Rate</th>' +
    '<th style="padding:4px 8px">Estimate</th>' +
    '<th style="padding:4px 8px">Next Reset</th>' +
    "</tr>";

  models.forEach(function (m) {
    var q = modelQuota[m];
    var avgQuota =
      q.totalCapacityMax > 0
        ? Math.round((q.totalCapacityRemaining / q.totalCapacityMax) * 100)
        : 0;
    var color = getModelColor(m);
    var rate = burnByPool[m] || 0;
    var rateLabel = rate > 0 ? rate.toFixed(1) + " req/h" : "idle";
    var displayName = m;
    if (m === "claude-opus-4-6-thinking") displayName = "claude";
    if (m === "gemini-3.1-pro") displayName = "gemini-3.1-pro";
    if (m === "gemini-3.5-flash") displayName = "gemini-3.5-flash";

    var minResetRemaining = null;
    q.entries.forEach(function (entry) {
      if (entry.resetTime && entry.timerType !== "fresh") {
        var remaining = new Date(entry.resetTime).getTime() - now;
        if (remaining > 0) {
          var isRolling5h =
            entry.percentRemaining === 100 &&
            Math.abs(remaining - 5 * 3600000) < 600000;
          var isRolling7d =
            entry.percentRemaining === 100 &&
            Math.abs(remaining - 7 * 86400000) < 600000;
          if (!isRolling5h && !isRolling7d) {
            if (minResetRemaining === null || remaining < minResetRemaining) {
              minResetRemaining = remaining;
            }
          }
        }
      }
    });
    var nextResetLabel =
      minResetRemaining !== null ? formatDuration(minResetRemaining) : "--";

    // Estimate: request capacity is weighted by tier capacity
    var totalCapacity = q.totalCapacityRemaining;
    var hoursLeft;
    var estimateLabel;
    var estimateColor = "var(--text)";
    if (rate <= 0) {
      estimateLabel = "∞";
      estimateColor = "var(--green)";
    } else {
      hoursLeft = totalCapacity / rate;
      if (hoursLeft > 24) {
        estimateLabel = (hoursLeft / 24).toFixed(1) + "d";
        estimateColor = "var(--green)";
      } else if (hoursLeft > 1) {
        estimateLabel = hoursLeft.toFixed(1) + "h";
        estimateColor = hoursLeft < 3 ? "var(--yellow)" : "var(--text)";
      } else {
        estimateLabel = Math.round(hoursLeft * 60) + "min";
        estimateColor = "var(--red)";
      }
    }

    // Quota bar
    var barColor =
      avgQuota > 50
        ? "var(--green)"
        : avgQuota > 20
          ? "var(--yellow)"
          : "var(--red)";
    var bar =
      '<div style="display:flex;align-items:center;gap:6px">' +
      '<div style="flex:1;height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden">' +
      '<div style="width:' +
      avgQuota +
      "%;height:100%;background:" +
      barColor +
      ';border-radius:3px"></div>' +
      "</div>" +
      "<span>" +
      avgQuota +
      "%</span></div>";

    html +=
      '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:4px 8px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' +
      color +
      ';margin-right:6px"></span>' +
      escapeHtml(displayName) +
      "</td>" +
      '<td style="padding:4px 8px;min-width:120px">' +
      bar +
      "</td>" +
      '<td style="padding:4px 8px;text-align:center">' +
      q.accountCount +
      "</td>" +
      '<td style="padding:4px 8px">' +
      rateLabel +
      "</td>" +
      '<td style="padding:4px 8px;color:' +
      estimateColor +
      ';font-weight:700">' +
      estimateLabel +
      "</td>" +
      '<td style="padding:4px 8px;color:var(--text-dim)">' +
      nextResetLabel +
      "</td>" +
      "</tr>";
  });

  html += "</table>";
  grid.innerHTML = html;
}

function renderLatencyPanel(latencyStats) {
  var panel = document.getElementById("latencyPanel");
  var grid = document.getElementById("latencyGrid");
  if (!latencyStats || Object.keys(latencyStats).length === 0) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "";

  var models = Object.keys(latencyStats).sort();
  var html =
    '<table style="width:100%;border-collapse:collapse;font-family:JetBrains Mono,monospace;font-size:0.8rem">' +
    '<tr style="color:var(--text-dim);text-align:left">' +
    '<th style="padding:4px 8px">Model</th>' +
    '<th style="padding:4px 8px">TTFB p50</th>' +
    '<th style="padding:4px 8px">TTFB p95</th>' +
    '<th style="padding:4px 8px">Total p50</th>' +
    '<th style="padding:4px 8px">Total p95</th>' +
    '<th style="padding:4px 8px">Samples</th>' +
    "</tr>";

  models.forEach(function (m) {
    var s = latencyStats[m];
    var color = getModelColor(m);
    html +=
      '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:4px 8px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' +
      color +
      ';margin-right:6px"></span>' +
      escapeHtml(m) +
      "</td>" +
      '<td style="padding:4px 8px">' +
      formatMs(s.ttfb.p50) +
      "</td>" +
      '<td style="padding:4px 8px;color:' +
      (s.ttfb.p95 > 10000 ? "var(--yellow)" : "var(--text)") +
      '">' +
      formatMs(s.ttfb.p95) +
      "</td>" +
      '<td style="padding:4px 8px">' +
      formatMs(s.total.p50) +
      "</td>" +
      '<td style="padding:4px 8px;color:' +
      (s.total.p95 > 30000 ? "var(--yellow)" : "var(--text)") +
      '">' +
      formatMs(s.total.p95) +
      "</td>" +
      '<td style="padding:4px 8px;color:var(--text-dim)">' +
      s.count +
      "</td>" +
      "</tr>";
  });

  html += "</table>";
  grid.innerHTML = html;
}

function renderRequestLog(log) {
  var panel = document.getElementById("requestLogPanel");
  var grid = document.getElementById("requestLogGrid");
  if (!log || log.length === 0) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "";

  var fModel = (
    document.getElementById("logFilterModel").value || ""
  ).toLowerCase();
  var fAccount = (
    document.getElementById("logFilterAccount").value || ""
  ).toLowerCase();
  var fStatus = (document.getElementById("logFilterStatus").value || "").trim();

  var filtered = log.filter(function (r) {
    if (fModel && r.model.toLowerCase().indexOf(fModel) === -1) return false;
    if (fAccount && r.account.toLowerCase().indexOf(fAccount) === -1)
      return false;
    if (fStatus && String(r.statusCode).indexOf(fStatus) === -1) return false;
    return true;
  });

  var html =
    '<table style="width:100%;border-collapse:collapse;font-family:JetBrains Mono,monospace;font-size:0.75rem">' +
    '<tr style="color:var(--text-dim);text-align:left;position:sticky;top:0;background:var(--card-bg)">' +
    '<th style="padding:3px 6px">Time</th>' +
    '<th style="padding:3px 6px">Model</th>' +
    '<th style="padding:3px 6px">Account</th>' +
    '<th style="padding:3px 6px">Status</th>' +
    '<th style="padding:3px 6px">TTFB</th>' +
    '<th style="padding:3px 6px">Total</th>' +
    '<th style="padding:3px 6px">Tokens</th>' +
    "</tr>";

  filtered.forEach(function (r) {
    var t = new Date(r.timestamp);
    var time =
      ("0" + t.getHours()).slice(-2) +
      ":" +
      ("0" + t.getMinutes()).slice(-2) +
      ":" +
      ("0" + t.getSeconds()).slice(-2);
    var statusColor =
      r.statusCode === 200
        ? "var(--green)"
        : r.statusCode === 429
          ? "var(--yellow)"
          : "var(--red)";
    var color = getModelColor(r.model);
    var tokens =
      r.inputTokens || r.outputTokens
        ? formatTokenCount(r.inputTokens) +
          "/" +
          formatTokenCount(r.outputTokens)
        : "-";
    html +=
      '<tr style="border-top:1px solid var(--border)">' +
      '<td style="padding:3px 6px;color:var(--text-dim)">' +
      time +
      "</td>" +
      '<td style="padding:3px 6px"><span style="display:inline-block;width:6px;height:6px;border-radius:2px;background:' +
      color +
      ';margin-right:4px"></span>' +
      escapeHtml(r.model) +
      "</td>" +
      '<td style="padding:3px 6px">' +
      (MASK_MODE ? "***" : escapeHtml(r.account)) +
      "</td>" +
      '<td style="padding:3px 6px;color:' +
      statusColor +
      ';font-weight:700">' +
      escapeHtml(r.statusCode) +
      "</td>" +
      '<td style="padding:3px 6px">' +
      formatMs(r.ttfbMs) +
      "</td>" +
      '<td style="padding:3px 6px">' +
      formatMs(r.totalMs) +
      "</td>" +
      '<td style="padding:3px 6px">' +
      escapeHtml(tokens) +
      "</td>" +
      "</tr>";
  });

  html += "</table>";
  if (filtered.length === 0)
    html =
      '<div style="color:var(--text-dim);text-align:center;padding:12px">No matching requests</div>';
  grid.innerHTML = html;
}

// Wire up filter inputs to re-render
(function () {
  ["logFilterModel", "logFilterAccount", "logFilterStatus"].forEach(
    function (id) {
      var el = document.getElementById(id);
      if (el)
        el.addEventListener("input", function () {
          if (window.__lastData) renderRequestLog(window.__lastData.requestLog);
        });
    },
  );
})();

function maskEventMessage(msg) {
  if (!MASK_MODE) return escapeHtml(msg);
  var out = msg;
  if (window.__lastData && window.__lastData.accounts) {
    window.__lastData.accounts.forEach(function (a) {
      if (a.label && out.indexOf(a.label) !== -1) {
        out = out.split(a.label).join("***");
      }
      if (a.email && out.indexOf(a.email) !== -1) {
        out = out.split(a.email).join("***");
      }
    });
  }
  return escapeHtml(out);
}

function renderRecentEvents(events) {
  var panel = document.getElementById("recentEventsPanel");
  var allEvents = events || [];
  if (allEvents.length === 0) {
    panel.style.display = "none";
    panel.innerHTML = "";
    return;
  }

  var list = allEvents.filter(matchesEventFilter).slice(0, 14);
  var toolbar =
    '<div class="events-toolbar">' +
    renderEventFilterButton("all", "All") +
    renderEventFilterButton("errors", "Errors Only") +
    renderEventFilterButton("proxy", "Proxy Only") +
    renderEventFilterButton("rotator", "Rotator Only") +
    "</div>";
  var rows = list
    .map(function (event) {
      var eventLevel = ["info", "warn", "error"].includes(event.level)
        ? event.level
        : "info";
      var eventSource = ["rotator", "proxy"].includes(event.source)
        ? event.source
        : "unknown";
      return (
        '<div class="event-item level-' +
        eventLevel +
        '">' +
        '<div class="event-time">' +
        formatTime(event.timestamp) +
        "</div>" +
        '<div class="event-source ' +
        eventSource +
        '">' +
        escapeHtml(eventSource) +
        "</div>" +
        '<div class="event-message">' +
        maskEventMessage(event.message) +
        "</div>" +
        "</div>"
      );
    })
    .join("");

  panel.style.display = "block";
  panel.innerHTML =
    '<div class="operator-title">Recent Events</div>' +
    toolbar +
    (rows
      ? '<div class="events-list">' + rows + "</div>"
      : '<div class="events-empty">No events match the current filter.</div>');
}

function renderEventFilterButton(filter, label) {
  return (
    '<button class="event-filter' +
    (EVENT_FILTER === filter ? " active" : "") +
    '" onclick="setEventFilter(&quot;' +
    filter +
    '&quot;)">' +
    label +
    "</button>"
  );
}

function matchesEventFilter(event) {
  if (EVENT_FILTER === "errors") return event.level === "error";
  if (EVENT_FILTER === "proxy") return event.source === "proxy";
  if (EVENT_FILTER === "rotator") return event.source === "rotator";
  return true;
}

var MASK_MODE = new URLSearchParams(window.location.search).has("mask");
var EVENT_FILTER =
  new URLSearchParams(window.location.search).get("events") || "all";
var maskCounter = 0;
var maskMap = {};

function maskText(text) {
  if (!MASK_MODE) return text;
  if (!maskMap[text]) {
    maskCounter++;
    maskMap[text] = "Account " + maskCounter;
  }
  return maskMap[text];
}

function maskEmail(email) {
  if (!MASK_MODE) return email;
  var masked = maskText(email.split("@")[0]);
  return masked.toLowerCase().replace(/ /g, "-") + "@***.com";
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeActionUrl(value) {
  if (!value) return "";
  try {
    var url = new URL(String(value), window.location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch (_) {
    return "";
  }
}

function jsString(text) {
  return escapeHtml(
    String(text)
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n"),
  );
}

var ADMIN_TOKEN =
  new URLSearchParams(window.location.search).get("token") ||
  localStorage.getItem("rotatorAdminToken") ||
  "";
if (ADMIN_TOKEN) localStorage.setItem("rotatorAdminToken", ADMIN_TOKEN);

function authHeaders() {
  return ADMIN_TOKEN ? { "X-Rotator-Admin-Token": ADMIN_TOKEN } : {};
}

function authFetch(url, options) {
  options = options || {};
  options.headers = Object.assign({}, authHeaders(), options.headers || {});
  return fetch(url, options);
}

function authEventUrl(path) {
  if (!ADMIN_TOKEN) return path;
  var url = new URL(path, window.location.origin);
  url.searchParams.set("token", ADMIN_TOKEN);
  return url.pathname + url.search;
}

function setEventFilter(filter) {
  EVENT_FILTER = filter;
  refresh();
}

async function loadConfigEditor() {
  var res = await authFetch("/api/config");
  var data = await res.json();
  document.getElementById("configEditor").value = JSON.stringify(data, null, 2);
  document.getElementById("configEditorStatus").textContent =
    "Loaded current config from disk.";
}

async function saveConfigEditor() {
  var raw = document.getElementById("configEditor").value;
  try {
    var parsed = JSON.parse(raw);
    var res = await authFetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    });
    var data = await res.json();
    if (!res.ok)
      throw new Error(
        (data.errors || [data.error || "Invalid config"]).join("; "),
      );
    document.getElementById("configEditorStatus").textContent =
      "Saved config and refreshed runtime.";
    refresh();
  } catch (err) {
    document.getElementById("configEditorStatus").textContent =
      "Save failed: " + (err && err.message ? err.message : String(err));
  }
}

async function exportConfig() {
  var res = await authFetch("/api/config/export");
  var data = await res.text();
  var blob = new Blob([data], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "tuxevil-rotator-config.json";
  a.click();
  URL.revokeObjectURL(url);
}

async function importConfigPrompt() {
  var raw = prompt("Paste a full config JSON document to import.");
  if (!raw) return;
  try {
    var parsed = JSON.parse(raw);
    var res = await authFetch("/api/config/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    });
    var data = await res.json();
    if (!res.ok)
      throw new Error(
        (data.errors || [data.error || "Import failed"]).join("; "),
      );
    document.getElementById("configEditor").value = JSON.stringify(
      parsed,
      null,
      2,
    );
    document.getElementById("configEditorStatus").textContent =
      "Imported config successfully.";
    refresh();
  } catch (err) {
    document.getElementById("configEditorStatus").textContent =
      "Import failed: " + (err && err.message ? err.message : String(err));
  }
}

async function openConfigEditorModal() {
  openModal("configEditorModal");
  await loadConfigEditor();
}

function renderRoutingInspector(data) {
  var panel = document.getElementById("routingInspectorPanel");
  if (!panel) return;
  var diagnostics =
    data && data.routingDiagnostics ? data.routingDiagnostics : {};
  var modelKeys = Object.keys(diagnostics).sort();
  if (modelKeys.length === 0) {
    panel.innerHTML =
      '<div class="modal-empty">No routing diagnostics available yet.</div>';
    return;
  }

  function formatHealthComponent(value, penalty) {
    var numeric = Number(value);
    if (!Number.isFinite(numeric)) return "--";
    var percent = Math.round(numeric * 100);
    return penalty && percent > 0 ? "-" + percent + "%" : percent + "%";
  }

  function renderHealthBreakdown(entry) {
    var breakdown = entry && entry.healthBreakdown;
    if (!breakdown) return '<span style="color:var(--text-dim)">--</span>';
    return (
      '<details class="health-breakdown">' +
      "<summary>View</summary>" +
      '<div style="display:grid;gap:3px;margin-top:5px;white-space:nowrap">' +
      "<span>Quota: " +
      formatHealthComponent(breakdown.quotaComponent, false) +
      "</span><span>Error: " +
      formatHealthComponent(breakdown.errorPenalty, true) +
      "</span><span>Cooldown: " +
      formatHealthComponent(breakdown.cooldownPenalty, true) +
      "</span><span>Availability: " +
      formatHealthComponent(breakdown.availabilityPenalty, true) +
      "</span><span>Final: " +
      formatHealthComponent(breakdown.score, false) +
      "</span></div></details>"
    );
  }

  panel.innerHTML = modelKeys
    .map(function (modelKey) {
      var diag = diagnostics[modelKey];
      var rows = (diag.accounts || [])
        .map(function (entry) {
          var score =
            entry.score === null || entry.score === undefined
              ? "--"
              : Number(entry.score).toFixed(1);
          var quota =
            entry.quota === null || entry.quota === undefined
              ? "--"
              : entry.quota + "%";
          var priority =
            entry.timerPriority === null || entry.timerPriority === undefined
              ? "--"
              : String(entry.timerPriority);
          var tokenText =
            entry.tokenBucket && entry.tokenBucket.enabled
              ? Number(entry.tokenBucket.tokens || 0).toFixed(1) +
                " / " +
                entry.tokenBucket.capacity
              : "off";
          var decision = entry.rejectedReason
            ? '<span style="color:var(--yellow)">' +
              escapeHtml(entry.rejectedDetail || entry.rejectedReason) +
              "</span>"
            : '<span style="color:var(--green)">selected candidate</span>';
          return (
            "<tr>" +
            '<td style="padding:6px 8px;border-top:1px solid var(--border)">' +
            escapeHtml(maskText(entry.label || entry.email)) +
            "</td>" +
            '<td style="padding:6px 8px;border-top:1px solid var(--border)">' +
            escapeHtml(entry.status) +
            "</td>" +
            '<td style="padding:6px 8px;border-top:1px solid var(--border);font-family:JetBrains Mono,monospace">' +
            escapeHtml(priority) +
            "</td>" +
            '<td style="padding:6px 8px;border-top:1px solid var(--border);font-family:JetBrains Mono,monospace">' +
            escapeHtml(quota) +
            "</td>" +
            '<td style="padding:6px 8px;border-top:1px solid var(--border);font-family:JetBrains Mono,monospace">' +
            escapeHtml(
              String(Math.round((entry.healthScore || 0) * 100)) + "%",
            ) +
            "</td>" +
            '<td style="padding:6px 8px;border-top:1px solid var(--border)">' +
            renderHealthBreakdown(entry) +
            "</td>" +
            '<td style="padding:6px 8px;border-top:1px solid var(--border);font-family:JetBrains Mono,monospace">' +
            escapeHtml(tokenText) +
            "</td>" +
            '<td style="padding:6px 8px;border-top:1px solid var(--border);font-family:JetBrains Mono,monospace">' +
            escapeHtml(score) +
            "</td>" +
            '<td style="padding:6px 8px;border-top:1px solid var(--border)">' +
            decision +
            "</td>" +
            "</tr>"
          );
        })
        .join("");

      return (
        '<div style="margin-bottom:16px;padding:14px;border:1px solid var(--border);border-radius:8px;background:rgba(255,255,255,0.02)">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">' +
        "<strong>" +
        escapeHtml(modelKey) +
        "</strong>" +
        '<span style="font-size:12px;color:var(--text-dim)">policy: ' +
        escapeHtml(diag.policy || "--") +
        " · available: " +
        escapeHtml(String(diag.availableCandidates || 0)) +
        " · rejected: " +
        escapeHtml(String(diag.rejectedCandidates || 0)) +
        "</span>" +
        "</div>" +
        '<div style="font-size:12px;color:var(--text-dim);margin-bottom:10px">' +
        escapeHtml(diag.reason || "No diagnostic summary available.") +
        "</div>" +
        '<div style="overflow:auto">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
        '<thead><tr style="text-align:left;color:var(--text-dim)">' +
        '<th style="padding:4px 8px">Account</th>' +
        '<th style="padding:4px 8px">Status</th>' +
        '<th style="padding:4px 8px">Timer</th>' +
        '<th style="padding:4px 8px">Quota</th>' +
        '<th style="padding:4px 8px">Health</th>' +
        '<th style="padding:4px 8px">Health breakdown</th>' +
        '<th style="padding:4px 8px">Bucket</th>' +
        '<th style="padding:4px 8px">Score</th>' +
        '<th style="padding:4px 8px">Decision</th>' +
        "</tr></thead>" +
        "<tbody>" +
        rows +
        "</tbody>" +
        "</table>" +
        "</div>" +
        "</div>"
      );
    })
    .join("");
}

function openRoutingInspectorModal() {
  openModal("routingInspectorModal");
  renderRoutingInspector(window.__lastData || {});
}

async function enableAccount(email) {
  await authFetch("/api/enable/" + encodeURIComponent(email), {
    method: "POST",
  });
  refresh();
}

async function disableAccount(email) {
  if (
    !confirm(
      "Disable this account? It will stop serving traffic until restored.",
    )
  )
    return;
  await authFetch("/api/disable/" + encodeURIComponent(email), {
    method: "POST",
  });
  refresh();
}

async function quarantineAccount(email) {
  if (
    !confirm(
      "Quarantine this account? It will be flagged and excluded from routing.",
    )
  )
    return;
  await authFetch("/api/quarantine/" + encodeURIComponent(email), {
    method: "POST",
  });
  refresh();
}

async function restoreAccount(email) {
  await authFetch("/api/restore/" + encodeURIComponent(email), {
    method: "POST",
  });
  refresh();
}

async function removeAccount(email) {
  try {
    var r = await authFetch(
      "/api/remove-account/" + encodeURIComponent(email),
      { method: "POST" },
    );
    var d = await r.json();
    if (d.ok) refresh();
    else alert("Failed to remove: " + JSON.stringify(d));
  } catch (e) {
    alert("Failed to remove: " + e);
  }
}

function confirmRemoveAccount(email) {
  if (confirm("Remove account " + email + "? This cannot be undone.")) {
    removeAccount(email);
  }
}

function openCliLogin() {
  var path =
    window.__lastData && window.__lastData.hostedOAuthConfigured
      ? "/login"
      : "/login-cli";
  window.open(
    path + (ADMIN_TOKEN ? "?token=" + encodeURIComponent(ADMIN_TOKEN) : ""),
    "_blank",
  );
}

function toggleTierDropdown(badge, email) {
  var dropdown = badge.nextElementSibling;
  var isOpen = dropdown.style.display !== "none";
  // Close all other dropdowns first
  document.querySelectorAll(".tier-dropdown").forEach(function (d) {
    d.style.display = "none";
  });
  if (!isOpen) {
    dropdown.style.display = "block";
    // Close on click outside
    setTimeout(function () {
      document.addEventListener("click", function closeDropdown(e) {
        if (!dropdown.contains(e.target) && e.target !== badge) {
          dropdown.style.display = "none";
          document.removeEventListener("click", closeDropdown);
        }
      });
    }, 0);
  }
}

async function setAccountTier(email, tier) {
  try {
    var r = await authFetch(
      "/api/set-tier/" +
        encodeURIComponent(email) +
        "/" +
        encodeURIComponent(tier),
      { method: "POST" },
    );
    var d = await r.json();
    if (d.ok) refresh();
    else alert("Failed to set tier: " + JSON.stringify(d));
  } catch (e) {
    alert("Failed to set tier: " + e);
  }
}

async function setFreshWindowStarts(enabled) {
  await authFetch(
    "/api/settings/fresh-window-starts/" + (enabled ? "on" : "off"),
    { method: "POST" },
  );
  refresh();
}

async function setAutoWarmup(enabled) {
  await authFetch(
    "/api/settings/auto-warmup/" + (enabled ? "on" : "off"),
    { method: "POST" },
  );
  refresh();
}

async function kickstartTimer(email, modelKey) {
  var res = await authFetch(
    "/api/kickstart/" +
      encodeURIComponent(email) +
      "/" +
      encodeURIComponent(modelKey),
    { method: "POST" },
  );
  var data = await res.json();
  if (!data.ok) {
    alert(
      "Kickstart failed for " +
        modelKey +
        ": " +
        (data.error || "status " + data.status),
    );
  }
  refresh();
}

async function kickstartAllTimers(email) {
  if (
    !confirm(
      "Send minimal requests to start all idle timers on " +
        email +
        "? One request per upstream model pool will be sent.",
    )
  )
    return;
  var res = await authFetch(
    "/api/kickstart/" + encodeURIComponent(email),
    { method: "POST" },
  );
  var data = await res.json();
  if (data.error) {
    alert("Kickstart failed: " + data.error);
  } else if (data.results && data.results.length === 0) {
    alert("No idle timers found for this account.");
  }
  refresh();
}

function toggleFlagged() {
  window.__hideFlagged = !window.__hideFlagged;
  refresh();
}

async function setAccountFreshWindowOverride(email, enabled) {
  await authFetch(
    "/api/account-fresh-window-starts/" +
      encodeURIComponent(email) +
      "/" +
      (enabled ? "on" : "off"),
    { method: "POST" },
  );
  refresh();
}

async function clearInFlight(email, modelKey) {
  if (
    !confirm(
      "Clear in-flight counter for this account/model? Use only when you are sure the request is stuck.",
    )
  )
    return;
  await authFetch(
    "/api/clear-inflight/" +
      encodeURIComponent(email) +
      "/" +
      encodeURIComponent(modelKey),
    { method: "POST" },
  );
  refresh();
}

async function clearCircuitBreaker(modelKey) {
  var target = modelKey ? modelKey : "ALL";
  if (
    !confirm(
      "Manually reset the circuit breaker for " +
        target +
        "? If the provider issue is still ongoing, this could lead to more rate-limits.",
    )
  )
    return;
  var path =
    "/api/clear-breaker/" + (modelKey ? encodeURIComponent(modelKey) : "all");
  await authFetch(path, { method: "POST" });
  refresh();
}

function openModal(id) {
  var modal = document.getElementById(id);
  if (modal) modal.classList.add("open");
}

function closeModal(event, id) {
  if (event) event.stopPropagation();
  var modal = document.getElementById(id);
  if (modal) modal.classList.remove("open");
}

var benchmarkRunning = false;
var benchmarkResultsState = [];

function benchmarkMetric(value, suffix) {
  return value === null || value === undefined
    ? "--"
    : Math.round(value * 10) / 10 + suffix;
}

function renderBenchmarkResults(results, summary) {
  var container = document.getElementById("benchmarkResults");
  if (!container) return;
  if (!results || results.length === 0) {
    container.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem">No active accounts available for benchmarking.</div>';
    return;
  }
  var summaryHtml = summary
    ? '<div style="color:var(--text-dim);font-size:0.8rem;margin-bottom:8px">Success: ' +
      summary.successRate.toFixed(1) +
      "% · Average latency: " +
      benchmarkMetric(summary.averageLatencyMs, " ms") +
      " · Average TTFB: " +
      benchmarkMetric(summary.averageTtfbMs, " ms") +
      "</div>"
    : "";
  var rows = results
    .map(function (result) {
      var color =
        result.status === "success"
          ? "var(--green)"
          : result.status === "skipped"
            ? "var(--yellow)"
            : "var(--red)";
      return (
        "<tr>" +
        '<td style="padding:7px 8px;font-family:monospace">' +
         escapeHtml(maskText(result.account)) +
        "</td>" +
        '<td style="padding:7px 8px;color:' +
        color +
        '">' +
        escapeHtml(result.status) +
        (result.error
          ? '<div style="color:var(--text-dim);font-size:0.72rem;max-width:360px">' +
            escapeHtml(result.error) +
            "</div>"
          : "") +
        "</td>" +
        '<td style="padding:7px 8px;text-align:right">' +
        benchmarkMetric(result.latencyMs, " ms") +
        "</td>" +
        '<td style="padding:7px 8px;text-align:right">' +
        benchmarkMetric(result.ttfbMs, " ms") +
        "</td>" +
        '<td style="padding:7px 8px;text-align:right">' +
        benchmarkMetric(result.tokensPerSecond, " tok/s") +
        "</td>" +
        "</tr>"
      );
    })
    .join("");
  container.innerHTML =
    summaryHtml +
    '<table style="width:100%;border-collapse:collapse;font-size:0.8rem">' +
    "<thead><tr>" +
    '<th style="text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)">Account</th>' +
    '<th style="text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)">Status</th>' +
    '<th style="text-align:right;padding:7px 8px;border-bottom:1px solid var(--border)">Latency</th>' +
    '<th style="text-align:right;padding:7px 8px;border-bottom:1px solid var(--border)">TTFB</th>' +
    '<th style="text-align:right;padding:7px 8px;border-bottom:1px solid var(--border)">Tokens/s</th>' +
    "</tr></thead><tbody>" +
    rows +
    "</tbody></table>";
}

function handleBenchmarkEvent(payload) {
  var status = document.getElementById("benchmarkStatus");
  if (!payload) return;
  if (payload.type === "start") {
    benchmarkResultsState = [];
    if (status) status.textContent = "Benchmarking " + payload.total + " active account(s)...";
    renderBenchmarkResults([], null);
  } else if (payload.type === "progress") {
    benchmarkResultsState = benchmarkResultsState.filter(function (result) {
      return result.account !== payload.result.account;
    });
    benchmarkResultsState.push(payload.result);
    if (status)
      status.textContent =
        "Completed " + payload.completed + " of " + payload.total + " account(s).";
    renderBenchmarkResults(benchmarkResultsState, null);
  } else if (payload.type === "complete") {
    benchmarkResultsState = payload.results || [];
    renderBenchmarkResults(benchmarkResultsState, payload.summary);
    if (status)
      status.textContent =
        "Completed: " +
        payload.summary.succeeded +
        " successful, " +
        payload.summary.failed +
        " failed, " +
        payload.summary.skipped +
        " skipped.";
  } else if (payload.type === "error" && status) {
    status.textContent = "Benchmark failed: " + payload.error;
  }
}

async function runBenchmark() {
  if (benchmarkRunning) return;
  benchmarkRunning = true;
  var button = document.getElementById("benchmarkBtn");
  var status = document.getElementById("benchmarkStatus");
  if (button) {
    button.disabled = true;
    button.textContent = "Benchmarking…";
  }
  try {
    var response = await authFetch("/api/benchmark", { method: "POST" });
    if (!response.ok) {
      var errorText = await response.text();
      throw new Error(errorText || "HTTP " + response.status);
    }
    if (!response.body) throw new Error("Benchmark stream unavailable");
    var reader = response.body.getReader();
    var decoder = new window.TextDecoder();
    var buffer = "";
    var consume = function (text) {
      buffer += text;
      var events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      events.forEach(function (event) {
        var data = event
          .split(/\r?\n/)
          .filter(function (line) {
            return line.indexOf("data:") === 0;
          })
          .map(function (line) {
            return line.slice(5).trim();
          })
          .join("\n");
        if (!data) return;
        try {
          handleBenchmarkEvent(JSON.parse(data));
        } catch (err) {
          console.error("Benchmark SSE parse error:", err);
        }
      });
    };
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      consume(decoder.decode(chunk.value, { stream: true }));
    }
    consume(decoder.decode());
  } catch (err) {
    if (status) status.textContent = "Benchmark failed: " + String(err);
  } finally {
    benchmarkRunning = false;
    if (button) {
      button.disabled = false;
      button.textContent = "Benchmark Active Accounts";
    }
  }
}

async function refresh() {
  try {
    var res = await authFetch("/api/status");
    var data = await res.json();
    renderAccounts(data);
    var btn = document.getElementById("maskBtn");
    if (btn) btn.textContent = MASK_MODE ? "PII: Hidden" : "PII: Visible";
  } catch (err) {
    console.error("Status fetch failed:", err);
  }
}

// Live updates via SSE
var evtSource = null;
function connectSSE() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource(authEventUrl("/api/events"));
  evtSource.onmessage = function (e) {
    try {
      var data = JSON.parse(e.data);
      renderAccounts(data);
    } catch (err) {
      console.error("SSE parse error:", err);
    }
  };
  evtSource.onerror = function () {
    // reconnect after 5s on error
    evtSource.close();
    evtSource = null;
    setTimeout(connectSSE, 5000);
  };
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

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") {
    closeModal(null, "attentionModal");
    closeModal(null, "configEditorModal");
    closeModal(null, "routingInspectorModal");
    closeModal(null, "advisorModal");
    closeModal(null, "donationModal");
  }
});

function hideDonationModalPermanently() {
  localStorage.setItem("hideDonationModal", "true");
  closeModal(null, "donationModal");
}

refresh();
connectSSE();
setInterval(refresh, 15000); // fallback poll every 15s in case SSE drops

if (!localStorage.getItem("hideDonationModal")) {
  setTimeout(function () {
    openModal("donationModal");
  }, 1000);
}

// ── Update Banner ──
function renderUpdateBanner(updateInfo) {
  var banner = document.getElementById("updateBanner");
  var message = document.getElementById("updateMessage");
  var actions = document.getElementById("updateActions");
  var badgeLabel = document.getElementById("updateBadgeLabel");

  if (!updateInfo || !banner || !message || !actions) return;

  // Check if update was already applied (waiting for restart)
  var pendingRestart = localStorage.getItem("updatePendingRestart");
  if (pendingRestart) {
    banner.className = "update-banner visible success";
    badgeLabel.textContent = "✓";
    message.innerHTML =
      "<strong>Updated to v" +
      escapeHtml(pendingRestart) +
      "</strong> — Restart the process to apply the new version.";
    actions.innerHTML =
      '<button class="btn-update-dismiss" onclick="clearPendingRestart()">Dismiss</button>';
    return;
  }

  if (!updateInfo.updateAvailable || !updateInfo.latestVersion) {
    banner.className = "update-banner";
    return;
  }

  // Check if user dismissed this specific version
  var dismissed = localStorage.getItem("updateDismissed");
  if (dismissed === updateInfo.latestVersion) {
    banner.className = "update-banner";
    return;
  }

  banner.className = "update-banner visible";
  badgeLabel.textContent = "NEW";
  message.innerHTML =
    "🚀 Version <strong>v" +
    escapeHtml(updateInfo.latestVersion) +
    "</strong> is available " +
    '<span style="color:var(--text-dim)">(current: v' +
    escapeHtml(updateInfo.currentVersion) +
    ")</span>";
  actions.innerHTML =
    '<a class="btn-update-link" href="https://github.com/tuxevil/tuxevil-rotator/releases" target="_blank">Changelog</a>' +
    '<button class="btn-update" id="btnDoUpdate" onclick="doSelfUpdate()">Update Now</button>' +
    '<button class="btn-update-dismiss" onclick="dismissUpdate(\'' +
    escapeHtml(updateInfo.latestVersion) +
    "')\">Dismiss</button>";
}

async function doSelfUpdate() {
  var btn = document.getElementById("btnDoUpdate");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Updating...";
  }
  try {
    var res = await authFetch("/api/self-update", { method: "POST" });
    var result = await res.json();
    var banner = document.getElementById("updateBanner");
    var message = document.getElementById("updateMessage");
    var actions = document.getElementById("updateActions");
    var badgeLabel = document.getElementById("updateBadgeLabel");
    if (result.ok) {
      localStorage.setItem("updatePendingRestart", result.to);
      banner.className = "update-banner visible success";
      badgeLabel.textContent = "✓";
      message.innerHTML =
        "<strong>Updated to v" +
        escapeHtml(result.to) +
        "</strong> — Restart the process to apply the new version.";
      actions.innerHTML =
        '<button class="btn-update-dismiss" onclick="clearPendingRestart()">Dismiss</button>';
    } else {
      message.innerHTML =
        '<strong style="color:var(--red)">Update failed</strong> — ' +
        escapeHtml(result.message || "Unknown error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Retry";
      }
    }
  } catch (err) {
    var message2 = document.getElementById("updateMessage");
    if (message2)
      message2.innerHTML =
        '<strong style="color:var(--red)">Update failed</strong> — ' +
        escapeHtml(String(err));
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Retry";
    }
  }
}

function dismissUpdate(version) {
  localStorage.setItem("updateDismissed", version);
  var banner = document.getElementById("updateBanner");
  if (banner) banner.className = "update-banner";
}

function clearPendingRestart() {
  localStorage.removeItem("updatePendingRestart");
  var banner = document.getElementById("updateBanner");
  if (banner) banner.className = "update-banner";
}

// ── Admin Notifications ──
var NOTIF_ICONS = { info: "ℹ️", warning: "⚠️", critical: "🚨" };

function renderNotifications(notifications) {
  var container = document.getElementById("notifContainer");
  if (!container) return;
  if (!notifications || notifications.length === 0) {
    container.innerHTML = "";
    updateNotifBellBadge(0);
    return;
  }

  var visibleCount = 0;
  var html = "";
  for (var i = 0; i < notifications.length; i++) {
    var n = notifications[i];
    // Check if user dismissed this notification
    if (localStorage.getItem("notif-dismissed-" + n.id)) continue;
    visibleCount++;
    var type = ["info", "warning", "critical"].includes(n.type)
      ? n.type
      : "info";
    var icon = NOTIF_ICONS[type] || NOTIF_ICONS.info;
    var typeClass = "notif-" + type;
    var actionUrl = safeActionUrl(n.actionUrl);
    html +=
      '<div class="notif-banner ' +
      typeClass +
      '" id="notif-' +
      escapeHtml(n.id) +
      '">';
    html += '<span class="notif-icon">' + icon + "</span>";
    html += '<div class="notif-content">';
    html += '<div class="notif-title">' + escapeHtml(n.title) + "</div>";
    html += '<div class="notif-msg">' + escapeHtml(n.message) + "</div>";
    if (actionUrl) {
      html += '<div class="notif-actions">';
      html +=
        '<a class="notif-action-btn" href="' +
        escapeHtml(actionUrl) +
        '" target="_blank">' +
        escapeHtml(n.actionLabel || "Learn More") +
        "</a>";
      html += "</div>";
    }
    html += "</div>";
    html +=
      '<button class="notif-dismiss" onclick="dismissNotification(\'' +
      jsString(n.id) +
      '\')" title="Dismiss">&times;</button>';
    html += "</div>";
  }
  container.innerHTML = html;
  updateNotifBellBadge(visibleCount);
}

function dismissNotification(id) {
  localStorage.setItem("notif-dismissed-" + id, "1");
  var el = document.getElementById("notif-" + id);
  if (el) {
    el.style.opacity = "0";
    el.style.transform = "translateY(-10px)";
    el.style.transition = "opacity 0.3s, transform 0.3s";
    setTimeout(function () {
      el.remove();
    }, 300);
  }
  // Recount visible
  var container = document.getElementById("notifContainer");
  if (container) {
    var remaining = container.querySelectorAll(".notif-banner").length - 1;
    updateNotifBellBadge(Math.max(0, remaining));
  }
}

function updateNotifBellBadge(count) {
  // Update the attention bell badge if it exists
  var bellBtn = document.querySelector(".header-icon-btn.attention");
  if (!bellBtn) return;
  var badge = bellBtn.querySelector(".header-icon-badge");
  if (count > 0) {
    bellBtn.classList.add("has-items");
    if (badge) {
      badge.textContent = String(count);
      badge.style.display = "";
    }
  }
}
