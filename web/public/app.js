// Client-side controller for PoE2 MCP Web Dashboard

const TOKEN = new URLSearchParams(location.search).get("token") || "";

function authHeaders() {
  return TOKEN ? { "X-POE2-Token": TOKEN } : {};
}

async function api(path, init = {}) {
  const headers = { ...authHeaders(), ...(init.headers || {}) };
  if (init.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let errMessage = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) errMessage = body.error;
    } catch {}
    throw new Error(errMessage);
  }
  return res.json();
}

function currentCharacterName() {
  return document.getElementById("character-input").value.trim() || undefined;
}

function showToast(title, message, urgency = "info", ttlMs = 4000) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast ${urgency === "critical" ? "toast-critical" : urgency === "warning" ? "toast-warning" : ""}`;
  toast.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div><div class="toast-msg">${escapeHtml(message)}</div>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, ttlMs);
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatStatName(key) {
  if (!key) return "";
  const map = {
    maximum_life: "Maximum Life",
    maximum_mana: "Maximum Mana",
    maximum_energy_shield: "Maximum Energy Shield",
    increased_energy_shield_percent: "Increased Energy Shield (%)",
    increased_armour_percent: "Increased Armour (%)",
    increased_evasion_percent: "Increased Evasion (%)",
    fire_resistance_percent: "Fire Resistance (%)",
    cold_resistance_percent: "Cold Resistance (%)",
    lightning_resistance_percent: "Lightning Resistance (%)",
    chaos_resistance_percent: "Chaos Resistance (%)",
    stun_threshold: "Stun Threshold",
    life_regeneration_per_second: "Life Regen / sec",
    increased_attack_speed_percent: "Increased Attack Speed (%)",
    increased_cast_speed_percent: "Increased Cast Speed (%)",
    increased_critical_strike_chance_percent: "Increased Critical Chance (%)",
    critical_damage_bonus_percent: "Critical Damage Bonus (%)",
    block_chance_percent: "Block Chance (%)",
    accuracy_rating: "Accuracy Rating",
    strength: "Strength",
    dexterity: "Dexterity",
    intelligence: "Intelligence",
  };
  if (map[key]) return map[key];
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(" Percent", " (%)");
}

function getRarityClass(rarity) {
  if (!rarity) return "rare";
  const r = rarity.toLowerCase();
  if (r.includes("unique")) return "unique";
  if (r.includes("magic")) return "magic";
  if (r.includes("normal")) return "normal";
  return "rare";
}

// ---- Live HUD Status Polling --------------------------------------

async function refreshServerStatus() {
  try {
    const s = await api("/api/status");

    // Account & Build
    const charEl = document.getElementById("status-character");
    const buildEl = document.getElementById("status-build");
    const activeChar = s.activeCharacter?.name ?? "–";
    const buildSummary = s.activeBuild?.buildSummary;
    if (buildSummary) {
      charEl.textContent = `${activeChar} (Lv ${buildSummary.level} ${buildSummary.ascendClassName || buildSummary.className})`;
      buildEl.textContent = `${s.activeBuild?.identity?.league ?? "League"} &bull; Source: ${s.activeBuild?.origin ?? "poe.ninja"}`;
    } else {
      charEl.textContent = activeChar;
      buildEl.textContent = s.activeBuild?.identity?.league ? `League: ${s.activeBuild.identity.league}` : "No active build";
    }

    // Zone & Session
    const areaEl = document.getElementById("status-area");
    const zoneTimeEl = document.getElementById("status-zone-time");
    areaEl.textContent = s.gameLog?.currentArea ?? "In Hideout / Town";
    if (s.gameLog?.enteredAreaAt) {
      const diffSec = Math.max(0, Math.round((Date.now() - new Date(s.gameLog.enteredAreaAt).getTime()) / 1000));
      zoneTimeEl.textContent = `Entered ${diffSec}s ago`;
    } else {
      zoneTimeEl.textContent = s.gameLog?.tailing ? "Log tailer active" : "Log tailer stopped";
    }

    const sessionEl = document.getElementById("status-session");
    const dlEl = document.getElementById("status-deaths-levels");
    const sess = s.gameLog?.session;
    if (sess) {
      sessionEl.textContent = `${sess.areasVisited ?? 0} zones visited`;
      dlEl.innerHTML = `💀 Deaths: <strong style="color:var(--bad);">${sess.deaths ?? 0}</strong> &bull; ⬆️ Level-ups: <strong style="color:var(--poe-rare);">${sess.levelUps ?? 0}</strong>`;
    }

    // Session duration tag in events panel
    const sessionTag = document.getElementById("session-duration-tag");
    if (sessionTag && sess?.startedAt) {
      const elapsedMins = Math.max(0, Math.round((Date.now() - new Date(sess.startedAt).getTime()) / 60000));
      const hours = Math.floor(elapsedMins / 60);
      const mins = elapsedMins % 60;
      sessionTag.textContent = `Session: ${hours > 0 ? `${hours}h ` : ""}${mins}m (${sess.deaths ?? 0} deaths)`;
    }

    // Latest Clipboard Item
    const clipNameEl = document.getElementById("status-clipboard-name");
    const clipMetaEl = document.getElementById("status-clipboard-meta");
    if (s.clipboard?.hasItem) {
      clipNameEl.textContent = `${s.clipboard.name} (${s.clipboard.baseType ?? s.clipboard.itemClass ?? ""})`;
      clipNameEl.className = `hud-value hud-item-name ${getRarityClass(s.clipboard.rarity)}`;
      clipMetaEl.textContent = `Copied ${s.clipboard.secondsAgo ?? 0}s ago &bull; Click to compare`;
    }

    // Update Active Build Panel card
    const buildNameEl = document.getElementById("build-display-name");
    const buildMetaEl = document.getElementById("build-display-meta");
    const buildPill = document.getElementById("build-freshness-pill");
    const buildIcon = document.getElementById("build-origin-icon");
    if (buildNameEl && s.activeBuild?.available) {
      const b = s.activeBuild;
      const bChar = b.identity?.characterName ?? b.buildSummary?.className ?? "Active Build";
      const bClass = b.buildSummary?.ascendClassName || b.buildSummary?.className || "";
      const bLvl = b.buildSummary?.level ? `Lv ${b.buildSummary.level} ` : "";
      buildNameEl.textContent = `${bChar} (${bLvl}${bClass})`;
      buildMetaEl.innerHTML = `Source: <strong>${escapeHtml(b.origin)}</strong> &bull; League: <strong>${escapeHtml(b.identity?.league ?? "Standard")}</strong> &bull; ${b.buildSummary?.equipmentCount ?? 0} items equipped`;
      if (buildIcon) buildIcon.textContent = b.origin.includes("ninja") ? "🥷" : "📜";
      if (buildPill) {
        if (b.stale) {
          buildPill.textContent = "Stale (click sync)";
          buildPill.className = "status-pill pill-stale";
        } else {
          buildPill.textContent = "Synced & Ready";
          buildPill.className = "status-pill pill-fresh";
        }
      }
    } else if (buildNameEl) {
      buildNameEl.textContent = "No Active Build Loaded";
      buildMetaEl.textContent = "Import from poe.ninja or paste a PoB share code below";
      if (buildIcon) buildIcon.textContent = "🛡️";
      if (buildPill) {
        buildPill.textContent = "No Build";
        buildPill.className = "status-pill pill-neutral";
      }
    }

    // Pre-fill import fields if empty
    const ninjaAcc = document.getElementById("ninja-account-input");
    if (ninjaAcc && !ninjaAcc.value && s.account?.accountName) {
      ninjaAcc.value = s.account.accountName;
    }
    const ninjaChar = document.getElementById("ninja-char-input");
    if (ninjaChar && !ninjaChar.value && s.activeCharacter?.name) {
      ninjaChar.value = s.activeCharacter.name;
    }
    const ninjaLg = document.getElementById("ninja-league-input");
    if (ninjaLg && !ninjaLg.value && s.activeBuild?.identity?.league) {
      ninjaLg.value = s.activeBuild.identity.league;
    }

    // Server badge
    const badge = document.getElementById("server-status-badge");
    badge.innerHTML = `<span class="static-dot"></span><span class="badge-label">Server: ${s.status} (up ${s.uptimeSeconds}s)</span>`;
    badge.className = "status-badge badge-ready";
  } catch (err) {
    const badge = document.getElementById("server-status-badge");
    badge.innerHTML = `<span class="static-dot" style="background:#ef4444"></span><span class="badge-label">Server: offline</span>`;
  }
}

async function refreshCharacter() {
  const name = currentCharacterName();
  const summaryEl = document.getElementById("character-summary");
  const defensesEl = document.getElementById("defenses-summary");
  const offenseEl = document.getElementById("offense-summary");
  try {
    const state = await api(`/api/character-state${name ? `?characterName=${encodeURIComponent(name)}` : ""}`);
    summaryEl.innerHTML = `
      <div style="font-weight:700;font-size:15px;color:var(--poe-rare);margin-bottom:4px;">
        ${escapeHtml(state.name)} &bull; Level ${state.level} ${escapeHtml(state.characterClass ?? state.class ?? "")}
      </div>
      <div style="color:var(--text-muted);font-size:12px;">
        League: <strong>${escapeHtml(state.league ?? "Standard")}</strong> &bull; Experience: ${Number(state.experience ?? 0).toLocaleString()}
      </div>
    `;

    const def = await api(`/api/defenses${name ? `?characterName=${encodeURIComponent(name)}` : ""}`);
    defensesEl.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">
        <div>Life: <strong style="color:#f87171;">${def.life}</strong></div>
        <div>Mana: <strong style="color:#60a5fa;">${def.mana}</strong></div>
        <div>Energy Shield: <strong style="color:#38bdf8;">${def.energyShield}</strong></div>
        <div>Armour: <strong style="color:#fbbf24;">${def.armour}</strong></div>
        <div>Evasion: <strong style="color:#4ade80;">${def.evasion}</strong></div>
        <div>Block: <strong>${def.blockChancePercent ?? 0}%</strong></div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);border-top:1px solid rgba(255,255,255,0.06);padding-top:6px;">
        Fire: <span style="color:var(--res-fire);">${def.resistances?.fire?.capped ?? 0}%</span> &bull; 
        Cold: <span style="color:var(--res-cold);">${def.resistances?.cold?.capped ?? 0}%</span> &bull; 
        Light: <span style="color:var(--res-lightning);">${def.resistances?.lightning?.capped ?? 0}%</span> &bull; 
        Chaos: <span style="color:var(--res-chaos);">${def.resistances?.chaos?.capped ?? 0}%</span>
      </div>
    `;

    const off = await api(`/api/offense-stats${name ? `?characterName=${encodeURIComponent(name)}` : ""}`);
    const weaponLines = (off.weapons || [])
      .map((w) => `<div><strong>${escapeHtml(w.slot)}:</strong> ${escapeHtml(w.name)} (${w.attacksPerSecond} aps, ${w.criticalStrikeChancePercent}% crit)</div>`)
      .join("");
    offenseEl.innerHTML = weaponLines || `<span style="color:var(--text-dim);">No weapon stats available</span>`;
  } catch (err) {
    summaryEl.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
}

