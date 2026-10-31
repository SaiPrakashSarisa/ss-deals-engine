import { FORBIDDEN_PHRASES } from '../format/post.js';

export function helpText(dailyPostLimit: number): string {
  return [
    'Send one deal per message:',
    '',
    'https://www.amazon.in/dp/B0XXXXXXXX',
    'title: Product name',
    'price: 1,499',
    'old: 2,999',
    'verified: yes',
    '- Highlight',
    '',
    'Rules:',
    '- title and price are required.',
    '- price is a whole number of rupees: 1499, 1,499, or ₹1,499.',
    '- old is optional and must be higher than price.',
    '- verified is yes or no. The default is no. A percentage is shown only when verified is yes.',
    '- Up to 3 lines starting with - become bullets.',
    '- Use a full amazon.in /dp/ or /gp/product/ link. Short links are rejected.',
    '- Nothing is posted until you tap Post to channel.',
    '- The same product within 14 days needs a second confirmation.',
    `- The daily limit is ${dailyPostLimit} posts. Going over it needs an extra confirmation.`,
    `- Avoid these words: ${FORBIDDEN_PHRASES.join(', ')}.`,
  ].join('\n');
}
