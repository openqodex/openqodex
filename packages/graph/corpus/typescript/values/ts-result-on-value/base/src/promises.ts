import { Item } from "./item";
class AsyncRepo {
  async find(): Promise<Item> { return new Item(); }
}
export class Svc {
  constructor(private repo: AsyncRepo) {}
  async run() {
    this.repo.find()
      .then(() => {});
    this.repo.find()
      .catch(() => {});
    this.repo.find()
      .finally(() => {});
    (await this.repo.find()).normalize();
  }
}
export async function run(x: AsyncRepo) {
  x.find()
    .then(() => {});
  (await x.find()).normalize();
  const item = await x.find();
  item.normalize();
}
