export interface Handler {
  (): void;
  cancel(): void;
}

export function onEvent(): void {}
onEvent.cancel = () => {};

export function makeHandler(): Handler {
  return onEvent;
}
