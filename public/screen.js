(function () {
  "use strict";

  var BACKOFF_MIN_MS = 500;
  var BACKOFF_MAX_MS = 5000;
  // A destructive button needs a second click between these two times after the first, so a double click can't
  // confirm itself and a stray click long after doesn't either.
  var CONFIRM_MIN_MS = 600;
  var CONFIRM_MAX_MS = 3000;
  // A host phase button (Next, +15, Close vote, Skip) acts at most once in this window.
  var DOUBLE_CLICK_MS = 600;
  var HOST_KEY_STORAGE = "spotTheHuman.hostKey";
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
    hRandom: $("h-random"),
    humans: $("humans"),
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

  // Take the host key out of the address bar so a mirrored screen never shows it. sessionStorage keeps it for
  // this tab only, so a reload still has the host bar.
  var hostKey = new URLSearchParams(location.search).get("host");
  if (hostKey) {
    try { sessionStorage.setItem(HOST_KEY_STORAGE, hostKey); } catch (e) { /* storage blocked: memory only */ }
  } else {
    try { hostKey = sessionStorage.getItem(HOST_KEY_STORAGE); } catch (e) { hostKey = null; }
  }
  if (location.search) {
    try { history.replaceState(null, "", location.pathname); } catch (e) { /* not fatal */ }
  }
  var isHost = typeof hostKey === "string" && hostKey !== "";
  els.hostBar.hidden = !isHost;

  var socket = null;
  var backoff = BACKOFF_MIN_MS;
  var view = null;
  var deadlineAt = null; // local clock time at which the phase ends
  // "random" lets the server pick one or two in secret, so not even the host knows.
  var humans = "random";
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
  }

  // The phone address comes from the server's PUBLIC_URL, so it is right even when this page is open on localhost.
  fetch("/public-url").then(function (r) { return r.text(); }).then(function (url) {
    els.joinUrl.textContent = url;
    els.joinUrl.hidden = false;
  }).catch(function () { /* the QR code still works */ });

  function renderRemoval(v) {
    var r = v.removal;
    els.removalMain.textContent = "";
    if (r && r.removed) {
      els.removalMain.appendChild(document.createTextNode("Player " + r.removed + " was… "));
      els.removalMain.appendChild(el("span", r.kind === "human" ? "human" : "agent", article(r.kind)));
    } else {
      els.removalMain.textContent = "Tie in the room vote, nobody is out";
    }
    // Only the room's phone votes remove a player; the players' posts before this are commentary. Saying so stops
    // a tie after six posts against one player from looking like a lost vote.
    var parts = v.players.map(function (p) { return p.letter + " " + (r && r.tally ? r.tally[p.letter] || 0 : 0); });
    els.removalTally.textContent = "The room's votes decide, not the players' posts: " + parts.join(" · ");
  }

  function renderGame(v) {
    // While the room votes the rows fill the screen, so the vote count sits in the progress line.
    els.progress.textContent = v.phase === "ended"
      ? "Game over"
      : v.phase === "voting"
        ? "Round " + v.round + " · vote · " + v.votedCount + " of " + v.rosterCount + " voted"
        : "Round " + v.round + " · prompt " + v.promptInRound;

    els.tiles.textContent = "";
    // While the room votes, each player is a row with their three answers from this round, so voters can compare.
    var rows = v.phase === "voting" ? v.roundAnswers : null;
    els.tiles.classList.toggle("rows", rows !== null);
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
      if (rows && rows[p.letter]) {
        var list = el("div", "round-answers");
        rows[p.letter].forEach(function (answer) { list.appendChild(el("p", "answer", answer)); });
        cell.appendChild(list);
      }
      els.tiles.appendChild(cell);
    });

    els.detail.textContent = "";
    if (v.phase === "answering" || v.phase === "revealed") {
      els.detail.appendChild(el("p", "prompt", v.prompt || ""));
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
    // The room sees this bar, so the human count only shows while it is being chosen.
    els.humans.hidden = p !== "lobby";
    els.next.disabled = !(p === "revealed" || p === "votePosts" || p === "removal");
    els.extend.disabled = !(p === "answering" || p === "voting");
    els.close.disabled = p !== "voting";
    els.skip.disabled = !(p === "answering" && v.canSkip);
    els.newGame.disabled = p === "lobby";
    if (p === "lobby") newGameConfirm.disarm();
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
    els.hRandom.setAttribute("aria-pressed", String(n === "random"));
  }

  els.h1.addEventListener("click", function () { setHumans(1); });
  els.h2.addEventListener("click", function () { setHumans(2); });
  els.hRandom.addEventListener("click", function () { setHumans("random"); });
  els.start.addEventListener("click", function () { command({ cmd: "start", humans: humans }); });
  // These carry the phase on screen, so the server drops a command for a phase that has closed. That alone doesn't
  // stop a double click: the new view reaches this page before the second click, which then carries the new
  // phase. So a phase command within DOUBLE_CLICK_MS of the last one is the second half of a double click and is
  // dropped here.
  var lastPhaseCommandAt = -Infinity;
  function phaseCommand(cmd) {
    var now = Date.now();
    if (now - lastPhaseCommandAt < DOUBLE_CLICK_MS) return;
    lastPhaseCommandAt = now;
    if (view) command({ cmd: cmd, phaseId: view.phaseId });
  }
  els.next.addEventListener("click", function () { phaseCommand("next"); });
  els.extend.addEventListener("click", function () { phaseCommand("extend"); });
  els.close.addEventListener("click", function () { phaseCommand("closeVote"); });
  els.skip.addEventListener("click", function () { phaseCommand("skip"); });

  // Arm on the first click (red, armedLabel); run on a click CONFIRM_MIN_MS to CONFIRM_MAX_MS later.
  // A click sooner than that is the second half of a double click and is ignored. confirm() is not used.
  function confirmButton(button, armedLabel, run) {
    var label = button.textContent;
    var armedAt = null;
    var timer = null;
    function disarm() {
      clearTimeout(timer);
      timer = null;
      armedAt = null;
      button.textContent = label;
      button.classList.remove("armed");
    }
    function click(needsConfirm) {
      var since = armedAt === null ? null : Date.now() - armedAt;
      if (!needsConfirm || (since !== null && since >= CONFIRM_MIN_MS && since <= CONFIRM_MAX_MS)) {
        disarm();
        run();
        return;
      }
      if (since !== null && since < CONFIRM_MIN_MS) return;
      armedAt = Date.now();
      button.textContent = armedLabel;
      button.classList.add("armed");
      clearTimeout(timer);
      timer = setTimeout(disarm, CONFIRM_MAX_MS);
    }
    return { click: click, disarm: disarm };
  }

  // New game ends a running game for everyone, so it needs a confirm unless the game is already over.
  var newGameConfirm = confirmButton(els.newGame, "Click again to end the game", function () { command({ cmd: "newGame" }); });
  els.newGame.addEventListener("click", function () {
    newGameConfirm.click(!!view && view.phase !== "ended" && view.phase !== "lobby");
  });

  // Reset wipes every phone, so it always needs a confirm.
  var resetConfirm = confirmButton(els.reset, "Click again to reset", function () { command({ cmd: "reset" }); });
  els.reset.addEventListener("click", function () { resetConfirm.click(true); });

  connect();
})();
