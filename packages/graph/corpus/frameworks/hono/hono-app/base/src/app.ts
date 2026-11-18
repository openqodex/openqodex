import { Hono as Server } from "hono";
import { buildAdmin, pickAdmin } from "./admin";
import { gone, health, stats } from "./handlers";
import { logger } from "./middleware";
import { users } from "./users";

export const app = new Server();
app.use("*", logger);
app.get("/health", health);
app.route("/users", users);
app.route("/admin", buildAdmin());
app.route("/pick", pickAdmin(true));
app.post("/gone", gone);
app.get("/inline", (c) => c.text("inline"));
app.on(["PUT", "PATCH"], "/both", health);
app.all("/any", health);
app.get(`/v${process.env.VERSION}/status`, stats);
app.route(`/${process.env.TENANT}`, users);
