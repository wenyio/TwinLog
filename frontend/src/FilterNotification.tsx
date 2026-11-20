import Notification from "./Notification";
import type { State } from "./bridge";

export default function FilterNotification({ state, savingFullLogs }: { state: State; savingFullLogs: boolean }) {
  if (state.filterWarning) return <Notification key={state.filterFailureAt || "filter-warning"} kind="warning"
    message={`应用进程查询失败，正在重试。${savingFullLogs ? "完整 Android 日志继续保存。" : ""}应用预览和抓取可能存在缺口。`}
    details={state.filterWarning} />;
  if (state.connected && state.filterRecoveredAt) return <Notification key={`recovered:${state.filterRecoveredAt}`} kind="warning"
    message="应用过滤已恢复；此前可能存在日志缺口，未自动补回。"
    details={savingFullLogs ? "可在本次连接的 full/android.log 中查找原始日志。" : "本次未保存完整日志，无法从完整日志找回缺失内容。"}
    duration={8000} />;
  return null;
}
