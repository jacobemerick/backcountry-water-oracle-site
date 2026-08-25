/**
 * A titled block of the essay: a collar label, a heading, and body.
 *
 * The eyebrow is a real `.collar-label` rather than the hand-rolled
 * `font-mono text-xs uppercase tracking-[0.2em]` it used to be — that string
 * was a collar label written from memory, which is exactly what the type role
 * classes exist to stop.
 */
export function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-4 border-t border-border py-14 sm:py-20">
      <p className="collar-label text-accent">{eyebrow}</p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
      <div className="mt-8">{children}</div>
    </section>
  );
}
