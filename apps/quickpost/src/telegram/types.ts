export type CallbackButton = { kind: 'callback'; text: string; data: string };
export type UrlButton = { kind: 'url'; text: string; url: string };
export type Keyboard = Array<Array<CallbackButton | UrlButton>>;

export type LinkPreviewSetting = { url: string } | { disabled: true };

export type SendRequest = {
  chatId: number | string;
  text: string;
  parseMode?: 'HTML';
  keyboard?: Keyboard;
  linkPreview?: LinkPreviewSetting;
};

export type PhotoSendRequest = {
  chatId: number | string;
  photo: string;
  caption: string;
  parseMode?: 'HTML';
  keyboard?: Keyboard;
};

export type SendOutcome =
  | { ok: true; messageId: number }
  | { ok: false; reason: 'rate_limited'; retryAfterSeconds: number }
  | { ok: false; reason: 'uncertain' }
  | { ok: false; reason: 'rejected'; description: string };

export interface TelegramApi {
  sendMessage(request: SendRequest): Promise<SendOutcome>;
  sendPhoto(request: PhotoSendRequest): Promise<SendOutcome>;
  answerCallback(callbackId: string): Promise<void>;
}
