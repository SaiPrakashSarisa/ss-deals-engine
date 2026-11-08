export function dealImageSrc(id: string, updatedAt: string | null | undefined): string {
  const path = `/api/deals/${id}/image`;
  if (updatedAt === undefined || updatedAt === null || updatedAt.length === 0) {
    return path;
  }
  return `${path}?v=${encodeURIComponent(updatedAt)}`;
}
