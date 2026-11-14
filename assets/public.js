/* RugClaw Observatory — read-only public spectator.
 * Fetches a sanitised static snapshot. It has no credentials, cannot trade,
 * and never contacts a wallet, exchange or trading endpoint.
 */
(() => {
  "use strict";

  const DATA_URL = "./data.json";
  const SCHEMA = "rugclaw-public-v1";
  const REFRESH_MS = 60_000;
  const STALE_AFTER_S = 30 * 60;
  const OFFLINE_AFTER_S = 90 * 60;
  const $ = (id) => document.getElementById(id);

  const state = {
    data: null,
    lastGoodAt: 0,
    loading: false,
    chart: null,
    chartFrame: 0,
  };

  /* ---------------------------------------------------------------- format */

  const ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
  }

  function num(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function money(value, digits = 2, signed = false) {
    const parsed = num(value);
    if (parsed === null) return "—";
    const absolute = Math.abs(parsed).toLocaleString("en-IE", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    if (parsed < 0) return `-€${absolute}`;
    if (signed && parsed > 0) return `+€${absolute}`;
    return `€${absolute}`;
  }

  function pct(value, digits = 1, signed = true) {
    const parsed = num(value);
    if (parsed === null) return "—";
    const sign = signed && parsed > 0 ? "+" : "";
    return `${sign}${parsed.toFixed(digits)}%`;
  }

  function duration(value) {
    const parsed = num(value);
    if (parsed === null) return "—";
    const total = Math.max(0, Math.round(parsed));
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}m ${total % 60}s`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  function age(value) {
    const parsed = num(value);
    if (parsed === null) return "—";
    const total = Math.max(0, Math.round(parsed));
    if (total < 45) return "just now";
    if (total < 3600) return `${Math.round(total / 60)}m ago`;
    if (total < 86400) return `${Math.round(total / 3600)}h ago`;
    return `${Math.round(total / 86400)}d ago`;
  }

  const DATE_UTC = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
  const DATE_YEAR_UTC = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const TIME_UTC = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });

  function stamp(value, withYear = false) {
    const parsed = num(value);
    if (parsed === null) return "—";
    const date = new Date(parsed * 1000);
    if (Number.isNaN(date.getTime())) return "—";
    const day = (withYear ? DATE_YEAR_UTC : DATE_UTC).format(date);
    return `${day} · ${TIME_UTC.format(date)} UTC`;
  }

  function compactUsd(value) {
    const parsed = num(value);
    if (parsed === null) return "—";
    const absolute = Math.abs(parsed);
    if (absolute >= 1e9) return `$${(parsed / 1e9).toFixed(2)}B`;
    if (absolute >= 1e6) return `$${(parsed / 1e6).toFixed(2)}M`;
    if (absolute >= 1e3) return `$${(parsed / 1e3).toFixed(1)}K`;
    return `$${parsed.toFixed(2)}`;
  }

  function usdPrice(value) {
    const parsed = num(value);
    if (parsed === null || parsed <= 0) return "—";
    if (parsed >= 1) return `$${parsed.toLocaleString("en-US", { maximumFractionDigits: 3 })}`;
    if (parsed >= 0.01) return `$${parsed.toFixed(4)}`;
    if (parsed >= 0.0001) return `$${parsed.toFixed(6)}`;
    return `$${parsed.toExponential(2)}`;
  }

  function toneFor(value) {
    const parsed = num(value);
    if (parsed === null || parsed === 0) return "";
    return parsed > 0 ? "pos" : "neg";
  }

  function toneText(value) {
    const parsed = num(value);
    if (parsed === null || parsed === 0) return "";
    return parsed > 0 ? "tone-mint" : "tone-coral";
  }

  function initials(symbol) {
    const clean = String(symbol || "?").replace(/[^A-Za-z0-9]/g, "");
    return (clean.slice(0, 2) || "?").toUpperCase();
  }

  function humanise(value) {
    return String(value || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function setText(id, value) {
    const node = $(id);
    if (node) node.textContent = value;
  }

  function setClass(id, className) {
    const node = $(id);
    if (node) node.className = className;
  }

  function avatar(symbol) {
    return `<span class="token-avatar" aria-hidden="true">${esc(initials(symbol))}</span>`;
  }

  /* ---------------------------------------------------------------- status */

  function effectiveStatus() {
    const generated = num(state.data?.generated_at);
    if (generated === null) return { label: "CONNECTING", tone: "offline" };
    const ageSeconds = Date.now() / 1000 - generated;
    if (ageSeconds > OFFLINE_AFTER_S) return { label: "SNAPSHOT STALE", tone: "offline" };
    if (ageSeconds > STALE_AFTER_S) return { label: "SNAPSHOT DELAYED", tone: "attention" };
    return state.data.status || { label: "UNKNOWN", tone: "offline" };
  }

  function renderStatus() {
    const status = effectiveStatus();
    const pill = $("statusPill");
    if (!pill) return;
    pill.className = `status-pill tone-${String(status.tone || "offline").replace(/[^a-z-]/gi, "")}`;
    setText("statusLabel", String(status.label || "UNKNOWN").toUpperCase());
  }

  function tickFreshness() {
    renderStatus();
    const generated = num(state.data?.generated_at);
    if (generated === null) {
      setText("freshness", "Read-only · sanitised");
      return;
    }
    const ageSeconds = Math.max(0, Date.now() / 1000 - generated);
    const node = $("freshness");
    if (node) {
      node.textContent = `Sanitised · ${age(ageSeconds)}`;
      node.className = ageSeconds > STALE_AFTER_S ? "tone-amber" : "";
    }
  }

  /* ----------------------------------------------------------------- chart */

  function chartGeometry() {
    const canvas = $("equityCanvas");
    const chart = state.chart;
    if (!canvas || !chart) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { canvas, chart, width: rect.width, height: rect.height };
  }

  function drawChart() {
    const canvas = $("equityCanvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const points = (state.data?.equity || [])
      .map((point) => ({
        ts: num(point.ts),
        value: num(point.equity_eur),
      }))
      .filter((point) => point.ts !== null && point.value !== null)
      .sort((a, b) => a.ts - b.ts);

    state.chart = null;
    const empty = $("chartEmpty");
    if (empty) empty.hidden = points.length > 0;
    if (!points.length) return;

    const starting = num(state.data?.account?.starting_eur);
    const values = points.map((point) => point.value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (starting !== null) {
      min = Math.min(min, starting);
      max = Math.max(max, starting);
    }
    if (max - min < 0.5) {
      const middle = (max + min) / 2;
      min = middle - 0.5;
      max = middle + 0.5;
    }
    const room = (max - min) * 0.14;
    min -= room;
    max += room;

    const padLeft = 3;
    const padRight = 3;
    const padTop = 12;
    const padBottom = 10;
    const plotWidth = Math.max(1, width - padLeft - padRight);
    const plotHeight = Math.max(1, height - padTop - padBottom);
    const xFor = (index) =>
      padLeft + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
    const yFor = (value) => padTop + ((max - value) / (max - min)) * plotHeight;
    const rising = points[points.length - 1].value >= points[0].value;
    const stroke = rising ? "#74f0c6" : "#ff8072";

    if (starting !== null && starting >= min && starting <= max) {
      const baselineY = yFor(starting);
      ctx.save();
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(231, 241, 245, 0.18)";
      ctx.beginPath();
      ctx.moveTo(padLeft, baselineY);
      ctx.lineTo(width - padRight, baselineY);
      ctx.stroke();
      ctx.restore();
    }

    const area = ctx.createLinearGradient(0, padTop, 0, height - padBottom);
    area.addColorStop(0, rising ? "rgba(116, 240, 198, 0.22)" : "rgba(255, 128, 114, 0.20)");
    area.addColorStop(1, "rgba(6, 9, 13, 0)");

    ctx.beginPath();
    points.forEach((point, index) => {
      const x = xFor(index);
      const y = yFor(point.value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(xFor(points.length - 1), height - padBottom);
    ctx.lineTo(xFor(0), height - padBottom);
    ctx.closePath();
    ctx.fillStyle = area;
    ctx.fill();

    ctx.beginPath();
    points.forEach((point, index) => {
      const x = xFor(index);
      const y = yFor(point.value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = stroke;
    ctx.shadowColor = stroke;
    ctx.shadowBlur = 9;
    ctx.stroke();
    ctx.shadowBlur = 0;

    const last = points[points.length - 1];
    const lastX = xFor(points.length - 1);
    const lastY = yFor(last.value);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = rising ? "rgba(116, 240, 198, 0.15)" : "rgba(255, 128, 114, 0.15)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lastX, lastY, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = stroke;
    ctx.fill();

    state.chart = { points, xFor, yFor, width, height, padLeft, padRight, padTop, padBottom };

    const firstStamp = stamp(points[0].ts);
    const lastStamp = stamp(last.ts);
    setText("chartRange", `${firstStamp} → ${lastStamp}`);
    setText("chartPoints", `${points.length} observation${points.length === 1 ? "" : "s"}`);
    canvas.setAttribute(
      "aria-label",
      `Virtual equity curve. ${points.length} observations from ${firstStamp} to ${lastStamp}. Latest ${money(last.value)}.`
    );
  }

  function scheduleChart() {
    if (state.chartFrame) cancelAnimationFrame(state.chartFrame);
    state.chartFrame = requestAnimationFrame(() => {
      state.chartFrame = 0;
      drawChart();
    });
  }

  function bindChart() {
    const canvas = $("equityCanvas");
    const wrap = canvas?.parentElement;
    const tip = $("chartTip");
    if (!canvas || !wrap || !tip) return;

    const hide = () => {
      tip.hidden = true;
    };

    canvas.addEventListener("pointermove", (event) => {
      const geometry = chartGeometry();
      if (!geometry) return;
      const chart = geometry.chart;
      const rect = geometry.canvas.getBoundingClientRect();
      const pointerX = Math.min(Math.max(event.clientX - rect.left, chart.padLeft), rect.width - chart.padRight);
      let nearest = 0;
      let best = Infinity;
      chart.points.forEach((point, index) => {
        const distance = Math.abs(chart.xFor(index) - pointerX);
        if (distance < best) {
          best = distance;
          nearest = index;
        }
      });
      const point = chart.points[nearest];
      if (!point) return;
      tip.innerHTML = `<b>${money(point.value)}</b><br><span>${stamp(point.ts)}</span>`;
      const x = Math.min(Math.max(chart.xFor(nearest), 82), rect.width - 82);
      tip.style.left = `${x}px`;
      tip.style.top = `${Math.max(36, chart.yFor(point.value))}px`;
      tip.hidden = false;
    });
    canvas.addEventListener("pointerleave", hide);
    canvas.addEventListener("pointercancel", hide);

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(() => {
        hide();
        scheduleChart();
      });
      observer.observe(wrap);
    } else {
      window.addEventListener("resize", scheduleChart);
    }
  }

  /* ------------------------------------------------------------------ hero */

  function renderHero(data) {
    const account = data.account || {};
    const round = data.round || {};
    const status = data.status || {};
    const equity = num(account.equity_eur);
    const starting = num(account.starting_eur);
    const deposits = num(account.owner_deposits_eur) || 0;
    const baseline = (starting || 0) + deposits;
    const delta = equity === null ? null : equity - baseline;

    setText("heroEquity", money(equity));
    const deltaNode = $("heroDelta");
    if (deltaNode) {
      deltaNode.textContent = money(delta, 2, true);
      deltaNode.className = toneFor(delta);
    }
    setText("heroRoi", `${pct(account.roi_pct, 1, true)} realised ROI`);
    setText(
      "heroFunded",
      deposits > 0 ? `${money(deposits)} owner funded` : "€100 virtual starting capital"
    );
    setText(
      "equitySub",
      round.number
        ? `Round ${String(round.number).padStart(2, "0")} · ${String(status.label || "paper model")}`
        : String(status.label || "Waiting for the first training round")
    );

    const points = (data.equity || [])
      .map((point) => num(point.equity_eur))
      .filter((value) => value !== null);
    const peak = points.length ? Math.max(...points, starting || 0) : starting;
    setText("miniStarting", money(starting));
    setText("miniPeak", money(peak));
    setText("miniClosed", String(num(account.closed) ?? "—"));
    setText("lastSync", `Last published ${stamp(data.generated_at)}`);

    tickFreshness();
  }

  /* ----------------------------------------------------------------- stats */

  function renderStats(data) {
    const account = data.account || {};
    const round = data.round || {};
    const wins = num(account.wins);
    const losses = num(account.losses);
    const fees = num(account.fees_eur);
    const slippage = num(account.slippage_eur);
    const costs = fees === null && slippage === null ? null : (fees || 0) + (slippage || 0);

    setText("statEquity", money(account.equity_eur));
    setText(
      "statEquitySub",
      `${num(account.open) ?? 0} open position${num(account.open) === 1 ? "" : "s"} · ${money(account.cash_eur)} cash`
    );
    setText("statRealised", money(account.realised_eur, 2, true));
    const realisedNode = $("statRealised");
    if (realisedNode) realisedNode.className = `stat-value ${toneText(account.realised_eur)}`;
    setText("statRealisedSub", "lifetime net after modelled costs");
    setText(
      "statWinRate",
      num(account.win_rate) === null ? "—" : `${(num(account.win_rate) * 100).toFixed(1)}%`
    );
    setText(
      "statWinSub",
      wins === null && losses === null
        ? "no closed trades yet"
        : `${wins ?? 0} wins · ${losses ?? 0} losses`
    );
    setText("statClosed", String(num(account.closed) ?? "—"));
    setText(
      "statClosedSub",
      round.number ? `${num(round.closed_trades) ?? 0} in the current round` : "all kept in the ledger"
    );
    setText("statCash", money(account.cash_eur));
    setText("statCashSub", "uncommitted paper capital");
    setText("statHold", duration(account.mean_hold_s));
    setText("statBest", money(account.best_trade_eur, 2, true));
    const bestNode = $("statBest");
    if (bestNode) bestNode.className = `stat-value ${toneText(account.best_trade_eur) || "tone-mint"}`;
    setText("statWorst", `Worst ${money(account.worst_trade_eur, 2, true)}`);
    setText("statCosts", money(costs));
    setText(
      "statCostsSub",
      costs === null
        ? "fees + slippage"
        : `fees ${money(fees)} · slippage ${money(slippage)}`
    );
  }

  /* ----------------------------------------------------------------- round */

  function roundTone(status) {
    if (status === "active") return { className: "round-badge is-active", label: "LIVE ROUND" };
    if (status === "awaiting_owner")
      return { className: "round-badge is-awaiting", label: "AWAITING OWNER" };
    if (status === "closed") return { className: "round-badge", label: "CLOSED" };
    return { className: "round-badge", label: String(status || "WAITING").toUpperCase() };
  }

  function renderRound(data) {
    const round = data.round || {};
    const number = num(round.number);
    const tone = roundTone(round.status);
    const badge = $("roundBadge");
    if (badge) {
      badge.className = tone.className;
      badge.textContent = tone.label;
    }
    setText("roundTitle", number === null ? "Round —" : `Round ${String(number).padStart(2, "0")}`);
    setText("roundWatermark", number === null ? "00" : String(number).padStart(2, "0"));
    setText(
      "roundSub",
      number === null
        ? "No training round has been opened yet."
        : round.status === "awaiting_owner"
          ? "New entries are paused while the owner reviews the session and its allowance request."
          : `Started ${stamp(round.started, true)} · capital and history carry across rounds.`
    );
    setText("roundNet", money(round.net_eur, 2, true));
    const netNode = $("roundNet");
    if (netNode) netNode.className = toneText(round.net_eur);
    setText("roundClosed", String(num(round.closed_trades) ?? "—"));
    setText("roundWins", String(num(round.wins) ?? "—"));
    setText("roundLosses", String(num(round.losses) ?? "—"));
    setText("roundDeposits", money(round.deposits_eur));
    setText("roundStarted", stamp(round.started, true));
    setText(
      "roundNote",
      round.status === "awaiting_owner"
        ? "A private report has been sent. No new paper entry is opened until the owner adds a virtual allowance or starts a new round."
        : "Each round is bounded and preserved. A new round never resets the account or deletes history."
    );
  }

  /* ------------------------------------------------------------- positions */

  function meter(label, value) {
    const parsed = num(value);
    if (parsed === null) {
      return `<div class="momentum-item"><span>${esc(label)}</span><div class="meter"><i></i></div><b>—</b></div>`;
    }
    const half = Math.min(50, Math.max(0, (Math.abs(parsed) / 15) * 50));
    const bar = `<i class="${parsed >= 0 ? "pos" : "neg"}" style="width:${half.toFixed(2)}%"></i>`;
    return `<div class="momentum-item"><span>${esc(label)}</span><div class="meter">${bar}</div><b class="${toneText(parsed)}">${pct(parsed, 1, true)}</b></div>`;
  }

  function decisionClass(action) {
    const clean = String(action || "").toUpperCase();
    if (clean.includes("SELL")) return "decision-badge sell";
    if (clean.includes("HOLD")) return "decision-badge hold";
    return "decision-badge";
  }

  function renderPositions(data) {
    const grid = $("positionGrid");
    if (!grid) return;
    const positions = Array.isArray(data.positions) ? data.positions : [];
    if (!positions.length) {
      grid.innerHTML = `<div class="empty-book">
        <span class="empty-orbit" aria-hidden="true"></span>
        <div><strong>No open paper positions.</strong><p>The engine is scanning the public market. Every completed trade remains in the record below.</p></div>
      </div>`;
      setText(
        "bookNote",
        "Flat book · the engine only opens a position when its deterministic risk checks pass."
      );
      return;
    }
    setText(
      "bookNote",
      `${positions.length} of 5 concurrent simulations · each marked and managed independently.`
    );
    grid.innerHTML = positions
      .map((position) => {
        const unrealised = num(position.unrealised_eur);
        const momentum = position.momentum || {};
        const reason = position.decision_reason
          ? String(position.decision_reason)
          : "Awaiting the next verified observation.";
        return `<article class="position-card">
          <div class="position-top">
            <div class="token-lockup">${avatar(position.symbol)}<div><strong>${esc(position.symbol)}</strong><small>PAPER POSITION · ${esc(String(position.mark_status || "pool-model mark").toUpperCase())}</small></div></div>
            <span class="${decisionClass(position.decision)}">${esc(position.decision || "AWAIT")}</span>
          </div>
          <div class="position-pnl">
            <b class="${toneText(unrealised)}">${money(unrealised, 2, true)}</b>
            <span class="${toneText(unrealised)}">${pct(position.unrealised_pct, 1, true)} vs ${money(position.cost_eur)} committed</span>
          </div>
          <div class="position-metrics">
            <div><span>Cost</span><b>${money(position.cost_eur)}</b></div>
            <div><span>Value</span><b>${money(position.value_eur)}</b></div>
            <div><span>Held</span><b>${duration(position.held_s)}</b></div>
          </div>
          <div class="momentum-row" aria-label="Observed momentum windows">
            ${meter("60s", momentum.return_60s_pct)}
            ${meter("180s", momentum.return_180s_pct)}
            ${meter("300s", momentum.return_300s_pct)}
          </div>
          <p class="position-why"><b>${esc(position.decision || "AWAIT")}.</b> ${esc(reason)} Evidence uses recorded observations, never invented windows.</p>
        </article>`;
      })
      .join("");
  }

  /* ---------------------------------------------------------------- trades */

  function renderTrades(data) {
    const body = $("tradesBody");
    if (!body) return;
    const trades = Array.isArray(data.recent_trades) ? data.recent_trades : [];
    if (!trades.length) {
      body.innerHTML = `<tr><td colspan="5" class="table-empty">No completed paper trade yet. The first one will be shown exactly as it closes.</td></tr>`;
      return;
    }
    body.innerHTML = trades
      .map((trade) => {
        const net = num(trade.net_eur);
        const evidence = humanise(trade.exit_reason) || "Recorded exit";
        return `<tr>
          <td><div class="trade-token">${avatar(trade.symbol)}${esc(trade.symbol)}</div></td>
          <td><span class="when">${stamp(trade.ts)}</span></td>
          <td class="right"><span class="net ${toneFor(net)}">${money(net, 2, true)}</span></td>
          <td><span class="evidence">${esc(evidence)}</span></td>
          <td class="right"><span class="held">${duration(trade.held_s)}</span></td>
        </tr>`;
      })
      .join("");
  }

  /* --------------------------------------------------------------- lessons */

  function renderLearning(data) {
    const lessons = Array.isArray(data.lessons) ? data.lessons : [];
    const improvements = Array.isArray(data.improvements) ? data.improvements : [];
    setText("lessonCount", String(lessons.length));
    setText("improvementCount", String(improvements.length));

    const lessonNode = $("lessonList");
    if (lessonNode) {
      lessonNode.innerHTML = lessons.length
        ? lessons
            .map((lesson) => {
              const net = num(lesson.net_eur);
              return `<div class="lesson-card">
                <div class="lesson-top">
                  <strong>${esc(lesson.observation || "Trade lesson recorded.")}</strong>
                  <span class="${toneText(net)}">${money(net, 2, true)}</span>
                </div>
                <div class="lesson-meta">
                  ${lesson.symbol ? `<span>${esc(lesson.symbol)}</span>` : ""}
                  <span>${duration(lesson.holding_s)} hold</span>
                  <span>${esc(humanise(lesson.exit) || "exit recorded")}</span>
                </div>
              </div>`;
            })
            .join("")
        : `<p class="empty-copy">No lesson has been recorded yet. Lessons are written from completed trades, not marketing copy.</p>`;
    }

    const improvementNode = $("improvementList");
    if (improvementNode) {
      improvementNode.innerHTML = improvements.length
        ? improvements
            .map(
              (item) => `<div class="improvement-card">
                <div class="param"><b>${esc(item.parameter || "Proposed change")}</b><span>${esc(item.value ?? "—")}</span></div>
                <p>${esc(item.hypothesis || "Forward-test hypothesis recorded.")}</p>
                <small>${esc(item.promotion || "Forward-test only · not promoted on a single result")}</small>
              </div>`
            )
            .join("")
        : `<p class="empty-copy">No forward experiment has been proposed yet. Ideas require evidence before promotion.</p>`;
    }
  }

  /* ----------------------------------------------------------------- radar */

  function renderRadar(data) {
    const body = $("radarBody");
    if (!body) return;
    const radar = Array.isArray(data.radar) ? data.radar : [];
    if (!radar.length) {
      body.innerHTML = `<tr><td colspan="7" class="table-empty">No public market observations in this snapshot.</td></tr>`;
      return;
    }
    body.innerHTML = radar
      .map((row) => {
        const share = num(row.buy_share);
        const sharePct = share === null ? null : Math.min(100, Math.max(0, share * 100));
        return `<tr>
          <td><div class="trade-token">${avatar(row.symbol)}${esc(row.symbol)}</div></td>
          <td class="right"><span class="net">${usdPrice(row.price_usd)}</span></td>
          <td class="right"><span class="net ${toneFor(row.price_change_m5_pct)}">${pct(row.price_change_m5_pct, 1, true)}</span></td>
          <td class="right"><span class="net ${toneFor(row.price_change_h1_pct)}">${pct(row.price_change_h1_pct, 1, true)}</span></td>
          <td class="right"><span class="net">${compactUsd(row.liquidity_usd)}</span></td>
          <td class="right"><span class="net">${compactUsd(row.volume_h1_usd)}</span></td>
          <td><div class="buy-meter"><span class="buy-track"><i style="width:${sharePct === null ? 0 : sharePct.toFixed(1)}%"></i></span><b>${sharePct === null ? "—" : `${sharePct.toFixed(0)}%`}</b></div></td>
        </tr>`;
      })
      .join("");
  }

  /* ---------------------------------------------------------------- render */

  function render(data) {
    renderStatus();
    renderHero(data);
    renderStats(data);
    renderRound(data);
    renderPositions(data);
    renderTrades(data);
    renderLearning(data);
    renderRadar(data);
    setText("footGenerated", stamp(data.generated_at, true));
    setText("disclaimerText", data.disclaimer || "Simulation only. No real funds, wallet, orders or blockchain transactions exist.");
    setText("scopeText", data.scope || "Sanitised spectator view of a simulated Solana paper-trading experiment.");
    scheduleChart();
  }

  function renderUnavailable() {
    renderStatus();
    const status = $("statusPill");
    if (status) {
      status.className = "status-pill tone-offline";
      setText("statusLabel", "SNAPSHOT UNAVAILABLE");
    }
    if (!state.data) {
      setText("equitySub", "The sanitised snapshot is not available right now.");
      setText("lastSync", "Retrying automatically every 60 seconds");
      const empty = $("chartEmpty");
      if (empty) {
        empty.hidden = false;
        empty.textContent = "No sanitised snapshot available. This page will retry automatically.";
      }
      const book = $("positionGrid");
      if (book) {
        book.innerHTML = `<div class="empty-book"><span class="empty-orbit" aria-hidden="true"></span><div><strong>Snapshot unavailable.</strong><p>The read-only feed could not be loaded. No trading interface or credentials exist on this page.</p></div></div>`;
      }
    } else {
      setText("freshness", "Showing last good snapshot · retrying");
    }
  }

  /* ------------------------------------------------------------------ load */

  async function load() {
    if (state.loading) return;
    state.loading = true;
    try {
      const response = await fetch(`${DATA_URL}?v=${Math.floor(Date.now() / 60_000)}`, {
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok) throw new Error(`Snapshot request failed (${response.status})`);
      const data = await response.json();
      if (!data || data.schema !== SCHEMA || data.paper_only !== true || data.mode !== "PAPER TRADING") {
        throw new Error("Snapshot failed schema or paper-trading checks");
      }
      state.data = data;
      state.lastGoodAt = Date.now();
      render(data);
      document.body.dataset.snapshot = "ready";
    } catch (error) {
      console.warn("RugClaw Observatory:", error.message);
      renderUnavailable();
      document.body.dataset.snapshot = "unavailable";
    } finally {
      state.loading = false;
    }
  }

  /* ------------------------------------------------------------------- ui */

  function reveal() {
    const nodes = Array.from(document.querySelectorAll(".reveal"));
    if (!nodes.length) return;
    if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      nodes.forEach((node) => node.classList.add("in"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -6% 0px" }
    );
    nodes.forEach((node) => observer.observe(node));
  }

  function boot() {
    reveal();
    bindChart();
    load();
    window.setInterval(load, REFRESH_MS);
    window.setInterval(tickFreshness, 10_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - state.lastGoodAt > REFRESH_MS) {
        load();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
