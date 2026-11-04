import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// What happens to your pictures and voice, one tap from the name.
export function PrivacyNote() {
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button variant="ghost" size="icon-touch" className="rounded-full" aria-label="Privacy">
              <Info />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Privacy</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Privacy</DialogTitle>
          <DialogDescription>Images and voice are sent to Meta's model API to make the edit; nothing is stored on our server; your work stays in this browser.</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Your pictures, results and recordings are kept in this browser's storage for this site. Clearing the site's data removes them.</p>
      </DialogContent>
    </Dialog>
  );
}
