function defineTool<T>(tool: T): T {
  return tool;
}

export class Sandbox {
  private tools = [defineTool({ handler: (input: string) => this.handleExec(input) })];
  static presets = [defineTool({ handler: (input: string) => this.handleExec(input) })];
  handleExec(input: string): string {
    return input;
  }
  static handleExec(input: string): string {
    return input;
  }
}
