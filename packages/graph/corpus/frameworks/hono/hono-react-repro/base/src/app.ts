import { Hono } from 'hono';
import { users } from './users';
const app = new Hono();
app.get('/healthz', c => c.text('ok'));
app.route('/api/v1/users', users);
export default app;
