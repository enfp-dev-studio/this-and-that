import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@/components/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider delayDuration={300}>
        <App />
        {/* Below the floating chrome, in both modes. */}
        <Toaster position="top-center" offset={{ top: 'var(--chrome-height)' }} />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
