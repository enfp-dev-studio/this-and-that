import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { checkPasscode, getPasscode, onPasscodeNeeded, setPasscode } from '@/runtime/meta';

// The demo runs on a shared budget behind a passcode: asked once, kept in
// this browser, asked again whenever the proxy refuses it.
export function PasscodeGate() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(getPasscode());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    checkPasscode().then((ok) => !ok && setOpen(true), () => setOpen(true));
    return onPasscodeNeeded(() => setOpen(true));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (await checkPasscode(value.trim())) {
        setPasscode(value.trim());
        setOpen(false);
      } else setError("That passcode didn't work.");
    } catch {
      setError("Can't reach the demo server. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} onInteractOutside={(e) => e.preventDefault()}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Demo passcode</DialogTitle>
            <DialogDescription>This demo calls the Meta models on a shared budget. Enter the passcode you were given.</DialogDescription>
          </DialogHeader>
          <Input type="password" autoFocus autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!!error} placeholder="Passcode" />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy || !value.trim()}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
