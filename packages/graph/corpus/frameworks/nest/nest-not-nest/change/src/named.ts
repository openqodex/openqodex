// A class named Controller, and a factory named like Nest's.
export class Controller {
  get(path: string): string {
    return `path ${path}`;
  }
}

const NestFactory = {
  create(root: unknown): Controller {
    void root;
    return new Controller();
  },
};

export function start(): string {
  const app = NestFactory.create(Controller);
  return app.get("/started");
}
