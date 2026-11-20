import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Paperclip, FileText, Plus, Trash2, File, X, Check, FolderOpen, Pencil, ClipboardPaste, AlertCircle } from "lucide-react";
import { api, Attachment, AttachmentProgress, RecordItem } from "./bridge";
import { WindowResizeGrip } from "./WindowFrame";

const bytes = (n: number) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB" : (n / 1073741824).toFixed(1) + " GB";
const splitName = (name: string) => { const dot = name.lastIndexOf("."); return dot < 0 ? [name, ""] : [name.slice(0, dot), name.slice(dot)]; };

function RenameAttachment({ item, path, onDone, onCancel }: { item: Attachment; path: string; onDone: () => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [base, ext] = splitName(item.name);
  const [value, setValue] = useState(base), [error, setError] = useState(""), [saving, setSaving] = useState(false);
  useEffect(() => { const d = dialog.current; d?.showModal(); input.current?.select(); return () => d?.close(); }, []);
  return <dialog ref={dialog} className="app-dialog attachment-dialog" aria-labelledby="attachment-rename-heading" onCancel={e => { e.preventDefault(); if (!saving) onCancel(); }}>
    <form onSubmit={async e => { e.preventDefault(); if (saving) return; setSaving(true); setError(""); try { await api.RenameAttachment(path, item.name, value); onDone(); } catch (e) { setError(String(e)); } finally { setSaving(false); } }}>
      <h2 id="attachment-rename-heading">重命名附件</h2>
      <label>文件名<div className="attachment-name-field"><input ref={input} aria-label="附件文件名" value={value} maxLength={255 - ext.length} disabled={saving} onChange={e => setValue(e.target.value)} /><span title={ext}>{ext}</span></div></label>
      {error && <div className="dialog-error" role="alert">{error}</div>}
      <div className="app-dialog-actions"><button type="button" className="secondary" disabled={saving} onClick={onCancel}>取消</button><button type="submit" className="primary" disabled={saving}><Check size={15} />保存</button></div>
    </form>
  </dialog>;
}

export default function Attachments({ record, enabled, blocked, mini, children, notesStatus }: {
  record: RecordItem | null; enabled: boolean; blocked: boolean; mini: boolean;
  children: ReactNode; notesStatus: ReactNode;
}) {
  const path = record?.path ?? "";
  const [items, setItems] = useState<Attachment[]>([]), [tab, setTab] = useState<"notes" | "attachments">("notes");
  const [menu, setMenu] = useState<{ item: Attachment; path: string; anchor: HTMLButtonElement; x: number; y: number } | null>(null), [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<{ item: Attachment; path: string } | null>(null);
  const [progress, setProgress] = useState<AttachmentProgress | null>(null), [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, { message: string; detail: string; error: boolean; sequence: number }>>({});
  const [errorExpanded, setErrorExpanded] = useState(false);
  const feedbackSequence = useRef(0);
  const feedbackTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => () => { feedbackTimers.current.forEach(clearTimeout); }, []);
  const task = useRef(false), request = useRef(0), current = useRef({ record, enabled, blocked });
  const taskTarget = useRef("");
  const pasteEpoch = useRef(0);
  const addButton = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelOpen = () => { if (openTimer.current) clearTimeout(openTimer.current); openTimer.current = null; };
  useEffect(() => { cancelOpen(); return cancelOpen; }, [path, blocked, enabled, mini, tab]);
  current.current = { record, enabled, blocked: blocked || !!renaming || working };
  const report = (message: string, target = current.current.record?.path ?? "", error = true, detail = message) => {
    const sequence = ++feedbackSequence.current;
    setErrorExpanded(false);
    setFeedback(prev => ({ ...prev, [target]: { message, detail, error, sequence } }));
    if (!error) {
      const timer = setTimeout(() => {
        feedbackTimers.current.delete(timer);
        setFeedback(prev => { if (prev[target]?.sequence !== sequence) return prev; const next = { ...prev }; delete next[target]; return next; });
      }, 2000);
      feedbackTimers.current.add(timer);
    }
  };
  const clearFeedback = (target = path) => setFeedback(prev => { const next = { ...prev }; delete next[target]; return next; });
  const localFeedback = feedback[path];
  const refresh = async (target = path) => {
    const id = ++request.current;
    const result = await api.ListAttachments(target);
    if (id === request.current && current.current.record?.path === target) setItems(result || []);
  };
  useEffect(() => { ++request.current; setItems([]); setTab("notes"); setMenu(null); setAdding(false); setErrorExpanded(false); if (path) void refresh(path).catch(e => report(String(e), path)); }, [path]);
  useEffect(() => { setMenu(null); setAdding(false); }, [mini, tab]);
  useEffect(() => window.runtime?.EventsOn("attachment-progress", (p: AttachmentProgress) => { if (task.current) setProgress(p); }), []);
  useEffect(() => {
    if (!menu && !adding) return;
    cancelOpen();
    const panel = popover.current;
    const anchor = menu?.anchor ?? addButton.current;
    const close = () => { setMenu(null); setAdding(false); };
    if (!panel || !anchor || blocked || working || !enabled || !anchor.isConnected) { close(); return; }
    const rect = panel.getBoundingClientRect();
    const buttonRect = anchor.getBoundingClientRect();
    const x = menu ? menu.x : buttonRect.right - rect.width;
    const y = menu ? menu.y : buttonRect.bottom + 4 + rect.height <= innerHeight - 6 ? buttonRect.bottom + 4 : buttonRect.top - rect.height - 4;
    panel.style.left = Math.max(6, Math.min(x, innerWidth - rect.width - 6)) + "px";
    panel.style.top = Math.max(6, Math.min(y, innerHeight - rect.height - 6)) + "px";
    panel.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (e: Event) => { if (!panel.contains(e.target as Node) && !(adding && anchor.contains(e.target as Node))) close(); };
    const scroll = (e: Event) => { if (e.target instanceof Node && e.target.contains(anchor)) close(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); anchor.focus(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault(); const buttons = [...panel.querySelectorAll<HTMLButtonElement>("button")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    };
    const focus = (e: FocusEvent) => { if (!panel.contains(e.target as Node) && e.target !== anchor) close(); };
    window.addEventListener("pointerdown", outside); window.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true); window.addEventListener("resize", close); window.addEventListener("focusin", focus);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", key); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", close); window.removeEventListener("focusin", focus); };
  }, [menu, adding, blocked, working, enabled]);

  const importFiles = async (paste: boolean, snapshot = current.current) => {
    const target = snapshot;
    if (!target.record) { report("开始抓取后可添加", "", false, "开始抓取后可添加附件"); return; }
    if (target.blocked || task.current) return;
    const record = target.record;
    taskTarget.current = record.title || "未命名";
    task.current = true; setWorking(true); setProgress({ path: record.path, name: paste ? "正在读取剪贴板…" : "选择文件…", copied: 0, total: 0 });
    setAdding(false); setMenu(null); clearFeedback(record.path);
    try {
      const result = await (paste ? api.PasteAttachments(record.path) : api.ImportAttachmentFiles(record.path));
      if (result?.length) { if (current.current.record?.path === record.path && current.current.enabled) setTab("attachments"); report("已添加 " + result.length + " 个", record.path, false, "已向“" + (record.title || "未命名") + "”添加 " + result.length + " 个附件"); }
    } catch (e) { if (String(e).includes("context canceled")) report("已取消", record.path, false, "已取消附件导入，已完成的附件会保留"); else { report(String(e), record.path); if (current.current.record?.path === record.path && current.current.enabled) setTab("attachments"); } }
    finally { task.current = false; setWorking(false); setProgress(null); if (current.current.record?.path === record.path) await refresh(record.path).catch(e => report(String(e), record.path)); }
  };
  const importRef = useRef(importFiles); importRef.current = importFiles;
  useEffect(() => {
    const eligible = (element: EventTarget | null) => {
      const c = current.current;
      if (!c.enabled || c.blocked || task.current || document.querySelector("dialog[open]")) return false;
      const target = element instanceof Element ? element : null;
      return !target?.closest("input,textarea,[contenteditable=true]") || !!target.closest(".notes-card");
    };
    const handle = (event: ClipboardEvent) => {
      ++pasteEpoch.current;
      const c = current.current;
      if (!eligible(event.target)) return;
      const data = event.clipboardData;
      if (data && (data.files.length > 0 || [...data.items].some(i => i.kind === "file"))) {
        event.preventDefault(); void importRef.current(true); return;
      }
      // Plain text stays native in notes. Only ask the native clipboard when
      // WebView2 supplied no text/files (Explorer CF_HDROP often looks empty).
      if (data?.getData("text/plain") || data?.getData("text/html")) return;
      void api.ClipboardAttachmentKind().then(kind => { if (kind) void importRef.current(true, c); }).catch(e => report(String(e), c.record?.path ?? ""));
    };
    // Some WebView2 versions omit paste events entirely for Explorer CF_HDROP.
    // Probe only after this key event; a normal paste event always wins.
    const shortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.key.toLowerCase() !== "v" || event.repeat || !eligible(event.target)) return;
      const epoch = pasteEpoch.current, snapshot = current.current;
      void api.ClipboardAttachmentKind().then(kind => {
        if (kind) setTimeout(() => { if (epoch === pasteEpoch.current && !task.current && !current.current.blocked) void importRef.current(true, snapshot); }, 0);
      }).catch(e => report(String(e), snapshot.record?.path ?? ""));
    };
    document.addEventListener("paste", handle);
    document.addEventListener("keydown", shortcut);
    return () => { document.removeEventListener("paste", handle); document.removeEventListener("keydown", shortcut); };
  }, []);
  const action = async (fn: () => Promise<void>) => { const target = path; setMenu(null); setWorking(true); clearFeedback(target); try { await fn(); await refresh(target); } catch (e) { report(String(e), target); } finally { setWorking(false); } };
  const context = (item: Attachment, anchor: HTMLButtonElement, x: number, y: number) => {
    cancelOpen(); if (blocked || working) return;
    setAdding(false); setMenu({ item, path, anchor, x, y });
  };
  return <section className="attachments-card" aria-label="备注与附件">
    <header>
      <div className="record-content-tabs" role="tablist" aria-label="备注与附件">
        {(["notes", "attachments"] as const).map(value => <button key={value} type="button" role="tab" id={"record-tab-" + value} aria-controls={"record-panel-" + value} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
          onClick={() => setTab(value)} onKeyDown={e => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
            e.preventDefault(); const next = e.key === "Home" ? "notes" : e.key === "End" ? "attachments" : value === "notes" ? "attachments" : "notes";
            setTab(next); document.getElementById("record-tab-" + next)?.focus();
          }}>{value === "notes" ? <><FileText size={15} />备注</> : <><Paperclip size={15} />附件 · {items.length}{localFeedback?.error && <i className="attachment-error-dot" aria-label="附件操作失败" />}</>}</button>)}
      </div>
      <span className="attachment-feedback" role="status" aria-live="polite" title={!localFeedback?.error ? localFeedback?.detail : undefined}>{localFeedback && !localFeedback.error ? <><Check size={12} /><span>{mini && localFeedback.message.startsWith("已添加") ? "已添加" : localFeedback.message}</span></> : tab === "notes" ? notesStatus : null}</span>
      <button ref={addButton} className="icon" type="button" title="添加附件" aria-label="添加附件" disabled={blocked || working || !path} aria-haspopup="menu" aria-expanded={adding} aria-controls={adding ? "attachment-add-menu" : undefined} onClick={() => { setAdding(v => !v); setMenu(null); }}><Plus size={16} /></button>
    </header>
    <div id="record-panel-notes" className="record-notes-panel" role="tabpanel" aria-labelledby="record-tab-notes" hidden={tab !== "notes"}>{children}</div>
    <div id="record-panel-attachments" className="record-attachments-panel" role="tabpanel" aria-labelledby="record-tab-attachments" hidden={tab !== "attachments"}>
    {localFeedback?.error && <div className="attachment-error" role="alert">
      <div className="attachment-error-row"><AlertCircle size={14} /><span title={localFeedback.message}>{localFeedback.message}</span><button type="button" className="text-button" aria-expanded={errorExpanded} onClick={() => setErrorExpanded(v => !v)}>{errorExpanded ? "收起" : "详情"}</button><button type="button" className="icon" aria-label="关闭附件错误" onClick={() => clearFeedback()}><X size={13} /></button></div>
      {errorExpanded && <div className="attachment-error-details">{localFeedback.detail}</div>}
    </div>}
    {adding && createPortal(<div id="attachment-add-menu" ref={popover} className="row-popover attachment-add-popover" role="menu" aria-label="添加附件">
      <button role="menuitem" onClick={() => void importFiles(false)}><FolderOpen size={15} />选择文件…</button>
      <button role="menuitem" onClick={() => void importFiles(true)}><ClipboardPaste size={15} />从剪贴板粘贴<small>Ctrl+V</small></button>
    </div>, document.body)}
    {items.length > 0 && <ul className="attachment-list">{items.map(item => {
      const [base, ext] = splitName(item.name);
      return <li key={item.name} onContextMenu={e => { e.preventDefault(); e.stopPropagation(); const anchor = e.currentTarget.querySelector<HTMLButtonElement>(".attachment-file")!; const rect = anchor.getBoundingClientRect(); context(item, anchor, e.clientX || rect.left, e.clientY || rect.bottom); }}>
        <File size={15} /><button className="attachment-file" title={item.name} aria-label={"打开附件：" + item.name} disabled={blocked || working}
          onClick={e => {
            cancelOpen();
            if (e.detail > 1) return;
            if (e.detail === 0) { void action(() => api.OpenAttachment(path, item.name, false)); return; }
            const target = path;
            openTimer.current = setTimeout(() => { openTimer.current = null; if (current.current.record?.path === target && current.current.enabled && !current.current.blocked) void action(() => api.OpenAttachment(target, item.name, false)); }, 500);
          }}
          onDoubleClick={() => { cancelOpen(); if (!blocked && !working) { setMenu(null); setRenaming({ item, path }); } }}
          onKeyDown={e => { if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); context(item, e.currentTarget, rect.left, rect.bottom); } }}>
          <span className="attachment-filename"><span className="attachment-basename">{base}</span><span className="attachment-extension">{ext}</span></span><small>{bytes(item.bytes)}</small>
        </button>
        <button className="icon attachment-remove" title="移除附件" aria-label={"移除附件：" + item.name} disabled={blocked || working} onClick={() => { cancelOpen(); void action(() => api.RemoveAttachment(path, item.name)); }}><Trash2 size={15} /></button>
      </li>;
    })}</ul>}
    {menu && createPortal(<div ref={popover} className="row-popover" role="menu" aria-label="附件操作">
      <button role="menuitem" onClick={() => void action(() => api.OpenAttachment(menu.path, menu.item.name, false))}><File size={15} />打开</button>
      <button role="menuitem" onClick={() => void action(() => api.OpenAttachment(menu.path, menu.item.name, true))}><FolderOpen size={15} />在文件夹中显示</button>
      <button role="menuitem" onClick={() => { setRenaming({ item: menu.item, path: menu.path }); setMenu(null); }}><Pencil size={15} />重命名</button>
      <button role="menuitem" className="menu-danger" onClick={() => void action(() => api.RemoveAttachment(menu.path, menu.item.name))}><Trash2 size={15} />移除</button>
    </div>, document.body)}
    {!items.length && <small className="attachment-hint">{path ? "截图或复制文件后，按 Ctrl+V 添加" : "开始抓取后可添加附件"}</small>}
    </div>
    {progress && <div className="attachment-progress" role="status"><span title={"导入到“" + taskTarget.current + "”：" + progress.name}>{progress.path !== path && "“" + taskTarget.current + "”："}{progress.name}{progress.total > 0 && " · " + bytes(progress.copied) + " / " + bytes(progress.total)}</span><button className="icon" title="取消附件导入" aria-label="取消附件导入" onClick={() => void api.CancelAttachmentImport().catch(e => report(String(e), progress.path))}><X size={14} /></button></div>}
    {renaming && <RenameAttachment {...renaming} onCancel={() => setRenaming(null)} onDone={() => { const target = renaming.path; setRenaming(null); void refresh(target).catch(e => report(String(e), target)); }} />}
    <WindowResizeGrip />
  </section>;
}
