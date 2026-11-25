import { Hono } from 'hono';
export const users = new Hono();
users.get('/:id', c => c.json({ id: c.req.param('id') }));
users.post('/', c => c.json({}));
