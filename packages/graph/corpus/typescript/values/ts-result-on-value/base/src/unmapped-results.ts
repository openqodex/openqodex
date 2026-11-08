import { Host } from "../packages/host/host";
import { Item } from "./item";
describe("declared results", () => {
  let host: Host;
  beforeEach(() => { host = new Host(new Item()); });
  it("follows a captured typed receiver", () => {
    const item = host.find();
    item.normalize();
  });
  it("follows a constructed receiver", () => {
    const host = new Host(new Item());
    host.find().normalize();
  });
});
