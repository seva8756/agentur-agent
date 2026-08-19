import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export type TokenEstimator = {
  estimateText: (text: string) => number;
  trimTextToTokens: (text: string, maxTokens: number) => string;
};

export const conservativeTokenEstimator: TokenEstimator = {
  estimateText,
  trimTextToTokens,
};

export function estimateMessageTokens(message: ChatCompletionMessageParam, estimator: TokenEstimator = conservativeTokenEstimator): number {
  return 4 + estimateContentTokens(message.content, estimator);
}

export function estimateContentTokens(content: ChatCompletionMessageParam['content'], estimator: TokenEstimator = conservativeTokenEstimator): number {
  if (typeof content === 'string') return estimator.estimateText(content);
  if (!content) return 0;
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (typeof part !== 'object' || part === null || !('type' in part)) return sum;
      if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
        return sum + estimator.estimateText(part.text);
      }
      return sum;
    }, 0);
  }
  return estimator.estimateText(JSON.stringify(content));
}

function estimateText(text: string): number {
  if (!text) return 0;
  const cyrillic = text.match(/[\u0400-\u04ff]/g)?.length ?? 0;
  const asciiWord = text.match(/[A-Za-z0-9_]+/g)?.join('').length ?? 0;
  const whitespace = text.match(/\s/g)?.length ?? 0;
  const punctuation = Math.max(0, text.length - cyrillic - asciiWord - whitespace);

  const estimate =
    cyrillic / 1.7 +
    asciiWord / 3.6 +
    punctuation / 1.5 +
    whitespace / 8;

  return Math.max(1, Math.ceil(estimate * 1.2));
}

function trimTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || !text) return '';
  if (estimateText(text) <= maxTokens) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateText(text.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }

  return text.slice(0, low).trimEnd();
}
