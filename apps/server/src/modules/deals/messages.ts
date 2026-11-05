export const FIELD_SUMMARY = 'Check the highlighted fields.';
export const ACTIVE_DEAL_MESSAGE = 'This product is already in the queue.';
export const NOT_FOUND = 'That deal was not found.';
export const NOT_EDITABLE = 'This deal can no longer be changed.';
export const ALREADY_REVIEWED = 'This deal was already reviewed.';
export const OWN_DRAFT_ONLY = 'You can only change your own draft.';
export const ONLY_DRAFT = 'Only a draft can be sent for review.';
export const DRAFT_RATE_LIMIT_ERROR =
  'You have saved too many deals this hour. Wait and try again.';
export const UPLOAD_RATE_LIMIT_ERROR =
  'You have uploaded too many images this hour. Wait and try again.';
export const IMAGE_TYPE_ERROR = 'Upload a JPEG, PNG, or WebP image.';
export const IMAGE_INVALID_ERROR = 'That file is not a valid image.';
export const IMAGE_MISSING_ERROR = 'Choose an image.';
export const IMAGE_NONE_ERROR = 'This deal has no image.';
export const IMAGE_SAVE_ERROR = 'The image could not be saved. Try again.';
export const SHORT_LINK_ERROR = 'Paste an https short link, or leave this empty.';
export const PRICE_ERROR = 'Enter the price in whole rupees.';
export const PRICE_TOO_BIG_ERROR = 'Enter a smaller price.';
export const OLD_PRICE_ERROR = 'Enter the old price in whole rupees.';
export const OLD_PRICE_ORDER_ERROR = 'Old price has to be higher than the price.';
export const TITLE_ERROR = 'Enter a title.';
export const TITLE_LENGTH_ERROR = 'Keep the title under 200 characters.';
export const URL_ERROR = 'Paste the product page link.';
export const OFFER_LENGTH_ERROR = 'Keep the offer under 120 characters.';
export const HIGHLIGHT_LENGTH_ERROR = 'Keep each highlight under 80 characters.';
export const HIGHLIGHT_COUNT_ERROR = 'Enter up to 3 highlights.';
export const SOURCE_NOTE_LENGTH_ERROR = 'Keep this under 120 characters.';
export const NOTES_LENGTH_ERROR = 'Keep notes under 300 characters.';

export function repostRefusalMessage(reason: 'price_not_lower' | 'previous_price_unknown'): string {
  if (reason === 'previous_price_unknown') {
    return 'This product was posted before, but the earlier price is missing. Ask an admin to check it.';
  }
  return 'This product was already posted. The new price has to be lower than the last posted price.';
}

export function imageTooLargeMessage(maxUploadBytes: number): string {
  const megabytes = maxUploadBytes / (1024 * 1024);
  if (Number.isInteger(megabytes)) {
    return `Image must be under ${megabytes} MB.`;
  }
  return 'This image is too large.';
}
