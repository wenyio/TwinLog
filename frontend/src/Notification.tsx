import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Check, X } from "lucide-react";

// Each source owns one card. Callers key by message so updates reset dismissal
// and the optional timer without queuing repeated device warnings.
export default function Notification({ kind, message, details, duration, onClose, children }: {
  kind: "error" | "warning" | "success";
  message: string;
  details?: string;
  duration?: number;
  onClose?: () => void;
  children?: ReactNode;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!duration || dismissed || hovered || focused) return;
    const timer = setTimeout(() => { setDismissed(true); closeRef.current?.(); }, duration);
    return () => clearTimeout(timer);
  }, [duration, dismissed, hovered, focused]);
  if (dismissed) return null;
  const canExpand = !!details || message.length > 60 || message.includes("\n");
  return <div className={"notification " + kind} role={kind === "error" ? "alert" : "status"}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
    }}>
    {kind === "success" ? <Check size={16} /> : <AlertCircle size={16} />}
    <div className="notification-content">
      <span className="notification-summary" title={message}>{message}</span>
      {expanded && <div className="notification-details">{details || message}</div>}
      {(canExpand || children) && <div className="notification-actions">
        {canExpand && <button type="button" className="text-button" aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}>{expanded ? "收起详情" : "查看详情"}</button>}
        {children}
      </div>}
    </div>
    <button type="button" className="icon" aria-label="关闭通知" onClick={() => {
      setDismissed(true); onClose?.();
    }}><X size={14} /></button>
  </div>;
}
