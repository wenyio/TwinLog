import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Download, Ellipsis, FileText, Folder, FolderOpen, LoaderCircle, ScrollText, Trash2 } from "lucide-react";
import type { RecordItem, Session, State } from "./bridge";

type Action = { label: string; icon: ReactNode; run: () => void; disabled?: boolean; danger?: boolean };
type Menu = { anchor: HTMLButtonElement; actions: Action[]; path: string };

export const recordTitle = (title?: string) => title?.trim() || "未命名";
const stamp = (s: string) => s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "";
const shortStamp = new Intl.DateTimeFormat("sv-SE", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function Writing({ label }: { label: string }) {
  return <span className="session-writing" title={label} aria-label={label}><LoaderCircle size={13} /></span>;
}

export default function SessionList({ sessions, selected, viewPath, state, locked, onSelect, onRecord, onFull, onExport, onDeleteRecords, onDeleteSession, onOpenFolder }: {
  sessions: Session[];
  selected: Set<string>;
  viewPath?: string;
  state: State;
  locked: boolean;
  onSelect: (path: string, checked: boolean) => void;
  onRecord: (record: RecordItem) => void;
  onFull: (session: Session) => void;
  onExport: (paths: string[], fullSessions?: string[]) => void;
  onDeleteRecords: (paths: string[]) => void;
  onDeleteSession: (path: string, fullOnly: boolean) => void;
  onOpenFolder: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<Menu | null>(null);
  const popover = useRef<HTMLDivElement>(null);
  const viewSession = sessions.find((s) => !!viewPath && (s.full?.path === viewPath || s.records.some((r) => r.path === viewPath)))?.path;
  useEffect(() => {
    if (viewSession) setExpanded((prev) => ({ ...prev, [viewSession]: true }));
  }, [viewPath, viewSession]);
  useEffect(() => {
    if (!menu) return;
    const panel = popover.current;
    if (!panel || locked || !menu.anchor.isConnected) {
      setMenu(null);
      return;
    }
    const anchor = menu.anchor.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(6, Math.min(anchor.right - width, window.innerWidth - width - 6))}px`;
    panel.style.top = `${Math.max(6, anchor.bottom + height + 10 > window.innerHeight ? anchor.top - height - 4 : anchor.bottom + 4)}px`;
    panel.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = () => setMenu(null);
    const outside = (event: PointerEvent) => {
      if (!panel.contains(event.target as Node) && !menu.anchor.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      menu.anchor.focus();
    };
    const focusOutside = (event: FocusEvent) => {
      if (!panel.contains(event.target as Node) && !menu.anchor.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    window.addEventListener("focusin", focusOutside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("focusin", focusOutside);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu, locked]);

  const trigger = (path: string, label: string, actions: Action[]) => (
    <button type="button" className="icon row-menu-trigger" title={label} aria-label={label}
      disabled={locked} aria-expanded={menu?.path === path} onClick={(e: MouseEvent<HTMLButtonElement>) => {
        const anchor = e.currentTarget;
        setMenu((prev) => prev?.anchor === anchor ? null : { anchor, actions, path });
      }}>
      <Ellipsis size={16} />
    </button>
  );
  const openFolder = (path: string): Action => ({ label: "打开目录", icon: <FolderOpen size={15} />, run: () => onOpenFolder(path) });
  const remove = (label: string, run: () => void, disabled: boolean): Action => ({ label, run, disabled, icon: <Trash2 size={15} />, danger: true });
  const exportItem = (label: string, run: () => void, disabled: boolean): Action => ({ label, run, disabled, icon: <Download size={15} /> });
  return (
    <div className="history-list" aria-label="日志会话">
      {!sessions.length && <div className="history-empty"><FileText size={30} /><b>还没有日志会话</b></div>}
      {sessions.map((s, index) => {
        const connected = state.connected && state.sessionDir === s.path;
        const writing = connected && !!s.full;
        const capturing = connected && state.capturing;
        const open = expanded[s.path] ?? (index === 0 || connected);
        const count = s.records.length;
        const date = stamp(s.startedAt);
        const short = date && !Number.isNaN(Date.parse(s.startedAt)) ? shortStamp.format(new Date(s.startedAt)) : s.path.split(/[/\\]/).pop();
        return <section className="session-group" key={s.path}>
          <div className="session-row">
            <button className="session-toggle" type="button" aria-expanded={open}
              title={`${date || short} · ${count} 条记录`}
              aria-label={`${date || short}，${count} 条记录${!open && (writing || capturing) ? "，写入中" : ""}`}
              onClick={() => setExpanded((prev) => ({ ...prev, [s.path]: !open }))}>
              {open ? <FolderOpen size={16} /> : <Folder size={16} />}
              <span>{short}</span><small className="session-count">{count}</small>
              {!open && (writing || capturing) && <Writing label="写入中" />}
            </button>
            {trigger(s.path, "会话操作 · " + (date || short), [openFolder(s.path), ...(s.managed ? [remove("删除会话", () => onDeleteSession(s.path, false), connected)] : [])])}
          </div>
          <div className="session-children" hidden={!open}>
            {s.full && <div className={"history-row full-row" + (viewPath === s.full.path ? " active" : "")}>
              <button className="history-item" type="button" onClick={() => onFull(s)} disabled={locked || state.capturing}
                title={writing && !state.capturing ? "返回实时预览" : undefined}
                aria-current={viewPath === s.full.path ? "page" : undefined}>
                <ScrollText size={15} /><strong>完整日志</strong>
                {writing ? <Writing label="写入中" /> : <small>{(s.full.bytes / 1048576).toFixed(1)} MB</small>}
              </button>
              {trigger(s.full.path, "完整日志操作 · " + (date || short), [
                openFolder(s.full.path), exportItem("导出完整日志", () => onExport([], [s.path]), connected),
                remove("删除完整日志", () => onDeleteSession(s.path, true), connected),
              ])}
            </div>}
            {s.records.map((r) => {
              const active = r.path === state.activeRecord?.path;
              const title = recordTitle(r.title);
              return <div className={"history-row record-row" + (viewPath === r.path ? " active" : "")} key={r.path}>
                <input type="checkbox" aria-label={"选择 " + title} checked={selected.has(r.path)} disabled={locked || active}
                  onChange={(e) => onSelect(r.path, e.target.checked)} />
                <button className="history-item" type="button" title={title}
                  aria-current={viewPath === r.path ? "page" : undefined} onClick={() => onRecord(r)} disabled={locked || state.capturing}>
                  <strong>{title}</strong>
                  <span>{stamp(r.startedAt)}</span>
                  <small>{r.interrupted ? "中断" : !r.endedAt ? "抓取中" : r.package || "全部应用"}{r.filterGaps ? " · 应用过滤有缺口" : ""}</small>
                  {active && !writing && <Writing label="抓取中" />}
                </button>
                {trigger(r.path, "记录操作 · " + title, [openFolder(r.path), exportItem("导出此记录", () => onExport([r.path]), active),
                  remove("删除此记录", () => onDeleteRecords([r.path]), state.capturing)])}
              </div>;
            })}
            {!s.full && !count && <span className="session-empty">无日志</span>}
          </div>
        </section>;
      })}
      {menu && createPortal(<div className="row-popover" ref={popover} role="group" aria-label="行操作">
        {menu.actions.map((action) => <button type="button" key={action.label} disabled={action.disabled}
          className={action.danger ? "menu-danger" : undefined} onClick={() => {
            setMenu(null);
            menu.anchor.focus();
            action.run();
          }}>{action.icon}{action.label}</button>)}
      </div>, document.body)}
    </div>
  );
}
