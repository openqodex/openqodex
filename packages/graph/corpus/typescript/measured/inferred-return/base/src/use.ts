import { Store } from "./store";

function createStore() {
  return new Store();
}

async function setup() {
  return { store: new Store() };
}

export function useIt(): string {
  const store = createStore();
  return store.get("1");
}

export async function useSetup(): Promise<string> {
  const { store } = await setup();
  return store.get("2");
}
