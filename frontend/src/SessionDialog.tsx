import { useEffect, useRef, useState } from "react";
import { Check, Radio } from "lucide-react";
import { sessionLabel, sessionStamp } from "./SessionList";
import type { Session, SessionChoice } from "./bridge";

export default function SessionDialog({ choices, renaming, onCancel, onSubmit }: {
  choices: Session[];
  renaming?: Session;
  onCancel: () => void;
  onSubmit: (choice: SessionChoice) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const [title, setTitle] = useState(renaming?.title ?? "");
  const [existing, setExisting] = useState(false);
  const [path, setPath] = useState("");
  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    return () => modal?.close();
  }, []);
  useEffect(() => { field.current?.focus(); }, [existing]);
  const cancel = () => {
    dialog.current?.close();
    onCancel();
  };
  return <dialog ref={dialog} className="session-dialog" aria-labelledby="session-dialog-title"
    onCancel={(event) => { event.preventDefault(); cancel(); }}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (existing && !path) return;
      dialog.current?.close();
      onSubmit({ title: existing ? "" : title.trim(), existingPath: existing ? path : "" });
    }}>
      <h2 id="session-dialog-title">{renaming ? "重命名会话" : "连接设备"}</h2>
      {!renaming && <div className="session-modes" role="group" aria-label="会话类型">
        <button type="button" aria-pressed={!existing} onClick={() => setExisting(false)}>新建会话</button>
        <button type="button" aria-pressed={existing} disabled={!choices.length} onClick={() => setExisting(true)}>已有会话</button>
      </div>}
      {existing ? <label>会话
        <select ref={(el) => { field.current = el; }} value={path} required onChange={(event) => setPath(event.target.value)}>
          <option value="" disabled>选择已有会话</option>
          {choices.map((s) => <option key={s.path} value={s.path}>
            {sessionLabel(s)}{s.title && ` · ${sessionStamp(s.startedAt)}`}
          </option>)}
        </select>
      </label> : <label>会话名称
        <input ref={(el) => { field.current = el; }} value={title} maxLength={100} placeholder="选填，留空按时间显示"
          onChange={(event) => setTitle(event.target.value)} />
      </label>}
      <div className="session-dialog-actions">
        <button type="button" className="secondary" onClick={cancel}>取消</button>
        <button type="submit" className="primary" disabled={existing && !path}>
          {renaming ? <><Check size={16} />保存</> : <><Radio size={16} />连接</>}
        </button>
      </div>
    </form>
  </dialog>;
}
