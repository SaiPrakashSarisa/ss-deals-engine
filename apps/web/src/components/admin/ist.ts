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
  const date = istDate(value);
  if (date === null) {
    return '';
  }
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatIstClock(value: string | Date | null): string {
  const date = value instanceof Date ? value : istDate(value);
  if (date === null) {
    return '';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: IST,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const hour = parts.find((item) => item.type === 'hour')?.value ?? '';
  const minute = parts.find((item) => item.type === 'minute')?.value ?? '';
  const period = (parts.find((item) => item.type === 'dayPeriod')?.value ?? '').toLowerCase();
  return `${hour}:${minute} ${period}`;
}

export function formatIstSchedule(value: string | null): string {
  const date = istDate(value);
  if (date === null) {
    return '';
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${pick('weekday')} ${pick('day')} ${pick('month')}, ${pick('hour')}:${pick('minute')} ${pick('dayPeriod').toLowerCase()}`;
}

export function quickScheduleChoices(now: Date): Array<{ label: string; value: string }> {
  const limits = istInputLimits(now);
  const choices: Array<{ label: string; value: string }> = [
    { label: 'In 1 hour', value: istInputValue(new Date(now.getTime() + 60 * 60_000)) },
  ];
  const today = istInputValue(now).slice(0, 10);
  const tonight = `${today}T18:00`;
  if (tonight >= limits.min && tonight <= limits.max) {
    choices.push({ label: 'Today 6 pm', value: tonight });
  }
  const morning = istInputValue(new Date(parseIstInput(`${today}T09:00`).getTime() + 86_400_000));
  if (morning >= limits.min && morning <= limits.max) {
    choices.push({ label: 'Tomorrow 9 am', value: morning });
  }
  return choices;
}

function istDate(value: string | null): Date | null {
  if (value === null || value.trim() === '') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
