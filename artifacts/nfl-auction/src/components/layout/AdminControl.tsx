import { useState, type FormEvent } from "react";
import { Lock, Unlock } from "lucide-react";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function AdminControl({ mobile = false }: { mobile?: boolean }) {
  const { adminKey, unlock, lock } = useAdminAccess();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [validating, setValidating] = useState(false);

  function close() {
    setOpen(false);
    setInput("");
    setError("");
  }

  async function handleUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!input.trim() || validating) return;
    setError("");
    setValidating(true);
    const result = await unlock(input.trim());
    setValidating(false);
    if (result.ok) close();
    else setError(result.error ?? "Invalid admin key");
  }

  return (
    <>
      <button
        type="button"
        data-testid={mobile ? "button-admin-mobile" : "button-admin-sidebar"}
        onClick={() => adminKey ? lock() : setOpen(true)}
        aria-label={adminKey ? "Admin active. Lock admin access" : "Unlock admin access"}
        title={adminKey ? "Admin active — click to lock across all tabs" : "Unlock admin controls across all tabs"}
        className={mobile
          ? `flex h-full w-full flex-col items-center justify-center gap-1 px-1 ${adminKey ? "text-green-700" : "text-muted-foreground hover:text-foreground"}`
          : `flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-medium transition-colors ${adminKey ? "text-green-700 hover:bg-sidebar-accent" : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"}`}
      >
        {adminKey ? <Unlock className={mobile ? "h-5 w-5" : "h-4 w-4"} /> : <Lock className={mobile ? "h-5 w-5" : "h-4 w-4"} />}
        <span className={mobile ? "text-[9px] font-bold uppercase tracking-wider" : ""}>
          {adminKey && !mobile ? "Admin Active" : "Admin"}
        </span>
      </button>
      <Dialog open={open} onOpenChange={(next) => { if (!next) close(); else setOpen(true); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Unlock Admin</DialogTitle>
            <DialogDescription>
              Enter your admin key once to access admin controls on Auction, Analysis, and Trades. Access lasts until you lock it or reload this page.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => void handleUnlock(event)} className="space-y-3">
            <label htmlFor={mobile ? "admin-key-mobile" : "admin-key-desktop"} className="block text-sm font-medium">Admin key</label>
            <input
              id={mobile ? "admin-key-mobile" : "admin-key-desktop"}
              data-testid={mobile ? "input-admin-key-mobile" : "input-admin-key-desktop"}
              type="password"
              autoComplete="off"
              value={input}
              onChange={(event) => { setInput(event.target.value); setError(""); }}
              className="w-full border border-border bg-background px-3 py-2 text-sm"
              autoFocus
            />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <button
              type="submit"
              data-testid={mobile ? "button-unlock-admin-mobile" : "button-unlock-admin-desktop"}
              disabled={!input.trim() || validating}
              className="w-full bg-primary px-4 py-2 text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              {validating ? "Validating…" : "Unlock"}
            </button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}