import { describe, expect, it } from 'vitest';
import { parseImportArgs, parsePostedLog } from '../src/scripts/import-quickpost.js';

const sample = JSON.stringify({
  entries: [
    {
      asin: 'B0IMPORT01',
      timestamp: '2026-11-01T04:00:00.000Z',
      message_id: 42,
      mode: 'photo',
      link: 'short',
      title: 'Logged kettle',
      channel: '@history_channel',
    },
    {
      asin: 'B0IMPORT02',
      timestamp: '2026-11-02T04:00:00.000Z',
      message_id: 'uncertain',
    },
    {
      asin: 'B0IMPORT01',
      timestamp: '2026-11-03T04:00:00.000Z',
      message_id: 43,
    },
    { asin: 'not-an-asin', timestamp: 'yesterday', message_id: 1 },
  ],
});

describe('quick-post import', () => {
  it('reads a posted log and reports one bad entry', () => {
    const parsed = parsePostedLog(sample);
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[0]?.title).toBe('Logged kettle');
    expect(parsed.entries[1]?.message_id).toBe('uncertain');
    expect(parsed.errors).toEqual(['Entry 4: not a valid post log entry.']);
  });

  it('rejects a file that is not a post log', () => {
    expect(() => parsePostedLog('{')).toThrow('posted.json is not a valid post log');
    expect(() => parsePostedLog('{"rows":[]}')).toThrow('posted.json is not a valid post log');
  });

  it('reads the file, the admin username, and dry run', () => {
    expect(
      parseImportArgs(['--file', 'posted.json', '--admin-username', 'ada', '--dry-run']),
    ).toEqual({
      file: 'posted.json',
      adminUsername: 'ada',
      dryRun: true,
    });
    expect(parseImportArgs(['--file=posted.json', '--admin-username=ada']).dryRun).toBe(false);
  });
});