async function refreshEvents() {
  try {
    const data = await api("/api/recent-events?limit=30");
    const list = document.getElementById("events-list");
    const countEl = document.getElementById("events-count");
    if (countEl) countEl.textContent = `${(data.events || []).length} events`;
    if (!data.events || data.events.length === 0) {
      list.innerHTML = `<li style="padding:12px;color:var(--text-dim);text-align:center;">No recent events recorded in Client.txt</li>`;
      return;
    }
    list.innerHTML = data.events
      .map((ev) => {
        const time = new Date(ev.timestamp).toLocaleTimeString();
        let badgeCls = "";
        let icon = "💬";
        if (ev.type === "area_entered") { icon = "🗺️"; }
        if (ev.type === "death") { icon = "💀"; badgeCls = "death"; }
        if (ev.type === "level_up") { icon = "⬆️"; badgeCls = "level_up"; }
        if (ev.type === "trade_whisper") { icon = "💰"; }
        if (ev.type === "instance_created") { icon = "🌐"; }

        const d = ev.data || {};
        const area = d.area || ev.area;
        const char = d.character || ev.character || ev.characterName;
        const level = d.level || ev.level;
        const from = d.player || d.from || ev.from;
        const message = d.message || ev.message;

        let detail = "";
        if (ev.type === "area_entered") {
          detail = `Entered <strong>${escapeHtml(area || "Unknown Area")}</strong>`;
        } else if (ev.type === "death") {
          detail = `<strong style="color:var(--bad);">${escapeHtml(char || "Character")} was slain</strong>${area ? ` in <em>${escapeHtml(area)}</em>` : ""}`;
        } else if (ev.type === "level_up") {
          detail = `<strong style="color:var(--poe-rare);">${escapeHtml(char || "Character")}</strong> reached level <strong>${level || "?"}</strong>`;
        } else if (ev.type === "trade_whisper") {
          detail = `${d.direction || "From"} <em>${escapeHtml(from || "Player")}</em>: ${escapeHtml(message || "")}`;
        } else if (ev.type === "instance_created") {
          detail = `Instance created for <em>${escapeHtml(d.areaId || "Area")}</em> (Lv ${d.areaLevel}, seed ${d.seed})`;
        } else {
          detail = escapeHtml(ev.text ?? d.message ?? ev.type);
        }

        return `<li class="event-item ${badgeCls}">
          <div>
            <span class="event-type-tag">${icon} ${ev.type.replace(/_/g, " ")}</span>
            <span>${detail}</span>
          </div>
          <span class="event-time">${time}</span>
        </li>`;
      })
      .join("");
  } catch {}
}

