import { Hono } from 'hono';
import type { AppContext } from '../context.js';

/** GET /api/profile/snapshot —— Profile 快照（确认界面的「现状」数据源） */
export function profileRoutes(ctx: AppContext): Hono {
  return new Hono().get('/snapshot', (c) => c.json(ctx.ws.profile.getSnapshot()));
}
