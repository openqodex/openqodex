import { z } from "@hono/zod-openapi";

export const User = z.object({ id: z.string() }).openapi("User");
export const Users = z.array(User).openapi("Users", { description: "every user" });
