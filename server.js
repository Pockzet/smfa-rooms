// SMFA 3D room server, step 1 (for Render's free web service).
// Players join a room by code (for example /room/RACE42). The server keeps a list of
// who is in each room and passes messages between them.
// It is a relay for now. Running the game itself on the server (the "referee") is step 2.
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const VERSION = "smfa-rooms-1";
const PORT = process.env.PORT || 10000;   // Render tells the server which port to use
const MAX_PLAYERS = 8;                      // players allowed in one room
const MAX_MSG = 8192;                       // biggest message accepted, in characters
const MAX_ROOMS = 200;                      // safety limit for the free server
// Websites allowed to connect. Empty means any website may connect.
// Later you can add your GitHub Pages address, e.g. "https://yourname.github.io".
const ALLOWED_ORIGINS = [];

const rooms = new Map(); // room code -> Set of sockets

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    let players = 0; for (const r of rooms.values()) players += r.size;
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
    res.end(`SMFA room server is running (${VERSION}) · rooms ${rooms.size} · players ${players}`);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG * 4 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{3,32})$/);
  const origin = req.headers.origin || "";
  const refuse = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
  if (!m) return refuse(404, "Not Found");
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) return refuse(403, "Forbidden");
  const code = m[1].toUpperCase();
  const room = rooms.get(code);
  if (room && room.size >= MAX_PLAYERS) return refuse(403, "Room Full");
  if (!room && rooms.size >= MAX_ROOMS) return refuse(503, "Server Busy");
  const name = (url.searchParams.get("name") || "Player").replace(/[<>&"']/g, "").slice(0, 20) || "Player";
  wss.handleUpgrade(req, socket, head, ws => join(ws, code, name));
});

function send(ws, msg) { try { if (ws.readyState === 1) ws.send(typeof msg === "string" ? msg : JSON.stringify(msg)); } catch (e) { /* already gone */ } }
function broadcast(room, msg, except) { const s = JSON.stringify(msg); for (const ws of room) if (ws !== except) send(ws, s); }

function join(ws, code, name) {
  let room = rooms.get(code);
  if (!room) { room = new Set(); rooms.set(code, room); }
  ws.info = { id: crypto.randomUUID().slice(0, 8), name };
  ws.alive = true;
  room.add(ws);
  send(ws, { t: "welcome", id: ws.info.id, players: [...room].map(w => w.info), now: Date.now(), v: VERSION });
  broadcast(room, { t: "join", id: ws.info.id, name }, ws);

  ws.on("pong", () => { ws.alive = true; });
  ws.on("message", (data, isBinary) => {
    if (isBinary || data.length > MAX_MSG) return;
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m) return;
    if (m.t === "hb") return send(ws, '{"t":"hb"}');
    if (m.t === "ping") return send(ws, { t: "pong", c: m.c, now: Date.now() });
    // everything else goes to the other players, stamped with who sent it
    broadcast(room, { t: "msg", from: ws.info.id, d: m.d, now: Date.now() }, ws);
  });
  ws.on("close", () => {
    room.delete(ws);
    broadcast(room, { t: "leave", id: ws.info.id });
    if (room.size === 0) rooms.delete(code);
  });
  ws.on("error", () => { /* the close event cleans up */ });
}

// drop players whose connection silently died (checked every 30 s)
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) { } }
}, 30000);

server.listen(PORT, () => console.log(`SMFA room server ${VERSION} listening on port ${PORT}`));
