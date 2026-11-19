import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { Session } from "./bridge";

export default function SessionDialog({ renaming, kind = "session", onCancel, onSubmit }: {
  renaming: Pick<Session, "title">;
  kind?: "session" | "record";
  onCancel: () => void;
  onSubmit: (title: string) => void | Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(renaming.title ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const record = kind === "record";
  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    field.current?.focus();
    return () => modal?.close();
  }, []);
  const cancel = () => { if (!saving) { dialog.current?.close(); onCancel(); } };
  return <dialog ref={dialog} className="app-dialog" aria-labelledby="session-dialog-title"
    onCancel={(event) => { event.preventDefault(); cancel(); }}>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (saving) return;
      setSaving(true);
      setError("");
      try { await onSubmit(title.trim()); }
      catch (e) { setError(String(e)); }
      finally { setSaving(false); }
    }}>
      <h2 id="session-dialog-title">{record ? "重命名记录" : "重命名连接"}</h2>
      <label>{record ? "记录标题" : "连接名称"}
        <input ref={field} value={title} disabled={saving} maxLength={record ? undefined : 100}
          placeholder={record ? "选填，留空显示未命名" : "选填，留空按时间显示"}
          onChange={(event) => setTitle(event.target.value)} />
      </label>
      {error && <div className="dialog-error" role="alert">{error}</div>}
      <div className="app-dialog-actions">
        <button type="button" className="secondary" disabled={saving} onClick={cancel}>取消</button>
        <button type="submit" className="primary" disabled={saving}><Check size={16} />保存</button>
      </div>
    </form>
  </dialog>;
}
