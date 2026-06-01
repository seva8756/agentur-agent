import { z } from 'zod';
import { FileStore } from './fileStore';

export const decisionSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  source: z.string().optional(),
  createdAt: z.string(),
});
export type Decision = z.infer<typeof decisionSchema>;
const decisionsSchema = z.array(decisionSchema);

export async function listDecisions(store: FileStore): Promise<Decision[]> {
  return store.readJson(decisionsSchema, [], 'chat', 'decisions.json');
}

export async function saveDecision(store: FileStore, text: string, source?: string): Promise<Decision> {
  const decisions = await listDecisions(store);
  const decision = { id: `decision_${Date.now()}`, text, source, createdAt: new Date().toISOString() };
  await store.writeJson([...decisions, decision], 'chat', 'decisions.json');
  return decision;
}
