export interface Config {
  outputDir: string;
  adbPath: string;
  serialPort: string;
  androidSerial: string;
  package: string;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: string;
  dtr: boolean;
  rts: boolean;
  saveFullLogs: boolean;
  previewLines: number;
}
export type LogSource = "mcu" | "android";

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
}
export interface State {
  connected: boolean;
  capturing: boolean;
  sessionDir: string;
  activeRecord: RecordItem | null;
  config: Config;
  error: string;
  filterStatus?: string;
  filterWarning?: string;
  mcuBytes: number;
  androidBytes: number;
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
  ConfirmClose(ok: boolean): Promise<void>;
  GetConfig(): Promise<Config>;
  SaveConfig(c: Config): Promise<void>;
  GetState(): Promise<State>;
  ListPorts(): Promise<Port[]>;
  ListDevices(adb: string): Promise<Device[]>;
  ListPackages(adb: string, serial: string): Promise<string[]>;
  SelectDirectory(): Promise<string>;
  SelectADB(): Promise<string>;
  Connect(c: Config): Promise<void>;
  Disconnect(): Promise<void>;
  SetPackage(pkg: string): Promise<void>;
  StartCapture(title: string, notes: string): Promise<RecordItem>;
  StopCapture(): Promise<RecordItem>;
  SaveNotes(path: string, notes: string): Promise<void>;
  SaveTitle(path: string, title: string): Promise<void>;
  ListRecords(root: string): Promise<RecordItem[]>;
  ReadRecordLogs(path: string): Promise<RecordLogs>;
  DeleteRecords(paths: string[]): Promise<void>;
  ExportRecords(paths: string[], full: boolean): Promise<string>;
  OpenFolder(path: string): Promise<void>;
};
declare global {
  interface Window {
    go?: { main: { App: Backend } };
    runtime?: {
      EventsOn(name: string, fn: (payload: any) => void): () => void;
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
