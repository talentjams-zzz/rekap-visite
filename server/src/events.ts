// Server-Sent Events: live sync across devices (same pattern as v1 server.js).
import type { FastifyInstance, FastifyReply } from 'fastify';

export interface Events {
  broadcast: (event: string, data: unknown) => void;
}

export function registerEvents(app: FastifyInstance): Events {
  const clients = new Set<FastifyReply>();

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reply.raw.write('retry: 2000\n\n');
    clients.add(reply);
    req.raw.on('close', () => clients.delete(reply));
  });

  return {
    broadcast(event, data) {
      const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const c of clients) {
        try {
          c.raw.write(msg);
        } catch {
          clients.delete(c);
        }
      }
    },
  };
}
