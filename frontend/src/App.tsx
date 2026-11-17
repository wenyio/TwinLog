import { useState, useEffect, useLayoutEffect, useRef } from "react";
import LogSplit from "./LogSplit";
import { version } from "../package.json";
import {
  Activity,
  Usb,
  FolderOpen,
  RefreshCw,
  Play,
  Square,
  Download,
  Plus,
  Pause,
  Trash2,
  Settings2,
  FileText,
  Check,
  AlertCircle,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Columns2,
  Rows2,
  Radio,
} from "lucide-react";
import {
  api,
  desktop,
  defaults,
  Config,
  State,
  RecordItem,
  RecordLogs,
  Port,
  Device,
} from "./bridge";
const empty: State = {
  connected: false,
  capturing: false,
  sessionDir: "",
  activeRecord: null,
  config: defaults,
  error: "",
  mcuBytes: 0,
  androidBytes: 0,
};
const size = (n: number) =>
  n >= 1048576
    ? (n / 1048576).toFixed(1) + " MB"
    : (n / 1024).toFixed(1) + " KB";
const time = (s: string) =>
  s ? new Date(s).toLocaleString("zh-CN", { hour12: false }) : "";
type LogLayout = "columns" | "rows" | "mcu" | "android";
function loadLayout() {
  try {
    const v = JSON.parse(localStorage.getItem("twinlog.layout") || "{}");
    return {
      left: v.left !== false,
      right: v.right !== false,
      mode: (["columns", "rows", "mcu", "android"].includes(v.mode)
        ? v.mode
        : "columns") as LogLayout,
    };
  } catch {
    return { left: true, right: true, mode: "columns" as LogLayout };
  }
}
const cut = (s: string) => s.slice(-300000).split("\n").slice(-2000).join("\n");
function LogPane({
  source,
  text,
  clear,
  visible,
  historical = false,
}: {
  source: string;
  text: string;
  clear: () => void;
  visible: boolean;
  historical?: boolean;
}) {
  const [paused, setPaused] = useState(false);
  const [snapshot, setSnapshot] = useState("");
  const pre = useRef<HTMLPreElement>(null);
  const displayedText = paused ? snapshot : text;
  useLayoutEffect(() => {
    if (visible && !paused && pre.current)
      pre.current.scrollTop = pre.current.scrollHeight;
  }, [text, paused, visible]);
  const togglePaused = () => {
    if (!paused) setSnapshot(text);
    setPaused((value) => !value);
  };
  const clearPreview = () => {
    setSnapshot("");
    clear();
    if (pre.current) pre.current.scrollTop = 0;
  };
  return (
    <section className="log-pane" hidden={!visible}>
      <header>
        <span className={"source-dot " + source} />
        <strong>{source === "mcu" ? "MCU 串口" : "Android Logcat"}</strong>
        <div className="grow" />
        {!historical && <button
          className={"icon " + (paused ? "toggled" : "")}
          title={
            paused ? "继续自动滚动，显示最新日志" : "暂停自动滚动，固定当前预览"
          }
          aria-label={paused ? "继续自动滚动" : "暂停自动滚动"}
          aria-pressed={paused}
          onClick={togglePaused}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>}
        <button
          className="icon"
          title="清空预览，不影响保存"
          onClick={clearPreview}
        >
          <Trash2 size={14} />
        </button>
      </header>
      <pre ref={pre}>
        {displayedText || (
          <span className="log-empty">
            {historical ? "该记录暂无日志内容" : source === "mcu" ? "等待串口数据…" : "等待 Android 日志…"}
          </span>
        )}
      </pre>
    </section>
  );
}
export default function App() {
  const [operationsTab, setOperationsTab] = useState<"capture" | "connection">(
    "connection",
  );
  const [layout, setLayout] = useState(loadLayout);
  useEffect(() => {
    try {
      localStorage.setItem("twinlog.layout", JSON.stringify(layout));
    } catch {
      /* Preferences are optional. */
    }
  }, [layout]);
  const [config, setConfig] = useState<Config>(defaults),
    [state, setState] = useState<State>(empty),
    [ports, setPorts] = useState<Port[]>([]),
    [devices, setDevices] = useState<Device[]>([]),
    [packages, setPackages] = useState<string[]>([]);
  const [records, setRecords] = useState<RecordItem[]>([]),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [view, setView] = useState<RecordItem | null>(null),
    [recordLogs, setRecordLogs] = useState<RecordLogs | null>(null),
    [title, setTitle] = useState(""),
    [notes, setNotes] = useState(""),
    [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [includeFull, setIncludeFull] = useState(false),
    [mcu, setMcu] = useState(""),
    [android, setAndroid] = useState(""),
    [saved, setSaved] = useState(true);
  const pending = useRef<{ path: string; text: string } | null>(null),
    draft = useRef({ title: "", notes: "" }),
    titleInput = useRef<HTMLInputElement>(null),
    focusTitle = useRef(false),
    selectAll = useRef<HTMLInputElement>(null),
    saving = useRef<Promise<void>>(Promise.resolve()),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    viewRef = useRef<RecordItem | null>(null),
    stateRef = useRef(state),
    flushRef = useRef<() => Promise<void>>(async () => {});
  stateRef.current = state;
  useEffect(() => {
    if (
      focusTitle.current &&
      !busy &&
      !view &&
      layout.right &&
      operationsTab === "capture"
    ) {
      titleInput.current?.focus();
      focusTitle.current = false;
    }
  }, [busy, view, layout.right, operationsTab]);
  const refreshRecords = async (root = config.outputDir) => {
    if (desktop() && root) {
      const items = (await api.ListRecords(root)) || [];
      setRecords(items);
      setSelected((s) => new Set([...s].filter((path) =>
        items.some((r) => r.path === path && r.path !== stateRef.current.activeRecord?.path),
      )));
    }
  };
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNotice("");
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };
  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    const p = pending.current;
    if (p) {
      pending.current = null;
      const task = saving.current
        .catch(() => {})
        .then(() => api.SaveNotes(p.path, p.text));
      saving.current = task;
      try {
        await task;
        setSaved(!pending.current);
      } catch (e) {
        if (!pending.current) pending.current = p;
        setSaved(false);
        throw e;
      }
    } else {
      await saving.current;
    }
  };
  flushRef.current = flush;
  const updateNotes = (text: string) => {
    setNotes(text);
    if (!viewRef.current) {
      draft.current.notes = text;
      return;
    }
    const path = viewRef.current?.path || stateRef.current.activeRecord?.path;
    if (!path) return;
    setRecords((rs) =>
      rs.map((r) => (r.path === path ? { ...r, notes: text } : r)),
    );
    if (viewRef.current?.path === path) {
      viewRef.current = { ...viewRef.current, notes: text };
      setView(viewRef.current);
    }
    pending.current = { path, text };
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      flush().catch((e) => setError(String(e)));
    }, 500);
  };
  useEffect(() => {
    if (!desktop()) return;
    let alive = true;
    api
      .GetConfig()
      .then(async (c) => {
        if (!alive) return;
        setConfig(c);
        await refreshRecords(c.outputDir);
        const [p, d] = await Promise.allSettled([
          api.ListPorts(),
          api.ListDevices(c.adbPath),
        ]);
        if (alive) {
          if (p.status === "fulfilled") setPorts(p.value || []);
          if (d.status === "fulfilled") setDevices(d.value || []);
        }
      })
      .catch((e) => setError(String(e)));
    api.GetState().then((s) => {
      if (alive) setState(s);
    });
    const offClose = window.runtime?.EventsOn("before-close", () => {
      flushRef
        .current()
        .then(() => api.ConfirmClose(true))
        .catch((e) => {
          setError(String(e));
          api.ConfirmClose(false);
        });
    });
    const off1 = window.runtime?.EventsOn("state", (s: State) => {
        if (alive) setState(s);
      }),
      off2 = window.runtime?.EventsOn(
        "logs",
        (b: { source: string; text: string }) => {
          if (b.source === "mcu") setMcu((s) => cut(s + b.text));
          else setAndroid((s) => cut(s + b.text));
        },
      ),
      off3 = window.runtime?.EventsOn("error", (s: string) => setError(s));
    return () => {
      alive = false;
      off1?.();
      off2?.();
      off3?.();
      offClose?.();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    if (!state.connected && !state.capturing && desktop())
      refreshRecords().catch((e) => setError(String(e)));
  }, [state.connected, state.capturing]);
  const patch = (v: Partial<Config>) => setConfig((c) => ({ ...c, ...v }));
  const changeView = async (r: RecordItem) => {
    await flush();
    const logs = await api.ReadRecordLogs(r.path);
    setRecordLogs(logs);
    setOperationsTab("capture");
    setLayout((v) => ({ ...v, right: true }));
    viewRef.current = r;
    setView(r);
    setTitle(r.title);
    setNotes(r.notes);
    setSaved(true);
  };
  const prepareCapture = () =>
    run("新建抓取", async () => {
      await flush();
      viewRef.current = null;
      setView(null);
      setRecordLogs(null);
      setTitle(draft.current.title);
      setNotes(draft.current.notes);
      setSaved(true);
      setLayout((v) => ({ ...v, right: true }));
      setOperationsTab(stateRef.current.connected ? "capture" : "connection");
      focusTitle.current = stateRef.current.connected;
    });
  const chooseDir = () =>
    run("选择目录", async () => {
      const p = await api.SelectDirectory();
      if (p) {
        const c = { ...config, outputDir: p };
        setConfig(c);
        setSelected(new Set());
        await api.SaveConfig(c);
        await refreshRecords(p);
      }
    });
  const refreshDevices = () =>
    run("刷新设备", async () => {
      const [p, d] = await Promise.all([
        api.ListPorts(),
        api.ListDevices(config.adbPath),
      ]);
      setPorts(p || []);
      setDevices(d || []);
    });
  const connect = () =>
    run("连接设备", async () => {
      await flush();
      await api.Connect(config);
      setState(await api.GetState());
      setOperationsTab("capture");
      focusTitle.current = !viewRef.current;
      setIncludeFull(false);
    });
  const disconnect = () =>
    run("断开连接", async () => {
      await flush();
      await api.Disconnect();
      setOperationsTab("connection");
      setState(await api.GetState());
      await refreshRecords();
    });
  const start = () =>
    run("开始抓取", async () => {
      await flush();
      if (config.package !== state.config.package)
        await api.SetPackage(config.package);
      const r = await api.StartCapture(title, notes);
      draft.current = { title: "", notes: "" };
      viewRef.current = r;
      setView(r);
      setRecordLogs(null);
      setTitle(r.title);
      setState(await api.GetState());
      await refreshRecords();
      setSaved(true);
    });
  const stop = () =>
    run("停止抓取", async () => {
      await flush();
      const r = await api.StopCapture();
      viewRef.current = r;
      setView(r);
      setRecordLogs(null);
      setNotes(r.notes);
      setState(await api.GetState());
      await refreshRecords();
      setRecordLogs(await api.ReadRecordLogs(r.path));
    });
  const deleteRecords = () =>
    run("删除记录", async () => {
      await flush();
      const paths = [...selected];
      let trash = "";
      try {
        trash = await api.DeleteRecords(paths);
      } finally {
        // Refresh even after a partially failed filesystem operation.
        await refreshRecords();
      }
      if (!trash) return;
      if (viewRef.current && selected.has(viewRef.current.path)) {
        viewRef.current = null;
        setView(null);
        setRecordLogs(null);
        setTitle(draft.current.title);
        setNotes(draft.current.notes);
        setSaved(true);
      }
      setSelected(new Set());
      setNotice("已将 " + paths.length + " 条记录移入回收目录：" + trash);
    });
  const exportRecords = () =>
    run("正在导出", async () => {
      await flush();
      const p = await api.ExportRecords([...selected], includeFull);
      if (p) setNotice("已导出：" + p);
    });
  const locked = !!busy,
    live = state.capturing && view?.path === state.activeRecord?.path,
    history = !!view && !live;
  const selectable = records.filter((r) => r.path !== state.activeRecord?.path);
  const selectedCount = selectable.filter((r) => selected.has(r.path)).length;
  const allSelected = selectable.length > 0 && selectedCount === selectable.length;
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selectedCount > 0 && !allSelected;
  }, [selectedCount, allSelected]);
  return (
    <div className="app-shell">
      <aside className="sidebar" hidden={!layout.left}>
        <div className="brand">
          <div className="brand-mark">
            <Activity size={25} />
          </div>
          <div>
            <b>TwinLog</b>
          </div>
          <span className="version">v{version}</span>
        </div>
        <div className="sidebar-top">
          <div>
            <h2>
              抓取记录 <span>{records.length}</span>
            </h2>
          </div>
          <button
            className="icon"
            title="刷新记录"
            disabled={locked}
            onClick={() => run("刷新记录", async () => refreshRecords())}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        <button
          className="new-record"
          disabled={state.capturing || locked}
          onClick={prepareCapture}
          aria-current={!view ? "page" : undefined}
        >
          <Plus size={17} />
          新建抓取
        </button>
        <div className="selection-toolbar">
          <label>
            <input
              ref={selectAll}
              type="checkbox"
              aria-label="全选记录"
              checked={allSelected}
              disabled={!selectable.length || locked}
              onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.path)))}
            />
            全选{selectedCount ? " · " + selectedCount : ""}
          </label>
          <button
            className="delete-records"
            aria-label="删除所选"
            title={state.capturing ? "请先停止当前抓取" : "移入回收目录，保留完整日志"}
            disabled={!selectedCount || locked || state.capturing}
            onClick={deleteRecords}
          >
            <Trash2 size={14} />删除
          </button>
        </div>
        <div className="history-list">
          {!records.length ? (
            <div className="history-empty">
              <FileText size={30} />
              <b>还没有抓取记录</b>
            </div>
          ) : (
            records.map((r) => (
              <div
                key={r.path}
                className={
                  "history-row " + (view?.path === r.path ? "active" : "")
                }
              >
                <input
                  type="checkbox"
                  aria-label={"选择 " + r.title}
                  checked={selected.has(r.path)}
                  disabled={locked || r.path === state.activeRecord?.path}
                  onChange={(e) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(r.path);
                      else n.delete(r.path);
                      return n;
                    })
                  }
                />
                <button
                  title="查看该记录的日志和备注"
                  aria-current={view?.path === r.path ? "page" : undefined}
                  onClick={() => run("打开记录", async () => changeView(r))}
                  disabled={state.capturing || locked}
                >
                  <strong>{r.title}</strong>
                  <span>{time(r.startedAt)}</span>
                  <small>
                    {r.interrupted
                      ? "中断"
                      : !r.endedAt
                        ? "抓取中"
                        : r.package || "全部应用"}
                    {r.filterGaps ? " · 应用过滤有缺口" : ""}
                  </small>
                </button>
              </div>
            ))
          )}
        </div>
        <div className="export-panel">
          <label title={state.connected ? "附带完整日志需先断开连接" : ""}>
            <input
              type="checkbox"
              checked={includeFull}
              disabled={state.connected || locked}
              onChange={(e) => setIncludeFull(e.target.checked)}
            />
            附带完整日志
          </label>

          <button
            className="secondary export"
            disabled={
              !selected.size ||
              locked ||
              state.capturing ||
              (includeFull && state.connected)
            }
            onClick={exportRecords}
          >
            <Download size={16} />
            {busy === "正在导出"
              ? "正在导出…"
              : "导出所选" + (selected.size ? " · " + selected.size : "")}
          </button>
        </div>
      </aside>
      <main>
        <header className="workspace-toolbar">
          <button
            className="icon"
            title={layout.left ? "收起记录栏" : "展开记录栏"}
            aria-label={layout.left ? "收起记录栏" : "展开记录栏"}
            aria-expanded={layout.left}
            onClick={() => setLayout((v) => ({ ...v, left: !v.left }))}
          >
            {layout.left ? (
              <PanelLeftClose size={18} />
            ) : (
              <PanelLeftOpen size={18} />
            )}
          </button>
          <div className="layout-switch" role="group" aria-label="日志布局">
            {(
              [
                ["columns", "左右", Columns2],
                ["rows", "上下", Rows2],
                ["mcu", "MCU", null],
                ["android", "Android", null],
              ] as const
            ).map(([mode, label, Icon]) => (
              <button
                key={mode}
                aria-pressed={layout.mode === mode}
                className={layout.mode === mode ? "active" : ""}
                onClick={() => setLayout((v) => ({ ...v, mode }))}
              >
                {Icon && <Icon size={14} />}
                {label}
              </button>
            ))}
          </div>
          <div className="grow" />
          {state.capturing && (
            <>
              <span className="capture-title" title={state.activeRecord?.title}>
                {state.activeRecord?.title}
              </span>
              <span className="recording">
                <i />
                抓取中
              </span>
              {!layout.right && (
                <button
                  className="stop compact"
                  disabled={locked}
                  onClick={stop}
                >
                  <Square size={13} />
                  停止并保存
                </button>
              )}
            </>
          )}
          <button
            className="icon"
            title="打开日志目录"
            aria-label="打开日志目录"
            disabled={!(view?.path || state.sessionDir) || locked}
            onClick={() =>
              run("打开目录", async () => api.OpenFolder(view?.path || state.sessionDir))
            }
          >
            <FolderOpen size={17} />
          </button>
          <button
            className="icon"
            title={layout.right ? "收起操作栏" : "展开操作栏"}
            aria-label={layout.right ? "收起操作栏" : "展开操作栏"}
            aria-expanded={layout.right}
            onClick={() => setLayout((v) => ({ ...v, right: !v.right }))}
          >
            {layout.right ? (
              <PanelRightClose size={18} />
            ) : (
              <PanelRightOpen size={18} />
            )}
          </button>
        </header>
        {(error || state.error) && (
          <div className="error-banner">
            <AlertCircle size={16} />
            <span>{error || state.error}</span>
            {error && (
              <button
                className="icon"
                aria-label="关闭提示"
                onClick={() => setError("")}
              >
                ×
              </button>
            )}
          </div>
        )}
        {state.filterWarning && (
          <div className="preview-banner" title={state.filterWarning}>
            <AlertCircle size={16} />
            <span>
              应用过滤暂不可用，正在重试；MCU 和完整 Android 日志继续保存。
            </span>
          </div>
        )}
        {history && (
          <div className="history-banner">
            <span title={view.path}>
              历史日志 · <strong>{view.title}</strong>
              <small>{recordLogs ? (recordLogs.mcu.truncated || recordLogs.android.truncated
                ? "仅预览末尾最多 2000 行 / 256 KB，全文请打开记录目录"
                : "显示该条抓取已保存的日志") : "日志未加载，可重新点击记录重试"}</small>
            </span>
            <button disabled={locked} onClick={prepareCapture}>返回实时</button>
          </div>
        )}
        <LogSplit mode={layout.mode}>
          <LogPane
            key={history ? view.path + "mcu" : "live-mcu"}
            source="mcu"
            historical={history}
            text={history ? recordLogs?.mcu.text || "" : mcu}
            clear={() => history ? setRecordLogs((logs) => logs && ({ ...logs, mcu: { ...logs.mcu, text: "" } })) : setMcu("")}
            visible={layout.mode !== "android"}
          />
          <LogPane
            key={history ? view.path + "android" : "live-android"}
            source="android"
            historical={history}
            text={history ? recordLogs?.android.text || "" : android}
            clear={() => history ? setRecordLogs((logs) => logs && ({ ...logs, android: { ...logs.android, text: "" } })) : setAndroid("")}
            visible={layout.mode !== "mcu"}
          />
        </LogSplit>
        <footer className="statusbar">
          <span>
            <i className={state.connected ? "online-dot" : "offline-dot"} />
            {busy || (state.connected ? "已连接 · 全量记录中" : "未连接")}
          </span>
          <span className="live-label">{history ? "历史日志" : "实时日志"}</span>
          <span className="status-notice" title={notice}>
            {notice}
          </span>
          <div className="grow" />
          <span className="mono">
            MCU {size(history ? recordLogs?.mcu.bytes || 0 : state.mcuBytes)}
            <span className="divider">/</span>Android {size(history ? recordLogs?.android.bytes || 0 : state.androidBytes)}
          </span>
        </footer>
      </main>
      <aside className="operations" hidden={!layout.right}>
        <header className="operations-heading">
          <div className="operations-tabs" role="tablist" aria-label="操作面板">
            {(["capture", "connection"] as const).map((tab) => (
              <button
                key={tab}
                id={"operations-tab-" + tab}
                role="tab"
                aria-selected={operationsTab === tab}
                aria-controls={"operations-panel-" + tab}
                tabIndex={operationsTab === tab ? 0 : -1}
                onClick={() => setOperationsTab(tab)}
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? "capture"
                      : event.key === "End"
                        ? "connection"
                        : tab === "capture"
                          ? "connection"
                          : "capture";
                  setOperationsTab(next);
                  document.getElementById("operations-tab-" + next)?.focus();
                }}
              >
                {tab === "capture" ? <FileText size={15} /> : <Usb size={15} />}
                {tab === "capture" ? "抓取" : "设备连接"}
                {tab === "connection" && (
                  <i
                    className={state.connected ? "online-dot" : "offline-dot"}
                  />
                )}
              </button>
            ))}
          </div>
        </header>
        <div
          className="operations-body"
          role="tabpanel"
          id="operations-panel-capture"
          aria-labelledby="operations-tab-capture"
          hidden={operationsTab !== "capture"}
        >
          <section className="capture-card">
            <div className="capture-heading">
              <span className="eyebrow">
                {live
                  ? "抓取中"
                  : history
                    ? view.interrupted
                      ? "已中断"
                      : "已保存"
                    : "待开始"}
              </span>
              {history && (
                <button
                  className="text-button"
                  onClick={() =>
                    run("打开目录", async () => api.OpenFolder(view.path))
                  }
                >
                  <FolderOpen size={14} />
                  打开记录目录
                </button>
              )}
            </div>
            <div className="capture-controls">
              <input
                ref={titleInput}
                className="title-input"
                placeholder="标题"
                aria-label="抓取标题"
                value={title}
                disabled={state.capturing || history || locked}
                onChange={(e) => {
                  setTitle(e.target.value);
                  draft.current.title = e.target.value;
                }}
              />
              {state.capturing ? (
                <button className="stop" disabled={locked} onClick={stop}>
                  <Square size={15} fill="currentColor" />
                  停止并保存
                </button>
              ) : history ? (
                <button
                  className="primary"
                  disabled={locked}
                  onClick={prepareCapture}
                >
                  <Plus size={16} />
                  新建抓取
                </button>
              ) : (
                <button
                  className="primary start"
                  disabled={
                    !state.connected || !title.trim() || history || locked
                  }
                  onClick={start}
                >
                  <Play size={16} fill="currentColor" />
                  开始抓取
                </button>
              )}
            </div>
            <div className="app-select">
              <label htmlFor="package">Android 应用</label>
              <input
                id="package"
                list="packages"
                placeholder="全部应用 / 包名"
                value={history ? view.package : config.package}
                disabled={state.capturing || history || locked}
                onChange={(e) => patch({ package: e.target.value })}
                onBlur={() => {
                  if (
                    state.connected &&
                    !state.capturing &&
                    !history &&
                    config.package !== state.config.package
                  )
                    run("切换应用", async () => {
                      await api.SetPackage(config.package);
                      setAndroid("");
                    });
                }}
              />
              <datalist id="packages">
                {packages.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
              <button
                className="text-button"
                title="加载应用"
                aria-label="加载应用"
                disabled={
                  !config.androidSerial || state.capturing || history || locked
                }
                onClick={() =>
                  run("加载应用", async () => {
                    setPackages(
                      await api.ListPackages(
                        config.adbPath,
                        config.androidSerial,
                      ),
                    );
                  })
                }
              >
                <RefreshCw size={13} />
                加载应用
              </button>
              {state.filterStatus && (
                <span className="filter-status" title={state.filterWarning}>
                  {state.filterStatus}
                </span>
              )}
            </div>
          </section>
          <section className="notes-card">
            <header>
              <FileText size={16} />
              <strong>备注</strong>

              <div className="grow" />
              {(view || state.capturing) && (
                <small className={saved ? "save-ok" : "save-pending"}>
                  {saved ? (
                    <>
                      <Check size={13} />
                      已保存
                    </>
                  ) : (
                    "保存中…"
                  )}
                </small>
              )}
            </header>
            <textarea
              disabled={locked}
              value={notes}
              placeholder="输入备注"
              onChange={(e) => updateNotes(e.target.value)}
              onBlur={() => flush().catch((e) => setError(String(e)))}
            />
          </section>
        </div>
        <div
          className="operations-body"
          role="tabpanel"
          id="operations-panel-connection"
          aria-labelledby="operations-tab-connection"
          hidden={operationsTab !== "connection"}
        >
          <section className="connection-card">
            <div className="connection-heading">
              <div className="section-icon">
                <Usb size={17} />
              </div>
              <strong>设备连接</strong>
              <span>
                {state.connected
                  ? config.serialPort + " + " + config.androidSerial
                  : "未连接"}
              </span>
              <div className="grow" />
            </div>
            <div className="connection-body">
              <div className="device-grid">
                <label>
                  串口
                  <select
                    value={config.serialPort}
                    disabled={state.connected || locked}
                    onChange={(e) => patch({ serialPort: e.target.value })}
                  >
                    <option value="">选择 COM 端口</option>
                    {ports.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                        {p.description ? " · " + p.description : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  波特率
                  <input
                    type="number"
                    min="1"
                    value={config.baudRate}
                    disabled={state.connected || locked}
                    onChange={(e) =>
                      patch({ baudRate: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Android 设备
                  <select
                    value={config.androidSerial}
                    disabled={state.connected || locked}
                    onChange={(e) => {
                      patch({ androidSerial: e.target.value });
                      setPackages([]);
                    }}
                  >
                    <option value="">选择设备</option>
                    {devices.map((d) => (
                      <option
                        key={d.serial}
                        value={d.serial}
                        disabled={d.state !== "device"}
                      >
                        {d.model || d.serial} · {d.serial} [{d.state}]
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="secondary refresh-device"
                  disabled={state.connected || locked}
                  onClick={refreshDevices}
                >
                  <RefreshCw size={15} />
                  刷新
                </button>
              </div>
              <div className="path-row">
                <label>
                  保存目录
                  <div className="input-button">
                    <input
                      value={config.outputDir}
                      placeholder="选择日志保存位置"
                      disabled={state.connected || locked}
                      onChange={(e) => patch({ outputDir: e.target.value })}
                    />
                    <button
                      disabled={state.connected || locked}
                      onClick={chooseDir}
                    >
                      <FolderOpen size={16} />
                    </button>
                  </div>
                </label>
                <button
                  className="text-button"
                  onClick={() => setAdvanced(!advanced)}
                >
                  <Settings2 size={15} />
                  更多设置
                </button>
                <button
                  className={state.connected ? "disconnect" : "primary"}
                  disabled={
                    locked ||
                    (!state.connected &&
                      (!config.outputDir ||
                        !config.serialPort ||
                        !config.androidSerial))
                  }
                  onClick={state.connected ? disconnect : connect}
                >
                  <Radio size={16} />
                  {busy === "连接设备"
                    ? "连接中…"
                    : state.connected
                      ? "断开连接"
                      : "连接设备"}
                </button>
              </div>
              {advanced && (
                <div className="advanced">
                  <label>
                    ADB 路径
                    <div className="input-button">
                      <input
                        value={config.adbPath}
                        disabled={state.connected || locked}
                        onChange={(e) => patch({ adbPath: e.target.value })}
                      />
                      <button
                        disabled={state.connected || locked}
                        onClick={() =>
                          run("选择 ADB", async () => {
                            const p = await api.SelectADB();
                            if (p) patch({ adbPath: p });
                          })
                        }
                      >
                        <FolderOpen size={15} />
                      </button>
                    </div>
                  </label>
                  <label>
                    数据位
                    <select
                      value={config.dataBits}
                      disabled={state.connected}
                      onChange={(e) =>
                        patch({ dataBits: Number(e.target.value) })
                      }
                    >
                      {[5, 6, 7, 8].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    停止位
                    <select
                      value={config.stopBits}
                      disabled={state.connected}
                      onChange={(e) =>
                        patch({ stopBits: Number(e.target.value) })
                      }
                    >
                      <option>1</option>
                      <option>2</option>
                    </select>
                  </label>
                  <label>
                    校验
                    <select
                      value={config.parity}
                      disabled={state.connected}
                      onChange={(e) => patch({ parity: e.target.value })}
                    >
                      <option value="none">无</option>
                      <option value="odd">奇</option>
                      <option value="even">偶</option>
                    </select>
                  </label>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={config.dtr}
                      disabled={state.connected}
                      onChange={(e) => patch({ dtr: e.target.checked })}
                    />
                    DTR
                  </label>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={config.rts}
                      disabled={state.connected}
                      onChange={(e) => patch({ rts: e.target.checked })}
                    />
                    RTS
                  </label>
                </div>
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
