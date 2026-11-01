import { homePath, getCurrentUser } from '../../lib/session';

export default async function ForbiddenPage() {
  const user = await getCurrentUser();
  const back = user === null ? '/login' : homePath(user.role);

  return (
    <section className="rounded-2xl border border-line bg-white p-6">
      <h1 className="text-3xl font-bold">You don&apos;t have access to this page.</h1>
      <a
        href={back}
        className="mt-6 inline-flex min-h-12 items-center rounded-xl bg-primary px-4 text-lg font-semibold text-white"
      >
        Go back
      </a>
    </section>
  );
}
