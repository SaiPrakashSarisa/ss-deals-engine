import { homePath, getCurrentUser } from '../../lib/session';

export default async function ForbiddenPage() {
  const user = await getCurrentUser();
  const back = user === null ? '/login' : homePath(user.role);

  return (
    <section className="rounded-2xl border border-line bg-white p-6">
      <h1 className="text-3xl font-bold">You do not have access to this page</h1>
      <p className="mt-4 text-xl">This part of the desk is for the owner.</p>
      <a
        href={back}
        className="mt-6 inline-flex min-h-12 items-center rounded-xl bg-primary px-4 text-lg font-semibold text-white"
      >
        Go back
      </a>
    </section>
  );
}
