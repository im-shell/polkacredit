import type { ReactNode } from "react";

/**
 * Per DESIGN §3.5 / §6.5: every major block sits inside a <Section> with a
 * mono numeric prefix ("01", "02", "∞"), a sans h2, an optional right-aligned
 * sub-label, a hairline rule, and the body content below.
 */
export function Section({
  num,
  title,
  sub,
  children,
}: {
  num: string;
  title: string;
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="head">
        <span className="num">{num}</span>
        <h2>{title}</h2>
        {sub !== undefined && <span className="sub">{sub}</span>}
      </div>
      {children}
    </section>
  );
}
