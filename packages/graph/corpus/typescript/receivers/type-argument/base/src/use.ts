import type { Box, Wrapper } from "./box";
import type { Sessions } from "./sessions";

export function fromBox(box: Box<Sessions>) {
  return box.value.close();
}

export function fromWrapper(wrapper: Wrapper<Sessions>) {
  return wrapper.value.close();
}

export function fromLoose(box: Box<any>) {
  return box.value.close();
}
