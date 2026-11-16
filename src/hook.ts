/**
 * Webhook local do orquestrador. O worker faz POST ao terminar. Ligação só em 127.0.0.1 e exige token.
 * O POST diz qual tarefa terminou. O estado vem do relatório em disco.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface HookHandle {
  server: Server;
  url: string;
  close(): void;
}

export function startHook(
  token: string,
  onPost: (taskId: string) => Promise<void>,
  port = 0,
): Promise<HookHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/hook" || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let taskId: string;
        try {
          taskId = (JSON.parse(body) as { task_id: string }).task_id;
          if (typeof taskId !== "string" || taskId === "") throw new Error("task_id ausente");
        } catch {
          res.writeHead(400).end();
          return;
        }
        onPost(taskId).then(
          () => res.writeHead(200).end("ok"),
          () => res.writeHead(500).end(),
        );
      });
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const { port: bound } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${bound}/hook`, close: () => server.close() });
    });
  });
}

/** POST do worker. Nunca lança: se o orquestrador estiver fora do ar, o relatório em disco segue valendo. */
export async function postToHook(url: string, token: string, taskId: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ task_id: taskId }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
