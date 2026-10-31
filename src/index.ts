import { DurableObject } from "cloudflare:workers";

// SMFA 3D room server, version 2.
// Players join a room by name (for example /room/SMFA-WORLD-1). The server keeps the list of
// who is in each room, says who the host is (whoever has been there longest), passes messages
// between players and tells everyone the server time so the game clocks line up.

const VERSION = "smfa-rooms-2";
const DEFAULT_MAX = 8;          // players in one room unless the game asks for a different limit
const HARD_MAX = 32;            // never more than this in one room
const MAX_MSG = 65536;          // biggest message accepted, in characters
const MAX_RATE = 60;            // messages per second one player may send
// Websites allowed to connect. Empty means any website may connect.
// Example: ["https://pockzet.github.io"]
const ALLOWED_ORIGINS: string[] = [];

export class MyDurableObject extends DurableObject {
  rate: Map<any, { s: number; n: number }> = new Map();

  constructor(ctx: any, env: any) {
    super(ctx, env);
    // keep-alive pings are answered without waking the room up (saves free-plan time)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"hb"}', '{"t":"hb"}'));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const url = new URL(request.url);
    const max = Math.max(2, Math.min(HARD_MAX, parseInt(url.searchParams.get("max") || "", 10) || DEFAULT_MAX));
    if (this.ctx.getWebSockets().length >= max) return new Response("Room full", { status: 403 });
    const name = (url.searchParams.get("name") || "Player").replace(/[<>&"'\\]/g, "").slice(0, 20) || "Player";
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    const id = crypto.randomUUID().slice(0, 8);
    const me = { id, name, j: Date.now() + Math.random() / 1000 };
    this.ctx.acceptWebSocket(server);          // "hibernation": an empty, quiet room costs nothing
    server.serializeAttachment(me);
    server.send(JSON.stringify({ t: "welcome", id, players: this.players(), host: this.host(), now: Date.now(), v: VERSION }));
    this.broadcast({ t: "join", id, name, j: me.j, host: this.host(), now: Date.now() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  players() {
    return this.ctx.getWebSockets().map((ws: any) => ws.deserializeAttachment()).filter(Boolean);
  }

  // the host is the player who joined first and is still here
  host(except?: any) {
    let best: any = null;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment();
      if (a && (!best || a.j < best.j)) best = a;
    }
    return best ? best.id : null;
  }

  broadcast(msg: any, except?: any) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(s); } catch (e) { /* that player already left */ }
    }
  }

  async webSocketMessage(ws: any, message: any) {
    if (typeof message !== "string" || message.length > MAX_MSG) return;
    // simple flood protection
    const now = Date.now(), r = this.rate.get(ws) || { s: now, n: 0 };
    if (now - r.s >= 1000) { r.s = now; r.n = 0; }
    if (++r.n > MAX_RATE) { this.rate.set(ws, r); return; }
    this.rate.set(ws, r);
    let m: any;
    try { m = JSON.parse(message); } catch (e) { return; }
    const me = ws.deserializeAttachment();
    if (!me || !m) return;
    if (m.t === "ping") { ws.send(JSON.stringify({ t: "pong", c: m.c, now })); return; }
    const out = JSON.stringify({ t: "msg", from: me.id, d: m.d, now });
    if (m.to) {
      // a message for one player only
      for (const o of this.ctx.getWebSockets()) {
        const a = o.deserializeAttachment();
        if (a && a.id === m.to) { try { o.send(out); } catch (e) { } }
      }
      return;
    }
    for (const o of this.ctx.getWebSockets()) {
      if (o === ws) continue;
      try { o.send(out); } catch (e) { }
    }
  }

  async webSocketClose(ws: any, code: number) {
    this.leave(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch (e) { /* already closed */ }
  }

  async webSocketError(ws: any) { this.leave(ws); }

  leave(ws: any) {
    this.rate.delete(ws);
    const me = ws.deserializeAttachment();
    if (me) this.broadcast({ t: "leave", id: me.id, host: this.host(ws), now: Date.now() }, ws);
  }
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("SMFA room server is running (" + VERSION + ")", { headers: { "content-type": "text/plain", "access-control-allow-origin": "*" } });
    }
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{3,40})$/);
    if (!m) return new Response("Not found", { status: 404 });
    const origin = request.headers.get("Origin") || "";
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) return new Response("Not allowed", { status: 403 });
    // one Durable Object per room name
    const stub = env.MY_DURABLE_OBJECT.get(env.MY_DURABLE_OBJECT.idFromName(m[1].toUpperCase()));
    return stub.fetch(request);
  },
};
