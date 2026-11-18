import { Hono } from "hono";
import { getUser, listUsers } from "./handlers";
import { requireAuth } from "./middleware";

export const users = new Hono();
users.get("/", listUsers);
users.get("/:id", requireAuth, getUser);
