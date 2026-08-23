import { useEffect } from "react";

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && target.matches("input, textarea, select, [contenteditable='true']");
}

export function useBacklinkBackShortcut(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (
        !event.ctrlKey
        || event.metaKey
        || event.altKey
        || event.shiftKey
        || event.code !== "BracketLeft"
        || isEditableTarget(event.target)
      ) {
        return;
      }

      event.preventDefault();
      window.history.back();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled]);
}