// ---- Comparison Rendering -----------------------------------------

function renderItemCard(item, title, isCandidate = false) {
  if (!item) {
    return `
      <div class="item-card ${isCandidate ? "candidate" : "equipped"}">
        <span class="item-card-badge ${isCandidate ? "badge-candidate" : "badge-equipped"}">${escapeHtml(title)}</span>
        <h4 class="item-name normal">(Empty Slot)</h4>
        <div class="item-base">No item currently equipped</div>
      </div>
    `;
  }

  const rarityCls = getRarityClass(item.rarity);
  const propsHtml = (item.properties || [])
    .map((p) => `<div>${escapeHtml(p.name)}: <strong>${escapeHtml(p.values?.[0]?.[0] ?? "")}</strong></div>`)
    .join("");

  const modsHtml = (item.mods || [])
    .map((m) => `<li>${escapeHtml(m)}</li>`)
    .join("");

  return `
    <div class="item-card ${isCandidate ? "candidate" : "equipped"}">
      <span class="item-card-badge ${isCandidate ? "badge-candidate" : "badge-equipped"}">${escapeHtml(title)}</span>
      <h4 class="item-name ${rarityCls}">${escapeHtml(item.name)}</h4>
      ${item.baseType ? `<div class="item-base">${escapeHtml(item.baseType)}</div>` : ""}
      <div class="item-meta-row">
        ${item.itemLevel ? `<span>iLvl ${item.itemLevel}</span>` : ""}
        ${item.rarity ? `<span>${escapeHtml(item.rarity)}</span>` : ""}
        ${item.corrupted ? `<span style="color:#ef4444;font-weight:700;">Corrupted</span>` : ""}
      </div>
      ${propsHtml ? `<div class="item-props">${propsHtml}</div>` : ""}
      <ul class="item-mods-list">
        ${modsHtml || `<li style="color:var(--text-dim);">No explicit modifiers</li>`}
      </ul>
    </div>
  `;
}

