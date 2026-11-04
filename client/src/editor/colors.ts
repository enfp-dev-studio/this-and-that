// Canvas colours come from the theme's CSS variables, so the marks follow
// whatever theme.css says (and light/dark).

const cache = new Map<string, string>();

export function themeColor(name: string) {
  let v = cache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cache.set(name, v);
  }
  return v;
}

export const MARK_COUNT = 6;
export const markVar = (mark: number) => `--mark-${((mark - 1) % MARK_COUNT) + 1}`;
export const markColor = (mark: number) => themeColor(markVar(mark));

// Re-read the colours when the theme class on <html> changes.
export function watchTheme(onChange: () => void) {
  const mo = new MutationObserver(() => {
    cache.clear();
    onChange();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  return () => mo.disconnect();
}
