import { OpenAPIHono } from '@hono/zod-openapi';
import { getUserRoute } from './routes';
const router = new OpenAPIHono();
router.openapi(getUserRoute, c => c.json({}));
const app = new OpenAPIHono();
app.route('/api/v1/users', router);
export default app;
