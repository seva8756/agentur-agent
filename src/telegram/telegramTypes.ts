export type ChatMessage = {
  messageId: number;
  chatId: string;
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
  date: Date;
  replyToBot?: boolean;
  entities?: Array<{ type: string; offset: number; length: number }>;
};
