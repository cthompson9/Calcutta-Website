import { useState, type FormEvent } from "react";
import type { AuctionSnapshot } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { resetAuctionRun } from "./admin-actions";

interface ResetAuctionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calcuttaId: number;
  auctionId: number;
  revision: number;
  adminKey: string;
  onReset: (snapshot: AuctionSnapshot) => void;
  onStale: () => void;
}

export function ResetAuctionDialog({ open, onOpenChange, calcuttaId, auctionId, revision, adminKey, onReset, onStale }: ResetAuctionDialogProps) {
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const phrase = `DELETE DRAFT ${auctionId}`;

  const close = (nextOpen: boolean) => {
    if (pending) return;
    if (!nextOpen) {
      setConfirmation("");
      setError("");
    }
    onOpenChange(nextOpen);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || confirmation !== phrase) return;
    setPending(true);
    setError("");
    try {
      const snapshot = await resetAuctionRun(calcuttaId, auctionId, revision, confirmation, adminKey);
      onReset(snapshot);
      setConfirmation("");
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reset the auction run.");
      onStale();
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-widest">Reset auction run</DialogTitle>
          <DialogDescription>
            This permanently clears nominations, bids, sales, and ownership created by this run, plus its listener transcript.
            The Calcutta, roster, and lots stay in place. Completed auctions and entries with approved trades cannot be reset.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <label className="block space-y-2 text-sm">
            <span>Type <strong className="font-mono select-all">{phrase}</strong> to confirm:</span>
            <input
              data-testid="input-reset-auction-confirmation"
              type="text"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="w-full border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
            />
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={() => close(false)} disabled={pending} className="border border-border px-4 py-2 text-sm font-mono disabled:opacity-50">Cancel</button>
            <button
              data-testid="button-confirm-reset-auction"
              type="submit"
              disabled={pending || confirmation !== phrase}
              className="inline-flex items-center gap-2 bg-destructive px-4 py-2 text-sm font-mono font-bold text-destructive-foreground disabled:opacity-50"
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Reset auction run
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}