function renderDefenseImpact(before, after) {
  if (!before || !after) return "";

  function defStatTile(label, bVal, aVal, isPercent = false) {
    const b = bVal ?? 0;
    const a = aVal ?? 0;
    const diff = a - b;
    const sign = diff > 0 ? `+${diff}` : `${diff}`;
    const pillCls = diff > 0 ? "pos" : diff < 0 ? "neg" : "neutral";
    const unit = isPercent ? "%" : "";
    return `
      <div class="def-stat-tile">
        <span class="def-stat-name">${escapeHtml(label)}</span>
        <div class="def-stat-vals">
          <span class="def-val-before">${b}${unit}</span>
          <span class="def-val-arrow">&rarr;</span>
          <span class="def-val-after">${a}${unit}</span>
        </div>
        <span class="delta-pill ${pillCls}">${diff === 0 ? "–" : sign + unit}</span>
      </div>
    `;
  }

  function resTile(name, bRes, aRes, resCls) {
    const b = bRes?.capped ?? 0;
    const a = aRes?.capped ?? 0;
    const diff = a - b;
    const sign = diff > 0 ? `+${diff}%` : `${diff}%`;
    const pillColor = diff > 0 ? "var(--good)" : diff < 0 ? "var(--bad)" : "var(--text-dim)";
    return `
      <div class="res-box ${resCls}">
        <span>${escapeHtml(name)}</span>
        <span><strong>${b}% &rarr; ${a}%</strong> <span style="font-weight:700;color:${pillColor};">(${diff === 0 ? "0%" : sign})</span></span>
      </div>
    `;
  }

  return `
    <div class="defense-impact-card">
      <div class="defense-impact-header">
        <h4>🛡️ Character Loadout Impact (Defense &amp; Resistances)</h4>
        <span class="panel-tag">Gear-Only Simulation</span>
      </div>
      <div class="defense-stat-grid">
        ${defStatTile("Life", before.life, after.life)}
        ${defStatTile("Energy Shield", before.energyShield, after.energyShield)}
        ${defStatTile("Armour", before.armour, after.armour)}
        ${defStatTile("Evasion", before.evasion, after.evasion)}
        ${defStatTile("Mana", before.mana, after.mana)}
        ${before.blockChancePercent !== null || after.blockChancePercent !== null ? defStatTile("Block", before.blockChancePercent, after.blockChancePercent, true) : ""}
      </div>
      <div class="res-row">
        ${resTile("Fire", before.resistances?.fire, after.resistances?.fire, "res-fire")}
        ${resTile("Cold", before.resistances?.cold, after.resistances?.cold, "res-cold")}
        ${resTile("Lightning", before.resistances?.lightning, after.resistances?.lightning, "res-lightning")}
        ${resTile("Chaos", before.resistances?.chaos, after.resistances?.chaos, "res-chaos")}
      </div>
    </div>
  `;
}

