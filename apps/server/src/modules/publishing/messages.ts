export const PUBLISHING_OFF = 'Publishing is turned off.';
export const PUBLISHING_PAUSED = 'Publishing is paused.';
export const NOT_APPROVED = 'Only an approved deal can be published.';
export const NO_CAPTION = 'This deal has no saved post.';
export const CAPTION_TOO_LONG = (length: number) =>
  `This photo caption is ${length} characters. Keep it under 1024 characters.`;
export const DAILY_LIMIT = "Today's post limit has been reached.";
export const UNKNOWN_PRICE =
  'The earlier posted price is missing. Confirm that this product was not posted recently.';
export const IN_FLIGHT = 'A post for this product is already in progress.';
export const IMAGE_MISSING = 'The deal image could not be read.';
export const RECORD_FAILED =
  'The post reached Telegram, but it could not be recorded. Check the channel before trying again.';
export const NOT_UNCERTAIN = 'Only an uncertain post can be resolved.';
export const CHANNEL_MISSING = 'The Telegram channel is not configured.';
export const SCHEDULE_FUTURE = 'Choose a time in the future.';
export const SCHEDULE_WINDOW = 'Choose a time within the next 7 days.';
export const NOT_QUEUED = 'Unschedule is only available before the post starts.';
export const NOT_SCHEDULED = 'Only a scheduled deal can be unscheduled.';
export const MISSED_WINDOW = 'Missed its scheduled time (the server was off or paused)';
export const STOPPED_WHILE_POSTING = 'Server stopped while posting. Check the channel.';
export const SETTINGS_INVALID =
  'Enter a daily limit from 1 to 100 and a gap from 0 to 1440 minutes.';
