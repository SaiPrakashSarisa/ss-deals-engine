export function parsePriceInput(raw: string): number | undefined {
  let text = raw.trim();
  if (text.startsWith('₹')) {
    text = text.slice(1).trim();
  }
  text = text.replaceAll(',', '');
  if (!/^[1-9]\d{0,11}$/.test(text)) {
    return undefined;
  }
  const amount = Number(text);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return undefined;
  }
  return amount;
}

export const parseRupeeAmount = parsePriceInput;

const PAISA_PER_RUPEE = 100;

export function rupeesToPaise(rupees: number): number {
  assertNonNegativeInteger(rupees, 'Rupees');
  const paise = rupees * PAISA_PER_RUPEE;
  if (!Number.isSafeInteger(paise)) {
    throw new RangeError('Rupees convert to a paise amount outside the safe integer range');
  }
  return paise;
}

export function paiseToRupees(paise: number): number {
  assertNonNegativeInteger(paise, 'Paise');
  if (paise % PAISA_PER_RUPEE !== 0) {
    throw new RangeError('Paise must be a multiple of 100 to convert to whole rupees');
  }
  return paise / PAISA_PER_RUPEE;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
}
