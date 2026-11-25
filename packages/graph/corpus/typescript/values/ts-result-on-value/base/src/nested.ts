import { Item } from "./item";
export class Service {
  find(): Item { return new Item(); }
}
class OtherItem {
  normalize(): number { return 0; }
}
class OtherService {
  find(): OtherItem { return new OtherItem(); }
}
describe("nested receiver", () => {
  class Service extends OtherService {
    run() { this.find().normalize(); }
  }
  new Service().run();
});
