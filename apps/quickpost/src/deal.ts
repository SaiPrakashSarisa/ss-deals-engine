export type DealDraft = {
  asin: string;
  taggedUrl: string;
  title: string;
  price: number;
  oldPrice?: number;
  verified: boolean;
  highlights: string[];
};
