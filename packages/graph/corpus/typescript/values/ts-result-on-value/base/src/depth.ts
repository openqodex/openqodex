import { Repo } from "./repo";

export function atLimit(x: Repo, id: number) {
  x.find(id).next().next().next().next().next().next().next().next().next().next().next().next().next().next().next().normalize();
}
export function pastLimit(x: Repo, id: number) {
  x.find(id).next().next().next().next().next().next().next().next().next().next().next().next().next().next().next().next().normalize();
}
