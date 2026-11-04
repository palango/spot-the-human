import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { REJOIN_FAILS_PER_WINDOW, REJOIN_MAX_FAILS } from "../src/config.js";
import type { Durations } from "../src/game.js";
import { PromptPool } from "../src/prompts.js";
import { startServer } from "../src/server.js";
import { normalizeShown } from "../src/text.js";
import type { Letter } from "../src/types.js";
import type { PhoneView, ScreenView } from "../src/views.js";
import { ScriptedBrain } from "./helpers.js";

const HOST_KEY = "test-host-key-0123456789";
const WAIT_MS = 4_000;

// Any server message; tests narrow on `t`.
type Message = { t: string; [key: string]: any };

/** A real ws client that keeps every message so tests can wait for them in order. */
class Client {
  /** Every message received, in order. */
  readonly received: Message[] = [];
  readonly closed: Promise<number>;
  private cursor = 0;
  private wake: (() => void) | null = null;
  private readonly handlers: ((msg: Message) => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Message;
      this.received.push(msg);
      for (const handler of this.handlers) handler(msg);
      this.wake?.();
    });
    this.closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  }

  static open(port: number, options?: WebSocket.ClientOptions): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, options);
    const client = new Client(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(client));
      ws.once("error", reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Runs handler on every later message. */
  onMessage(handler: (msg: Message) => void): void {
    this.handlers.push(handler);
  }

  /** Resolves with the first message after the last one waited for that matches. */
  async next(match: (msg: Message) => boolean, timeoutMs = WAIT_MS): Promise<Message> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      for (; this.cursor < this.received.length; this.cursor++) {
        const msg = this.received[this.cursor]!;
        if (match(msg)) {
          this.cursor++;
          return msg;
        }
      }
      const left = end - Date.now();
      if (left <= 0) throw new Error("timed out waiting for a message");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  view<V = PhoneView>(match: (view: V) => boolean = () => true, timeoutMs?: number): Promise<V> {
    return this.next((m) => m.t === "view" && match(m.view as V), timeoutMs).then((m) => m.view as V);
  }

  errors(): Message[] {
    return this.received.filter((m) => m.t === "error");
  }

  close(): Promise<number> {
    this.ws.close();
    return this.closed;
  }
}

const open: Client[] = [];
const servers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => (c.ws.readyState === WebSocket.CLOSED ? c.closed : c.close())));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function setup(durations: Partial<Durations> = {}, heartbeatMs?: number, rejoinWindowMs?: number) {
  const pool = new PromptPool(Array.from({ length: 40 }, (_, i) => `prompt ${i}`));
  const server = await startServer({
    port: 0,
    hostKey: HOST_KEY,
    publicUrl: "https://example.trycloudflare.com",
    brain: new ScriptedBrain(),
    pool,
    durations: { answerMs: 300, voteMs: 300, extendMs: 300, agentMarginMs: 50, ...durations },
    heartbeatMs,
    rejoinWindowMs,
  });
  servers.push(server);
  const connect = async (options?: WebSocket.ClientOptions) => {
    const client = await Client.open(server.port, options);
    open.push(client);
    return client;
  };
  /** A phone that has said hello; resolves once it has its phoneId and first view. */
  const phone = async (phoneId?: string) => {
    const client = await connect();
    client.send({ t: "hello-phone", phoneId });
    const you = await client.next((m) => m.t === "you");
    const view = await client.view();
    return { client, phoneId: you.phoneId as string, view };
  };
  const screen = async (hostKey?: string) => {
    const client = await connect();
    client.send({ t: "hello-screen", hostKey });
    await client.view<ScreenView>();
    return client;
  };
  return { server, connect, phone, screen };
}

