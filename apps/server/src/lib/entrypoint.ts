import { pathToFileURL } from 'node:url';

export function isEntrypoint(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }

  return metaUrl === pathToFileURL(entry).href;
}
