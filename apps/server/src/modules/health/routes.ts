import type { FastifyInstance } from 'fastify';

export type HealthBody = {
  status: 'ok' | 'error';
  uptimeSeconds: number;
  db: 'up' | 'down';
};

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: { checkDb: () => Promise<boolean> },
): void {
  app.get('/health', async (_request, reply) => {
    const dbUp = await deps.checkDb();
    const body: HealthBody = {
      status: dbUp ? 'ok' : 'error',
      uptimeSeconds: Math.floor(process.uptime()),
      db: dbUp ? 'up' : 'down',
    };

    if (!dbUp) {
      return reply.code(503).send(body);
    }

    return body;
  });
}