describe("server", () => {
  it("twelve phones play a full game", async () => {
    const { phone, screen } = await setup();
    const phones = await Promise.all(Array.from({ length: 12 }, () => phone()));
    const host = await screen(HOST_KEY);

    // Voters all vote for the same agent, so each round removes an agent and the game lasts three rounds.
    const humanLetters = new Set<Letter>();
    phones.forEach(({ client }, i) => {
      let handled = 0;
      client.onMessage((msg) => {
        if (msg.t !== "view") return;
        const view = msg.view as PhoneView;
        if (view.you.letter) humanLetters.add(view.you.letter);
        if (view.phaseId === handled || !view.you.inRoster) return;
        if (view.phase === "answering") {
          handled = view.phaseId;
          client.send({ t: "draft", phaseId: view.phaseId, text: `Phone ${i} answers!` });
        } else if (view.phase === "voting") {
          handled = view.phaseId;
          const target = view.players.find((p) => !p.out && !humanLetters.has(p.letter))!.letter;
          client.send({ t: "vote", phaseId: view.phaseId, target, reason: `phone ${i} thinks so` });
        }
      });
    });
    let handled = 0;
    host.onMessage((msg) => {
      const view = msg.view as ScreenView;
      if (msg.t !== "view" || view.phaseId === handled) return;
      if (view.phase === "revealed" || view.phase === "votePosts" || view.phase === "removal") {
        handled = view.phaseId;
        host.send({ t: "host", cmd: "next", phaseId: view.phaseId });
      }
    });

    host.send({ t: "host", cmd: "start", humans: 2 });
    const ended = await host.view<ScreenView>((v) => v.phase === "ended", 15_000);
    expect(ended.round).toBe(3);
    expect(ended.winner).toBe("humans");
    expect(ended.players.filter((p) => p.out)).toHaveLength(3);
    expect(humanLetters.size).toBe(2);
    expect(host.errors()).toEqual([]);
  }, 20_000);

  it("reconnect keeps draft", async () => {
    const { phone, screen } = await setup({ answerMs: 1_500 });
    const first = await phone();
    await phone();
    const host = await screen(HOST_KEY);
    host.send({ t: "host", cmd: "start", humans: 2 });
    const answering = await first.client.view((v) => v.phase === "answering");
    const letter = answering.you.letter!;
    expect(answering.you.role).toBe("human");

    first.client.send({ t: "draft", phaseId: answering.phaseId, text: "Hello, World! It's me." });
    await first.client.close();

    const again = await phone(first.phoneId);
    expect(again.phoneId).toBe(first.phoneId);
    expect(again.view.phase).toBe("answering");
    expect(again.view.you.draft).toBe("Hello, World! It's me.");
    expect(again.view.you.letter).toBe(letter);

    const revealed = await host.view<ScreenView>((v) => v.phase === "revealed");
    expect(revealed.answers![letter]).toBe(normalizeShown("Hello, World! It's me."));
  });

  it("rejoin code restores identity", async () => {
    const { connect, phone, screen } = await setup({ answerMs: 2_000 });
    const human = await phone();
    const host = await screen(HOST_KEY);
    host.send({ t: "host", cmd: "start", humans: 1 });
    const answering = await human.client.view((v) => v.phase === "answering");

    const fresh = await connect();
    fresh.send({ t: "rejoin", code: answering.you.rejoinCode.toLowerCase() });
    const you = await fresh.next((m) => m.t === "you");
    expect(you.phoneId).toBe(human.phoneId);
    const view = await fresh.view();
    expect(view.you.role).toBe("human");
    expect(view.you.letter).toBe(answering.you.letter);

    const guesser = await connect();
    for (let i = 1; i < REJOIN_MAX_FAILS; i++) {
      guesser.send({ t: "rejoin", code: "WRONG1" });
      expect(await guesser.next((m) => m.t === "error")).toEqual({ t: "error", reason: "bad-code" });
    }
    expect(guesser.ws.readyState).toBe(WebSocket.OPEN);
    guesser.send({ t: "rejoin", code: "WRONG1" });
    await guesser.closed;
    expect(guesser.received.filter((m) => m.t === "you")).toEqual([]);
  });

  it("host command without key is refused", async () => {
    const { phone, screen } = await setup();
    const p = await phone();
    for (const hostKey of [undefined, "wrong", HOST_KEY.slice(0, -1) + "X"]) {
      const viewer = await screen(hostKey);
      viewer.send({ t: "host", cmd: "start", humans: 1 });
      expect(await viewer.next((m) => m.t === "error")).toEqual({ t: "error", reason: "not-host" });
    }

    // A phone socket's host command gets no reply; the ready toggle after it proves it was read.
    p.client.send({ t: "host", cmd: "start", humans: 1 });
    p.client.send({ t: "ready", ready: false });
    const view = await p.client.view((v) => !v.you.ready);
    expect(view.phase).toBe("lobby");
    expect(p.client.errors()).toEqual([]);

    const host = await screen(HOST_KEY);
    host.send({ t: "host", cmd: "start", humans: 1 });
    expect(await host.next((m) => m.t === "error")).toEqual({ t: "error", reason: "too-few-ready" });
  });

  it("starts with a random human count and ignores any other count", async () => {
    const { phone, screen } = await setup();
    const phones = [await phone(), await phone()];
    const host = await screen(HOST_KEY);
    host.send({ t: "host", cmd: "start", humans: 3 });
    host.send({ t: "host", cmd: "start", humans: "two" });
    host.send({ t: "host", cmd: "start", humans: "random" });
    await host.view<ScreenView>((v) => v.phase === "answering");
    const roles = await Promise.all(phones.map(async (p) => (await p.client.view((v) => v.you.role !== null)).you.role));
    expect(roles.filter((r) => r === "human").length).toBeGreaterThanOrEqual(1);
    expect(host.errors()).toEqual([]);
  });

  it("keeps a vote reason sent before a letter is picked", async () => {
    const { phone, screen } = await setup({ answerMs: 50, voteMs: 5_000 });
    const p = await phone();
    await phone();
    const host = await screen(HOST_KEY);
    host.send({ t: "host", cmd: "start", humans: 1 });
    for (let i = 0; i < 3; i++) {
      const revealed = await host.view<ScreenView>((v) => v.phase === "revealed");
      host.send({ t: "host", cmd: "next", phaseId: revealed.phaseId });
    }
    const voting = await p.client.view((v) => v.phase === "voting");
    p.client.send({ t: "vote", phaseId: voting.phaseId, target: null, reason: "not sure yet" });
    const view = await p.client.view((v) => v.you.vote.reason === "not sure yet");
    expect(view.you.vote.target).toBeNull();
    expect(view.votedCount).toBe(0);
  });

  it("caps wrong rejoin codes across all connections, so reconnecting doesn't reset the limit", async () => {
    const { connect, phone } = await setup({}, undefined, 1_500);
    const p = await phone();
    const code = p.view.you.rejoinCode;
    for (let c = 0; c < REJOIN_FAILS_PER_WINDOW / (REJOIN_MAX_FAILS - 1); c++) {
      const guesser = await connect();
      for (let i = 1; i < REJOIN_MAX_FAILS; i++) {
        guesser.send({ t: "rejoin", code: "WRONG1" });
        await guesser.next((m) => m.t === "error");
      }
      guesser.ws.close();
    }
    const blocked = await connect();
    blocked.send({ t: "rejoin", code });
    expect(await blocked.next((m) => m.t === "error")).toEqual({ t: "error", reason: "bad-code" });
    expect(blocked.received.filter((m) => m.t === "you")).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 1_600));
    const later = await connect();
    later.send({ t: "rejoin", code });
    expect((await later.next((m) => m.t === "you")).phoneId).toBe(p.phoneId);
  });

  it("late joiner waits then plays next game", async () => {
    const { phone, screen } = await setup({ answerMs: 2_000 });
    await phone();
    await phone();
    const host = await screen(HOST_KEY);
    host.send({ t: "host", cmd: "start", humans: 2 });
    await host.view<ScreenView>((v) => v.phase === "answering");

    const late = await phone();
    expect(late.view.phase).toBe("answering");
    expect(late.view.you.inRoster).toBe(false);
    expect(late.view.you.role).toBeNull();
    expect(late.view.you.rejoinCode).toMatch(/^[A-Z0-9]{6}$/);

    host.send({ t: "host", cmd: "newGame" });
    await late.client.view((v) => v.phase === "lobby");
    late.client.send({ t: "ready", ready: true });
    await host.view<ScreenView>((v) => v.readyCount === 1);
    host.send({ t: "host", cmd: "start", humans: 1 });
    const playing = await late.client.view((v) => v.phase === "answering");
    expect(playing.you.inRoster).toBe(true);
    expect(playing.you.role).toBe("human");
  });

  it("reset gives connected phones a new identity", async () => {
    const { phone, screen } = await setup();
    const p = await phone();
    const host = await screen(HOST_KEY);
    host.send({ t: "host", cmd: "reset" });
    expect(await p.client.closed).toBe(4000);
    await host.view<ScreenView>((v) => v.readyCount === 0);

    const again = await phone(p.phoneId);
    expect(again.phoneId).not.toBe(p.phoneId);
    expect(again.view.you.ready).toBe(true);
  });

  it("caps text, drops bad input and closes oversized messages", async () => {
    const { phone, screen } = await setup({ answerMs: 2_000 });
    const p = await phone();
    const host = await screen(HOST_KEY);
    host.send({ t: "host", cmd: "start", humans: 1 });
    const answering = await p.client.view((v) => v.phase === "answering");

    p.client.send({ t: "draft", phaseId: answering.phaseId, text: "x".repeat(600) });
    // A draft for a closed phase is dropped.
    p.client.send({ t: "draft", phaseId: answering.phaseId - 1, text: "stale" });
    // Not JSON, and not an object: both ignored without closing the socket.
    p.client.ws.send("{nope");
    p.client.send(42);
    await p.client.close();
    const again = await phone(p.phoneId);
    expect(again.view.you.draft).toBe("x".repeat(500));

    again.client.ws.send(JSON.stringify({ t: "draft", phaseId: answering.phaseId, text: "y".repeat(4_100) }));
    expect(await again.client.closed).toBe(1009);

    // The server is still up for everyone else.
    const after = await phone(p.phoneId);
    expect(after.view.you.draft).toBe("x".repeat(500));
  });

  it("resends views with a falling countdown while a deadline runs", async () => {
    const { phone, screen } = await setup({ answerMs: 2_500 });
    const p = await phone();
    const host = await screen(HOST_KEY);
    host.send({ t: "host", cmd: "start", humans: 1 });
    const first = await p.client.view((v) => v.phase === "answering");
    // Nothing is sent and nothing changes during answering, so the next view can only come from the ticker.
    const second = await p.client.view();
    expect(second.phaseId).toBe(first.phaseId);
    expect(second.remainingMs!).toBeLessThan(first.remainingMs!);
    expect({ ...second, remainingMs: 0 }).toEqual({ ...first, remainingMs: 0 });
  });

  it("never deals human to a phone with no open socket at Start", async () => {
    const { phone, screen } = await setup({ answerMs: 2_000 });
    const online = await phone();
    const locked = await phone();
    await locked.client.close();
    const host = await screen(HOST_KEY);
    host.send({ t: "host", cmd: "start", humans: 2 });
    expect(await host.next((m) => m.t === "error")).toEqual({ t: "error", reason: "too-few-ready" });

    host.send({ t: "host", cmd: "start", humans: 1 });
    const playing = await online.client.view((v) => v.phase === "answering");
    expect(playing.you.role).toBe("human");
    expect(playing.rosterCount).toBe(2);
    const back = await phone(locked.phoneId);
    expect(back.view.you.inRoster).toBe(true);
    expect(back.view.you.role).toBe("voter");
  });

  it("hello-phone without an id on a bound socket keeps its phone", async () => {
    const { phone, screen } = await setup();
    const p = await phone();
    const host = await screen(HOST_KEY);
    p.client.send({ t: "hello-phone" });
    expect(await p.client.next((m) => m.t === "you")).toEqual({ t: "you", phoneId: p.phoneId });
    p.client.send({ t: "ready", ready: false });
    // The ready toggle comes after the hello, so its view shows whether a second phone was added.
    const view = await host.view<ScreenView>((v) => v.readyCount === 0);
    expect(view.rosterCount).toBe(0);
    p.client.send({ t: "ready", ready: true });
    expect((await host.view<ScreenView>((v) => v.readyCount > 0)).readyCount).toBe(1);
  });

  it("ignores phase commands with a stale or missing phaseId", async () => {
    const { phone, screen } = await setup({ answerMs: 200 });
    await phone();
    const host = await screen(HOST_KEY);
    host.send({ t: "host", cmd: "start", humans: 1 });
    const revealed = await host.view<ScreenView>((v) => v.phase === "revealed");

    for (const cmd of ["next", "skip", "closeVote", "extend"]) {
      host.send({ t: "host", cmd });
      host.send({ t: "host", cmd, phaseId: revealed.phaseId - 1 });
      host.send({ t: "host", cmd, phaseId: String(revealed.phaseId) });
    }
    expect(await settle(host)).toMatchObject({ phase: "revealed", phaseId: revealed.phaseId });

    host.send({ t: "host", cmd: "next", phaseId: revealed.phaseId });
    expect(await settle(host)).toMatchObject({ phase: "answering", promptInRound: 2 });
  });

  it("a double Next on the vote posts shows the removal", async () => {
    const { phone, screen } = await setup({ answerMs: 200, voteMs: 200 });
    await phone();
    const host = await screen(HOST_KEY);
    host.send({ t: "host", cmd: "start", humans: 1 });
    for (let i = 0; i < 3; i++) {
      const revealed = await host.view<ScreenView>((v) => v.phase === "revealed");
      host.send({ t: "host", cmd: "next", phaseId: revealed.phaseId });
    }
    const posts = await host.view<ScreenView>((v) => v.phase === "votePosts");

    host.send({ t: "host", cmd: "next", phaseId: posts.phaseId });
    host.send({ t: "host", cmd: "next", phaseId: posts.phaseId });
    expect(await settle(host)).toMatchObject({ phase: "removal", phaseId: posts.phaseId + 1 });
  });

  it("heartbeat terminates a socket that stops answering pings", async () => {
    const { connect, phone, screen } = await setup({}, 100);
    const live = await phone();
    // ws clients answer pings by themselves; this one doesn't, like a phone whose network died.
    const dead = await connect({ autoPong: false });
    dead.send({ t: "hello-phone" });
    await dead.view();
    expect(await dead.closed).toBe(1006);

    const host = await screen(HOST_KEY);
    host.send({ t: "host", cmd: "start", humans: 2 });
    expect(await host.next((m) => m.t === "error")).toEqual({ t: "error", reason: "too-few-ready" });
    // The live phone has kept answering pings over many intervals.
    expect(live.client.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects start on a busy port", async () => {
    const { server } = await setup();
    const pool = new PromptPool(Array.from({ length: 40 }, (_, i) => `prompt ${i}`));
    const opts = { port: server.port, hostKey: HOST_KEY, publicUrl: "https://example.test", brain: new ScriptedBrain(), pool };
    await expect(startServer(opts)).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("qr and pages are served", async () => {
    const { server } = await setup();
    const base = `http://127.0.0.1:${server.port}`;
    for (const path of ["/", "/screen", "/screen?host=abc", "/public/phone.html"]) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toMatch(/^text\/html/);
      await res.text();
    }
    const qr = await fetch(`${base}/qr.svg`);
    expect(qr.status).toBe(200);
    expect(qr.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
    expect(await qr.text()).toContain("<svg");
    const url = await fetch(`${base}/public-url`);
    expect(url.status).toBe(200);
    expect(url.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await url.text()).toBe("https://example.trycloudflare.com");

    for (const path of ["/src/game.ts", "/public/", "/public/missing.js", "/package.json"]) {
      const res = await fetch(base + path);
      expect(res.status, path).toBe(404);
      await res.text();
    }
    // fetch normalizes "..", so send raw paths that try to climb out of public/.
    const climbing = [
      "/public/../src/game.ts",
      "/public/%2e%2e/src/game.ts",
      "/public/..%2fsrc%2fgame.ts",
      "/public/..%2fpackage.json",
    ];
    for (const path of climbing) {
      expect(await rawGetStatus(server.port, path), path).toBe(404);
    }
  });
});

/**
 * Waits until the server has handled every message sent so far and sent every view they caused, then returns the
 * last view. Each Start in a game gets an error at once; views are broadcast on the next turn of the event loop,
 * so by the second error every earlier view has arrived.
 */
async function settle(host: Client): Promise<ScreenView> {
  for (let i = 0; i < 2; i++) {
    host.send({ t: "host", cmd: "start", humans: 1 });
    await host.next((m) => m.t === "error" && m.reason === "not-in-lobby");
  }
  const views = host.received.filter((m) => m.t === "view");
  return views[views.length - 1]!.view as ScreenView;
}

function rawGetStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end();
  });
}
