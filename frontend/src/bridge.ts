export interface Config {
  outputDir: string;
  adbPath: string;
  serialPort: string;
  androidSerial: string;
  package: string;
  baudRate: number;
  customBaudRates?: number[];
  dataBits: number;
  stopBits: number;
  parity: string;
  dtr: boolean;
  rts: boolean;
  saveFullLogs: boolean;
  previewLines: number;
}
export type LogSource = "mcu" | "android";
export type RecordResult = "" | "PASS" | "FAIL";

export interface RecordItem {
  path: string;
  title: string;
  notes: string;
  startedAt: string;
  endedAt: string;
  package: string;
  source?: LogSource;
  interrupted: boolean;
  filterGaps?: boolean;
  archived?: boolean;
  result?: RecordResult;
}
export interface Attachment { name: string; bytes: number; }
export interface AttachmentProgress { path: string; name: string; copied: number; total: number; }
export interface State {
  connected: boolean;
  capturing: boolean;
  sessionDir: string;
  activeRecord: RecordItem | null;
  config: Config;
  error: string;
  filterStatus?: string;
  filterWarning?: string;
  filterFailureAt?: string;
  filterRecoveredAt?: string;
  mcuBytes: number;
  androidBytes: number;
}
export interface FullLog {
  path: string;
  source?: LogSource;
  bytes: number;
}
export interface Session {
  path: string;
  startedAt: string;
  title?: string;
  archived?: boolean;
  managed: boolean;
  records: RecordItem[];
  full: FullLog | null;
}
export interface LogPreview {
  text: string;
  bytes: number;
  truncated: boolean;
}
export interface RecordLogs {
  mcu: LogPreview;
  android: LogPreview;
}
export interface Port {
  name: string;
  description: string;
}
export interface Device {
  serial: string;
  state: string;
  model: string;
}
export const defaults: Config = {
  outputDir: "",
  adbPath: "adb",
  serialPort: "",
  androidSerial: "",
  package: "",
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  dtr: false,
  rts: false,
  saveFullLogs: true,
  previewLines: 2000,
};
type Backend = {
  ListAttachments(path: string): Promise<Attachment[]>;
  ImportAttachmentFiles(path: string): Promise<Attachment[]>;
  PasteAttachments(path: string): Promise<Attachment[]>;
  ClipboardAttachmentKind(): Promise<string>;
  CancelAttachmentImport(): Promise<void>;
  RenameAttachment(path: string, name: string, base: string): Promise<void>;
  RemoveAttachment(path: string, name: string): Promise<void>;
  OpenAttachment(path: string, name: string, reveal: boolean): Promise<void>;
  SetCompactWindow(compact: boolean, width: number, height: number, pinned: boolean): Promise<void>;
  ConfirmClose(ok: boolean): Promise<void>;
  GetConfig(): Promise<Config>;
  SaveConfig(c: Config): Promise<void>;
  GetState(): Promise<State>;
  ListPorts(): Promise<Port[]>;
  ListDevices(adb: string): Promise<Device[]>;
  ListPackages(adb: string, serial: string): Promise<string[]>;
  ForegroundPackage(adb: string, serial: string): Promise<string>;
  SelectDirectory(): Promise<string>;
  SelectADB(): Promise<string>;
  Connect(c: Config): Promise<void>;
  Disconnect(): Promise<void>;
  SetPackage(pkg: string): Promise<void>;
  StartCapture(title: string, notes: string): Promise<RecordItem>;
  StopCapture(): Promise<RecordItem>;
  SaveNotes(path: string, notes: string): Promise<void>;
  SaveTitle(path: string, title: string): Promise<void>;
  SaveResult(path: string, result: RecordResult): Promise<void>;
  ListSessions(root: string): Promise<Session[]>;
  SaveSessionTitle(path: string, title: string): Promise<void>;
  SetSessionArchived(path: string, archived: boolean): Promise<void>;
  SetRecordArchived(path: string, archived: boolean): Promise<void>;
  ReadRecordLogs(path: string): Promise<RecordLogs>;
  ReadFullLogs(session: string): Promise<RecordLogs>;
  DeleteRecords(paths: string[]): Promise<void>;
  DeleteSessionLogs(path: string, fullOnly: boolean): Promise<void>;
  ExportLogs(paths: string[], fullSessions: string[]): Promise<string>;
  ExportSession(path: string): Promise<string>;
  OpenFolder(path: string): Promise<void>;
};
declare global {
  interface Window {
    go?: { main: { App: Backend } };
    runtime?: {
      EventsOn(name: string, fn: (payload: any) => void): () => void;
      WindowSetAlwaysOnTop?(value: boolean): void;
      WindowGetSize?(): Promise<{ w: number; h: number }>;
      WindowGetPosition?(): Promise<{ x: number; y: number }>;
      WindowIsMaximised?(): Promise<boolean>;
      WindowSetSize?(width: number, height: number): void;
      WindowSetMinSize?(width: number, height: number): void;
      WindowSetPosition?(x: number, y: number): void;
      WindowMaximise?(): void;
      WindowUnmaximise?(): void;
      WindowToggleMaximise?(): void;
      WindowMinimise?(): void;
      Quit?(): void;
    };
  }
}
export const desktop = () => !!window.go?.main?.App;
export const api = new Proxy({} as Backend, {
  get:
    (_, key) =>
    (...args: unknown[]) => {
      const app = window.go?.main?.App;
      if (!app)
        return Promise.reject(new Error("请运行 TwinLog 桌面程序以连接设备。"));
      return (
        app[key as keyof Backend] as (...args: unknown[]) => Promise<unknown>
      )(...args);
    },
});
