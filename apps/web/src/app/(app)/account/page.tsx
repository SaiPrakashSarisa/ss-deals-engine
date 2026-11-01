import { ChangePasswordForm } from '../../../components/ChangePasswordForm';

export const dynamic = 'force-dynamic';

export default function AccountPage() {
  return (
    <section className="max-w-lg rounded-2xl border border-line bg-white p-6">
      <h1 className="text-3xl font-bold">Account</h1>
      <p className="mt-2 text-xl">Change the password for this sign-in.</p>
      <div className="mt-6">
        <ChangePasswordForm />
      </div>
    </section>
  );
}
