export class ConversationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(chatId) ?? Promise.resolve();
    const execution = previous.then(task);
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );

    this.tails.set(chatId, tail);
    void tail.then(() => {
      if (this.tails.get(chatId) === tail) this.tails.delete(chatId);
    });

    return execution;
  }
}
