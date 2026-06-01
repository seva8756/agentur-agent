import { AgentTool } from './types';

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool<any>>();

  register(tool: AgentTool<any>): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool<any> | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool<any>[] {
    return [...this.tools.values()];
  }
}
