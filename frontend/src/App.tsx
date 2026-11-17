import { useState, useEffect, useLayoutEffect, useRef } from "react";
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
  ChevronDown,
  ChevronUp,
  FileText,
  Check,
  AlertCircle,
  ArrowUpRight,
  Radio,
} from "lucide-react";
import {
  api,
  desktop,
  defaults,
  Config,
  State,
  RecordItem,
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
const cut = (s: string) => s.slice(-300000).split("\n").slice(-2000).join("\n");
function LogPane({
  source,
  text,
  clear,
}: {
  source: string;
  text: string;
  clear: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const [snapshot, setSnapshot] = useState("");
  const pre = useRef<HTMLPreElement>(null);
  const displayedText = paused ? snapshot : text;
  useLayoutEffect(() => {
    if (!paused && pre.current)
      pre.current.scrollTop = pre.current.scrollHeight;
  }, [text, paused]);
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
    <section className="log-pane">
      <header>
        <span className={"source-dot " + source} />
        <strong>{source === "mcu" ? "MCU 串口" : "Android Logcat"}</strong>
        <span className="mono sub">
          {source === "mcu" ? "接收时间戳" : "应用日志"}
        </span>
        <div className="grow" />
        <button
          className={"icon " + (paused ? "toggled" : "")}
          title={paused ? "继续自动滚动，显示最新日志" : "暂停自动滚动，固定当前预览"}
          aria-label={paused ? "继续自动滚动" : "暂停自动滚动"}
          aria-pressed={paused}
          onClick={togglePaused}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
        <button className="icon" title="清空预览，不影响保存" onClick={clearPreview}>
          <Trash2 size={14} />
        </button>
      </header>
      <pre ref={pre}>
        {displayedText || (
          <span className="log-empty">
            {source === "mcu" ? "等待串口数据…" : "等待 Android 日志…"}
            <br />
            <small>连接后持续保存，预览仅显示最近 2000 行</small>
          </span>
        )}
      </pre>
      <footer>
        <span>{paused ? "预览已暂停 · 后台继续保存" : "自动滚动"}</span>
        <span>清屏仅影响预览</span>
      </footer>
    </section>
  );
}
export default function App() {
  const [config, setConfig] = useState<Config>(defaults),
    [state, setState] = useState<State>(empty),
    [ports, setPorts] = useState<Port[]>([]),
    [devices, setDevices] = useState<Device[]>([]),
    [packages, setPackages] = useState<string[]>([]);
  const [records, setRecords] = useState<RecordItem[]>([]),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [view, setView] = useState<RecordItem | null>(null),
    [title, setTitle] = useState(""),
    [notes, setNotes] = useState(""),
    [advanced, setAdvanced] = useState(false),
    [connectionOpen, setConnectionOpen] = useState(true);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [includeFull, setIncludeFull] = useState(false),
    [mcu, setMcu] = useState(""),
    [android, setAndroid] = useState(""),
    [saved, setSaved] = useState(true);
  const pending = useRef<{ path: string; text: string } | null>(null),
    saving = useRef<Promise<void>>(Promise.resolve()),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    viewRef = useRef<RecordItem | null>(null),
    stateRef = useRef(state),
    flushRef = useRef<() => Promise<void>>(async () => {});
  stateRef.current = state;
  const refreshRecords = async (root = config.outputDir) => {
    if (desktop() && root) setRecords((await api.ListRecords(root)) || []);
  };
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
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
  const changeView = async (r: RecordItem | null) => {
    await flush();
    viewRef.current = r;
    setView(r);
    setTitle(r?.title || "");
    setNotes(r?.notes || "");
    setSaved(true);
  };
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
      setNotice("设备列表已更新");
    });
  const connect = () =>
    run("连接设备", async () => {
      await flush();
      await api.Connect(config);
      setState(await api.GetState());
      setConnectionOpen(false);
      setIncludeFull(false);
      setNotice("两路已连接，完整日志持续保存中");
    });
  const disconnect = () =>
    run("断开连接", async () => {
      await flush();
      await api.Disconnect();
      setState(await api.GetState());
      await refreshRecords();
      setNotice("已断开，日志已保存");
    });
  const start = () =>
    run("开始抓取", async () => {
      await flush();
      if (config.package !== state.config.package)
        await api.SetPackage(config.package);
      const r = await api.StartCapture(title, notes);
      viewRef.current = r;
      setView(r);
      setState(await api.GetState());
      await refreshRecords();
      setSaved(true);
      setNotice("正在抓取，备注会自动保存");
    });
  const stop = () =>
    run("停止抓取", async () => {
      await flush();
      const r = await api.StopCapture();
      viewRef.current = r;
      setView(r);
      setNotes(r.notes);
      setState(await api.GetState());
      await refreshRecords();
      setNotice("抓取已保存，完整日志继续记录");
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
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Activity size={25} />
          </div>
          <div>
            <b>TwinLog</b>
            <span>双路日志助手</span>
          </div>
          <span className="version">v0.1.2</span>
        </div>
        <div className="sidebar-top">
          <div>
            <span className="eyebrow">WORKSPACE</span>
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
          onClick={() => run("新建记录", async () => changeView(null))}
        >
          <Plus size={17} />
          新建抓取
        </button>
        <div className="history-list">
          {!records.length ? (
            <div className="history-empty">
              <FileText size={30} />
              <b>还没有抓取记录</b>
              <span>
                连接设备后，创建第一条抓取。
                <br />
                日志与备注会自动保存在本地。
              </span>
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
                  disabled={r.path === state.activeRecord?.path}
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
          <label>
            <input
              type="checkbox"
              checked={includeFull}
              disabled={state.connected || locked}
              onChange={(e) => setIncludeFull(e.target.checked)}
            />
            附带完整日志
          </label>
          {state.connected && <small>附带完整日志需先断开连接</small>}
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
        <div className="sidebar-bottom">
          <span className="source-dot mcu" />
          本地保存 · 无数据库
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="eyebrow">CAPTURE WORKSPACE</span>
            <h1>
              让每次复现都有记录
              <span
                className={
                  "connection-badge " + (state.connected ? "online" : "")
                }
              >
                <i />
                {state.connected ? "持续采集中" : "未连接"}
              </span>
            </h1>
          </div>
          <button
            className="secondary"
            disabled={!state.sessionDir || locked}
            onClick={() =>
              run("打开目录", async () => api.OpenFolder(state.sessionDir))
            }
          >
            <FolderOpen size={16} />
            打开日志目录
            <ArrowUpRight size={13} />
          </button>
        </header>
        {!desktop() && (
          <div className="preview-banner">
            <AlertCircle size={16} />
            浏览器界面预览 · 请运行 TwinLog 桌面程序连接串口和 Android 设备。
          </div>
        )}
        {(error || state.error) && (
          <div className="error-banner">
            <AlertCircle size={17} />
            <span>{error || state.error}</span>
            <button className="icon" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        <section className="connection-card">
          <button
            className="connection-heading"
            onClick={() => setConnectionOpen(!connectionOpen)}
          >
            <div className="section-icon">
              <Usb size={17} />
            </div>
            <strong>设备连接</strong>
            <span>
              {state.connected
                ? config.serialPort + " + " + config.androidSerial
                : "一个串口，一台 Android 设备"}
            </span>
            <div className="grow" />
            {connectionOpen ? (
              <ChevronUp size={16} />
            ) : (
              <ChevronDown size={16} />
            )}
          </button>
          {connectionOpen && (
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
                      : "连接并持续采集"}
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
          )}
        </section>
        <section className="capture-card">
          <div className="capture-heading">
            <span className="eyebrow">
              {history ? "SAVED CAPTURE" : "CURRENT CAPTURE"}
            </span>
            {history && (
              <button
                className="text-button"
                onClick={() =>
                  run("打开目录", async () => api.OpenFolder(view.path))
                }
              >
                <FolderOpen size={14} />
                打开记录日志
              </button>
            )}
            {live && (
              <span className="recording">
                <i />
                正在抓取
              </span>
            )}
          </div>
          <div className="capture-controls">
            <input
              className="title-input"
              placeholder="为这次抓取起个标题…"
              value={title}
              disabled={state.capturing || history || locked}
              onChange={(e) => setTitle(e.target.value)}
            />
            {state.capturing ? (
              <button className="stop" disabled={locked} onClick={stop}>
                <Square size={15} fill="currentColor" />
                Stop · 保存抓取
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
                Start · 开始抓取
              </button>
            )}
          </div>
          <div className="app-select">
            <label htmlFor="package">Android 应用</label>
            <input
              id="package"
              list="packages"
              placeholder="全部应用（或输入包名）"
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
                  setNotice("应用包名已加载，可输入搜索");
                })
              }
            >
              <RefreshCw size={13} />
              加载应用
            </button>
            <span>留空为全部 · full 始终保存全量</span>
            {state.filterStatus && (
              <span className="filter-status" title={state.filterWarning}>
                {state.filterStatus}
              </span>
            )}
          </div>
        </section>
        {state.filterWarning && (
          <div className="preview-banner" title={state.filterWarning}>
            <AlertCircle size={16} />
            <span>
              应用过滤暂不可用，正在重试；MCU 和完整 Android 日志继续保存。
            </span>
          </div>
        )}
        <div className="logs-grid">
          <LogPane source="mcu" text={mcu} clear={() => setMcu("")} />
          <LogPane
            source="android"
            text={android}
            clear={() => setAndroid("")}
          />
        </div>
        {history && (
          <div className="history-preview-hint">
            上方是当前连接的实时预览。历史日志请点击“打开记录日志”查看。
          </div>
        )}
        <section className="notes-card">
          <header>
            <FileText size={16} />
            <strong>备注</strong>
            <span>随时记录，停止后也能补充</span>
            <div className="grow" />
            {(view || state.capturing) && (
              <small className={saved ? "save-ok" : "save-pending"}>
                {saved ? (
                  <>
                    <Check size={13} />
                    已自动保存
                  </>
                ) : (
                  "保存中…"
                )}
              </small>
            )}
          </header>
          <textarea
            value={notes}
            placeholder="输入备注，例如复现步骤、测试员反馈…"
            onChange={(e) => updateNotes(e.target.value)}
            onBlur={() => flush().catch((e) => setError(String(e)))}
          />
        </section>
        <footer className="statusbar">
          <span>
            <i className={state.connected ? "online-dot" : "offline-dot"} />
            {busy ||
              notice ||
              (state.connected
                ? "完整日志持续保存中"
                : "准备就绪 · 连接设备开始记录")}
          </span>
          <div className="grow" />
          <span className="mono">
            MCU {size(state.mcuBytes)}
            <span className="divider">/</span>Android {size(state.androidBytes)}
          </span>
        </footer>
      </main>
    </div>
  );
}
