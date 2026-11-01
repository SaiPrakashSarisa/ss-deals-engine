export const dynamic = 'force-dynamic';

const buttonClass =
  'flex min-h-32 items-center justify-center rounded-2xl bg-primary px-6 text-2xl font-bold text-white';

export default function DealsPage() {
  return (
    <section>
      <h1 className="text-3xl font-bold">Deals</h1>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <a href="/deals/new" className={buttonClass}>
          New deal
        </a>
        <a href="/deals/mine" className={buttonClass}>
          My deals
        </a>
      </div>
    </section>
  );
}
