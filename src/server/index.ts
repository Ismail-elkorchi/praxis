import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { createPraxisApp } from "../composition/createPraxisApp";
import { PraxisApi, type ClientRequest } from "../app/PraxisApi";

const port = Number(process.env.PORT ?? 4187);
const app = await createPraxisApp();
const api = new PraxisApi(app);

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.method === "POST" && request.url === "/api") {
    const body = await readBody(request);
    const result = await api.handle(JSON.parse(body) as ClientRequest);
    response.writeHead("error" in result ? 400 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

const sockets = new WebSocketServer({ server, path: "/ws" });

sockets.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "push", channel: "dashboard.snapshotChanged", data: app.snapshot().dashboard }));
  socket.on("message", async (message) => {
    const result = await api.handle(JSON.parse(String(message)) as ClientRequest);
    socket.send(JSON.stringify(result));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Praxis local server listening on http://127.0.0.1:${port}`);
});

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    request.on("data", (chunk: Buffer) => {
      data += String(chunk);
    });
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });
}
