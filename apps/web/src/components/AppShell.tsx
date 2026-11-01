import type { SessionUser } from '../lib/session';
import { LogoutButton } from './LogoutButton';
import { RoleNav } from './RoleNav';

export function AppShell({ user }: { user: SessionUser }) {
  return (
    <div className="border-b border-line bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-4">
        <div>
          <p className="text-2xl font-bold text-primary">SS Deals</p>
          <p className="text-lg text-ink">
            <span className="font-semibold">{user.displayName}</span>
            {user.role === 'owner' ? (
              <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-sm font-semibold text-ink">
                Admin
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a
            href="/account"
            className="inline-flex min-h-12 items-center rounded-xl border-2 border-primary px-4 text-lg font-semibold text-primary"
          >
            Account
          </a>
          <LogoutButton />
        </div>
      </div>
      <div className="mx-auto max-w-5xl px-4 pb-4">
        <RoleNav role={user.role} />
      </div>
    </div>
  );
}
