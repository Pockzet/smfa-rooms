const ws = new WebSocket("wss://smfa-rooms.YOURNAME.workers.dev/room/TEST1?name=Sadli");
ws.onmessage = e => console.log("server:", e.data);
ws.onopen = () => ws.send(JSON.stringify({ t: "ping", c: 1 }));
