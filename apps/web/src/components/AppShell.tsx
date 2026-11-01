import type { SessionUser } from '../lib/session';
import { LogoutButton } from './LogoutButton';
import { RoleNav } from './RoleNav';

export function AppShell({ user }: { user: SessionUser }) {
  const roleLabel = user.role === 'owner' ? 'Owner' : 'Clerk';

  return (
    <div className="border-b border-line bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-4">
        <div>
          <p className="text-2xl font-bold text-primary">SS Deals</p>
          <p className="text-lg text-ink">
            <span className="font-semibold">{user.username}</span>
            <span className="mx-2 text-slate-400" aria-hidden="true">
              ·
            </span>
            <span className="rounded-full bg-accent px-3 py-1 text-base font-semibold text-ink">
              {roleLabel}
            </span>
          </p>
        </div>
        <LogoutButton />
      </div>
      <div className="mx-auto max-w-5xl px-4 pb-4">
        <RoleNav role={user.role} />
      </div>
    </div>
  );
}
