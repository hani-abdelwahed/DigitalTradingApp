import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createApiKeyRequest, type ApiKey, type CreatedApiKey } from '@dta/shared';

// Creating a key re-checks the password and two-factor code, so limit attempts like sign-in.
const createLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

/** API key management. Only a signed-in user can manage keys; keys cannot manage keys. */
export default async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.authenticate);

  const ctx = (req: { ip: string; headers: { 'user-agent'?: string | undefined } }) => ({
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  app.get('/api-keys', async (req): Promise<ApiKey[]> => app.apiKeys.list(req.user.id));

  app.post('/api-keys', { config: createLimit }, async (req, reply): Promise<CreatedApiKey> => {
    const body = createApiKeyRequest.parse(req.body);
    const key = await app.apiKeys.create(req.user, body, ctx(req));
    reply.code(201);
    return key;
  });

  app.delete('/api-keys/:id', async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await app.apiKeys.revoke(req.user.id, id, ctx(req));
    reply.code(204);
  });
}
