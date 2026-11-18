import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Download, Ellipsis, FileText, Folder, FolderOpen, LoaderCircle, Pencil, Radio, ScrollText, Trash2 } from "lucide-react";
import type { RecordItem, Session, State } from "./bridge";

type Action = { label: string; icon: ReactNode; run: () => void; disabled?: boolean; danger?: boolean };
type Menu = { anchor: HTMLButtonElement; actions: Action[]; path: string };

export const recordTitle = (title?: string) => title?.trim() || "未命名";
export const sessionStamp = (s: string) => s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "";
const shortStamp = new Intl.DateTimeFormat("sv-SE", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const shortTime = (s: Session) => !Number.isNaN(Date.parse(s.startedAt))
  ? shortStamp.format(new Date(s.startedAt)) : s.path.split(/[/\\]/).pop() || s.path;
export const sessionLabel = (s: Session) => s.title?.trim() || shortTime(s);
const groupKey = (s: Session) => s.group ? `group:${s.group}` : `path:${s.path}`;

export function groupSessions(sessions: Session[]) {
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const key = groupKey(session);
    const connections = groups.get(key);
    if (connections) connections.push(session);
    else groups.set(key, [session]);
  }
  return groups;
}

function Writing({ label }: { label: string }) {
  return <span className="session-writing" title={label} aria-label={label}><LoaderCircle size={13} /></span>;
}

export default function SessionList({ sessions, selected, viewPath, state, locked, onSelect, onRecord, onFull, onExport, onDeleteRecords, onDeleteSession, onOpenFolder, onRename }: {
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
  onRename: (session: Session) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<Menu | null>(null);
  const popover = useRef<HTMLDivElement>(null);
  const viewed = sessions.find((s) => !!viewPath && (s.full?.path === viewPath || s.records.some((r) => r.path === viewPath)));
  const active = state.connected ? sessions.find((s) => state.sessionDir === s.path) : undefined;
  const activePath = active?.path, activeGroup = active && groupKey(active);
  const viewSession = viewed?.path, viewGroup = viewed && groupKey(viewed);
  useEffect(() => {
    if (viewSession && viewGroup) setExpanded((prev) => ({ ...prev, [viewSession]: true, [viewGroup]: true }));
  }, [viewPath, viewSession, viewGroup]);
  useEffect(() => {
    if (activePath && activeGroup) setExpanded((prev) => ({ ...prev, [activePath]: true, [activeGroup]: true }));
  }, [activePath, activeGroup]);
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
  const rename = (s: Session): Action => ({ label: "重命名会话", icon: <Pencil size={15} />, run: () => onRename(s) });
  const remove = (label: string, run: () => void, disabled: boolean): Action => ({ label, run, disabled, icon: <Trash2 size={15} />, danger: true });
  const exportItem = (label: string, run: () => void, disabled: boolean): Action => ({ label, run, disabled, icon: <Download size={15} /> });
  const renderConnection = (s: Session, open: boolean, nested: boolean) => {
        const connected = state.connected && state.sessionDir === s.path;
        const writing = connected && !!s.full;
        const capturing = connected && state.capturing;
        const count = s.records.length;
        const date = sessionStamp(s.startedAt);
        const short = shortTime(s);
        return <div className={nested ? "connection-group" : undefined} key={s.path}>
          <div className="session-row">
            <button className="session-toggle" type="button" aria-expanded={open}
              title={`${date || short} · ${count} 条记录`}
              aria-label={`${date || short}，${count} 条记录${!open && (writing || capturing) ? "，写入中" : ""}`}
              onClick={() => setExpanded((prev) => ({ ...prev, [nested ? s.path : groupKey(s)]: !open }))}>
              {nested ? <Radio size={14} /> : open ? <FolderOpen size={16} /> : <Folder size={16} />}
              <span>{short}</span><small className="session-count" title={`${count} 条记录`}>{count}</small>
              {!open && (writing || capturing) && <Writing label="写入中" />}
            </button>
            {trigger(s.path, (nested ? "连接操作 · " : "会话操作 · ") + (date || short), [
              openFolder(s.path),
              ...(!nested && s.managed ? [rename(s)] : []),
              ...(s.managed ? [remove("删除连接", () => onDeleteSession(s.path, false), connected)] : []),
            ])}
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
                  <span>{sessionStamp(r.startedAt)}</span>
                  <small>{r.interrupted ? "中断" : !r.endedAt ? "抓取中" : r.package || "全部应用"}{r.filterGaps ? " · 应用过滤有缺口" : ""}</small>
                  {active && !writing && <Writing label="抓取中" />}
                </button>
                {trigger(r.path, "记录操作 · " + title, [openFolder(r.path), exportItem("导出此记录", () => onExport([r.path]), active),
                  remove("删除此记录", () => onDeleteRecords([r.path]), state.capturing)])}
              </div>;
            })}
            {!s.full && !s.records.length && <span className="session-empty">无日志</span>}
          </div>
        </div>;
  };
  return (
    <div className="history-list" aria-label="日志会话">
      {!sessions.length && <div className="history-empty"><FileText size={30} /><b>还没有日志会话</b></div>}
      {[...groupSessions(sessions)].map(([key, connections], index) => {
        const [latest] = connections;
        const open = expanded[key] ?? (index === 0 || key === activeGroup);
        if (connections.length === 1 && !latest.title)
          return <section className="session-group" key={key}>{renderConnection(latest, open, false)}</section>;
        const title = sessionLabel(latest);
        const count = connections.reduce((sum, s) => sum + s.records.length, 0);
        const writing = key === activeGroup && (!!active?.full || state.capturing);
        return <section className="session-group" key={key}>
          <div className="session-row">
            <button className="session-toggle" type="button" aria-expanded={open}
              title={`${title} · ${connections.length} 次连接 · ${count} 条记录`}
              aria-label={`${title}，${count} 条记录${!open && writing ? "，写入中" : ""}`}
              onClick={() => setExpanded((prev) => ({ ...prev, [key]: !open }))}>
              {open ? <FolderOpen size={16} /> : <Folder size={16} />}
              <span>{title}</span><small className="session-count" title={`${count} 条记录`}>{count}</small>
              {!open && writing && <Writing label="写入中" />}
            </button>
            {trigger(key, "会话操作 · " + title, [rename(latest)])}
          </div>
          <div className="session-children" hidden={!open}>
            {connections.map((s, i) => renderConnection(s, expanded[s.path] ?? (i === 0 || s.path === activePath), true))}
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
