import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minimize2, Minus, Pin, Square, Copy, X } from "lucide-react";
import { api } from "./bridge";

const miniMin = { w: 282, h: 560 };
type Size = { w: number; h: number };
function miniSize(): Size {
  try {
    const value = JSON.parse(localStorage.getItem("twinlog.mini-size") || "null");
    if (Number.isFinite(value?.w) && Number.isFinite(value?.h)) {
      return { w: Math.max(miniMin.w, Math.min(800, value.w)), h: Math.max(miniMin.h, Math.min(1200, value.h)) };
    }
  } catch { /* Optional preference. */ }
  return { w: 308, h: 620 };
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const MiniContext = createContext(false);

export function WindowResizeGrip() {
  const mini = useContext(MiniContext);
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  if (!mini) return null;
  return <button type="button" className="mini-resize" title="拖动调整小窗宽高，也可使用方向键" aria-label="调整小窗宽高"
    onKeyDown={(event) => {
      const delta: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };
      const step = delta[event.key];
      if (!step) return;
      event.preventDefault();
      window.runtime?.WindowSetSize?.(Math.max(miniMin.w, window.innerWidth + step[0]), Math.max(miniMin.h, window.innerHeight + step[1]));
    }}
    onPointerDown={(event) => {
      drag.current = { x: event.screenX, y: event.screenY, w: window.innerWidth, h: window.innerHeight };
      event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
    }} onPointerMove={(event) => {
      if (!drag.current) return;
      const start = drag.current;
      const w = Math.max(miniMin.w, Math.min(window.screen.availWidth, start.w + event.screenX - start.x));
      const h = Math.max(miniMin.h, Math.min(window.screen.availHeight, start.h + event.screenY - start.y));
      window.runtime?.WindowSetSize?.(w, h);
    }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />;
}

// One mounted workspace: mode changes only window bounds and presentation.
export default function WindowFrame({ children, beforeToggle, blocked, onError, onModeChange }: {
  children: ReactNode;
  beforeToggle(): Promise<void>;
  blocked: boolean;
  onError(message: string): void;
  onModeChange(mini: boolean): void;
}) {
  const [mini, setMini] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [maximised, setMaximised] = useState(false);
  const originalPinned = useRef(false);
  const preferred = useRef(miniSize());
  const changing = useRef(false);

  useEffect(() => {
    let alive = true;
    const resize = () => {
      window.runtime?.WindowIsMaximised?.().then((value) => { if (alive) setMaximised(value); });
      if (mini && !changing.current) {
        preferred.current = { w: Math.max(miniMin.w, window.innerWidth), h: Math.max(miniMin.h, window.innerHeight) };
        try { localStorage.setItem("twinlog.mini-size", JSON.stringify(preferred.current)); } catch { /* Optional. */ }
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => { alive = false; window.removeEventListener("resize", resize); };
  }, [mini]);

  const toggle = async () => {
    if (changing.current || blocked) return;
    const runtime = window.runtime;
    if (!runtime?.WindowGetSize || !runtime.WindowGetPosition || !runtime.WindowSetSize || !runtime.WindowSetMinSize) {
      onError("当前环境不支持窗口切换，请运行 TwinLog 桌面程序。");
      return;
    }
    changing.current = true;
    setSwitching(true);
    try {
      await beforeToggle();
      if (!mini) {
        originalPinned.current = pinned;
        const desired = preferred.current;
        // Read the full-mode panel width, including when the panel is collapsed.
        // Do not let an older remembered width override the compact entry size.
        const panel = document.querySelector<HTMLElement>(".operations");
        const panelWidth = panel ? parseFloat(getComputedStyle(panel).width) : miniMin.w;
        const w = Math.min(Math.max(miniMin.w, Math.round(panelWidth)), Math.max(miniMin.w, window.screen.availWidth));
        const h = Math.min(desired.h, Math.max(miniMin.h, window.screen.availHeight));
        await api.SetCompactWindow(true, w, h, pinned);
        setPinned(true);
        setMini(true);
        onModeChange(true);
      } else {
        preferred.current = await runtime.WindowGetSize();
        try { localStorage.setItem("twinlog.mini-size", JSON.stringify(preferred.current)); } catch { /* Optional. */ }
        await api.SetCompactWindow(false, 0, 0, pinned);
        setPinned(originalPinned.current);
        setMini(false);
        onModeChange(false);
      }
      await frame();
      await frame();
    } catch (error) { onError(String(error)); }
    finally { changing.current = false; setSwitching(false); }
  };

  return <div className={"desktop-frame" + (mini ? " mini-window" : "")}>
    <header className="window-titlebar">
      <div className="window-drag-region" onDoubleClick={() => { if (!mini && !switching) window.runtime?.WindowToggleMaximise?.(); }}>
        <span>TwinLog</span>
      </div>
      <div className="window-buttons">
        <button type="button" title={pinned ? "取消置顶" : "置顶"} aria-label={pinned ? "取消置顶" : "置顶"}
          aria-pressed={pinned} disabled={switching} onClick={() => {
            window.runtime?.WindowSetAlwaysOnTop?.(!pinned); setPinned(!pinned);
          }}><Pin size={14} /></button>
        <button type="button" title={mini ? "展开主窗口" : "切换小窗"} aria-label={mini ? "展开主窗口" : "切换小窗"}
          disabled={blocked || switching} onClick={() => void toggle()}>{mini ? <Maximize2 size={14} /> : <Minimize2 size={14} />}</button>
        <button type="button" title="最小化" aria-label="最小化" onClick={() => window.runtime?.WindowMinimise?.()}><Minus size={15} /></button>
        <button type="button" title={maximised ? "还原窗口" : "最大化"} aria-label={maximised ? "还原窗口" : "最大化"}
          disabled={mini || switching} onClick={() => window.runtime?.WindowToggleMaximise?.()}>{maximised ? <Copy size={12} /> : <Square size={12} />}</button>
        <button type="button" className="window-close" title="关闭" aria-label="关闭" onClick={() => window.runtime?.Quit?.()}><X size={16} /></button>
      </div>
    </header>
    <MiniContext.Provider value={mini}>{children}</MiniContext.Provider>
  </div>;
}
