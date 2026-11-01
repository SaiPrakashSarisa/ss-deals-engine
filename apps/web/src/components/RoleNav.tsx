import type { SessionUser } from '../lib/session';

const links = {
  owner: [
    { href: '/admin', label: 'Review queue' },
    { href: '/deals/new', label: 'New deal' },
  ],
  clerk: [
    { href: '/deals/new', label: 'New deal' },
    { href: '/deals/mine', label: 'My deals' },
  ],
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
