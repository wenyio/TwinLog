import { useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { ArrowDownToLine, ChevronDown, ChevronUp, Eraser, Pause, Search, X } from "lucide-react";
import type { LogSource } from "./bridge";

export type Preview = { text: string; truncated: boolean };
export const emptyPreview: Preview = { text: "", truncated: false };
const maxPreviewChars = 2 * 1024 * 1024;

export function trimPreview(text: string, lines: number, truncated: boolean): Preview {
  let start = Math.max(0, text.length - maxPreviewChars);
  let end = text.endsWith("\n") ? text.length - 1 : text.length;
  for (let i = 0; i < lines && end > start; i++) {
    const newline = text.lastIndexOf("\n", end - 1);
    if (newline < start) break;
    end = newline;
    if (i === lines - 1) start = newline + 1;
  }
  const unit = text.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff) start++;
  return { text: text.slice(start), truncated: truncated || start > 0 };
}

function lineCount(text: string) {
  let count = text.endsWith("\n") ? 0 : 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) count++;
  return count;
}

export default function LogPane({
  source, preview, clear, visible, historical, findRef, searchOpen, setSearchOpen, activate,
}: {
  source: LogSource;
  preview: Preview;
  clear: () => void;
  visible: boolean;
  historical: boolean;
  findRef: Ref<HTMLButtonElement>;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  activate: () => void;
}) {
  const [pause, setPause] = useState<{ reason: "manual" | "scroll"; preview: Preview } | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const pre = useRef<HTMLPreElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const searchBar = useRef<HTMLDivElement>(null);
  const displayed = pause?.preview ?? preview;
  const { text, truncated } = displayed;
  const shownLines = useMemo(() => truncated && text ? lineCount(text) : 0, [text, truncated]);
  const matches = useMemo(() => {
    if (!searchOpen || !visible || !query) return [];
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    const offsets: number[] = [];
    for (const match of text.matchAll(pattern)) offsets.push(match.index);
    return offsets;
  }, [text, query, searchOpen, visible]);
  const current = matches.length ? index % matches.length : 0;
  const offset = matches[current];

  useLayoutEffect(() => {
    if (visible && !pause && pre.current)
      pre.current.scrollTop = pre.current.scrollHeight;
  }, [text, pause, visible]);
  const focusSearch = () => {
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  };
  useLayoutEffect(() => {
    if (searchOpen && visible) focusSearch();
  }, [searchOpen, visible]);
  useLayoutEffect(() => {
    const el = pre.current;
    const node = el?.firstChild;
    const bar = searchBar.current;
    if (!el || !bar || node?.nodeType !== Node.TEXT_NODE || offset === undefined) return;
    const range = new Range();
    range.setStart(node, offset);
    range.setEnd(node, offset + query.length);
    CSS.highlights?.set("log-match", new Highlight(range));
    const reveal = () => {
      const hit = range.getBoundingClientRect();
      const viewport = el.getBoundingClientRect();
      el.scrollTop += hit.top - viewport.top - (el.clientHeight - hit.height) / 2;
      if (hit.left < viewport.left || hit.right > viewport.left + el.clientWidth)
        el.scrollLeft += hit.left - viewport.left - 12;

      bar.removeAttribute("data-bottom");
      const match = range.getBoundingClientRect();
      const floating = bar.getBoundingClientRect();
      if (match.right <= floating.left || match.left >= floating.right ||
        match.bottom <= floating.top || match.top >= floating.bottom) return;
      const delta = floating.bottom + 4 - match.top;
      if (el.scrollTop >= delta && floating.bottom + 4 + match.height <= viewport.top + el.clientHeight)
        el.scrollTop -= delta;
      else
        bar.setAttribute("data-bottom", "");
    };
    reveal();
    const resize = new ResizeObserver(reveal);
    resize.observe(el);
    resize.observe(bar);
    return () => {
      resize.disconnect();
      bar.removeAttribute("data-bottom");
      CSS.highlights?.delete("log-match");
    };
  }, [text, offset, query]);

  const openSearch = () => {
    if (searchOpen) {
      focusSearch();
      return;
    }
    if (!historical) setPause({ reason: "manual", preview: displayed });
    setQuery("");
    setIndex(0);
    setSearchOpen(true);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    pre.current?.focus({ preventScroll: true });
  };
  const step = (direction: number) => {
    if (matches.length) setIndex((current + direction + matches.length) % matches.length);
  };
  const clearPreview = () => {
    setSearchOpen(false);
    setPause((value) => value && { ...value, preview: emptyPreview });
    clear();
    if (pre.current) pre.current.scrollTop = 0;
  };

  return (
    <section className="log-pane" hidden={!visible} onPointerDown={activate} onFocus={activate} onKeyDown={(event) => {
      if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
      }
    }}>
      <header>
        <span className={"source-dot " + source} />
        <strong>{source === "mcu" ? "MCU 串口" : "Android Logcat"}</strong>
        <div className="grow" />
        {shownLines > 0 && <span className="log-limit" title={historical ? `仅显示末尾 ${shownLines} 行，全文请打开日志目录` : `仅显示末尾 ${shownLines} 行，清屏与暂停不影响保存`}>仅显示末尾 {shownLines} 行</span>}
        <button ref={findRef} className="icon" title="查找当前预览 (Ctrl+F)" aria-label="查找当前预览" onClick={openSearch}>
          <Search size={15} />
        </button>
        {!historical && <>
          <button
            className={"icon " + (pause ? "toggled" : "")}
            title={pause ? "回到最新" : "暂停自动滚动，固定当前预览"}
            aria-label={pause ? "回到最新" : "暂停自动滚动"}
            onClick={() => {
              if (pause) setSearchOpen(false);
              setPause(pause ? null : { reason: "manual", preview });
            }}
          >
            {pause ? <ArrowDownToLine size={15} /> : <Pause size={14} />}
          </button>
          <button className="icon" title="清空预览，不影响保存" aria-label="清空预览" onClick={clearPreview}>
            <Eraser size={15} />
          </button>
        </>}
      </header>
      <div className="log-body">
      {searchOpen && <div ref={searchBar} className="log-search" role="search" aria-label="查找当前预览">
        <input ref={input} aria-label="搜索当前预览" placeholder="搜索当前预览" value={query}
          onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            }
          }} />
        <output aria-live="polite">{query ? (matches.length ? `${current + 1} / ${matches.length}` : "无匹配") : ""}</output>
        <div className="log-search-actions">
          <button className="icon" title="上一个 (Shift+Enter)" aria-label="上一个" disabled={!matches.length} onClick={() => step(-1)}><ChevronUp size={15} /></button>
          <button className="icon" title="下一个 (Enter)" aria-label="下一个" disabled={!matches.length} onClick={() => step(1)}><ChevronDown size={15} /></button>
          <button className="icon" title="关闭查找 (Esc)" aria-label="关闭查找" onClick={closeSearch}><X size={15} /></button>
        </div>
      </div>}
      <pre ref={pre} tabIndex={0} onScroll={(event) => {
        if (historical || !visible || pause?.reason === "manual") return;
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        if (scrollHeight <= clientHeight) return;
        const atBottom = scrollHeight - clientHeight - scrollTop <= 2;
        if (!pause && !atBottom) setPause({ reason: "scroll", preview });
        else if (pause && atBottom) setPause(null);
      }}>
        {text || <span className="log-empty">
          {historical ? "该记录暂无日志内容" : source === "mcu" ? "等待串口数据…" : "等待 Android 日志…"}
        </span>}
      </pre>
      </div>
    </section>
  );
}
