import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { WebSocket, WebSocketServer } from "ws";
import { LETTERS, REJOIN_MAX_FAILS, TICK_MS } from "./config.js";
import { type Durations, Session } from "./game.js";
import type { PromptPool } from "./prompts.js";
import type { AgentBrain, Letter } from "./types.js";
import { phoneView, screenView } from "./views.js";

export interface ServerOptions {
  port: number;
  hostKey: string;
  publicUrl: string;
  brain: AgentBrain;
  pool: PromptPool;
  durations?: Durations; // tests only
  heartbeatMs?: number; // tests only
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MAX_MESSAGE_BYTES = 4096;
const MAX_TEXT_CHARS = 500;
// Close code for a phone whose identity was wiped by Reset; it reconnects and gets a new one.
const CLOSE_RESET = 4000;
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};
const PAGES: Record<string, string> = { "/": "phone.html", "/screen": "screen.html" };
const HOST_COMMANDS = new Set(["start", "next", "extend", "closeVote", "skip", "newGame", "reset"]);
// These act on the phase the host was looking at; a repeat click that arrives after the phase moved on is dropped.
const PHASE_COMMANDS = new Set(["next", "extend", "closeVote", "skip"]);
// A socket that has not answered the previous ping by the next one is dead (a phone that lost its network
// keeps a half-open socket that still reads as OPEN), so it is terminated and stops counting as connected.
const HEARTBEAT_MS = 10_000;

/** One WebSocket. A phone socket is bound to one phoneId; later messages act for that phone only. */
interface Client {
  ws: WebSocket;
  phoneId: string | null;
  screen: boolean;
  host: boolean;
  rejoinFails: number;
  alive: boolean; // answered the last ping
}

// Client messages are untrusted JSON; handlers check each field they use.
type Incoming = Record<string, unknown>;

