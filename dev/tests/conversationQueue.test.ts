import { describe, expect, it } from 'vitest';
import { ConversationQueue } from '../../src/messaging/conversationQueue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ConversationQueue', () => {
  it('runs one conversation sequentially', async () => {
    const queue = new ConversationQueue();
    const gate = deferred();
    const events: string[] = [];
    const chatId = 'one';

    const first = queue.enqueue(chatId, async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = queue.enqueue(chatId, async () => {
      events.push('second');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('does not block another chat', async () => {
    const queue = new ConversationQueue();
    const gate = deferred();

    const blocked = queue.enqueue('one', () => gate.promise);
    await queue.enqueue('two', async () => undefined);

    gate.resolve();
    await blocked;
  });

  it('continues a conversation after a failed task', async () => {
    const queue = new ConversationQueue();
    const chatId = 'one';

    await expect(queue.enqueue(chatId, async () => {
      throw new Error('failed');
    })).rejects.toThrow('failed');

    await expect(queue.enqueue(chatId, async () => 'continued')).resolves.toBe('continued');
  });
});