function renderStatDeltasTable(statDeltas) {
  if (!statDeltas || statDeltas.length === 0) {
    return `<div style="padding:14px;color:var(--text-dim);font-size:13px;text-align:center;">No direct matching stat affixes between these items.</div>`;
  }

  const rows = statDeltas
    .map((d) => {
      const cls = d.delta === null ? "td-delta-zero" : d.delta > 0 ? "td-delta-pos" : d.delta < 0 ? "td-delta-neg" : "td-delta-zero";
      const deltaText = d.delta === null ? "–" : d.delta > 0 ? `+${d.delta}` : `${d.delta}`;
      return `
        <tr>
          <td class="stat-name-label">${escapeHtml(formatStatName(d.stat))}</td>
          <td>${d.before ?? "–"}</td>
          <td>${d.after ?? "–"}</td>
          <td class="${cls}">${deltaText}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="deltas-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Affix Modifier</th>
            <th>Equipped</th>
            <th>Candidate</th>
            <th>Net Delta</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderComparison(result) {
  const el = document.getElementById("compare-result");
  if (result.error) {
    el.innerHTML = `
      <div class="empty-state" style="border-color:var(--bad);">
        <div class="empty-icon" style="color:var(--bad);">⚠️</div>
        <h3>Comparison Failed</h3>
        <p class="error">${escapeHtml(result.error)}</p>
      </div>
    `;
    return;
  }

  // Dual-ring display if present
  if (result.ringComparisons) {
    const rc = result.ringComparisons;
    const isRing1Rec = rc.recommendedSlot === "Ring";
    const isRing2Rec = rc.recommendedSlot === "Ring2";
    const chosenComp = isRing1Rec ? rc.ring1 : rc.ring2;

    el.innerHTML = `
      <div class="recommendation-box">
        <strong>✨ Recommended Replacement: ${rc.recommendedSlot === "Ring" ? "Ring 1 (Left Slot)" : "Ring 2 (Right Slot)"}</strong> &bull; 
        ${escapeHtml(rc.recommendationReason)}
      </div>

      <!-- Side by side equipped vs candidate -->
      <div class="item-compare-cards">
        ${renderItemCard(chosenComp.current, `Equipped in ${rc.recommendedSlot === "Ring" ? "Ring 1" : "Ring 2"}`, false)}
        <div class="vs-divider">⚔️</div>
        ${renderItemCard(result.candidate, "New Drop / Candidate", true)}
      </div>

      <!-- Defenses loadout impact -->
      ${renderDefenseImpact(chosenComp.defensesBefore, chosenComp.defensesAfter)}

      <!-- Dual ring cards breakdown -->
      <h3 style="margin:20px 0 10px;">Ring 1 vs Ring 2 Comparison Breakdown</h3>
      <div class="dual-ring-grid">
        <div class="ring-card ${isRing1Rec ? "recommended" : ""}">
          <div class="ring-card-header">
            <strong>Ring 1 (Left): ${escapeHtml(rc.ring1.current?.name ?? "(Empty)")}</strong>
            ${isRing1Rec ? `<span class="badge-rec">Recommended Replacement</span>` : ""}
          </div>
          ${renderStatDeltasTable(rc.ring1.statDeltas)}
        </div>
        <div class="ring-card ${isRing2Rec ? "recommended" : ""}">
          <div class="ring-card-header">
            <strong>Ring 2 (Right): ${escapeHtml(rc.ring2.current?.name ?? "(Empty)")}</strong>
            ${isRing2Rec ? `<span class="badge-rec">Recommended Replacement</span>` : ""}
          </div>
          ${renderStatDeltasTable(rc.ring2.statDeltas)}
        </div>
      </div>
    `;
    return;
  }

  // Standard Single Slot Comparison
  el.innerHTML = `
    <!-- Side by Side Item Cards -->
    <div class="item-compare-cards">
      ${renderItemCard(result.current, `Currently Equipped (${result.slot ?? "Slot"})`, false)}
      <div class="vs-divider">⚔️</div>
      ${renderItemCard(result.candidate, "New Drop / Candidate", true)}
    </div>

    <!-- Defenses Loadout Impact -->
    ${renderDefenseImpact(result.defensesBefore, result.defensesAfter)}

    <!-- Detailed Affix Stat Deltas -->
    <h3 style="margin:16px 0 8px;">Affix Modifier Breakdown</h3>
    ${renderStatDeltasTable(result.statDeltas)}

    ${result.note ? `<p class="hint" style="margin-top:12px;">ℹ️ ${escapeHtml(result.note)}</p>` : ""}
  `;
}

async function compareItem() {
  const itemText = document.getElementById("item-text").value.trim();
  const slot = document.getElementById("slot-input").value.trim() || undefined;
  const characterName = currentCharacterName();
  const el = document.getElementById("compare-result");

  if (!itemText) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <h3>No Item Text Provided</h3>
        <p>Paste item text into the box above, or press <kbd>Ctrl+C</kbd> on any item in Path of Exile 2.</p>
      </div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">⏳</div>
      <h3>Comparing Item...</h3>
      <p>Calculating defense deltas and evaluating gear impact...</p>
    </div>
  `;

  try {
    const result = await api("/api/compare-item", {
      method: "POST",
      body: JSON.stringify({ itemText, slot, characterName }),
    });
    renderComparison(result);
  } catch (err) {
    renderComparison({ error: err.message });
  }
}

function clearCompare() {
  document.getElementById("item-text").value = "";
  document.getElementById("slot-input").value = "";
  document.getElementById("drop-detected-banner").style.display = "none";
  document.getElementById("compare-result").innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">🛡️</div>
      <h3>Comparison Cleared</h3>
      <p>Hover over any item in Path of Exile 2 and press <kbd>Ctrl+C</kbd> to compare.</p>
    </div>
  `;
}

function showDropBanner(name, rarity) {
  const banner = document.getElementById("drop-detected-banner");
  const text = document.getElementById("drop-banner-text");
  if (!banner || !text) return;
  text.innerHTML = `New Item Detected: <strong class="${getRarityClass(rarity)}">${escapeHtml(name)}</strong> &bull; Replaced comparison automatically!`;
  banner.style.display = "flex";
}

// ---- Quick Trade Search Generator ---------------------------------

async function handleCreateTradeSearch() {
  const slot = document.getElementById("trade-slot").value;
  const budget = Number(document.getElementById("trade-budget").value) || 20;
  const currency = document.getElementById("trade-currency").value;
  const reqLvl = document.getElementById("trade-req-lvl").value ? Number(document.getElementById("trade-req-lvl").value) : undefined;
  const resultBox = document.getElementById("trade-search-result");

  const checkboxes = document.querySelectorAll("#trade-stat-chips input[type='checkbox']:checked");
  const stats = Array.from(checkboxes).map((cb) => {
    let min = 1;
    if (cb.value === "maximum_life") min = 40;
    if (cb.value === "movement_speed") min = 20;
    if (cb.value.includes("_resistance")) min = 25;
    return { stat: cb.value, min };
  });

  resultBox.style.display = "block";
  resultBox.innerHTML = `<div>Generating official trade search link...</div>`;

  try {
    const res = await api("/api/trade/search", {
      method: "POST",
      body: JSON.stringify({
        slot,
        maxPrice: budget,
        currency,
        maxRequiredLevel: reqLvl,
        stats,
      }),
    });

    const candidatesHtml = (res.candidates || [])
      .map((c) => {
        const price = c.price?.amount ? `${c.price.amount} ${c.price.currency}` : "Unpriced";
        const mods = (c.mods || []).slice(0, 3).map((m) => `<div>• ${escapeHtml(typeof m === "string" ? m : m.description || "")}</div>`).join("");
        return `
          <div class="trade-candidate-card">
            <div class="trade-cand-price">${escapeHtml(price)}</div>
            <strong>${escapeHtml(c.name || c.baseType)}</strong>
            <div style="color:var(--text-muted);font-size:11px;margin-bottom:4px;">${escapeHtml(c.baseType)} (iLvl ${c.itemLevel ?? "?"})</div>
            <div style="font-size:11px;color:var(--text-dim);">${mods}</div>
          </div>
        `;
      })
      .join("");

    resultBox.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
        <div>
          <strong style="color:var(--poe-rare);font-size:14px;">Official Trade Search Created!</strong>
          <div style="font-size:12px;color:var(--text-muted);">League: <strong>${escapeHtml(res.league)}</strong> &bull; Total matches: ${res.totalMatches ?? 0}</div>
        </div>
        <div class="trade-links-row" style="margin-bottom:0;">
          <a href="${escapeHtml(res.searchUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-trade-link">
            🔗 Open on PoE Trade
          </a>
          <button id="copy-trade-url-btn" class="btn btn-secondary btn-sm" data-url="${escapeHtml(res.searchUrl)}">
            📋 Copy Link
          </button>
        </div>
      </div>
      ${res.candidates && res.candidates.length > 0 ? `
        <div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-top:10px;">Live Candidate Preview:</div>
        <div class="trade-candidates-grid">${candidatesHtml}</div>
      ` : ""}
    `;

    const copyBtn = document.getElementById("copy-trade-url-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(res.searchUrl);
        copyBtn.textContent = "✓ Copied!";
        setTimeout(() => (copyBtn.textContent = "📋 Copy Link"), 2000);
      });
    }
  } catch (err) {
    resultBox.innerHTML = `<span class="error">Failed to create trade search: ${escapeHtml(err.message)}</span>`;
  }
}

