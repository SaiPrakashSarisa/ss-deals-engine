import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  agentRules: false,
  // Next.js only renders forbidden.tsx when this switch is on.
  experimental: {
    authInterrupts: true,
  },
};

export default nextConfig;
