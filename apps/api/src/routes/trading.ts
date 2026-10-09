import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ordersQuery, placeOrderRequest, type Fill, type Order, type Portfolio, type TradingHalt } from '@dta/shared';

// Order entry is limited per account (not per IP), after authentication, so one user cannot
// flood the engine from many addresses and users behind one address do not share a budget.
const orderLimit = {
  rateLimit: {
    max: 60,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: (req: FastifyRequest) => `user:${req.user.id}`,
  },
};

export default async function tradingRoutes(app: FastifyInstance): Promise<void> {
  const read = { onRequest: app.authorize('read') };
  const trade = { onRequest: app.authorize('trade'), config: orderLimit };

  app.get('/portfolio', read, async (req): Promise<Portfolio> => app.trading.portfolio(req.user.id));

  app.get('/orders', read, async (req): Promise<Order[]> => {
    const q = ordersQuery.parse(req.query);
    return app.trading.listOrders(req.user.id, q.status, q.limit);
  });

  app.post('/orders', trade, async (req, reply): Promise<Order> => {
    const body = placeOrderRequest.parse(req.body);
    const order = await app.trading.placeOrder(req.user.id, body, { apiKeyId: req.principal.apiKeyId });
    reply.code(201);
    return order;
  });

  app.delete('/orders/:id', trade, async (req): Promise<Order> => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return app.trading.cancelOrder(req.user.id, id);
  });

  app.get('/fills', read, async (req): Promise<Fill[]> => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return app.trading.listFills(req.user.id, limit);
  });

  app.get('/halts', read, async (): Promise<TradingHalt[]> => app.trading.listHalts());
}
