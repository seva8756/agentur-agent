const TOKEN_PREFIX = '\uE000';
const TOKEN_SUFFIX = '\uE001';

export function hasTelegramRichMarkup(text: string): boolean {
  return markdownToTelegramHtml(text).includes('<') || /^(#{1,6}|[-*+]|\d+\.)\s/m.test(text);
}

export function markdownToTelegramHtml(text: string): string {
  const tokens: string[] = [];
  const token = (html: string): string => {
    const index = tokens.push(html) - 1;
    return `${TOKEN_PREFIX}${index}${TOKEN_SUFFIX}`;
  };

  let formatted = text.replace(/\r\n/g, '\n');
  formatted = formatted.replace(/```([\s\S]*?)```/g, (_match, rawCode: string) => {
    const code = stripFenceLanguage(rawCode);
    return token(`<pre><code>${escapeHtml(code)}</code></pre>`);
  });
  formatted = formatted.replace(/`([^`\n]+)`/g, (_match, code: string) => token(`<code>${escapeHtml(code)}</code>`));
  formatted = formatted.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    return token(`<a href="${escapeHtmlAttribute(url)}">${escapeHtml(label)}</a>`);
  });

  formatted = escapeHtml(formatted);
  formatted = formatted.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  formatted = formatted.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  formatted = formatted.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');

  return formatted.replace(new RegExp(`${TOKEN_PREFIX}(\\d+)${TOKEN_SUFFIX}`, 'g'), (_match, index: string) => {
    return tokens[Number(index)] ?? '';
  });
}

function stripFenceLanguage(rawCode: string): string {
  const code = rawCode.replace(/^\n/, '').replace(/\n$/, '');
  const newlineIndex = code.indexOf('\n');
  if (newlineIndex <= 0) return code;
  const firstLine = code.slice(0, newlineIndex).trim();
  if (/^[a-zA-Z0-9_+.-]{1,32}$/.test(firstLine)) return code.slice(newlineIndex + 1);
  return code;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
