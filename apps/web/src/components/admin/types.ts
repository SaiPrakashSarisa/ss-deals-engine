export type AdminListItem = {
  id: string;
  title: string;
  price: number;
  oldPrice: number | null;
  oldPriceVerified: boolean;
  hasImage: boolean;
  createdBy: string;
  sourceNote: string | null;
  submittedAt: string | null;
  status: string;
  updatedAt: string;
};

export type AdminDeal = AdminListItem & {
  highlights: string[];
  offer: string | null;
  clerkNotes: string | null;
  reviewNote: string | null;
  rejectedReason: string | null;
  previewEnabled: boolean;
  productUrl: string;
  taggedUrl: string;
  shortLink: string | null;
  asin: string;
  image: { url: string; mime: string } | null;
  duplicate: {
    hasActiveDeal: boolean;
    repost: { allowed: boolean; reason: string };
  };
  preview: {
    ok: boolean;
    html?: string;
    caption?: string;
    message?: string;
    characterCount: number;
    warnings: string[];
    forbiddenWords: string[];
  };
};

export const STALE_DEAL = 'This deal changed. Reload to see the latest version.';
