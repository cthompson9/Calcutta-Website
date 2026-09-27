import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  createCalcutta,
  getGetCalcuttasQueryKey,
  getGetCalcuttasQueryOptions,
  type CalcuttaCreate,
  type CalcuttaOption,
} from "@workspace/api-client-react";
import { useAdminAccess } from "@/hooks/useAdminAccess";
import { useSeason } from "@/hooks/useSeason";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type RubricLine = { event: string; value: string };
export function validateCalcuttaForm(input: {
  sport: string;
  year: string;
  lots: string;
  rubric: RubricLine[];
  scoringFormat: "points" | "percentage";
}): string | null {
  if (!input.sport.trim()) return "Sport is required.";
  if (!/^\d{4}$/.test(input.year) || Number(input.year) < 1900) return "Enter a valid four-digit year.";
  if (input.lots.split(",").map((lot) => lot.trim()).filter(Boolean).length === 0) return "Enter at least one lot.";
  if (input.rubric.length === 0) return "Add at least one rubric event.";
  if (input.rubric.some((line) => !line.event.trim() || line.value.trim() === "" || !Number.isFinite(Number(line.value)) || Number(line.value) < 0)) {
    return "Each rubric event needs a name and a non-negative numeric value.";
  }
  if (input.scoringFormat === "percentage") {
    if (input.rubric.some((line) => Number(line.value) <= 0)) return "Each percentage rubric value must be greater than zero.";
    const total = input.rubric.reduce((sum, line) => sum + Number(line.value), 0);
    if (Math.abs(total - 100) > 1e-8) return `Percentage rubric values must total exactly 100% (currently ${total}%).`;
  } else if (!input.rubric.some((line) => Number(line.value) > 0)) {
    return "At least one points rubric value must be greater than zero.";
  }
  return null;
}

export function CreateCalcuttaDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { adminKey } = useAdminAccess();
  const { setCalcutta } = useSeason();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [sport, setSport] = useState("");
  const [type, setType] = useState<"full_season" | "postseason">("full_season");
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [lots, setLots] = useState("");
  const [scoringFormat, setScoringFormat] = useState<"points" | "percentage">("points");
  const [rubric, setRubric] = useState<RubricLine[]>([{ event: "", value: "" }]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setSport("");
    setType("full_season");
    setYear(String(new Date().getFullYear()));
    setLots("");
    setScoringFormat("points");
    setRubric([{ event: "", value: "" }]);
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adminKey || submitting) {
      setError("Admin access is required to create a Calcutta.");
      return;
    }
    const validationError = validateCalcuttaForm({ sport, year, lots, rubric, scoringFormat });
    if (validationError) {
      setError(validationError);
      return;
    }

    const payload: CalcuttaCreate = {
      sport: sport.trim(),
      type,
      year: Number(year),
      lots: lots.split(",").map((lot) => lot.trim()).filter(Boolean),
      scoringFormat,
      rubric: rubric.map((line) => ({ event: line.event.trim(), value: Number(line.value) })),
    };
    setSubmitting(true);
    setError("");
    try {
      const createdResponse = await createCalcutta(payload, {
        headers: { Authorization: `Bearer ${adminKey}` },
      });
      const createdId = createdResponse.id;
      if (!Number.isInteger(createdId) || createdId <= 0) {
        throw new Error("Calcutta was created, but the server did not return its identifier.");
      }
      const listKey = getGetCalcuttasQueryKey();
      await queryClient.invalidateQueries({ queryKey: listKey });
      const updatedCalcuttas = await queryClient.fetchQuery(getGetCalcuttasQueryOptions());
      const created = (updatedCalcuttas as CalcuttaOption[]).find((item) => item.id === createdId);
      if (!created) throw new Error("Calcutta was created, but it was not present in the refreshed Calcutta list.");
      setCalcutta(created.id);
      onOpenChange(false);
      reset();
      navigate("/auction");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create Calcutta. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create New Calcutta</DialogTitle>
          <DialogDescription>
            Set up the sport, season, lots, and scoring rubric. Lots, owners, and consortia can be edited later; sport, type, and year cannot.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm font-medium">
              Sport <span aria-hidden="true" className="text-destructive">*</span>
              <input required value={sport} onChange={(event) => setSport(event.target.value)} placeholder="e.g. CFB" className="w-full rounded-md border border-input bg-background px-3 py-2" />
            </label>
            <label className="space-y-1 text-sm font-medium">
              Type <span aria-hidden="true" className="text-destructive">*</span>
              <select required value={type} onChange={(event) => setType(event.target.value as typeof type)} className="w-full rounded-md border border-input bg-background px-3 py-2">
                <option value="full_season">Full season</option>
                <option value="postseason">Postseason</option>
              </select>
            </label>
            <label className="space-y-1 text-sm font-medium">
              Year <span aria-hidden="true" className="text-destructive">*</span>
              <input required inputMode="numeric" pattern="[0-9]{4}" value={year} onChange={(event) => setYear(event.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2" />
            </label>
            <label className="space-y-1 text-sm font-medium">
              Scoring format <span aria-hidden="true" className="text-destructive">*</span>
              <select required value={scoringFormat} onChange={(event) => setScoringFormat(event.target.value as typeof scoringFormat)} className="w-full rounded-md border border-input bg-background px-3 py-2">
                <option value="points">Points</option>
                <option value="percentage">Percentage</option>
              </select>
            </label>
          </div>
          <label className="block space-y-1 text-sm font-medium">
            Lots <span aria-hidden="true" className="text-destructive">*</span>
            <textarea required value={lots} onChange={(event) => setLots(event.target.value)} placeholder="Comma-separated lots" rows={2} className="w-full rounded-md border border-input bg-background px-3 py-2" />
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Scoring rubric</legend>
            {rubric.map((line, index) => (
              <div key={index} className="flex items-end gap-2">
                <label className="min-w-0 flex-1 space-y-1 text-xs font-medium">
                  Event
                  <input aria-label={`Rubric event ${index + 1}`} value={line.event} onChange={(event) => setRubric((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, event: event.target.value } : row))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
                </label>
                <label className="w-28 space-y-1 text-xs font-medium">
                  {scoringFormat === "percentage" ? "Value (%)" : "Value"}
                  <input aria-label={`Rubric value ${index + 1}`} type="number" min="0" step="any" value={line.value} onChange={(event) => setRubric((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, value: event.target.value } : row))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
                </label>
                <button type="button" aria-label={`Remove rubric event ${index + 1}`} disabled={rubric.length === 1} onClick={() => setRubric((current) => current.filter((_, rowIndex) => rowIndex !== index))} className="h-10 px-2 text-sm text-muted-foreground hover:text-destructive disabled:opacity-40">Remove</button>
              </div>
            ))}
            <button type="button" onClick={() => setRubric((current) => [...current, { event: "", value: "" }])} className="text-sm font-semibold text-primary hover:underline">+ Add rubric event</button>
            {scoringFormat === "percentage" && (
              <p className="text-xs text-muted-foreground" aria-live="polite">
                Total: {rubric.reduce((sum, line) => sum + (Number(line.value) || 0), 0)}% (must equal 100%)
              </p>
            )}
          </fieldset>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => onOpenChange(false)} className="rounded-md border border-border px-4 py-2 text-sm">Cancel</button>
            <button type="submit" disabled={submitting || !adminKey} className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{submitting ? "Creating…" : "Create Calcutta"}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}