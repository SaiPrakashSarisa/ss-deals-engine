import { redirect } from 'next/navigation';
import { LoginForm } from '../../components/LoginForm';
import { getCurrentUser, homePath } from '../../lib/session';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user !== null) {
    redirect(homePath(user.role));
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4 py-10">
      <h1 className="text-4xl font-bold text-primary">SS Deals</h1>
      <p className="mt-2 text-xl text-ink">Sign in to continue.</p>
      <div className="mt-8 rounded-2xl border border-line bg-white p-6 shadow-sm">
        <LoginForm />
      </div>
    </main>
  );
}
