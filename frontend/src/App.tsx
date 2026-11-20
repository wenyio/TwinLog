import { useState, useEffect, useMemo, useRef } from "react";
import LogSplit from "./LogSplit";
import Notification from "./Notification";
import LogPane, { emptyPreview, trimPreview } from "./LogPane";
import SessionList, { recordTitle as displayTitle } from "./SessionList";
import SessionDialog from "./SessionDialog";
import BaudRateDialog, { baudRatePresets, customBaudRates, validBaudRate } from "./BaudRateDialog";
import { version } from "../package.json";
import {
  Activity,
  Usb,
  FolderOpen,
  RefreshCw,
  Undo2,
  Crosshair,
  Play,
  Square,
  Download,
  Plus,
  Trash2,
  Settings2,
  FileText,
  Check,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Columns2,
  Rows2,
  Radio,
  X,
} from "lucide-react";
import {
  api,
  desktop,
  defaults,
  Config,
  State,
  RecordItem,
  RecordLogs,
  Session,
  LogSource,
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
type RecordFields = Pick<RecordItem, "title" | "notes">;
type CapturePreview = Record<LogSource, typeof emptyPreview>;
type LogLayout = "columns" | "rows" | "mcu" | "android";
function loadLayout() {
  try {
    const v = JSON.parse(localStorage.getItem("twinlog.layout") || "{}");
    return {
      left: v.left !== false,
      right: v.right !== false,
      mode: (["columns", "rows", "mcu", "android"].includes(v.mode)
        ? v.mode
        : "rows") as LogLayout,
    };
  } catch {
    return { left: true, right: true, mode: "rows" as LogLayout };
  }
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
  const [sessions, setSessions] = useState<Session[]>([]),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [view, setView] = useState<RecordItem | null>(null),
    [fullView, setFullView] = useState<Session | null>(null),
    [recordLogs, setRecordLogs] = useState<RecordLogs | null>(null),
    [title, setTitle] = useState(""),
    [notes, setNotes] = useState(""),
    [advanced, setAdvanced] = useState(false);
  const [sessionDialog, setSessionDialog] = useState<Session | null>(null);
  const [recordDialog, setRecordDialog] = useState<RecordItem | null>(null);
  const [archivedView, setArchivedView] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [archiveUndo, setArchiveUndo] = useState<({ session: Session; record?: never } | { record: RecordItem; session?: never }) & { archived: boolean } | null>(null);
  const [baudRateDialog, setBaudRateDialog] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [fallback, setFallback] = useState<{ source: LogSource } | null>(null),
    [notice, setNotice] = useState(""),
    [includeFull, setIncludeFull] = useState(false),
    [mcu, setMcu] = useState(emptyPreview),
    [android, setAndroid] = useState(emptyPreview),
    [capturePreviews, setCapturePreviews] = useState<Record<string, CapturePreview>>({}),
    [androidPreviewKey, setAndroidPreviewKey] = useState(0),
    [searchPane, setSearchPane] = useState<string | null>(null),
    [saveStatus, setSaveStatus] = useState<"saved" | "pending" | "failed">("saved");
  const lastPane = useRef<LogSource>("mcu");
  const mcuFind = useRef<HTMLButtonElement>(null);
  const androidFind = useRef<HTMLButtonElement>(null);
  const packageInput = useRef<HTMLInputElement>(null);
  const focusPackage = useRef(false);
  const previewLines = useRef(config.previewLines);
  const capturePath = useRef<string | null>(null);
  const startingCapture = useRef(false);
  useEffect(() => {
    const lines = config.previewLines;
    previewLines.current = lines;
    setMcu((value) => trimPreview(value.text, lines, value.truncated));
    setAndroid((value) => trimPreview(value.text, lines, value.truncated));
    setCapturePreviews((items) => Object.fromEntries(Object.entries(items).map(([path, preview]) => [path, {
      mcu: trimPreview(preview.mcu.text, lines, preview.mcu.truncated),
      android: trimPreview(preview.android.text, lines, preview.android.truncated),
    }])));
  }, [config.previewLines]);
  const pending = useRef<({ path: string } & Partial<RecordFields>) | null>(null),
    draft = useRef({ title: "", notes: "" }),
    titleInput = useRef<HTMLInputElement>(null),
    focusTitle = useRef(false),
    selectAll = useRef<HTMLInputElement>(null),
    saving = useRef<Promise<void> | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    viewRef = useRef<RecordItem | null>(null),
    recordsRequest = useRef(0),
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
  useEffect(() => {
    if (!busy && focusPackage.current) {
      focusPackage.current = false;
      packageInput.current?.focus();
    }
  }, [busy]);
  const refreshRecords = async (root = config.outputDir, isCurrent = () => true) => {
    const request = ++recordsRequest.current;
    if (desktop() && root) {
      const items = (await api.ListSessions(root)) || [];
      if (!isCurrent() || request !== recordsRequest.current) return;
      const current = viewRef.current;
      setSessions(items.map((s) => ({ ...s, records: s.records.map((r) =>
        r.path === current?.path && r.path === pending.current?.path
          ? { ...r, title: current.title, notes: current.notes } : r) })));
      const valid = new Set(items.flatMap((s) => s.records.map((r) => r.path)));
      setSelected((s) => new Set([...s].filter((path) =>
        valid.has(path) && path !== stateRef.current.activeRecord?.path,
      )));
      return items;
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
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (saving.current) return saving.current;
    if (!pending.current) return Promise.resolve();
    setSaveStatus("pending");
    saving.current = (async () => {
      // Keep the snapshot available for retry until both writes succeed.
      while (pending.current) {
        const p = pending.current;
        if (p.title !== undefined) await api.SaveTitle(p.path, p.title);
        if (p.notes !== undefined) await api.SaveNotes(p.path, p.notes);
        if (pending.current === p) pending.current = null;
      }
      setSaveStatus("saved");
    })()
      .catch((e) => {
        setSaveStatus("failed");
        throw e;
      })
      .finally(() => { saving.current = null; });
    return saving.current;
  };
  flushRef.current = flush;
  const updateField = (field: keyof RecordFields, text: string) => {
    if (field === "title") setTitle(text);
    else setNotes(text);
    const current = viewRef.current;
    if (!current) {
      draft.current[field] = text;
      return;
    }
    const { path } = current;
    setSessions((items) => items.map((s) => s.records.some((r) => r.path === path)
      ? { ...s, records: s.records.map((r) => r.path === path ? { ...r, [field]: text } : r) }
      : s));
    viewRef.current = { ...current, [field]: text };
    setView(viewRef.current);
    pending.current = { ...pending.current, path, [field]: text };
    setSaveStatus("pending");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      flush().catch((e) => setError(String(e)));
    }, 500);
  };
  useEffect(() => {
    if (!desktop()) return;
    let alive = true;
    // Port enumeration does not depend on settings, history, or ADB.
    api.ListPorts().then((p) => {
      if (alive) setPorts(p || []);
    }).catch(() => {});
    api
      .GetConfig()
      .then(async (c) => {
        if (!alive) return;
        const baudRate = validBaudRate(c.baudRate) ? c.baudRate : defaults.baudRate;
        setConfig({ ...defaults, ...c, baudRate, customBaudRates: customBaudRates([...(c.customBaudRates ?? []), baudRate]) });
        setConfigLoaded(true);
        // Publish each result as it arrives; a slow scan or ADB query must
        // not hold up the other startup tasks.
        await Promise.allSettled([
          refreshRecords(c.outputDir, () => alive).catch((e) => {
            if (alive) setError(String(e));
          }),
          api.ListDevices(c.adbPath).then((d) => {
            if (alive) setDevices(d || []);
          }),
        ]);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    api.GetState().then((s) => {
      if (alive) setState(s);
    }).catch((e) => {
      if (alive) setError(String(e));
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
        if (alive) {
          stateRef.current = s;
          setState(s);
        }
      }),
      off2 = window.runtime?.EventsOn(
        "logs",
        (b: { source: LogSource; text: string; recordPath?: string }) => {
          const lines = previewLines.current;
          const path = b.recordPath;
          if (path) {
            if (!startingCapture.current && capturePath.current !== path) return;
            setCapturePreviews((items) => {
              const preview = items[path] ?? { mcu: emptyPreview, android: emptyPreview };
              const previous = preview[b.source];
              return { ...items, [path]: { ...preview, [b.source]: trimPreview(previous.text + b.text, lines, previous.truncated) } };
            });
            return;
          }
          const update = b.source === "mcu" ? setMcu : setAndroid;
          update((previous) => trimPreview(previous.text + b.text, lines, previous.truncated));
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
  const patch = (v: Partial<Config>) => {
    setFallback(null);
    setConfig((c) => ({ ...c, ...v }));
  };
  const saveBaudRate = async (baudRate: number) => {
    const next = { ...config, baudRate, customBaudRates: customBaudRates([...(config.customBaudRates ?? []), baudRate]) };
    await api.SaveConfig(next);
    patch(next);
  };
  const changeView = async (r: RecordItem) => {
    await flush();
    if (viewRef.current?.path === r.path) r = viewRef.current;
    const logs = await api.ReadRecordLogs(r.path);
    setFullView(null);
    setRecordLogs(logs);
    setOperationsTab("capture");
    setLayout((v) => ({ ...v, right: true }));
    viewRef.current = r;
    setView(r);
    setTitle(r.title);
    setNotes(r.notes);
  };
  const resetView = () => {
    viewRef.current = null;
    setView(null);
    setFullView(null);
    setRecordLogs(null);
    setTitle(draft.current.title);
    setNotes(draft.current.notes);
  };
  const changeFullView = async (session: Session) => {
    await flush();
    const logs = await api.ReadFullLogs(session.path);
    resetView();
    setFullView(session);
    setRecordLogs(logs);
  };
  const prepareCapture = () =>
    run("新建抓取", async () => {
      await flush();
      resetView();
      setLayout((v) => ({ ...v, right: true }));
      setOperationsTab("capture");
      focusTitle.current = true;
    });
  const openFull = (session: Session) => {
    const current = stateRef.current;
    if (current.capturing) return;
    if (current.connected && current.sessionDir === session.path) {
      if (viewRef.current || fullView) return prepareCapture();
      return;
    }
    return run("打开完整日志", () => changeFullView(session));
  };
  const chooseDir = () =>
    run("选择目录", async () => {
      const p = await api.SelectDirectory();
      if (p) {
        await flush();
        const c = { ...config, outputDir: p };
        await api.SaveConfig(c);
        setConfig(c);
        setArchiveUndo(null);
        setArchivedView(false);
        setBatchMode(false);
        setFallback(null);
        resetView();
        setSelected(new Set());
        setSessions([]);
        await refreshRecords(p);
      }
    });
  const refreshDevices = () =>
    run("刷新设备", async () => {
      const results = await Promise.allSettled([
        api.ListPorts().then((p) => setPorts(p || [])),
        api.ListDevices(config.adbPath).then((d) => setDevices(d || [])),
      ]);
      const errors = results.flatMap((result, i) =>
        result.status === "rejected" && (i === 0 || config.androidSerial)
          ? [String(result.reason)] : [],
      );
      if (errors.length) setError(errors.join(" · "));
    });
  const connect = (next = config) =>
    run("连接设备", async () => {
      await flush();
      setFallback(null);
      setMcu(emptyPreview);
      setAndroid(emptyPreview);
      capturePath.current = null;
      setCapturePreviews({});
      try {
        await api.Connect(next);
      } catch (e) {
        if (next.serialPort && next.androidSerial) {
          const message = String(e);
          if (message.includes("Android 连接失败：")) setFallback({ source: "mcu" });
          else if (message.includes("串口连接失败：")) setFallback({ source: "android" });
        }
        throw e;
      }
      setConfig(next);
      setArchivedView(false);
      setSelected(new Set());
      setState(await api.GetState());
      resetView();
      setOperationsTab("capture");
      focusTitle.current = true;
      await refreshRecords(next.outputDir);
    });
  const renameSession = (session: Session, title: string) =>
    run("重命名连接", async () => {
      await api.SaveSessionTitle(session.path, title);
      await refreshRecords();
    });
  const renameRecord = async (record: RecordItem, nextTitle: string) => {
    await flush();
    await api.SaveTitle(record.path, nextTitle);
    if (viewRef.current?.path === record.path) {
      viewRef.current = { ...viewRef.current, title: nextTitle };
      setView(viewRef.current);
      setTitle(nextTitle);
    }
    await refreshRecords();
    setRecordDialog(null);
  };
  const archiveSession = (session: Session, archived: boolean, undo = false) =>
    run(archived ? "归档连接" : "取消归档", async () => {
      await flush();
      await api.SetSessionArchived(session.path, archived);
      setSessions((items) => items.map((s) => s.path === session.path ? { ...s, archived } : s));
      setSelected((items) => new Set([...items].filter((path) => !session.records.some((r) => r.path === path))));
      setArchiveUndo(undo ? null : { session, archived: !archived });
      if (undo) setNotice(archived ? "已归档连接" : "已取消归档");
    });
  const archiveRecord = (record: RecordItem, archived: boolean, undo = false) =>
    run(archived ? "归档记录" : "取消归档", async () => {
      await flush();
      await api.SetRecordArchived(record.path, archived);
      setSessions((items) => items.map((s) => ({ ...s, records: s.records.map((r) => r.path === record.path ? { ...r, archived } : r) })));
      setSelected((items) => new Set([...items].filter((path) => path !== record.path)));
      setArchiveUndo(undo ? null : { record, archived: !archived });
      if (undo) setNotice(archived ? "已归档记录" : "已取消归档");
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
      if (state.config.androidSerial && config.package !== state.config.package)
        await api.SetPackage(config.package);
      setCapturePreviews({});
      startingCapture.current = true;
      let r: RecordItem;
      try {
        r = await api.StartCapture(title, notes);
        capturePath.current = r.path;
        setCapturePreviews((items) => items[r.path] ? { [r.path]: items[r.path] } : {});
      } finally {
        startingCapture.current = false;
      }
      setFullView(null);
      draft.current = { title: "", notes: "" };
      viewRef.current = r;
      setView(r);
      setRecordLogs(null);
      setTitle(r.title);
      setState(await api.GetState());
      await refreshRecords();
    });
  const stop = () =>
    run("停止抓取", async () => {
      await flush();
      const r = await api.StopCapture();
      capturePath.current = null;
      setCapturePreviews({});
      viewRef.current = r;
      setView(r);
      setRecordLogs(null);
      setTitle(r.title);
      setNotes(r.notes);
      setState(await api.GetState());
      await refreshRecords();
      setRecordLogs(await api.ReadRecordLogs(r.path));
    });
  const deleteRecords = (paths: string[]) =>
    run("删除记录", async () => {
      await flush();
      try {
        await api.DeleteRecords(paths);
      } finally {
        // The shell can cancel or delete only part of the selection.
        const items = (await refreshRecords())?.flatMap((s) => s.records);
        const current = viewRef.current;
        if (items && current && paths.includes(current.path) && !items.some((r) => r.path === current.path)) {
          resetView();
        }
        const removed = items ? paths.filter((path) => !items.some((r) => r.path === path)).length : 0;
        if (removed) setNotice(`已删除 ${removed} 条记录`);
      }
    });
  const deleteSession = (path: string, fullOnly: boolean) =>
    run(fullOnly ? "删除完整日志" : "删除连接", async () => {
      await flush();
      try {
        await api.DeleteSessionLogs(path, fullOnly);
      } finally {
        const items = await refreshRecords();
        const remaining = items?.find((s) => s.path === path);
        if (items && (fullOnly ? !remaining?.full : !remaining)) {
          if (fullView?.path === path || (!fullOnly && sessions.find((s) => s.path === path)?.records.some((r) => r.path === viewRef.current?.path))) resetView();
          setNotice(fullOnly ? "已删除完整日志" : "已删除连接");
        }
      }
    });
  const exportRecords = (paths: string[], fullSessions: string[] = [], omitted = 0) =>
    run("正在导出", async () => {
      await flush();
      const p = await api.ExportLogs(paths, fullSessions);
      if (p) setNotice("已导出：" + p + (omitted ? ` · ${omitted} 个连接未附带完整日志` : ""));
    });
  const locked = !!busy,
    live = state.capturing && view?.path === state.activeRecord?.path,
    recordHistory = !!view && !live,
    history = recordHistory || !!fullView;
  const packageLocked = state.capturing || history || locked;
  const foregroundContext = useRef({ config, state, history });
  foregroundContext.current = { config, state, history };
  const baudRates = [...baudRatePresets, ...(config.customBaudRates ?? [])].sort((a, b) => a - b);
  const applyPackage = (pkg: string) => {
    if (!packageLocked && state.connected && pkg !== state.config.package) {
      return run("切换应用", async () => {
        await api.SetPackage(pkg);
        setAndroid(emptyPreview);
        setAndroidPreviewKey((key) => key + 1);
      });
    }
  };
  const getForegroundPackage = () => {
    if (packageLocked) return;
    const before = foregroundContext.current;
    const device = before.state.connected ? before.state.config : before.config;
    if (!device.androidSerial) return;
    return run("获取前台应用", async () => {
      const pkg = await api.ForegroundPackage(device.adbPath, device.androidSerial);
      const current = { ...foregroundContext.current, state: stateRef.current };
      const currentDevice = current.state.connected ? current.state.config : current.config;
      if (current.state.capturing || current.history ||
        current.state.connected !== before.state.connected ||
        current.state.sessionDir !== before.state.sessionDir ||
        currentDevice.androidSerial !== device.androidSerial ||
        currentDevice.adbPath !== device.adbPath) {
        throw new Error("设备或连接状态已变化，请重新获取前台应用");
      }
      if (!pkg) throw new Error("未获取到前台应用，请在设备上打开目标应用后重试");
      if (current.state.connected && pkg !== current.state.config.package) {
        await api.SetPackage(pkg);
        setAndroid(emptyPreview);
        setAndroidPreviewKey((key) => key + 1);
      } else if (!current.state.connected) {
        await api.SaveConfig({ ...current.config, package: pkg });
      }
      patch({ package: pkg });
      setNotice(`已选择前台应用：${pkg}`);
    });
  };
  const savingFullLogs = state.config.saveFullLogs !== false;
  const currentDevices = state.connected ? state.config : config;
  const singleSource = fullView ? fullView.full?.source : recordHistory ? view.source : currentDevices.serialPort
    ? (currentDevices.androidSerial ? undefined : "mcu")
    : (currentDevices.androidSerial ? "android" : undefined);
  const logLayout = singleSource ?? layout.mode;
  const viewPath = fullView?.full?.path ?? view?.path;
  const previewKey = history ? `history:${viewPath}` : live ? `capture:${viewPath}` : `live:${state.sessionDir}`;
  const capturePreview = live && view ? capturePreviews[view.path] : undefined;
  const clearPreview = (source: LogSource) => {
    if (live && view) {
      const path = view.path;
      setCapturePreviews((items) => items[path] ? { ...items, [path]: { ...items[path], [source]: emptyPreview } } : items);
    } else {
      (source === "mcu" ? setMcu : setAndroid)(emptyPreview);
    }
  };
  const mcuKey = `${previewKey}/mcu`;
  const androidKey = `${previewKey}/android/${history ? 0 : androidPreviewKey}`;
  useEffect(() => {
    setSearchPane((pane) => pane === mcuKey || pane === androidKey ? pane : null);
  }, [mcuKey, androidKey]);
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      if (sessionDialog || recordDialog || baudRateDialog || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      const source = logLayout === "mcu" || logLayout === "android" ? logLayout : lastPane.current;
      (source === "mcu" ? mcuFind : androidFind).current?.click();
    };
    window.addEventListener("keydown", find, true);
    return () => window.removeEventListener("keydown", find, true);
  }, [logLayout, sessionDialog, recordDialog, baudRateDialog]);
  const connectionSummary = currentDevices.serialPort && currentDevices.androidSerial
    ? `${currentDevices.serialPort} + ${currentDevices.androidSerial}`
    : currentDevices.serialPort ? `仅串口 · ${currentDevices.serialPort}`
    : currentDevices.androidSerial ? `仅 Android · ${currentDevices.androidSerial}` : "未选择设备";
  const visibleSessions = useMemo(() => sessions.flatMap((s) => {
    if (s.archived) return archivedView ? [s] : [];
    const records = s.records.filter((r) => !!r.archived === archivedView);
    if (archivedView) return records.length ? [{ ...s, records, full: null }] : [];
    return [{ ...s, records }];
  }), [sessions, archivedView]);
  const viewedArchived = sessions.some((s) => (s.archived && s.full?.path === viewPath) || s.records.some((r) => r.path === viewPath && (s.archived || r.archived)));
  const selectable = visibleSessions.flatMap((s) => s.records).filter((r) => r.path !== state.activeRecord?.path);
  const selectedPaths = selectable.filter((r) => selected.has(r.path)).map((r) => r.path);
  const selectedCount = selectedPaths.length;
  const selectedSessions = visibleSessions.filter((s) => s.records.some((r) => selected.has(r.path) && r.path !== state.activeRecord?.path));
  const attachable = selectedSessions.filter((s) => s.full && (!state.connected || state.sessionDir !== s.path));
  const attaching = includeFull && !!attachable.length;
  const omitted = attaching ? selectedSessions.length - attachable.length : 0;
  const allSelected = selectable.length > 0 && selectedCount === selectable.length;
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selectedCount > 0 && !allSelected;
  }, [selectedCount, allSelected, batchMode]);
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
              日志连接 <span>{visibleSessions.length}</span>
            </h2>
          </div>
          <button
            className="icon"
            title="刷新连接"
            disabled={locked}
            onClick={() => run("刷新连接", async () => { await refreshRecords(); })}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        <div className="history-controls">
          <div className="history-tabs" role="group" aria-label="连接范围">
            {[false, true].map((archived) => <button key={String(archived)} type="button"
              aria-pressed={archivedView === archived} disabled={locked}
              onClick={() => { setArchivedView(archived); setSelected(new Set()); }}>
              {archived ? "已归档" : "当前"}
            </button>)}
          </div>
          <button type="button" className="text-button" disabled={locked} aria-pressed={batchMode}
            onClick={() => { setBatchMode(!batchMode); setSelected(new Set()); }}>
            {batchMode ? "完成" : "批量管理"}
          </button>
        </div>
        <div className="history-region">
        <SessionList sessions={visibleSessions} selected={selected} batchMode={batchMode} archived={archivedView}
          viewPath={viewPath} state={state} locked={locked}
          onSelect={(path, checked) => setSelected((s) => {
            const next = new Set(s);
            if (checked) next.add(path);
            else next.delete(path);
            return next;
          })}
          onRecord={(r) => run("打开记录", () => changeView(r))}
          onFull={openFull}
          onExport={exportRecords} onDeleteRecords={deleteRecords} onDeleteSession={deleteSession}
          onRename={setSessionDialog}
          onRenameRecord={setRecordDialog} onArchive={archiveSession} onArchiveRecord={archiveRecord}
          onOpenFolder={(path) => run("打开目录", () => api.OpenFolder(path))} />
        </div>
        {batchMode && <div className="export-panel">
          <div className="batch-options">
            <label>
              <input
                ref={selectAll}
                type="checkbox"
                checked={allSelected}
                disabled={!selectable.length || locked}
                onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((r) => r.path)))}
              />
              全选记录
            </label>
            <label title={!attachable.length ? "所选记录没有可导出的完整日志" : ""}>
              <input
                type="checkbox"
                checked={attaching}
                disabled={!attachable.length || locked}
                onChange={(e) => setIncludeFull(e.target.checked)}
              />
              附带完整日志
            </label>
          </div>
          {!!omitted && <small>{omitted} 个连接的完整日志不可用，不会附带</small>}
          <div className="batch-actions">
          <button
            className="secondary export"
            disabled={
              !selectedCount ||
              locked ||
              state.capturing
            }
            onClick={() => exportRecords(selectedPaths, attaching ? attachable.map((s) => s.path) : [], omitted)}
          >
            <Download size={16} />
            {busy === "正在导出"
              ? "正在导出…"
              : "导出所选" + (selectedCount ? " · " + selectedCount : "")}
          </button>
          <button className="icon delete-records" aria-label="删除所选"
            title={state.capturing ? "请先停止当前抓取" : "删除所选记录，保留完整日志"}
            disabled={!selectedCount || locked || state.capturing} onClick={() => deleteRecords(selectedPaths)}>
            <Trash2 size={15} />
          </button>
          </div>
        </div>}
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
          {!singleSource && <div className="layout-switch" role="group" aria-label="日志布局">
            {(
              [
                ["rows", "上下", Rows2],
                ["columns", "左右", Columns2],
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
          </div>}
          <div className="grow" />
          {history && <div className="history-context">
            <span className="view-kind" title={fullView ? new Date(fullView.startedAt).toLocaleString("zh-CN", { hour12: false }) : displayTitle(view?.title)}>
              {fullView ? "完整日志" : "历史日志"}
            </span>
          </div>}
          {history && <button className="primary return-live" disabled={locked} onClick={prepareCapture}>
            <Undo2 size={15} aria-hidden="true" />返回实时
          </button>}
          {state.capturing && (
            <>
              <span className="recording">
                <i />
                抓取中
              </span>
              <button className="stop compact" disabled={locked} onClick={stop}>
                <Square size={13} />
                停止并保存
              </button>
            </>
          )}
          <button
            className="icon"
            title="打开日志目录"
            aria-label="打开日志目录"
            disabled={!(viewPath || state.sessionDir) || locked}
            onClick={() =>
              run("打开目录", async () => api.OpenFolder(viewPath || state.sessionDir))
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
        <LogSplit mode={logLayout}>
          {singleSource !== "android" && <LogPane
            key={mcuKey}
            source="mcu"
            historical={history}
            preview={history ? recordLogs?.mcu ?? emptyPreview : live ? capturePreview?.mcu ?? emptyPreview : mcu}
            clear={() => clearPreview("mcu")}
            visible={logLayout !== "android"}
            findRef={mcuFind}
            activate={() => { lastPane.current = "mcu"; }}
            searchOpen={searchPane === mcuKey}
            setSearchOpen={(open) => setSearchPane(open ? mcuKey : null)}
          />}
          {singleSource !== "mcu" && <LogPane
            key={androidKey}
            source="android"
            historical={history}
            preview={history ? recordLogs?.android ?? emptyPreview : live ? capturePreview?.android ?? emptyPreview : android}
            clear={() => clearPreview("android")}
            visible={logLayout !== "mcu"}
            findRef={androidFind}
            activate={() => { lastPane.current = "android"; }}
            searchOpen={searchPane === androidKey}
            setSearchOpen={(open) => setSearchPane(open ? androidKey : null)}
          />}
        </LogSplit>
        <footer className="statusbar">
          <span>
            <i className={state.connected ? "online-dot" : "offline-dot"} />
            {busy || (state.connected
              ? (savingFullLogs ? "已连接 · 全量记录中" : "已连接 · 未保存完整日志")
              : "未连接")}
          </span>
          <span className="live-label">{fullView ? "完整日志" : history ? "历史日志" : live ? "抓取预览" : "实时日志"}</span>
          <div className="grow" />
          <span className="mono">
            {singleSource !== "android" && <>MCU {size(history ? recordLogs?.mcu.bytes || 0 : state.mcuBytes)}</>}
            {!singleSource && <span className="divider">/</span>}
            {singleSource !== "mcu" && <>Android {size(history ? recordLogs?.android.bytes || 0 : state.androidBytes)}</>}
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
          {!state.capturing && <div className="new-capture-bar">
            <button type="button" className="secondary" disabled={locked} onClick={prepareCapture}>
              <Plus size={16} />新建抓取
            </button>
            {viewedArchived && <small>已归档</small>}
          </div>}
          {fullView ? <section className="capture-card">
            <div className="capture-heading"><span className="eyebrow">完整日志</span></div>
          </section> : <>
          <section className="capture-card">
            <div className="capture-heading">
              <span className="eyebrow">
                {live
                  ? "抓取中"
                  : recordHistory
                    ? view.interrupted
                      ? "已中断"
                      : "已保存"
                    : "新建抓取 · 待开始"}
              </span>
              {recordHistory && <div className="capture-heading-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={locked}
                  onClick={() => setRecordDialog(view)}
                >
                  重命名
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    run("打开目录", async () => api.OpenFolder(view.path))
                  }
                >
                  <FolderOpen size={14} />
                  打开目录
                </button>
              </div>}
            </div>
            <div className="capture-controls">
              {recordHistory ? <div className="saved-record-title">
                <strong title={title} onDoubleClick={() => { if (!locked) setRecordDialog(view); }}>{displayTitle(title)}</strong>
              </div> : <input
                ref={titleInput}
                className="title-input"
                placeholder={view ? "未命名" : "标题（选填）"}
                aria-label="抓取标题"
                value={title}
                disabled={locked}
                onChange={(e) => updateField("title", e.target.value)}
                onBlur={() => flush().catch((e) => setError(String(e)))}
              />}
              {!state.capturing && !history && (
                <button
                  className="primary start"
                  disabled={!state.connected || locked}
                  onClick={start}
                >
                  <Play size={16} fill="currentColor" />
                  开始抓取
                </button>
              )}
            </div>
            {(recordHistory ? view.source !== "mcu" : !!currentDevices.androidSerial) && <div className="app-select">
              <label htmlFor="package">Android 应用</label>
              <div
                className="package-field"
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget) &&
                    !(e.relatedTarget instanceof HTMLElement && e.relatedTarget.dataset.foreground)) applyPackage(config.package);
                }}
              >
                <input
                  ref={packageInput}
                  id="package"
                  list="packages"
                  placeholder="全部应用 / 包名"
                  value={recordHistory ? view.package : config.package}
                  disabled={packageLocked}
                  onChange={(e) => patch({ package: e.target.value })}
                />
                {!packageLocked && config.package && (
                  <button
                    type="button"
                    className="icon package-clear"
                    title="清空 Android 应用"
                    aria-label="清空 Android 应用"
                    onClick={() => {
                      patch({ package: "" });
                      if (applyPackage("")) focusPackage.current = true;
                      else packageInput.current?.focus();
                    }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <datalist id="packages">
                {packages.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
              <button
                type="button"
                className="text-button"
                title="获取前台应用"
                aria-label="获取前台应用"
                data-foreground="true"
                aria-busy={busy === "获取前台应用"}
                disabled={!currentDevices.androidSerial || packageLocked}
                onMouseDown={(e) => e.preventDefault()}
                onClick={getForegroundPackage}
              >
                <Crosshair size={14} />
                获取前台应用
              </button>
              <button
                className="text-button"
                title="加载应用"
                aria-label="加载应用"
                disabled={!config.androidSerial || packageLocked}
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
            </div>}
          </section>
          <section className="notes-card">
            <header>
              <FileText size={16} />
              <strong>备注</strong>

              <div className="grow" />
              {(view || state.capturing) && (
                <small className={saveStatus === "saved" ? "save-ok" : "save-pending"}>
                  {saveStatus === "saved" ? (
                    <>
                      <Check size={13} />
                      已保存
                    </>
                  ) : (
                    saveStatus === "failed" ? "未保存" : "保存中…"
                  )}
                </small>
              )}
            </header>
            <textarea
              disabled={locked}
              value={notes}
              placeholder="输入备注"
              onChange={(e) => updateField("notes", e.target.value)}
              onBlur={() => flush().catch((e) => setError(String(e)))}
            />
          </section>
          </>}
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
              <span title={connectionSummary}>{connectionSummary}</span>
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
                    <option value="">不连接串口</option>
                    {config.serialPort && !ports.some((p) => p.name === config.serialPort) && (
                      <option value={config.serialPort}>{config.serialPort} · 未发现</option>
                    )}
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
                  <select
                    value={config.baudRate}
                    disabled={!configLoaded || !config.serialPort || state.connected || locked}
                    onChange={(e) => {
                      if (e.target.value === "add") setBaudRateDialog(true);
                      else patch({ baudRate: Number(e.target.value) });
                    }}
                  >
                    {baudRates.map((rate) => <option key={rate} value={rate}>{rate}</option>)}
                    <option value="add">新增波特率…</option>
                  </select>
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
                    <option value="">不连接 Android</option>
                    {config.androidSerial && !devices.some((d) => d.serial === config.androidSerial) && (
                      <option value={config.androidSerial}>{config.androidSerial} · 未发现</option>
                    )}
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
                        (!config.serialPort && !config.androidSerial)))
                  }
                  onClick={state.connected ? disconnect : () => connect()}
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
                  <label className="check-label full-logs-setting" title="关闭后，只有手动抓取的日志会保存">
                    <input
                      type="checkbox"
                      checked={config.saveFullLogs}
                      disabled={state.connected || locked}
                      onChange={(e) => {
                        const next = { ...config, saveFullLogs: e.target.checked };
                        run("保存设置", async () => {
                          await api.SaveConfig(next);
                          setConfig(next);
                        });
                      }}
                    />
                    保存完整日志
                  </label>
                  <label className="preview-lines-setting">
                    预览行数
                    <select value={config.previewLines} disabled={locked} onChange={(e) => {
                      const next = { ...config, previewLines: Number(e.target.value) };
                      run("保存设置", async () => {
                        await api.SaveConfig(next);
                        setConfig(next);
                      });
                    }}>
                      {[1000, 2000, 5000, 10000].map((lines) => <option key={lines} value={lines}>{lines} 行</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>
          </section>
        </div>
      </aside>
      <section className="notifications" aria-label="通知">
        {(error || state.error) && <Notification key={`error:${error || state.error}`} kind="error" message={error || state.error}
          onClose={() => setError("")}>
          {error && fallback && !state.connected && <button className="secondary connection-fallback" disabled={locked}
            onClick={() => connect(fallback.source === "mcu" ? { ...config, androidSerial: "" } : { ...config, serialPort: "" })}>
            {fallback.source === "mcu" ? "仅连接串口" : "仅连接 Android"}
          </button>}
        </Notification>}
        {state.filterWarning && <Notification key="filter-warning" kind="warning"
          message={`应用过滤暂不可用，正在重试。${savingFullLogs ? "完整 Android 日志继续保存。" : ""}`}
          details={state.filterWarning} />}
        {notice && <Notification key={`notice:${notice}`} kind="success" message={notice} duration={3000}
          onClose={() => setNotice("")} />}
        {archiveUndo && <Notification key={`archive:${archiveUndo.record?.path ?? archiveUndo.session?.path}:${archiveUndo.archived}`}
          kind="success" message={archiveUndo.archived ? "已取消归档" : archiveUndo.record ? "已归档记录" : "已归档连接"}
          duration={8000} onClose={() => setArchiveUndo(null)}>
          <button type="button" className="text-button" disabled={locked}
            onClick={() => archiveUndo.record ? archiveRecord(archiveUndo.record, archiveUndo.archived, true)
              : archiveSession(archiveUndo.session, archiveUndo.archived, true)}>撤销</button>
        </Notification>}
      </section>
      {baudRateDialog && <BaudRateDialog onCancel={() => setBaudRateDialog(false)} onSave={saveBaudRate} />}
      {sessionDialog && <SessionDialog renaming={sessionDialog}
        onCancel={() => setSessionDialog(null)}
        onSubmit={(title) => { const session = sessionDialog; setSessionDialog(null); void renameSession(session, title); }} />}
      {recordDialog && <SessionDialog renaming={recordDialog} kind="record"
        onCancel={() => setRecordDialog(null)} onSubmit={(title) => renameRecord(recordDialog, title)} />}
    </div>
  );
}
