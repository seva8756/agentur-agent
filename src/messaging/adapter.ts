import { FileStore } from '../memory/fileStore';
import { SkillRunResult } from '../skills/result';

export type ChatAdapter = {
  id: string;
  botUsername: string;
  sendResult: (chatId: string, store: FileStore, result: SkillRunResult, threadId?: number | null) => Promise<void>;
  sendTyping?: (chatId: string, threadId?: number | null) => Promise<void>;
  start: () => Promise<void>;
};
