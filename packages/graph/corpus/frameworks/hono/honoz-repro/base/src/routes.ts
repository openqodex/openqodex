import { createRoute } from '@hono/zod-openapi';
export const getUserRoute = createRoute({ method: 'get', path: '/{id}', responses: { 200: { description: 'ok' } } });