// ---- WebSocket Connection -----------------------------------------

function connectWs() {
  const badge = document.getElementById("ws-status");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
  const ws = new WebSocket(url);

  ws.onopen = () => {
    badge.innerHTML = `<span class="pulse-dot"></span><span class="badge-label">Clipboard Watcher: Live</span>`;
    badge.className = "status-badge badge-live";
  };
  ws.onclose = () => {
    badge.innerHTML = `<span class="pulse-dot"></span><span class="badge-label">Clipboard Watcher: Reconnecting&hellip;</span>`;
    badge.className = "status-badge badge-connecting";
    setTimeout(connectWs, 3000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "clipboard_item") {
        // Automatically replace the textarea content
        document.getElementById("item-text").value = msg.text;

        // Show banner indicating replacement
        const itemName = msg.parsed?.name ?? "Item";
        const rarity = msg.parsed?.rarity ?? "Rare";
        showDropBanner(itemName, rarity);
        showToast("New Item Copied (Ctrl+C)", `${itemName} (${msg.parsed?.baseType ?? ""})`, "info", 3000);

        // Instantly execute compareItem() so it replaces whatever was currently displayed!
        compareItem();
        refreshServerStatus();
      } else if (msg.type === "advisory") {
        const act = msg.action;
        showToast(act?.reason ? `Advisory: ${act.reason}` : "AI Advisory", act?.message ?? "", act?.urgency ?? "info", act?.ttlMs ?? 6000);
      } else if (msg.type === "log_event") {
        const ev = msg.event;
        if (!ev) return;
        const list = document.getElementById("events-list");
        if (list) {
          const time = new Date(ev.timestamp).toLocaleTimeString();
          let badgeCls = "";
          let icon = "💬";
          if (ev.type === "area_entered") { icon = "🗺️"; }
          if (ev.type === "death") { icon = "💀"; badgeCls = "death"; }
          if (ev.type === "level_up") { icon = "⬆️"; badgeCls = "level_up"; }
          if (ev.type === "trade_whisper") { icon = "💰"; }
          if (ev.type === "instance_created") { icon = "🌐"; }

          const d = ev.data || {};
          const area = d.area || ev.area;
          const char = d.character || ev.character || ev.characterName;
          const level = d.level || ev.level;
          const from = d.player || d.from || ev.from;
          const message = d.message || ev.message;

          let detail = "";
          if (ev.type === "area_entered") {
            detail = `Entered <strong>${escapeHtml(area || "Unknown Area")}</strong>`;
          } else if (ev.type === "death") {
            detail = `<strong style="color:var(--bad);">${escapeHtml(char || "Character")} was slain</strong>${area ? ` in <em>${escapeHtml(area)}</em>` : ""}`;
          } else if (ev.type === "level_up") {
            detail = `<strong style="color:var(--poe-rare);">${escapeHtml(char || "Character")}</strong> reached level <strong>${level || "?"}</strong>`;
          } else if (ev.type === "trade_whisper") {
            detail = `${d.direction || "From"} <em>${escapeHtml(from || "Player")}</em>: ${escapeHtml(message || "")}`;
          } else if (ev.type === "instance_created") {
            detail = `Instance created for <em>${escapeHtml(d.areaId || "Area")}</em> (Lv ${d.areaLevel}, seed ${d.seed})`;
          } else {
            detail = escapeHtml(ev.text ?? d.message ?? ev.type);
          }

          const li = document.createElement("li");
          li.className = `event-item ${badgeCls}`;
          li.innerHTML = `<div><span class="event-type-tag">${icon} ${ev.type.replace(/_/g, " ")}</span><span>${detail}</span></div><span class="event-time">${time}</span>`;
          if (list.firstChild && list.firstChild.textContent?.includes("No recent events")) {
            list.innerHTML = "";
          }
          list.insertBefore(li, list.firstChild);
          while (list.children.length > 30) list.removeChild(list.lastChild);
        }

        if (ev.type === "death") {
          const char = ev.data?.character || "Character";
          const area = ev.data?.area;
          showToast("💀 Character Slain", `${char} died${area ? ` in ${area}` : ""}`, "critical", 6000);
          refreshServerStatus();
        } else if (ev.type === "area_entered") {
          const area = ev.data?.area || "New Area";
          showToast("🗺️ Area Entered", area, "info", 2500);
          refreshServerStatus();
        } else if (ev.type === "level_up") {
          const char = ev.data?.character || "Character";
          showToast("⬆️ Level Up!", `${char} reached level ${ev.data?.level ?? ""}`, "info", 5000);
          refreshCharacter();
          refreshServerStatus();
        }
      }
    } catch {}
  };
}

