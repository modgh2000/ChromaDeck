/**
 * Window-control dots — three 6px dots. Leader at 40% of the muted foreground,
 * two trailing dots at 15%. Decorative.
 */
export default function WindowDots() {
  return (
    <span className="inline-flex h-1.5 w-[26px] items-center justify-between" aria-hidden="true">
      <span className="size-1.5 rounded-full bg-muted-foreground/40" />
      <span className="size-1.5 rounded-full bg-muted-foreground/15" />
      <span className="size-1.5 rounded-full bg-muted-foreground/15" />
    </span>
  );
}
