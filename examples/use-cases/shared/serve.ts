import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(
  incoming: IncomingMessage,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function toRequest(incoming: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const each of [value ?? []].flat()) headers.append(name, each);
  }
  const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
  return new Request(
    `http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`,
    {
      method: incoming.method ?? "GET",
      headers,
      ...(hasBody ? { body } : {}),
    },
  );
}

async function respond(
  incoming: IncomingMessage,
  handle: (request: Request) => Promise<Response>,
): Promise<Response> {
  const body = await readBody(incoming);
  if (body === undefined)
    return new Response("Payload Too Large", { status: 413 });
  return handle(toRequest(incoming, body)).catch((error: unknown) => {
    console.error(error);
    return new Response("Internal Server Error", { status: 500 });
  });
}

async function writeResponse(
  response: Response,
  outgoing: ServerResponse,
): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  const body = await response.arrayBuffer();
  outgoing.end(Buffer.from(body));
}

export function serve(
  port: number,
  handle: (request: Request) => Promise<Response>,
): Server {
  return createServer(async (incoming, outgoing) => {
    const response = await respond(incoming, handle);
    await writeResponse(response, outgoing);
  }).listen(port, "127.0.0.1", () =>
    console.log(`listening on http://localhost:${port}`),
  );
}
