import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { ping, timing } from "./ping";

const pingRoute = createRoute({ method: "get", path: "/{id}", responses: { 200: { description: "pong" } } });

const api = new OpenAPIHono();
api.openapi(pingRoute, ping);

export const app = new Hono();
app.use("*", timing);
app.get("/ping", ping);
app.route("/api", api);
