import { DurableObject } from "cloudflare:workers";

// SMFA 3D room server, step 1.
// Players join a room by code (for example /room/RACE42). The server keeps a list of
// who is in each room and passes messages between them.
// It is a relay for now. Running the game itself on the server (the "referee") is step 2.

const VERSION = "smfa-rooms-1";
const MAX_PLAYERS = 8;          // players allowed in one room
const MAX_MSG = 8192;           // biggest message accepted, in characters
// Websites allowed to connect. Empty means any website may connect.
// Later you can add your GitHub Pages address, e.g. "https://yourname.github.io".
const ALLOWED_ORIGINS: string[] = [];

export class MyDurableObject extends DurableObject {
  constructor(ctx: any, env: any) {
    super(ctx, env);
    // keep-alive pings are answered without waking the room up (saves free-plan time)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"hb"}', '{"t":"hb"}'));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) return new Response("Room full", { status: 403 });
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "Player").replace(/[<>&"']/g, "").slice(0, 20) || "Player";
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    const id = crypto.randomUUID().slice(0, 8);
    this.ctx.acceptWebSocket(server);          // "hibernation": an empty, quiet room costs nothing
    server.serializeAttachment({ id, name });
    server.send(JSON.stringify({ t: "welcome", id, players: this.players(), now: Date.now(), v: VERSION }));
    this.broadcast({ t: "join", id, name }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  players() {
    return this.ctx.getWebSockets().map((ws: any) => ws.deserializeAttachment()).filter(Boolean);
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
    let m: any;
    try { m = JSON.parse(message); } catch (e) { return; }
    const me = ws.deserializeAttachment();
    if (!me || !m) return;
    if (m.t === "ping") { ws.send(JSON.stringify({ t: "pong", c: m.c, now: Date.now() })); return; }
    // everything else goes to the other players, stamped with who sent it
    this.broadcast({ t: "msg", from: me.id, d: m.d, now: Date.now() }, ws);
  }

  async webSocketClose(ws: any, code: number) {
    this.leave(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch (e) { /* already closed */ }
  }

  async webSocketError(ws: any) { this.leave(ws); }

  leave(ws: any) {
    const me = ws.deserializeAttachment();
    if (me) this.broadcast({ t: "leave", id: me.id }, ws);
  }
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("SMFA room server is running (" + VERSION + ")", { headers: { "content-type": "text/plain" } });
    }
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{3,32})$/);
    if (!m) return new Response("Not found", { status: 404 });
    const origin = request.headers.get("Origin") || "";
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) return new Response("Not allowed", { status: 403 });
    // one Durable Object per room code
    const stub = env.MY_DURABLE_OBJECT.get(env.MY_DURABLE_OBJECT.idFromName(m[1].toUpperCase()));
    return stub.fetch(request);
  },
};
