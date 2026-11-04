import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { checkPasscode, configLoaded, getPasscode, onLimit, onPasscodeNeeded, setPasscode } from '@/runtime/meta';

// Today's free jobs are used up: said on load and whenever a take is refused.
const quotaToast = (message = "It resets at 09:00 KST (00:00 UTC).") =>
  toast.error("Today's free quota is used up", { id: 'quota', description: message.replace(/^Today's free quota is used up\.\s*/, ''), duration: 10_000 });

// When the Worker has a passcode set, it is asked once, kept in this
// browser, and asked again whenever the proxy refuses it. A reached limit is
// said in the proxy's own words.
export function PasscodeGate() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(getPasscode());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    configLoaded.then((c) => {
      if (c.passcode) checkPasscode().then((ok) => !ok && setOpen(true), () => setOpen(true));
      if (c.jobs && c.jobs.used >= c.jobs.cap) quotaToast();
    });
    const offLimit = onLimit(({ error, message }) => (error === 'quota' ? quotaToast(message) : toast.error('Limit reached', { id: 'limit', description: message })));
    const offPass = onPasscodeNeeded(() => setOpen(true));
    return () => (offLimit(), offPass());
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
            <DialogDescription>This build is shared with a passcode. Enter the one you were given.</DialogDescription>
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
