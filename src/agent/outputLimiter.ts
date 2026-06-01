export function limitOutput(text: string, maxChars: number): string {
  const compact = text.replace(/[ \t]+\n/g, '\n').trim();
  if (compact.length <= maxChars) return compact;
  const sliced = compact.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  const sentence = sliced.match(/^([\s\S]*?[.!?。！？])(?:\s|$)/g)?.join('').trim();
  if (sentence && sentence.length > 20 && sentence.length <= maxChars) return sentence;
  return `${sliced.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
