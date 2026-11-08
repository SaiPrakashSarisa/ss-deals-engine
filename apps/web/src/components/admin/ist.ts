const IST = 'Asia/Kolkata';

function part(date: Date, type: Intl.DateTimeFormatPartTypes): string {
  return (
    new Intl.DateTimeFormat('en-CA', {
      timeZone: IST,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .find((item) => item.type === type)?.value ?? ''
  );
}

export function istInputValue(date: Date): string {
  return `${part(date, 'year')}-${part(date, 'month')}-${part(date, 'day')}T${part(date, 'hour')}:${part(date, 'minute')}`;
}

export function istInputLimits(now: Date): { min: string; max: string } {
  return {
    min: istInputValue(new Date(now.getTime() + 60_000)),
    max: istInputValue(new Date(now.getTime() + 7 * 24 * 60 * 60_000)),
  };
}

export function parseIstInput(value: string): Date {
  return new Date(`${value}:00+05:30`);
}

export function formatIst(value: string | null): string {
  if (value === null || value.trim() === '') {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
