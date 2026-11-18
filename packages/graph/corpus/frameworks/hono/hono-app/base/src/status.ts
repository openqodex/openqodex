import { Hono } from "hono";
import { health } from "./handlers";

const status = new Hono();
status.get("/health", health);
export default status;
