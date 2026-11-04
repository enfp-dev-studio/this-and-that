// The canvas reads the theme's CSS variables (colours and layout lengths), so
// it follows whatever theme.css says, light or dark.

const cache = new Map<string, string>();

export function themeVar(name: string) {
  let v = cache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cache.set(name, v);
  }
  return v;
}

// A length variable (px or rem) in CSS pixels.
export function themeLength(name: string) {
  const v = themeVar(name);
  const n = parseFloat(v) || 0;
  return v.endsWith('rem') ? n * parseFloat(getComputedStyle(document.documentElement).fontSize) : n;
}

export const MARK_COUNT = 6;
export const markVar = (mark: number) => `--mark-${((mark - 1) % MARK_COUNT) + 1}`;
export const markColor = (mark: number) => themeVar(markVar(mark));

// Re-read the colours when the theme class on <html> changes.
export function watchTheme(onChange: () => void) {
  const mo = new MutationObserver(() => {
    cache.clear();
    onChange();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  return () => mo.disconnect();
}
