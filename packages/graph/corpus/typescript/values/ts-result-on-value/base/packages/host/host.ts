import type { Item } from "@sample/view/internal";
export class Host {
  constructor(private item: Item) {}
  find(): Item { return this.item; }
}
