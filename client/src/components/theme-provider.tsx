import { createContext, useContext, useEffect, useState } from 'react';

// shadcn/ui's dark mode for Vite: a class on <html>, remembered per browser.
type Theme = 'dark' | 'light';
const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({ theme: 'dark', setTheme: () => {} });
const KEY = 'this-and-that-theme';

export function ThemeProvider({ children, defaultTheme = 'dark' }: { children: React.ReactNode; defaultTheme?: Theme }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(KEY) as Theme) || defaultTheme;
    } catch {
      return defaultTheme;
    }
  });
  useEffect(() => {
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {}
  }, [theme]);
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