// ---- Event Listeners ----------------------------------------------

document.getElementById("refresh-btn").addEventListener("click", async () => {
  const btn = document.getElementById("refresh-btn");
  btn.classList.add("btn-spinning");
  btn.textContent = "Refreshing...";
  try {
    await api("/api/character/refresh", { method: "POST" });
    await refreshCharacter();
    await refreshServerStatus();
    showToast("Refreshed", "Character loadout and stats updated", "info");
  } catch (err) {
    await refreshCharacter();
    await refreshServerStatus();
  } finally {
    btn.classList.remove("btn-spinning");
    btn.textContent = "↻ Refresh Character";
  }
});

document.getElementById("set-active-btn").addEventListener("click", async () => {
  const name = currentCharacterName();
  if (!name) return;
  try {
    await api("/api/active-character", { method: "POST", body: JSON.stringify({ characterName: name }) });
    await refreshCharacter();
    await refreshServerStatus();
    showToast("Active Character Pinned", name, "info");
  } catch (err) {
    document.getElementById("character-summary").innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
  }
});

// Build & Sync Tab Switching
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => (c.style.display = "none"));
    btn.classList.add("active");
    const target = document.getElementById(btn.dataset.tab);
    if (target) target.style.display = "block";
  });
});

// Sync Active Build Button
const syncBuildBtn = document.getElementById("sync-build-btn");
if (syncBuildBtn) {
  syncBuildBtn.addEventListener("click", async () => {
    syncBuildBtn.classList.add("btn-spinning");
    syncBuildBtn.textContent = "Syncing...";
    try {
      const res = await api("/api/active-build/refresh", { method: "POST" });
      showToast("Build Synchronized", `Updated build from ${res.status?.origin ?? "upstream"}`, "info");
      await refreshServerStatus();
      await refreshCharacter();
    } catch (err) {
      showToast("Sync Error", err.message, "warning");
    } finally {
      syncBuildBtn.classList.remove("btn-spinning");
      syncBuildBtn.textContent = "↻ Sync / Refresh Build";
    }
  });
}

