(function () {
  "use strict";

  var ANSWER_DEBOUNCE_MS = 300;
  var BACKOFF_MIN_MS = 500;
  var BACKOFF_MAX_MS = 5000;
  var STORAGE_KEY = "spotTheHuman.phoneId";
  var LOOK_PHASES = ["revealed", "votePosts", "removal", "ended"];

  function $(id) { return document.getElementById(id); }

  var els = {
    conn: $("conn"),
    loading: $("s-loading"),
    lobby: $("s-lobby"),
    out: $("s-out"),
    answering: $("s-answering"),
    look: $("s-look"),
    voting: $("s-voting"),
    role: $("role"),
    readyToggle: $("ready-toggle"),
    readyCount: $("ready-count"),
    rejoinForm: $("rejoin-form"),
    rejoinCode: $("rejoin-code"),
    rejoinError: $("rejoin-error"),
    prompt: $("answer-prompt"),
    answerTimer: $("answer-timer"),
    answerText: $("answer-text"),
    answerSend: $("answer-send"),
    answerSent: $("answer-sent"),
    voteTimer: $("vote-timer"),
    voteButtons: $("vote-buttons"),
    voteReason: $("vote-reason"),
    roleCard: $("role-card"),
    roleText: $("role-text"),
    roleCode: $("role-code")
  };
  var sections = [els.loading, els.lobby, els.out, els.answering, els.look, els.voting];

  var storage = {
    get: function () {
      try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
    },
    set: function (id) {
      try { localStorage.setItem(STORAGE_KEY, id); } catch (e) { /* storage blocked */ }
    },
    clear: function () {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* storage blocked */ }
    }
  };

  var socket = null;
  var backoff = BACKOFF_MIN_MS;
  var view = null;
  var deadlineAt = null; // local clock time at which the phase ends
  var holding = false;

  // Per-phase input state: the page owns the fields once the phase has filled them.
  var filledPhaseId = null;
  var voteTarget = null;
  var draftTimer = null;
  var voteTimer = null;

  function send(msg) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  }

  function connect() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var ws = new WebSocket(proto + "//" + location.host + "/ws");
    socket = ws;
    ws.onopen = function () {
      if (socket !== ws) return;
      backoff = BACKOFF_MIN_MS;
      var id = storage.get();
      send(id ? { t: "hello-phone", phoneId: id } : { t: "hello-phone" });
    };
    ws.onmessage = function (ev) {
      if (socket !== ws) return;
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handle(msg);
    };
    ws.onclose = function (ev) {
      if (socket !== ws) return;
      socket = null;
      els.conn.hidden = false;
      // The host reset the game: this phone is unknown now, so start fresh.
      if (ev.code === 4000) { storage.clear(); view = null; filledPhaseId = null; }
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    };
    ws.onerror = function () { /* onclose follows */ };
  }

  function handle(msg) {
    if (msg.t === "you" && typeof msg.phoneId === "string") {
      storage.set(msg.phoneId);
    } else if (msg.t === "view" && msg.view) {
      els.conn.hidden = true;
      view = msg.view;
      deadlineAt = typeof view.remainingMs === "number" ? Date.now() + view.remainingMs : null;
      render();
    } else if (msg.t === "error" && msg.reason === "bad-code") {
      els.rejoinError.hidden = false;
    }
  }

  function show(section) {
    sections.forEach(function (s) { s.hidden = s !== section; });
  }

  function render() {
    var v = view;
    if (!v) return;
    var inGame = v.phase !== "lobby";
    var inRoster = v.you.inRoster;

    els.role.hidden = !(inGame && inRoster);
    if (!(inGame && inRoster) && holding) release();

    if (v.phase === "lobby") {
      show(els.lobby);
      els.readyToggle.setAttribute("aria-pressed", String(v.you.ready));
      els.readyCount.textContent = String(v.readyCount);
    } else if (!inRoster) {
      show(els.out);
    } else if (v.phase === "answering") {
      show(els.answering);
      els.prompt.textContent = v.prompt || "";
      fillInputs(v);
    } else if (v.phase === "voting") {
      show(els.voting);
      fillInputs(v);
      renderVoteButtons(v);
    } else if (LOOK_PHASES.indexOf(v.phase) !== -1) {
      show(els.look);
    }
    if (holding) showRole();
    tickTimers();
  }

  // Restore the fields from the server once per phase, so a reconnect brings back
  // the draft or vote and later views never overwrite what the player is typing.
  function fillInputs(v) {
    if (filledPhaseId === v.phaseId) return;
    filledPhaseId = v.phaseId;
    if (v.phase === "answering") {
      els.answerText.value = v.you.draft;
      els.answerSent.hidden = true;
    } else {
      voteTarget = v.you.vote.target;
      els.voteReason.value = v.you.vote.reason;
    }
  }

  function renderVoteButtons(v) {
    var letters = v.players.filter(function (p) { return !p.out; }).map(function (p) { return p.letter; });
    var existing = Array.prototype.map.call(els.voteButtons.children, function (b) { return b.dataset.letter; });
    if (existing.join() !== letters.join()) {
      els.voteButtons.textContent = "";
      letters.forEach(function (letter) {
        var b = document.createElement("button");
        b.type = "button";
        b.dataset.letter = letter;
        b.textContent = "Player " + letter;
        b.addEventListener("click", function () {
          voteTarget = letter;
          renderVoteSelection();
          sendVote();
        });
        els.voteButtons.appendChild(b);
      });
    }
    renderVoteSelection();
  }

  function renderVoteSelection() {
    Array.prototype.forEach.call(els.voteButtons.children, function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.letter === voteTarget));
    });
  }

  function formatSeconds() {
    if (deadlineAt === null) return "";
    return String(Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)));
  }

  function tickTimers() {
    var text = formatSeconds();
    els.answerTimer.textContent = text;
    els.voteTimer.textContent = text;
  }
  setInterval(tickTimers, 250);

  // Drafts and votes

  function sendDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    if (view && view.phase === "answering") {
      send({ t: "draft", phaseId: view.phaseId, text: els.answerText.value });
    }
  }

  els.answerText.addEventListener("input", function () {
    els.answerSent.hidden = true;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(sendDraft, ANSWER_DEBOUNCE_MS);
  });

  els.answerSend.addEventListener("click", function () {
    sendDraft();
    els.answerSent.hidden = false;
  });

  function sendVote() {
    clearTimeout(voteTimer);
    voteTimer = null;
    if (view && view.phase === "voting") {
      send({ t: "vote", phaseId: view.phaseId, target: voteTarget, reason: els.voteReason.value });
    }
  }

  els.voteReason.addEventListener("input", function () {
    clearTimeout(voteTimer);
    voteTimer = setTimeout(sendVote, ANSWER_DEBOUNCE_MS);
  });

  // Lobby and rejoin

  els.readyToggle.addEventListener("click", function () {
    if (!view) return;
    send({ t: "ready", ready: view.you.ready ? false : true });
  });

  els.rejoinForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var code = els.rejoinCode.value.trim();
    if (!code) return;
    els.rejoinError.hidden = true;
    send({ t: "rejoin", code: code });
  });

  // Held role card

  function showRole() {
    var you = view && view.you;
    if (!you || !you.inRoster) return;
    els.roleText.textContent = you.role === "human"
      ? "You're a hidden human. You are Player " + you.letter + ". Make them think you're an agent."
      : "You're a voter. Find the humans.";
    els.roleCode.textContent = "Rejoin code: " + you.rejoinCode;
  }

  function hold(ev) {
    if (ev.cancelable) ev.preventDefault();
    holding = true;
    showRole();
  }

  function release() {
    holding = false;
    els.roleText.textContent = "";
    els.roleCode.textContent = "";
  }

  var card = els.roleCard;
  card.addEventListener("pointerdown", hold);
  card.addEventListener("pointerup", release);
  card.addEventListener("pointercancel", release);
  card.addEventListener("pointerleave", release);
  card.addEventListener("touchstart", hold, { passive: false });
  card.addEventListener("touchend", release);
  card.addEventListener("touchcancel", release);
  card.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
  window.addEventListener("blur", release);
  document.addEventListener("visibilitychange", function () { if (document.hidden) release(); });

  connect();
})();
