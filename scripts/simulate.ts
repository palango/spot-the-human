// Load test and rehearsal driver. Opens fake phones against a running server and plays them.
//   npm run simulate -- ws://localhost:3000/ws 12
//   npm run simulate -- ws://localhost:3000/ws 12 --host <key>   also plays host: Start, Next, then New game and a second Start
// Without --host, press Start on the screen yourself. Exits non-zero on a stale phone or a protocol error.
import { WebSocket } from "ws";
import type { PhoneView, ScreenView } from "../src/views.js";

const STALE_AFTER_MS = 2000;
const CHECK_EVERY_MS = 500;
const HOST_PAUSE_MS = 2000; // pause before Next, so the screen is readable when someone watches

const args = process.argv.slice(2);
const hostIdx = args.indexOf("--host");
const hostKey = hostIdx >= 0 ? args[hostIdx + 1] : undefined;
if (hostIdx >= 0) args.splice(hostIdx, 2);
const url = args[0];
const phoneCount = Number(args[1] ?? 12);
if (!url || !Number.isInteger(phoneCount) || phoneCount < 1 || (hostIdx >= 0 && !hostKey)) {
  console.error("usage: simulate <ws-url> [phones=12] [--host <key>]");
  process.exit(2);
}

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
const fail = (msg: string) => {
  failures.push(msg);
  log(`FAIL ${msg}`);
};
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

const WORDS = ["chai", "traffic", "honestly", "no idea", "vada pav", "monsoon", "wifi", "late again", "ok so", "mumbai", "keynote", "audit"];
const randomText = () => Array.from({ length: 1 + Math.floor(Math.random() * 6) }, () => pick(WORDS)).join(" ");

let screenView: ScreenView | null = null;
let screenSeenAt = 0;

class FakePhone {
  ws: WebSocket | null = null;
  phoneId: string | null = null;
  view: PhoneView | null = null;
  viewAt = 0;
  behindSince: number | null = null;
  acted = new Set<string>(); // "<phase>:<phaseId>" already handled
  reconnects = 0;

  constructor(readonly name: string) {}

  connect(): Promise<void> {
    return new Promise((done) => {
      const ws = new WebSocket(url!);
      this.ws = ws;
      ws.on("open", () => {
        this.send({ t: "hello-phone", phoneId: this.phoneId ?? undefined });
        done();
      });
      ws.on("message", (data) => this.onMessage(JSON.parse(data.toString())));
      ws.on("error", (err) => fail(`${this.name} socket error: ${err.message}`));
    });
  }

  send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Drops the socket and reconnects as the same phone after a short gap. */
  async dropAndReconnect(): Promise<void> {
    const old = this.ws;
    this.ws = null;
    old?.terminate();
    await sleep(300 + Math.random() * 700);
    this.reconnects += 1;
    await this.connect();
  }

  onMessage(msg: { t: string; [k: string]: unknown }): void {
    if (msg.t === "error") {
      log(`${this.name} error message: ${String(msg.reason)}`);
      if (msg.reason !== "not-host") failures.push(`${this.name} got error ${String(msg.reason)}`);
      return;
    }
    if (msg.t === "you") this.phoneId = msg.phoneId as string;
    if (msg.t !== "view") return;
    const view = msg.view as PhoneView;
    this.view = view;
    this.viewAt = Date.now();
    this.act(view);
  }

  act(view: PhoneView): void {
    const key = `${view.phase}:${view.phaseId}`;
    if (view.phase === "lobby" && !view.you.ready) this.send({ t: "ready", ready: true });
    if (this.acted.has(key)) return;
    if (view.phase === "answering") {
      this.acted.add(key);
      this.typeDrafts(view.phaseId);
    } else if (view.phase === "voting" && view.you.inRoster) {
      this.acted.add(key);
      void this.castVote(view);
    }
  }

  /** A few partial drafts at random times, as if typing; the server keeps the last one. */
  async typeDrafts(phaseId: number): Promise<void> {
    let text = "";
    for (let i = 0; i < 3; i++) {
      await sleep(1000 + Math.random() * 8000);
      if (this.view?.phaseId !== phaseId) return;
      text = `${text} ${randomText()}`.trim();
      this.send({ t: "draft", phaseId, text });
    }
  }

  async castVote(view: PhoneView): Promise<void> {
    const targets = view.players.filter((p) => !p.out).map((p) => p.letter);
    await sleep(1000 + Math.random() * 15000);
    if (this.view?.phaseId !== view.phaseId) return;
    this.send({ t: "vote", phaseId: view.phaseId, target: pick(targets), reason: randomText() });
  }

  checkStale(now: number): void {
    const behind = this.ws?.readyState === WebSocket.OPEN && this.view !== null && screenView !== null && this.view.phaseId < screenView.phaseId;
    if (!behind) {
      this.behindSince = null;
      return;
    }
    this.behindSince ??= now;
    if (now - this.behindSince > STALE_AFTER_MS) {
      fail(`${this.name} stuck on phaseId ${this.view!.phaseId}, screen is on ${screenView!.phaseId}`);
      this.behindSince = now; // report once per 2 s, not every check
    }
  }
}

