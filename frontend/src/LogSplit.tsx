import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

type Mode = "columns" | "rows" | "mcu" | "android";
type Ratios = { columns: number; rows: number };
const clamp = (value: number) => Math.max(20, Math.min(80, value));
function loadRatios(): Ratios {
  try {
    const saved = JSON.parse(localStorage.getItem("twinlog.split") || "{}");
    return {
      columns: Number.isFinite(saved.columns) ? clamp(saved.columns) : 50,
      rows: Number.isFinite(saved.rows) ? clamp(saved.rows) : 50,
    };
  } catch {
    return { columns: 50, rows: 50 };
  }
}

export default function LogSplit({ mode, children }: { mode: Mode; children: [ReactNode, ReactNode] }) {
  const [ratios, setRatios] = useState(loadRatios);
  const [dragging, setDragging] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; origin: number; ratio: number; extent: number; mode: "columns" | "rows" } | null>(null);
  const split = mode === "columns" || mode === "rows";
  const ratio = split ? ratios[mode] : 50;

  useLayoutEffect(() => {
    if (dragging) return;
    try { localStorage.setItem("twinlog.split", JSON.stringify(ratios)); } catch { /* Optional preference. */ }
  }, [dragging, ratios]);
  useEffect(() => {
    if (!dragging) return;
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = mode === "columns" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
  }, [dragging, mode]);

  const finish = (pointer: number) => {
    if (drag.current?.pointer !== pointer) return;
    drag.current = null;
    setDragging(false);
  };

  return (
    <div
      ref={container}
      className={"logs-grid resizable " + mode + (dragging ? " resizing" : "")}
      style={split ? mode === "columns"
        ? { gridTemplateColumns: "minmax(0, " + ratio + "fr) 10px minmax(0, " + (100 - ratio) + "fr)" }
        : { gridTemplateRows: "minmax(0, " + ratio + "fr) 10px minmax(0, " + (100 - ratio) + "fr)" }
        : undefined}
    >
      {children[0]}
      {split && (
        <div
          className="log-divider"
          role="separator"
          tabIndex={0}
          aria-label={mode === "columns" ? "调整 MCU 与 Android 日志宽度" : "调整 MCU 与 Android 日志高度"}
          aria-orientation={mode === "columns" ? "vertical" : "horizontal"}
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(ratio)}
          aria-valuetext={"MCU " + Math.round(ratio) + "%，Android " + Math.round(100 - ratio) + "%"}
          title="拖拽调整比例，双击恢复均分；方向键微调"
          onPointerDown={(event) => {
            if (event.button !== 0 || !container.current) return;
            event.preventDefault();
            event.currentTarget.focus();
            const bounds = container.current.getBoundingClientRect();
            drag.current = {
              pointer: event.pointerId,
              origin: mode === "columns" ? event.clientX : event.clientY,
              ratio,
              extent: Math.max(1, (mode === "columns" ? bounds.width : bounds.height) - 10),
              mode,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.pointer !== event.pointerId) return;
            const coordinate = current.mode === "columns" ? event.clientX : event.clientY;
            const value = clamp(current.ratio + (coordinate - current.origin) / current.extent * 100);
            setRatios((previous) => ({ ...previous, [current.mode]: value }));
          }}
          onPointerUp={(event) => {
            finish(event.pointerId);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={(event) => finish(event.pointerId)}
          onLostPointerCapture={(event) => finish(event.pointerId)}
          onDoubleClick={() => setRatios((previous) => ({ ...previous, [mode]: 50 }))}
          onKeyDown={(event) => {
            const decrease = mode === "columns" ? "ArrowLeft" : "ArrowUp";
            const increase = mode === "columns" ? "ArrowRight" : "ArrowDown";
            if (![decrease, increase, "Home", "End", "Enter"].includes(event.key)) return;
            event.preventDefault();
            const value = event.key === "Home" ? 20 : event.key === "End" ? 80 : event.key === "Enter" ? 50
              : clamp(ratio + (event.key === increase ? 1 : -1) * (event.shiftKey ? 10 : 2));
            setRatios((previous) => ({ ...previous, [mode]: value }));
          }}
        ><span /></div>
      )}
      {children[1]}
    </div>
  );
}
