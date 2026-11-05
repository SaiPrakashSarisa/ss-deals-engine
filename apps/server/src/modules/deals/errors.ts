export class DealHttpError extends Error {
  readonly statusCode: number;
  readonly fields?: Record<string, string>;

  constructor(statusCode: number, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'DealHttpError';
    this.statusCode = statusCode;
    this.fields = fields;
  }
}
