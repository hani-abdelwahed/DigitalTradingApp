import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ordersQuery, placeOrderRequest, type Fill, type Order, type Portfolio } from '@dta/shared';

const orderLimit = { rateLimit: { max: 60, timeWindow: '1 minute' } };

export default async function tradingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', app.authenticate);

  app.get('/portfolio', async (req): Promise<Portfolio> => app.trading.portfolio(req.user.id));

  app.get('/orders', async (req): Promise<Order[]> => {
    const q = ordersQuery.parse(req.query);
    return app.trading.listOrders(req.user.id, q.status, q.limit);
  });

  app.post('/orders', { config: orderLimit }, async (req, reply): Promise<Order> => {
    const body = placeOrderRequest.parse(req.body);
    const order = await app.trading.placeOrder(req.user.id, body);
    reply.code(201);
    return order;
  });

  app.delete('/orders/:id', { config: orderLimit }, async (req): Promise<Order> => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return app.trading.cancelOrder(req.user.id, id);
  });

  app.get('/fills', async (req): Promise<Fill[]> => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return app.trading.listFills(req.user.id, limit);
  });
}
