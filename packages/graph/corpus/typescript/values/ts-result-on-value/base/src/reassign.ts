import { Repo } from "./repo";
export function reassign(x: Repo, other: OtherRepo, id: number) {
  let item = x.find(id);
  item = other.find(id);
  item.normalize();
}
class OtherRepo {
  find(_id: number): OtherItem { return new OtherItem(); }
}
class OtherItem {
  normalize(): number { return 0; }
}
