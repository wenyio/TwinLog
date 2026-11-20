import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, Download, FileText, Folder, FolderOpen, LoaderCircle, Pencil, ScrollText, Trash2 } from "lucide-react";
import type { RecordItem, Session, State } from "./bridge";

type Action = { label: string; icon: ReactNode; run: () => void; disabled?: boolean; danger?: boolean };
type Menu = { anchor: HTMLElement; actions: Action[]; x: number; y: number };

export const recordTitle = (title?: string) => title?.trim() || "未命名";
export const sessionStamp = (s: string) => s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "";
const shortStamp = new Intl.DateTimeFormat("zh-CN", {
  month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const shortTime = (s: Session) => !Number.isNaN(Date.parse(s.startedAt))
  ? shortStamp.format(new Date(s.startedAt)) : s.path.split(/[/\\]/).pop() || s.path;
export const sessionLabel = (s: Session) => s.title?.trim() || shortTime(s);
function Writing({ label }: { label: string }) {
  return <span className="session-writing" title={label} aria-label={label}><LoaderCircle size={13} /></span>;
}

export default function SessionList({ sessions, selected, batchMode, archived, viewPath, state, locked, onSelect, onRecord, onFull, onExport, onDeleteRecords, onDeleteSession, onOpenFolder, onRename, onRenameRecord, onArchive, onArchiveRecord }: {
  sessions: Session[];
  selected: Set<string>;
  batchMode: boolean;
  archived: boolean;
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
  onRenameRecord: (record: RecordItem) => void;
  onArchive: (session: Session, archived: boolean) => void;
  onArchiveRecord: (record: RecordItem, archived: boolean) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<Menu | null>(null);
  const popover = useRef<HTMLDivElement>(null);
  const viewed = sessions.find((s) => !!viewPath && (s.full?.path === viewPath || s.records.some((r) => r.path === viewPath)));
  const active = state.connected ? sessions.find((s) => state.sessionDir === s.path) : undefined;
  const activePath = active?.path;
  const viewSession = viewed?.path;
  useEffect(() => {
    if (viewSession) setExpanded((prev) => ({ ...prev, [viewSession]: true }));
  }, [viewPath, viewSession]);
  useEffect(() => {
    if (activePath) setExpanded((prev) => ({ ...prev, [activePath]: true }));
  }, [activePath]);
  useEffect(() => {
    if (!menu) return;
    const panel = popover.current;
    if (!panel || locked || !menu.anchor.isConnected) {
      setMenu(null);
      return;
    }
    const { width, height } = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(6, Math.min(menu.x, window.innerWidth - width - 6))}px`;
    panel.style.top = `${Math.max(6, Math.min(menu.y, window.innerHeight - height - 6))}px`;
    panel.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = () => setMenu(null);
    const outside = (event: PointerEvent) => {
      if (!panel.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = [...panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
        return;
      }
      if (event.key !== "Escape") return;
      close();
      menu.anchor.focus();
    };
    const focusOutside = (event: FocusEvent) => {
      if (!panel.contains(event.target as Node) && !menu.anchor.contains(event.target as Node)) close();
    };
    const scrollAncestor = (event: Event) => {
      // Only scrolling an ancestor can move the row away from its menu.
      if (event.target instanceof Node && event.target.contains(menu.anchor)) close();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    window.addEventListener("focusin", focusOutside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scrollAncestor, true);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("focusin", focusOutside);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scrollAncestor, true);
    };
  }, [menu, locked]);
  useEffect(() => { setMenu(null); }, [sessions, state.capturing, state.connected, state.sessionDir, state.activeRecord?.path]);

  const context = (actions: Action[]) => ({
    onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (locked) return;
      const anchor = event.currentTarget.querySelector<HTMLElement>(".session-toggle, .history-item")!;
      const rect = anchor.getBoundingClientRect();
      setMenu({ anchor, actions, x: event.clientX || rect.left, y: event.clientY || rect.bottom });
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      event.stopPropagation();
      if (locked) return;
      const anchor = event.currentTarget.querySelector<HTMLElement>(".session-toggle, .history-item")!;
      const rect = anchor.getBoundingClientRect();
      setMenu({ anchor, actions, x: rect.left, y: rect.bottom });
    },
  });
  const openFolder = (path: string): Action => ({ label: "打开目录", icon: <FolderOpen size={15} />, run: () => onOpenFolder(path) });
  const rename = (s: Session): Action => ({ label: "重命名连接", icon: <Pencil size={15} />, run: () => onRename(s) });
  const remove = (label: string, run: () => void, disabled: boolean): Action => ({ label, run, disabled, icon: <Trash2 size={15} />, danger: true });
  const exportItem = (label: string, run: () => void, disabled: boolean): Action => ({ label, run, disabled, icon: <Download size={15} /> });
  const renderConnection = (s: Session, open: boolean) => {
        const connected = state.connected && state.sessionDir === s.path;
        const writing = connected && !!s.full;
        const capturing = connected && state.capturing;
        const count = s.records.length;
        const date = sessionStamp(s.startedAt);
        const short = sessionLabel(s);
        const archiveLabel = s.archived ? "取消归档" : "归档连接";
        const canArchiveConnection = s.managed && (!archived || !!s.archived);
        return <div key={s.path}>
          <div className="session-header">
          <div className="session-row" {...context([openFolder(s.path), ...(s.managed ? [rename(s),
            ...(canArchiveConnection ? [{ label: archiveLabel, icon: s.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />,
              run: () => onArchive(s, !s.archived), disabled: connected }] : []),
            remove("删除连接", () => onDeleteSession(s.path, false), connected)] : [])])}>
            <button className="session-toggle" type="button" aria-expanded={open}
              title={`${date || short} · ${count} 条记录`}
              aria-label={`${short}，${count} 条记录${!open && (writing || capturing) ? "，写入中" : ""}`}
              onClick={() => setExpanded((prev) => ({ ...prev, [s.path]: !open }))}>
              {open ? <FolderOpen size={16} /> : <Folder size={16} />}
              <span>{short}</span>
              {!open && (writing || capturing) && <Writing label="写入中" />}
              <small className="session-count" title={`${count} 条记录`}>{count}</small>
            </button>
            {canArchiveConnection && <span className="archive-action" title={connected ? "断开连接后可归档" : archiveLabel}>
              <button type="button" className="icon" aria-label={`${archiveLabel} · ${short}`}
                disabled={locked || connected} onClick={() => onArchive(s, !s.archived)}>
                {s.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
              </button>
            </span>}
          </div>
            {s.full && <div hidden={!open} className={"history-row full-row" + (viewPath === s.full.path ? " active" : "")}
              {...context([openFolder(s.full.path), exportItem("导出完整日志", () => onExport([], [s.path]), connected),
                remove("删除完整日志", () => onDeleteSession(s.path, true), connected)])}>
              <button className="history-item" type="button" onClick={() => onFull(s)} disabled={locked || state.capturing}
                title={writing && !state.capturing ? "返回实时预览" : undefined}
                aria-current={viewPath === s.full.path ? "page" : undefined}>
                <ScrollText size={15} /><strong>完整日志</strong>
                {writing ? <Writing label="写入中" /> : <small>{(s.full.bytes / 1048576).toFixed(1)} MB</small>}
              </button>
            </div>}
          </div>
          <div className="session-children" hidden={!open}>
            {s.records.map((r) => {
              const active = r.path === state.activeRecord?.path;
              const title = recordTitle(r.title);
              const recordArchived = !!(s.archived || r.archived);
              const recordArchiveLabel = recordArchived ? "取消记录归档" : "归档记录";
              const archiveDisabled = active || !!s.archived;
              const status = [r.interrupted ? "中断" : !r.endedAt ? "抓取中" : "",
                r.filterGaps ? "应用过滤有缺口" : ""].filter(Boolean).join(" · ");
              const detail = [title, `时间：${sessionStamp(r.startedAt)}`, `应用：${r.package || "全部应用"}`,
                ...(status ? [`状态：${status}`] : [])].join("\n");
              return <div className={"history-row record-row" + (viewPath === r.path ? " active" : "")} key={r.path} title={detail}
                {...context([openFolder(r.path), { label: "重命名记录", icon: <Pencil size={15} />,
                  run: () => onRenameRecord(r), disabled: state.capturing },
                  { label: recordArchiveLabel, icon: recordArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />,
                    run: () => onArchiveRecord(r, !recordArchived), disabled: archiveDisabled },
                  exportItem("导出此记录", () => onExport([r.path]), active),
                  remove("删除此记录", () => onDeleteRecords([r.path]), state.capturing)])}>
                {batchMode && <input type="checkbox" aria-label={"选择 " + title} checked={selected.has(r.path)} disabled={locked || active}
                  onChange={(e) => onSelect(r.path, e.target.checked)} />}
                <button className="history-item" type="button" title={detail} aria-label={title}
                  aria-description={detail}
                  aria-current={viewPath === r.path ? "page" : undefined} onClick={() => onRecord(r)} disabled={locked || state.capturing}>
                  <strong>{title}</strong>
                  {active && !writing && <Writing label="抓取中" />}
                </button>
                <span className="archive-action" title={active ? "停止当前抓取后可归档" : s.archived ? "请先取消连接归档" : recordArchiveLabel}>
                  <button type="button" className="icon" aria-label={`${recordArchiveLabel} · ${title}`}
                    disabled={locked || archiveDisabled} onClick={() => onArchiveRecord(r, !recordArchived)}>
                    {recordArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                  </button>
                </span>
              </div>;
            })}
            {!s.full && !s.records.length && <span className="session-empty">无日志</span>}
          </div>
        </div>;
  };
  return (
    <div className="history-list" aria-label="日志连接" title="右键查看更多操作">
      {!sessions.length && <div className="history-empty"><FileText size={30} /><b>{archived ? "还没有已归档连接" : "还没有日志连接"}</b></div>}
      {sessions.map((s, index) => <section className="session-group" key={s.path}>
        {renderConnection(s, expanded[s.path] ?? (index === 0 || s.path === activePath))}
      </section>)}
      {menu && createPortal(<div className="row-popover" ref={popover} role="menu" aria-label="行操作">
        {menu.actions.map((action) => <button type="button" role="menuitem" key={action.label} disabled={action.disabled}
          className={action.danger ? "menu-danger" : undefined} onClick={() => {
            setMenu(null);
            menu.anchor.focus();
            action.run();
          }}>{action.icon}{action.label}</button>)}
      </div>, document.body)}
    </div>
  );
}
