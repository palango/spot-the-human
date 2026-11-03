(function () {
  "use strict";

  var BACKOFF_MIN_MS = 500;
  var BACKOFF_MAX_MS = 5000;
  var RESET_CONFIRM_MS = 3000;
  var ERROR_SHOW_MS = 6000;

  var ERROR_TEXT = {
    "not-host": "Not the host screen.",
    "too-few-ready": "Not enough phones are ready.",
    "too-few-prompts": "Not enough unused prompts left.",
    "not-in-lobby": "A game is already running."
  };

  function $(id) { return document.getElementById(id); }

  var els = {
    conn: $("conn"),
    lobby: $("s-lobby"),
    game: $("s-game"),
    removal: $("s-removal"),
    joinUrl: $("join-url"),
    readyLine: $("ready-line"),
    progress: $("progress"),
    timer: $("timer"),
    tiles: $("tiles"),
    detail: $("detail"),
    removalMain: $("removal-main"),
    removalTally: $("removal-tally"),
    hostBar: $("host-bar"),
    h1: $("h1"),
    h2: $("h2"),
    start: $("b-start"),
    next: $("b-next"),
    extend: $("b-extend"),
    close: $("b-close"),
    skip: $("b-skip"),
    newGame: $("b-new"),
    reset: $("b-reset"),
    promptsLeft: $("prompts-left"),
    hostError: $("host-error")
  };

  // The host key lives in memory only; take it out of the address bar so a mirrored screen never shows it.
  var hostKey = new URLSearchParams(location.search).get("host");
  if (location.search) {
    try { history.replaceState(null, "", location.pathname); } catch (e) { /* not fatal */ }
  }
  var isHost = typeof hostKey === "string" && hostKey !== "";
  els.hostBar.hidden = !isHost;

  var socket = null;
  var backoff = BACKOFF_MIN_MS;
  var view = null;
  var deadlineAt = null; // local clock time at which the phase ends
  var humans = 2;
  var resetArmedUntil = 0;
  var errorTimer = null;

  function send(msg) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(msg));
  }

  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var ws = new WebSocket(proto + "//" + location.host + "/ws");
    socket = ws;
    ws.onopen = function () {
      if (socket !== ws) return;
      backoff = BACKOFF_MIN_MS;
      send(isHost ? { t: "hello-screen", hostKey: hostKey } : { t: "hello-screen" });
    };
    ws.onmessage = function (ev) {
      if (socket !== ws) return;
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === "view" && msg.view) {
        els.conn.hidden = true;
        view = msg.view;
        deadlineAt = typeof view.remainingMs === "number" ? Date.now() + view.remainingMs : null;
        render();
      } else if (msg.t === "error" && typeof msg.reason === "string") {
        showError(msg.reason);
      }
    };
    ws.onclose = function () {
      if (socket !== ws) return;
      socket = null;
      els.conn.hidden = false;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
    ws.onerror = function () { /* onclose follows */ };
  }

  function showError(reason) {
    els.hostError.textContent = ERROR_TEXT[reason] || ("Error: " + reason);
    clearTimeout(errorTimer);
    errorTimer = setTimeout(function () { els.hostError.textContent = ""; }, ERROR_SHOW_MS);
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function article(kind) { return kind === "human" ? "a human" : "an agent"; }

  function render() {
    var v = view;
    if (!v) return;
    els.lobby.hidden = v.phase !== "lobby";
    els.game.hidden = v.phase === "lobby" || v.phase === "removal";
    els.removal.hidden = v.phase !== "removal";
    if (v.phase === "lobby") renderLobby(v);
    else if (v.phase === "removal") renderRemoval(v);
    else renderGame(v);
    renderHostBar(v);
    tick();
  }

  function renderLobby(v) {
    els.readyLine.textContent = v.readyCount + " ready";
    // Behind the tunnel the page's own address is the join address; on localhost the QR code carries it.
    var host = location.hostname;
    var local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    els.joinUrl.hidden = local;
    els.joinUrl.textContent = local ? "" : location.origin;
  }

  function renderRemoval(v) {
    var r = v.removal;
    els.removalMain.textContent = "";
    if (r && r.removed) {
      els.removalMain.appendChild(document.createTextNode("Player " + r.removed + " was… "));
      els.removalMain.appendChild(el("span", r.kind === "human" ? "human" : "agent", article(r.kind)));
    } else {
      els.removalMain.textContent = "Tie, nobody is out";
    }
    var parts = v.players.map(function (p) { return p.letter + " " + (r && r.tally ? r.tally[p.letter] || 0 : 0); });
    els.removalTally.textContent = "votes: " + parts.join(" · ");
  }

  function renderGame(v) {
    els.progress.textContent = v.phase === "ended"
      ? "Game over"
      : "Round " + v.round + " · prompt " + v.promptInRound;

    els.tiles.textContent = "";
    v.players.forEach(function (p) {
      var cell = el("div", "cell");
      var cls = "tile" + (p.out ? " out" : "") + (p.revealedKind ? " revealed " + p.revealedKind : "");
      var tile = el("div", cls);
      tile.appendChild(el("span", "letter", p.letter));
      tile.appendChild(el("span", "kind", p.revealedKind || ""));
      cell.appendChild(tile);
      if (v.phase === "revealed" && !p.out && v.answers) {
        cell.appendChild(el("p", "answer", v.answers[p.letter] || "…"));
      }
      els.tiles.appendChild(cell);
    });

    els.detail.textContent = "";
    if (v.phase === "answering" || v.phase === "revealed") {
      els.detail.appendChild(el("p", "prompt", v.prompt || ""));
    } else if (v.phase === "voting") {
      els.detail.appendChild(el("p", "status", v.votedCount + " of " + v.rosterCount + " voted"));
    } else if (v.phase === "votePosts") {
      var posts = el("div", "posts");
      (v.posts || []).forEach(function (post) {
        var line = el("p", "post");
        line.appendChild(el("b", "", post.target
          ? "Player " + post.letter + " votes " + post.target + ": "
          : "Player " + post.letter + ": "));
        line.appendChild(document.createTextNode(post.reason));
        posts.appendChild(line);
      });
      els.detail.appendChild(posts);
    } else if (v.phase === "ended") {
      els.detail.appendChild(el("p", "winner", v.winner === "humans" ? "The humans win" : "The agents win"));
    }
  }

  function tick() {
    var text = "";
    if (deadlineAt !== null && view && view.phase !== "lobby" && view.phase !== "removal") {
      text = String(Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)));
    }
    els.timer.textContent = text;
  }
  setInterval(tick, 250);

  // Host bar

  function renderHostBar(v) {
    if (!isHost) return;
    var p = v.phase;
    els.start.disabled = p !== "lobby";
    els.h1.disabled = els.h2.disabled = p !== "lobby";
    els.next.disabled = !(p === "revealed" || p === "votePosts" || p === "removal");
    els.extend.disabled = !(p === "answering" || p === "voting");
    els.close.disabled = p !== "voting";
    els.skip.disabled = !(p === "answering" && v.canSkip);
    els.newGame.disabled = p === "lobby";
    els.promptsLeft.textContent = v.promptsLeft + " prompts left";
  }

  function command(msg) {
    msg.t = "host";
    send(msg);
  }

  function setHumans(n) {
    humans = n;
    els.h1.setAttribute("aria-pressed", String(n === 1));
    els.h2.setAttribute("aria-pressed", String(n === 2));
  }

  els.h1.addEventListener("click", function () { setHumans(1); });
  els.h2.addEventListener("click", function () { setHumans(2); });
  els.start.addEventListener("click", function () { command({ cmd: "start", humans: humans }); });
  els.next.addEventListener("click", function () { command({ cmd: "next" }); });
  els.extend.addEventListener("click", function () { command({ cmd: "extend" }); });
  els.close.addEventListener("click", function () { command({ cmd: "closeVote" }); });
  els.skip.addEventListener("click", function () { command({ cmd: "skip" }); });
  els.newGame.addEventListener("click", function () { command({ cmd: "newGame" }); });

  // Reset wipes every phone: ask for a second click within 3 s instead of confirm().
  els.reset.addEventListener("click", function () {
    if (Date.now() < resetArmedUntil) {
      resetArmedUntil = 0;
      disarmReset();
      command({ cmd: "reset" });
      return;
    }
    resetArmedUntil = Date.now() + RESET_CONFIRM_MS;
    els.reset.textContent = "Click again to reset";
    els.reset.classList.add("armed");
    setTimeout(disarmReset, RESET_CONFIRM_MS);
  });

  function disarmReset() {
    if (Date.now() < resetArmedUntil) return; // armed again since this timer was set
    els.reset.textContent = "Reset";
    els.reset.classList.remove("armed");
  }

  connect();
})();
