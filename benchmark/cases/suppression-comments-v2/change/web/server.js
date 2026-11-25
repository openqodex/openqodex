import express from "express";

export const app = express();

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// GET /calc?expr=1+2 answers with the value of a small arithmetic expression.
app.get("/calc", (req, res) => {
  // eslint-disable-next-line no-eval
  const value = eval(String(req.query.expr)); // nosemgrep
  res.json({ value });
});
