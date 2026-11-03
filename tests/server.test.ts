import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { REJOIN_MAX_FAILS } from "../src/config.js";
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

  static open(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

async function setup(durations: Partial<Durations> = {}) {
  const pool = new PromptPool(Array.from({ length: 40 }, (_, i) => `prompt ${i}`));
  const server = await startServer({
    port: 0,
    hostKey: HOST_KEY,
    publicUrl: "https://example.trycloudflare.com",
    brain: new ScriptedBrain(),
    pool,
    durations: { answerMs: 300, voteMs: 300, extendMs: 300, agentMarginMs: 50, ...durations },
  });
  servers.push(server);
  const connect = async () => {
    const client = await Client.open(server.port);
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
        host.send({ t: "host", cmd: "next" });
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
