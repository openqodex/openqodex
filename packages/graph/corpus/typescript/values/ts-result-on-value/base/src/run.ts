import { Repo } from "./repo";
import { Item } from "./item";
export class Service {
  constructor(private repo: Repo) {}
  field(id: number) { this.repo.find(id).normalize(); }
  find(id: number): Item { return this.repo.find(id); }
  self(id: number) { this.find(id).normalize(); }
}
export function run(x: Repo, id: number) {
  x.find(id).normalize();
}
export function local(id: number) {
  const x = new Repo();
  x.find(id).normalize();
}
export function untyped(x, id: number) {
  x.find(id).normalize();
}
export function anyReceiver(x: any, id: number) {
  x.find(id).normalize();
}
export function external(x: Repo, id: number) {
  x.remote(id)
    .normalize();
}
