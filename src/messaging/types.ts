export type ChatProvider = 'telegram' | (string & {});

export type ChatMessage = {
  provider?: ChatProvider;
  messageId: number;
  chatId: string;
  threadId?: number;
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  fromId?: string;
  username?: string;
  displayName?: string;
  text: string;
  image?: {
    dataUrl: string;
    mimeType: string;
    sizeBytes: number;
  };
  /** Image attached to the Telegram message being quoted, kept out of chat storage. */
  quotedImage?: {
    dataUrl: string;
    mimeType: string;
    sizeBytes: number;
  };
  attachments?: ChatMessageAttachment[];
  date: Date;
  replyToBot?: boolean;
  quotedMessage?: { text: string; authorName?: string };
  entities?: Array<{ type: string; offset: number; length: number }>;
};

export type ChatMessageAttachment = {
  kind: 'file' | 'photo' | 'video';
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Text extracted from a newly received text-like attachment; never sent to the model inline. */
  extractedText?: string;
  extractedTextTruncated?: boolean;
  /** Original bytes from the newly received message; never set for a quoted reply attachment. */
  originalBytes?: Uint8Array;
};
