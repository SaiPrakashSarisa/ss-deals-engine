import { formatRupees } from '@ss-deals/core';

export function formatPaise(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const absolute = Math.abs(paise);
  const rupees = Math.trunc(absolute / 100);
  const fraction = absolute % 100;
  if (fraction === 0) {
    return `${sign}₹${formatRupees(rupees)}`;
  }
  return `${sign}₹${formatRupees(rupees)}.${String(fraction).padStart(2, '0')}`;
}
