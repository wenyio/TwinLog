import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

export const baudRatePresets = [9600, 19200, 115200, 460800, 1500000];
// Windows stores the baud rate in an unsigned 32-bit field.
const maxBaudRate = 0xffffffff;
export const validBaudRate = (rate: number) => Number.isInteger(rate) && rate > 0 && rate <= maxBaudRate;
export const customBaudRates = (rates: number[]) => [...new Set(rates)]
  .filter((rate) => validBaudRate(rate) && !baudRatePresets.includes(rate))
  .sort((a, b) => a - b);

export default function BaudRateDialog({ onCancel, onSave }: {
  onCancel: () => void;
  onSave: (baudRate: number) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    return () => modal?.close();
  }, []);

  const close = () => {
    dialog.current?.close();
    onCancel();
  };
  const save = async () => {
    const value = draft.trim();
    const rate = Number(value);
    if (!/^\d+$/.test(value) || !validBaudRate(rate)) {
      setError("请输入 1 到 4294967295 之间的整数。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(rate);
      close();
    } catch (e) {
      setError(`保存波特率失败：${String(e)}`);
      setSaving(false);
    }
  };
  return <dialog ref={dialog} className="app-dialog" aria-labelledby="baud-rate-dialog-title"
    onCancel={(event) => {
      event.preventDefault();
      if (!saving) close();
    }}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!saving) void save();
    }}>
      <h2 id="baud-rate-dialog-title">新增波特率</h2>
      <label>波特率
        <input autoFocus inputMode="numeric" value={draft} readOnly={saving}
          onChange={(event) => { setDraft(event.target.value); setError(""); }} />
      </label>
      {error && <div className="dialog-error" role="alert">{error}</div>}
      <div className="app-dialog-actions">
        <button type="button" className="secondary" disabled={saving} onClick={close}>取消</button>
        <button type="submit" className="primary" disabled={saving}><Check size={16} />保存</button>
      </div>
    </form>
  </dialog>;
}
