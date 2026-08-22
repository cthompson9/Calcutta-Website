import { useLayoutEffect, useRef, useState } from "react";

type ConsortiumLabelProps = {
  label: string;
  className?: string;
};

/**
 * Keeps long consortium names readable in narrow table cells and cards.
 * The label scales down to fit its current container, then wraps as a
 * last resort rather than being truncated with an ellipsis.
 */
export function ConsortiumLabel({
  label,
  className = "",
}: ConsortiumLabelProps) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = labelRef.current;
    if (!element) return;

    const resize = () => {
      const parent = element.parentElement;
      if (!parent) return;

      const computed = window.getComputedStyle(element);
      const baseSize = Number.parseFloat(computed.fontSize);
      const availableWidth = element.clientWidth || parent.clientWidth;
      if (!baseSize || availableWidth <= 0) return;

      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) return;

      context.font = [
        computed.fontStyle,
        computed.fontVariant,
        computed.fontWeight,
        computed.fontSize,
        computed.fontFamily,
      ].join(" ");
      const naturalWidth = context.measureText(label).width;
      const minimumSize = Math.max(10, baseSize * 0.68);
      const nextSize =
        naturalWidth > availableWidth
          ? Math.max(minimumSize, (baseSize * availableWidth) / naturalWidth)
          : baseSize;

      setFontSize((previous) =>
        previous != null && Math.abs(previous - nextSize) < 0.1
          ? previous
          : nextSize,
      );
    };

    resize();
    const parent = element.parentElement;
    const observer = parent ? new ResizeObserver(resize) : null;
    observer?.observe(parent!);
    window.addEventListener("resize", resize);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [label]);

  return (
    <span
      ref={labelRef}
      className={`block max-w-full break-words leading-tight ${className}`}
      style={{
        fontSize: fontSize == null ? undefined : `${fontSize}px`,
        overflowWrap: "anywhere",
      }}
    >
      {label}
    </span>
  );
}