import { Repo } from "./repo";

describe("declared results", () => {
  let host: Repo;
  beforeEach(() => { host = new Repo(); });
  it("follows a captured typed receiver", () => {
    const item = host.find(1);
    item.normalize();
  });
  it("follows a constructed receiver", () => {
    const host = new Repo();
    host.find(1).normalize();
  });
});