function openScreen(): WebSocket {
  const ws = new WebSocket(url!);
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello-screen", hostKey })));
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.t === "view") {
      screenView = msg.view;
      screenSeenAt = Date.now();
    } else if (msg.t === "error") {
      fail(`screen error message: ${msg.reason}`);
    }
  });
  ws.on("error", (err) => fail(`screen socket error: ${err.message}`));
  return ws;
}

/** Logs how long each phase lasted, and for answering and voting how far from the deadline the phase closed. */
function trackPhases(): void {
  let last = { id: -1, phase: "", at: Date.now(), opensWithMs: null as number | null };
  setInterval(() => {
    const v = screenView;
    if (!v || v.phaseId === last.id && v.phase === last.phase) return;
    const now = Date.now();
    if (last.id >= 0) {
      const took = now - last.at;
      const detail = last.opensWithMs !== null ? ` (window ${last.opensWithMs} ms, closed ${took - last.opensWithMs} ms after the deadline)` : "";
      log(`phase ${last.phase} #${last.id} lasted ${took} ms${detail}`);
    }
    last = { id: v.phaseId, phase: v.phase, at: now, opensWithMs: v.remainingMs };
    const answers = v.answers ? Object.values(v.answers) : [];
    const blanks = answers.filter((a) => a === "…").length;
    log(`-> ${v.phase} #${v.phaseId} round ${v.round}.${v.promptInRound} players in ${v.players.filter((p) => !p.out).length}${v.answers ? `, answers ${answers.length}, blank ${blanks}` : ""}${v.winner ? `, winner ${v.winner}` : ""}`);
  }, 100);
}

async function until(what: string, cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Host mode: presses Start, then Next through every phase until the game ends, or until the first reveal. */
async function playHost(host: WebSocket, stopAfterFirstReveal: boolean): Promise<void> {
  const cmd = (c: string, extra: object = {}) => host.send(JSON.stringify({ t: "host", cmd: c, ...extra }));
  const phase = () => screenView?.phase;
  await until("lobby", () => phase() === "lobby", 10000);
  await until("all phones ready", () => screenView!.readyCount >= phoneCount, 10000);
  cmd("start");
  await until("game start", () => phase() === "answering", 5000);
  let seen = screenView!.phaseId;
  while (phase() !== "ended") {
    await until("next phase", () => screenView!.phaseId !== seen || phase() === "ended", 120000);
    seen = screenView!.phaseId;
    const p = phase();
    if (p === "revealed" && stopAfterFirstReveal) return;
    if (p === "revealed" || p === "votePosts" || p === "removal") {
      await sleep(HOST_PAUSE_MS);
      cmd("next", { phaseId: seen });
    } else if (p === "voting") {
      // Close early once every roster phone has voted; otherwise the deadline closes it.
      const id = seen;
      void (async () => {
        while (screenView?.phaseId === id && screenView.votedCount < screenView.rosterCount) await sleep(500);
        if (screenView?.phaseId === id) cmd("closeVote", { phaseId: id });
      })();
    }
  }
}

async function main(): Promise<void> {
  const phones = Array.from({ length: phoneCount }, (_, i) => new FakePhone(`phone${i + 1}`));
  await Promise.all(phones.map((p) => p.connect()));
  const screen = openScreen();
  log(`${phoneCount} phones connected${hostKey ? ", host mode" : ", press Start on the screen"}`);
  trackPhases();

  // One phone drops and reconnects at every phase change.
  let dropped = -1;
  let dropForPhase = -1;
  setInterval(() => {
    const now = Date.now();
    for (const p of phones) p.checkStale(now);
    if (screenView && screenView.phaseId !== dropForPhase && screenView.phase !== "lobby") {
      dropForPhase = screenView.phaseId;
      dropped = (dropped + 1) % phones.length;
      log(`${phones[dropped]!.name} drops and reconnects`);
      void phones[dropped]!.dropAndReconnect();
    }
  }, CHECK_EVERY_MS);

  if (hostKey) {
    await until("screen view", () => screenView !== null, 5000);
    log("game 1");
    await playHost(screen, false);
    log("game 1 ended; New game, then a second Start");
    const phaseAfterGame1 = screenView!.phaseId;
    screen.send(JSON.stringify({ t: "host", cmd: "newGame" }));
    await playHost(screen, true);
    if (screenView!.phaseId <= phaseAfterGame1) fail("second game did not get a newer phaseId");
    log("game 2 reached its first reveal; replay works");
  } else {
    log("waiting for a game; stop with ctrl-c");
    await new Promise(() => {});
  }
  const staleSeenFor = Date.now() - screenSeenAt;
  log(`screen last view ${staleSeenFor} ms ago; reconnects: ${phones.map((p) => p.reconnects).join(",")}`);
}

try {
  await main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
log(failures.length === 0 ? "OK: no failures" : `${failures.length} failure(s):\n  ${failures.join("\n  ")}`);
process.exit(failures.length === 0 ? 0 : 1);