/** Serves the pages and QR code, and runs the game protocol on /ws. */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  if (opts.hostKey === "") throw new Error("hostKey must not be empty");
  const hostKey = Buffer.from(opts.hostKey);
  const qrSvg = await QRCode.toString(opts.publicUrl, { type: "svg" });
  const clients = new Set<Client>();

  let broadcastPending: ReturnType<typeof setImmediate> | null = null;
  const scheduleBroadcast = () => {
    broadcastPending ??= setImmediate(() => {
      broadcastPending = null;
      broadcast();
    });
  };
  const session = new Session({
    brain: opts.brain,
    pool: opts.pool,
    onChange: scheduleBroadcast,
    durations: opts.durations,
    isConnected: (phoneId) => [...clients].some((c) => c.phoneId === phoneId && c.ws.readyState === WebSocket.OPEN),
  });

  function send(client: Client, msg: unknown): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
  }

  function sendView(client: Client, now = Date.now()): void {
    if (client.phoneId !== null) {
      if (!session.phones.has(client.phoneId)) {
        client.ws.close(CLOSE_RESET, "reset");
        return;
      }
      send(client, { t: "view", view: phoneView(session, client.phoneId, now) });
    } else if (client.screen) {
      send(client, { t: "view", view: screenView(session, now) });
    }
  }

  function broadcast(): void {
    const now = Date.now();
    for (const client of clients) sendView(client, now);
  }

  function bindPhone(client: Client, phoneId: string): void {
    client.phoneId = phoneId;
    client.screen = false;
    client.host = false;
    send(client, { t: "you", phoneId });
    sendView(client);
  }

  function isHostKey(given: unknown): boolean {
    if (typeof given !== "string") return false;
    const buf = Buffer.from(given);
    return buf.length === hostKey.length && timingSafeEqual(buf, hostKey);
  }

  function onHelloPhone(client: Client, msg: Incoming): void {
    const known = typeof msg.phoneId === "string" ? session.phones.get(msg.phoneId) : undefined;
    // A socket that already has a phone keeps it rather than adding a second one.
    const bound = client.phoneId !== null ? session.phones.get(client.phoneId) : undefined;
    // A new phone in the lobby is in the next game; during a game it waits for the next one.
    bindPhone(client, (known ?? bound ?? session.addPhone()).id);
  }

  function onRejoin(client: Client, msg: Incoming): void {
    const code = typeof msg.code === "string" ? msg.code.trim().toUpperCase() : "";
    const phone = code === "" ? undefined : session.phoneByRejoinCode(code);
    if (phone) {
      bindPhone(client, phone.id);
      return;
    }
    client.rejoinFails += 1;
    if (client.rejoinFails >= REJOIN_MAX_FAILS) client.ws.close(1008, "too many wrong codes");
    else send(client, { t: "error", reason: "bad-code" });
  }

  function onPhoneMessage(phoneId: string, msg: Incoming): void {
    const game = session.game;
    switch (msg.t) {
      case "ready":
        if (typeof msg.ready === "boolean") session.setReady(phoneId, msg.ready);
        return;
      case "draft":
        if (game && typeof msg.phaseId === "number" && typeof msg.text === "string") {
          game.draft(phoneId, msg.phaseId, msg.text.slice(0, MAX_TEXT_CHARS));
        }
        return;
      case "vote":
        if (game && typeof msg.phaseId === "number" && isLetter(msg.target) && typeof msg.reason === "string") {
          game.vote(phoneId, msg.phaseId, msg.target, msg.reason.slice(0, MAX_TEXT_CHARS));
        }
        return;
    }
  }

  function onHostCommand(client: Client, msg: Incoming): void {
    if (typeof msg.cmd !== "string" || !HOST_COMMANDS.has(msg.cmd)) return;
    if (!client.host) {
      send(client, { t: "error", reason: "not-host" });
      return;
    }
    const game = session.game;
    if (PHASE_COMMANDS.has(msg.cmd) && (game === null || msg.phaseId !== game.phaseId)) return;
    switch (msg.cmd) {
      case "start": {
        if (msg.humans !== 1 && msg.humans !== 2) return;
        const result = session.start(msg.humans);
        if (!result.ok) send(client, { t: "error", reason: result.reason });
        return;
      }
      case "next":
        game?.next();
        return;
      case "extend":
        game?.extend();
        return;
      case "closeVote":
        game?.closeVote();
        return;
      case "skip":
        game?.skip();
        return;
      case "newGame":
        session.newGame();
        return;
      case "reset":
        session.reset();
        return;
    }
  }

  function onMessage(client: Client, msg: Incoming): void {
    switch (msg.t) {
      case "hello-phone":
        onHelloPhone(client, msg);
        return;
      case "rejoin":
        onRejoin(client, msg);
        return;
      case "hello-screen":
        client.phoneId = null;
        client.screen = true;
        client.host = isHostKey(msg.hostKey);
        sendView(client);
        return;
      case "host":
        // Only screen sockets can be host; a phone's host message is ignored.
        if (client.screen) onHostCommand(client, msg);
        return;
      default:
        if (client.phoneId !== null && session.phones.has(client.phoneId)) onPhoneMessage(client.phoneId, msg);
    }
  }

  const server = createServer((req, res) => {
    serveHttp(req, res, qrSvg, opts.publicUrl).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  // ws closes a socket with code 1009 when a message is over maxPayload.
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MESSAGE_BYTES });
  wss.on("connection", (ws) => {
    const client: Client = { ws, phoneId: null, screen: false, host: false, rejoinFails: 0, alive: true };
    clients.add(client);
    ws.on("pong", () => {
      client.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return;
      try {
        onMessage(client, msg as Incoming);
      } catch (err) {
        // Keep the server up for everyone else; the message holds no ids or codes.
        console.error(`message handler failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    ws.on("close", () => clients.delete(client));
    // Without a listener, a protocol error (such as an oversized message) would crash the process.
    ws.on("error", () => {});
  });

  // ws re-emits the http server's errors on wss; without a listener they would crash the process.
  let failStart: ((err: Error) => void) | null = null;
  wss.on("error", (err) => {
    if (failStart) failStart(err);
    else console.error(`server error: ${err.message}`);
  });
  try {
    await new Promise<void>((done, fail) => {
      failStart = fail;
      server.listen(opts.port, () => done());
    });
  } catch (err) {
    wss.close();
    throw err;
  } finally {
    failStart = null;
  }

  // Phones show the countdown the server sends, so resend views while a deadline runs.
  const ticker = setInterval(() => {
    if (session.game?.deadline != null) broadcast();
  }, TICK_MS);
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : opts.port;

  return {
    port,
    close: async () => {
      clearInterval(ticker);
      clearInterval(heartbeat);
      if (broadcastPending) clearImmediate(broadcastPending);
      session.game?.dispose();
      for (const client of clients) client.ws.terminate();
      await new Promise<void>((done) => wss.close(() => done()));
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

function isLetter(value: unknown): value is Letter {
  return typeof value === "string" && (LETTERS as string[]).includes(value);
}

/** GET only: the two pages, the QR code, and files inside public/. Everything else is 404. */
async function serveHttp(req: IncomingMessage, res: ServerResponse, qrSvg: string, publicUrl: string): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") return notFound(res);
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/qr.svg") return reply(res, CONTENT_TYPES[".svg"]!, qrSvg);
  if (path === "/public-url") return reply(res, CONTENT_TYPES[".txt"]!, publicUrl);
  const page = PAGES[path];
  if (page) return serveFile(res, resolve(PUBLIC_DIR, page));
  if (path.startsWith("/public/")) {
    let rel: string;
    try {
      rel = decodeURIComponent(path.slice("/public/".length));
    } catch {
      return notFound(res);
    }
    const file = resolve(PUBLIC_DIR, rel);
    // The decoded path may hold "..": refuse anything that resolves outside public/.
    if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) return notFound(res);
    return serveFile(res, file);
  }
  notFound(res);
}

async function serveFile(res: ServerResponse, file: string): Promise<void> {
  const type = CONTENT_TYPES[extname(file)];
  if (!type) return notFound(res);
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return notFound(res); // missing file or a directory
  }
  reply(res, type, body);
}

function reply(res: ServerResponse, type: string, body: string | Buffer): void {
  // Pages change between rehearsals; make phones fetch them fresh.
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}