// Import from poe.ninja Button
const importNinjaBtn = document.getElementById("btn-import-ninja");
if (importNinjaBtn) {
  importNinjaBtn.addEventListener("click", async () => {
    const profileUrl = document.getElementById("ninja-url-input")?.value.trim() || undefined;
    const accountName = document.getElementById("ninja-account-input")?.value.trim() || undefined;
    const characterName = document.getElementById("ninja-char-input")?.value.trim() || undefined;
    const league = document.getElementById("ninja-league-input")?.value.trim() || undefined;

    if (!profileUrl && !accountName) {
      showToast("Input Required", "Enter an account name or full poe.ninja profile URL", "warning");
      return;
    }

    importNinjaBtn.classList.add("btn-spinning");
    importNinjaBtn.textContent = "Importing...";
    try {
      const res = await api("/api/active-build/poe-ninja", {
        method: "POST",
        body: JSON.stringify({ profileUrl, accountName, characterName, league }),
      });
      showToast("Build Imported!", `Active build updated: ${res.summary?.character} (Lv ${res.summary?.level} ${res.summary?.ascendClassName || res.summary?.className})`, "info");
      await refreshServerStatus();
      await refreshCharacter();
    } catch (err) {
      showToast("Import Failed", err.message, "critical");
    } finally {
      importNinjaBtn.classList.remove("btn-spinning");
      importNinjaBtn.textContent = "Import & Sync from poe.ninja";
    }
  });
}

// Import PoB Build Button
const importPobBtn = document.getElementById("btn-import-pob");
if (importPobBtn) {
  importPobBtn.addEventListener("click", async () => {
    const code = document.getElementById("pob-code-input")?.value.trim();
    if (!code) {
      showToast("Input Required", "Paste a PoB share code (pobb.in/...) or XML first", "warning");
      return;
    }

    importPobBtn.classList.add("btn-spinning");
    importPobBtn.textContent = "Importing PoB...";
    try {
      const res = await api("/api/active-build/pob", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      showToast("PoB Imported!", `Active build updated: Lv ${res.summary?.level} ${res.summary?.ascendClassName || res.summary?.className}`, "info");
      document.getElementById("pob-code-input").value = "";
      await refreshServerStatus();
      await refreshCharacter();
    } catch (err) {
      showToast("Import Failed", err.message, "critical");
    } finally {
      importPobBtn.classList.remove("btn-spinning");
      importPobBtn.textContent = "Import PoB Build";
    }
  });
}

document.getElementById("compare-btn").addEventListener("click", compareItem);
document.getElementById("clear-compare-btn").addEventListener("click", clearCompare);

document.getElementById("toggle-raw-btn").addEventListener("click", () => {
  const wrap = document.getElementById("raw-textarea-wrap");
  const btn = document.getElementById("toggle-raw-btn");
  if (wrap.style.display === "none") {
    wrap.style.display = "block";
    btn.textContent = "Hide Raw Text";
  } else {
    wrap.style.display = "none";
    btn.textContent = "Show Raw Text";
  }
});

document.getElementById("latest-drop-hud").addEventListener("click", () => {
  const text = document.getElementById("item-text").value.trim();
  if (text) {
    compareItem();
  } else {
    api("/api/clipboard-item").then((clip) => {
      if (clip.available && clip.text) {
        document.getElementById("item-text").value = clip.text;
        showDropBanner(clip.itemName, clip.rarity);
        compareItem();
      }
    });
  }
});

document.getElementById("btn-create-trade-search").addEventListener("click", handleCreateTradeSearch);

// ---- Initial Load -------------------------------------------------

refreshCharacter();
refreshEvents();
refreshServerStatus();
setInterval(refreshEvents, 1500);
setInterval(refreshServerStatus, 1500);
connectWs();

// Auto-populate latest clipboard item on first load if available
api("/api/clipboard-item")
  .then((clip) => {
    if (clip.available && clip.text) {
      document.getElementById("item-text").value = clip.text;
      showDropBanner(clip.itemName, clip.rarity);
      compareItem();
    }
  })
  .catch(() => {});
