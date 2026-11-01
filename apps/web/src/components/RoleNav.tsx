import type { SessionUser } from '../lib/session';

const links = {
  owner: [
    { href: '/owner', label: 'Review queue' },
    { href: '/clerk', label: 'New deal' },
  ],
  clerk: [{ href: '/clerk', label: 'New deal' }],
} as const;

export function RoleNav({ role }: { role: SessionUser['role'] }) {
  return (
    <nav aria-label="Sections" className="flex flex-wrap gap-3">
      {links[role].map((link) => (
        <a
          key={link.href}
          href={link.href}
          className="inline-flex min-h-12 items-center rounded-xl bg-primary px-4 text-lg font-semibold text-white"
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}
