import { z } from 'zod';
import { FileStore } from './fileStore';

export const factSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  source: z.string().optional(),
  createdAt: z.string(),
});
export type Fact = z.infer<typeof factSchema>;
const factsSchema = z.array(factSchema);

export async function listFacts(store: FileStore): Promise<Fact[]> {
  return store.readJson(factsSchema, [], 'chat', 'facts.json');
}

export async function rememberFact(store: FileStore, text: string, source?: string): Promise<Fact> {
  const facts = await listFacts(store);
  const fact = { id: `fact_${Date.now()}`, text, source, createdAt: new Date().toISOString() };
  await store.writeJson([...facts, fact], 'chat', 'facts.json');
  return fact;
}
