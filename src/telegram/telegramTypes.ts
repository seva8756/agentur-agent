export type ChatMessage = {
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
};
