import { Item } from "./item";
import { Item as RemoteItem } from "outside-sdk";
export class Repo {
  find(_id: number): Item { return new Item(); }
  remote(_id: number): RemoteItem { throw new Error(); }
}
