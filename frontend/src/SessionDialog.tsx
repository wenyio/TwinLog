import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { Session } from "./bridge";

export default function SessionDialog({ renaming, onCancel, onSubmit }: {
  renaming: Session;
  onCancel: () => void;
  onSubmit: (title: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(renaming.title ?? "");
  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    field.current?.focus();
    return () => modal?.close();
  }, []);
  const cancel = () => { dialog.current?.close(); onCancel(); };
  return <dialog ref={dialog} className="app-dialog" aria-labelledby="session-dialog-title"
    onCancel={(event) => { event.preventDefault(); cancel(); }}>
    <form onSubmit={(event) => { event.preventDefault(); dialog.current?.close(); onSubmit(title.trim()); }}>
      <h2 id="session-dialog-title">重命名连接</h2>
      <label>连接名称
        <input ref={field} value={title} maxLength={100} placeholder="选填，留空按时间显示"
          onChange={(event) => setTitle(event.target.value)} />
      </label>
      <div className="app-dialog-actions">
        <button type="button" className="secondary" onClick={cancel}>取消</button>
        <button type="submit" className="primary"><Check size={16} />保存</button>
      </div>
    </form>
  </dialog>;
}
