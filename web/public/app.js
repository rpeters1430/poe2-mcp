// Vanilla JS, no build step -- see CLAUDE.md/README for why (this repo has
// no frontend framework dependency anywhere else either).

const TOKEN = new URLSearchParams(location.search).get("token") || sessionStorage.getItem("poe2_web_token") || "";
if (TOKEN) sessionStorage.setItem("poe2_web_token", TOKEN);

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (TOKEN) headers["X-POE2-Token"] = TOKEN;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function fmtPercent(n) {
  return n === null || n === undefined ? "?" : `${n}%`;
}

function currentCharacterName() {
  return document.getElementById("character-input").value.trim() || undefined;
}

async function refreshCharacter() {
  const name = currentCharacterName();
  const summaryEl = document.getElementById("character-summary");
  const defEl = document.getElementById("defenses-summary");
  const offEl = document.getElementById("offense-summary");
  summaryEl.textContent = "Loading…";
  defEl.textContent = "–";
  offEl.textContent = "–";

  try {
    if (!name) {
      const active = await api("/api/current-character");
      if (active.name) document.getElementById("character-input").placeholder = `${active.name} (${active.source})`;
    }
    const query = name ? `?characterName=${encodeURIComponent(name)}` : "";
    const state = await api(`/api/character-state${query}`);
    summaryEl.textContent =
      `${state.name} -- ${state.characterClass}, level ${state.level}\n` +
      `League: ${state.league ?? "unknown"}${state.hardcore ? " (hardcore)" : ""}\n` +
      `Source: ${state.source}, fetched ${new Date(state.fetchedAt).toLocaleTimeString()}`;
  } catch (err) {
    summaryEl.innerHTML = `<span class="error">${err.message}</span>`;
  }

  try {
    const query = name ? `?characterName=${encodeURIComponent(name)}` : "";
    const def = await api(`/api/defenses${query}`);
    defEl.textContent =
      `Life: ${def.life}  Mana: ${def.mana}  ES: ${def.energyShield}\n` +
      `Armour: ${def.armour}  Evasion: ${def.evasion}\n` +
      `Res (F/C/L/Ch): ${def.resistances.fire.capped}% / ${def.resistances.cold.capped}% / ` +
      `${def.resistances.lightning.capped}% / ${def.resistances.chaos.capped}%`;
  } catch (err) {
    defEl.innerHTML = `<span class="error">${err.message}</span>`;
  }

  try {
    const query = name ? `?characterName=${encodeURIComponent(name)}` : "";
    const off = await api(`/api/offense-stats${query}`);
    offEl.textContent =
      `Accuracy: ${off.accuracyRating}\n` +
      `Attack speed: +${fmtPercent(off.increasedAttackSpeedPercent)}  Cast speed: +${fmtPercent(off.increasedCastSpeedPercent)}\n` +
      `Crit chance: +${fmtPercent(off.increasedCriticalStrikeChancePercent)}  Crit dmg: +${fmtPercent(off.criticalDamageBonusPercent)}`;
  } catch (err) {
    offEl.innerHTML = `<span class="error">${err.message}</span>`;
  }
}

async function refreshEvents() {
  const list = document.getElementById("events-list");
  try {
    const { events } = await api("/api/recent-events?limit=25");
    list.innerHTML = events
      .slice()
      .reverse()
      .map((e) => {
        const time = new Date(e.timestamp).toLocaleTimeString();
        const detail = e.data ? JSON.stringify(e.data) : "";
        return `<li><span class="type">${e.type}</span>${detail}<span class="time">${time}</span></li>`;
      })
      .join("");
  } catch (err) {
    list.innerHTML = `<li class="error">${err.message}</li>`;
  }
}

function renderComparison(result) {
  const el = document.getElementById("compare-result");
  if (result.error) {
    el.innerHTML = `<p class="error">${result.error}</p>`;
    return;
  }
  const rows = result.statDeltas
    .map((d) => {
      const cls = d.delta === null ? "" : d.delta > 0 ? "delta-pos" : d.delta < 0 ? "delta-neg" : "";
      const deltaText = d.delta === null ? "?" : d.delta > 0 ? `+${d.delta}` : `${d.delta}`;
      return `<tr><td>${d.stat}</td><td>${d.before ?? "–"}</td><td>${d.after ?? "–"}</td><td class="${cls}">${deltaText}</td></tr>`;
    })
    .join("");
  el.innerHTML =
    `<p>Slot: <strong>${result.slot ?? "unresolved"}</strong> -- ` +
    `${result.current ? result.current.name : "(empty)"} &rarr; ${result.candidate.name}</p>` +
    `<table><thead><tr><th>Stat</th><th>Before</th><th>After</th><th>Delta</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="hint">${result.note}</p>`;
}

async function compareItem() {
  const itemText = document.getElementById("item-text").value.trim();
  const slot = document.getElementById("slot-input").value.trim() || undefined;
  const characterName = currentCharacterName();
  const el = document.getElementById("compare-result");
  if (!itemText) {
    el.innerHTML = `<p class="error">Paste an item's text first.</p>`;
    return;
  }
  el.textContent = "Comparing…";
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

function connectWs() {
  const badge = document.getElementById("ws-status");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/ws${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
  const ws = new WebSocket(url);

  ws.onopen = () => {
    badge.textContent = "clipboard link: connected";
    badge.className = "badge badge-on";
  };
  ws.onclose = () => {
    badge.textContent = "clipboard link: disconnected, retrying…";
    badge.className = "badge badge-off";
    setTimeout(connectWs, 3000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "clipboard_item") {
        document.getElementById("item-text").value = msg.text;
        compareItem();
      }
    } catch {
      // ignore malformed frames
    }
  };
}

document.getElementById("refresh-btn").addEventListener("click", refreshCharacter);
document.getElementById("set-active-btn").addEventListener("click", async () => {
  const name = currentCharacterName();
  if (!name) return;
  try {
    await api("/api/active-character", { method: "POST", body: JSON.stringify({ characterName: name }) });
    await refreshCharacter();
  } catch (err) {
    document.getElementById("character-summary").innerHTML = `<span class="error">${err.message}</span>`;
  }
});
document.getElementById("compare-btn").addEventListener("click", compareItem);

refreshCharacter();
refreshEvents();
setInterval(refreshEvents, 3000);
connectWs();
