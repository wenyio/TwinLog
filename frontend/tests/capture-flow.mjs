import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
const url = "http://127.0.0.1:5183";
const server = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    "5183",
    "--strictPort",
  ],
  { stdio: "pipe" },
);
let output = "",
  browser;
server.stdout.on("data", (b) => (output += b));
server.stderr.on("data", (b) => (output += b));
try {
  for (let i = 0; ; i++) {
    if (server.exitCode !== null) throw Error(output);
    try {
      if ((await fetch(url)).ok) break;
    } catch {}
    if (i === 100) throw Error(output);
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    headless: true,
    channel: process.platform === "win32" ? "msedge" : undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1080, height: 640 },
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      "twinlog.layout",
      JSON.stringify({ left: true, right: false, mode: "columns" }),
    );
    const config = {
      outputDir: "test",
      adbPath: "adb",
      serialPort: "COM1",
      androidSerial: "test",
      package: "",
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      dtr: false,
      rts: false,
    };
    const records = [
      {
        path: "test/old",
        title: "旧记录",
        notes: "原备注",
        package: "",
        startedAt: "2026-11-17T01:00:00Z",
        endedAt: "2026-11-17T01:01:00Z",
      },
    ];
    const state = {
      connected: false,
      capturing: false,
      sessionDir: "test",
      activeRecord: null,
      config,
      error: "",
      mcuBytes: 0,
      androidBytes: 0,
    };
    const handlers = {};
    const emit = (name) =>
      handlers[name]?.forEach((fn) => fn(structuredClone(state)));
    window.calls = {
      start: 0,
      stop: 0,
      saves: [],
      failConnect: false,
      failStart: false,
      failSave: false,
      failRead: false,
      deleteApproved: false,
      deleted: [],
    };
    window.go = {
      main: {
        App: {
          GetConfig: async () => config,
          GetState: async () => structuredClone(state),
          ListRecords: async () => structuredClone(records),
          ReadRecordLogs: async (path) => {
            if (window.calls.failRead) throw Error("模拟日志读取失败");
            return {
              mcu: { text: path + " MCU 历史内容\n", bytes: 600000, truncated: true },
              android: { text: path + " Android 历史内容\n", bytes: 90, truncated: false },
            };
          },
          DeleteRecords: async (paths) => {
            if (!window.calls.deleteApproved) return "";
            window.calls.deleted.push(...paths);
            for (let i = records.length - 1; i >= 0; i--) {
              if (paths.includes(records[i].path)) records.splice(i, 1);
            }
            return "test/.twinlog-trash/batch";
          },
          ListPorts: async () => [],
          ListDevices: async () => [],
          Connect: async () => {
            if (window.calls.failConnect) throw Error("模拟连接失败");
            state.connected = true;
            emit("state");
          },
          Disconnect: async () => {
            state.connected = false;
            emit("state");
          },
          SetPackage: async () => {},
          StartCapture: async (title, notes) => {
            window.calls.start++;
            if (window.calls.failStart) throw Error("模拟开始失败");
            const r = {
              path: "test/new",
              title,
              notes,
              package: "",
              startedAt: "2026-11-17T02:00:00Z",
              endedAt: "",
            };
            records.unshift(r);
            state.activeRecord = r;
            state.capturing = true;
            emit("state");
            return structuredClone(r);
          },
          StopCapture: async () => {
            window.calls.stop++;
            state.activeRecord.endedAt = "2026-11-17T02:01:00Z";
            const r = structuredClone(state.activeRecord);
            state.activeRecord = null;
            state.capturing = false;
            emit("state");
            return r;
          },
          SaveNotes: async (path, notes) => {
            if (window.calls.failSave) throw Error("模拟备注失败");
            window.calls.saves.push({ path, notes });
            records.find((r) => r.path === path).notes = notes;
          },
        },
      },
    };
    window.runtime = {
      EventsOn: (name, fn) => {
        (handlers[name] ??= new Set()).add(fn);
        return () => handlers[name].delete(fn);
      },
    };
    window.sendLogs = () =>
      handlers.logs?.forEach((fn) => {
        fn({ source: "mcu", text: "MCU 保留日志\n" });
        fn({ source: "android", text: "Android 保留日志\n" });
      });
  });
  await page.goto(url);
  const capture = page.getByRole("tabpanel", { name: "抓取", exact: true });
  const title = page.getByRole("textbox", { name: "抓取标题", exact: true });
  const notes = page.getByPlaceholder("输入备注", { exact: true });
  const newCapture = () =>
    page
      .locator(".sidebar")
      .getByRole("button", { name: "新建抓取", exact: true });
  await newCapture().click();
  const connection = page.getByRole("tabpanel", {
    name: "设备连接",
    exact: true,
  });
  assert.ok(await connection.isVisible());
  assert.equal(await capture.isVisible(), false);
  await page.evaluate(() => (window.calls.failConnect = true));
  await connection
    .getByRole("button", { name: "连接设备", exact: true })
    .click();
  await page.getByText("Error: 模拟连接失败", { exact: true }).waitFor();
  assert.ok(await connection.isVisible());
  assert.equal(await page.evaluate(() => window.calls.start), 0);
  await page.evaluate(() => (window.calls.failConnect = false));
  await connection
    .getByRole("button", { name: "连接设备", exact: true })
    .click();
  await title.waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "抓取标题",
  );
  assert.ok(await capture.getByText("待开始", { exact: true }).isVisible());
  assert.ok(
    await capture
      .getByRole("button", { name: "开始抓取", exact: true })
      .isDisabled(),
  );
  await title.fill("未开始草稿");
  await notes.fill("草稿备注");
  await page.evaluate(() => window.sendLogs());
  await newCapture().click();
  assert.equal(await title.inputValue(), "未开始草稿");
  assert.equal(await notes.inputValue(), "草稿备注");
  assert.equal(await page.evaluate(() => window.calls.start), 0);
  await page.getByRole("tab", { name: "设备连接", exact: true }).click();
  await page.getByRole("button", { name: "断开连接", exact: true }).click();
  await page.getByRole("button", { name: "收起操作栏", exact: true }).click();
  await newCapture().click();
  assert.ok(await connection.isVisible());
  assert.equal(await capture.isVisible(), false);
  await connection
    .getByRole("button", { name: "连接设备", exact: true })
    .click();
  await title.waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "抓取标题",
  );
  assert.equal(await title.inputValue(), "未开始草稿");
  assert.equal(await notes.inputValue(), "草稿备注");
  await page.locator(".history-row button").first().click();
  assert.equal(await title.inputValue(), "旧记录");
  await page.getByText("test/old MCU 历史内容", { exact: false }).waitFor();
  assert.ok(await page.getByText("test/old Android 历史内容", { exact: false }).isVisible());
  assert.ok(await page.getByText("仅预览末尾最多 2000 行 / 256 KB，全文请打开记录目录", { exact: true }).isVisible());
  await page.evaluate(() => window.sendLogs());
  assert.ok(!(await page.locator(".log-pane pre").first().textContent()).includes("MCU 保留日志"));
  assert.equal(
    await capture
      .getByRole("button", { name: "开始抓取", exact: true })
      .count(),
    0,
  );
  await notes.fill("历史补充备注");
  await capture.getByRole("button", { name: "新建抓取", exact: true }).click();
  assert.equal(await title.inputValue(), "未开始草稿");
  assert.equal(await notes.inputValue(), "草稿备注");
  assert.deepEqual(await page.evaluate(() => window.calls.saves), [
    { path: "test/old", notes: "历史补充备注" },
  ]);
  await page.evaluate(() => (window.calls.failStart = true));
  await capture.getByRole("button", { name: "开始抓取", exact: true }).click();
  await page.getByText("Error: 模拟开始失败", { exact: true }).waitFor();
  assert.equal(await title.inputValue(), "未开始草稿");
  await page.locator(".history-row button").first().click();
  await newCapture().click();
  assert.equal(await notes.inputValue(), "草稿备注");
  await page.evaluate(() => (window.calls.failStart = false));
  await capture.getByRole("button", { name: "开始抓取", exact: true }).click();
  await capture.getByText("抓取中", { exact: true }).waitFor();
  assert.ok(await title.isDisabled());
  assert.ok(await newCapture().isDisabled());
  assert.ok(await page.getByRole("checkbox", { name: "选择 未开始草稿", exact: true }).isDisabled());
  await page.getByRole("checkbox", { name: "全选记录", exact: true }).check();
  assert.equal(await page.locator('.history-row input:checked').count(), 1);
  assert.ok(await page.getByRole("button", { name: "删除所选", exact: true }).isDisabled());
  assert.equal(
    await page.locator(".history-row.active strong").textContent(),
    "未开始草稿",
  );
  await notes.fill("抓取中补充");
  await page.getByRole("button", { name: "收起操作栏", exact: true }).click();
  await page
    .locator(".workspace-toolbar")
    .getByRole("button", { name: "停止并保存", exact: true })
    .click();
  await page.getByRole("button", { name: "展开操作栏", exact: true }).click();
  await capture.getByText("已保存", { exact: true }).first().waitFor();
  assert.equal(await notes.inputValue(), "抓取中补充");
  await notes.fill("停止后补充");
  await capture.getByRole("button", { name: "新建抓取", exact: true }).click();
  assert.equal(await title.inputValue(), "");
  assert.equal(await notes.inputValue(), "");
  assert.ok(
    (await page.locator(".log-pane pre").nth(0).textContent()).includes(
      "MCU 保留日志",
    ),
  );
  assert.ok(
    (await page.locator(".log-pane pre").nth(1).textContent()).includes(
      "Android 保留日志",
    ),
  );
  assert.ok(
    (await page.evaluate(() => window.calls.saves)).some(
      (v) => v.path === "test/new" && v.notes === "停止后补充",
    ),
  );
  // A failed note save must keep the selected record and allow a retry before switching.
  await page.locator(".history-row button").first().click();
  await page.evaluate(() => (window.calls.failSave = true));
  await notes.fill("失败后重试备注");
  await newCapture().click();
  await page.getByText("Error: 模拟备注失败", { exact: true }).waitFor();
  assert.equal(await title.inputValue(), "未开始草稿");
  assert.equal(await notes.inputValue(), "失败后重试备注");
  await page.evaluate(() => (window.calls.failSave = false));
  await newCapture().click();
  await title.waitFor({ state: "visible" });
  assert.equal(await title.inputValue(), "");
  assert.equal(await page.evaluate(() => window.calls.stop), 1);
  assert.ok(
    (await page.evaluate(() => window.calls.saves)).some(
      (v) => v.notes === "失败后重试备注",
    ),
  );
  // Read failures leave the current view intact; retry switches both log panes.
  await page.evaluate(() => (window.calls.failRead = true));
  await page.locator(".history-row button").first().click();
  await page.getByText("Error: 模拟日志读取失败", { exact: true }).waitFor();
  assert.equal(await title.inputValue(), "");
  await page.evaluate(() => (window.calls.failRead = false));
  await page.locator(".history-row button").first().click();
  await page.getByText("test/new MCU 历史内容", { exact: false }).waitFor();
  await page.getByRole("button", { name: "返回实时", exact: true }).click();
  await page.getByText("MCU 保留日志", { exact: false }).first().waitFor();
  await page.locator(".history-row button").first().click();
  const selectAll = page.getByRole("checkbox", { name: "全选记录", exact: true });
  assert.equal(await selectAll.evaluate((el) => el.indeterminate), true);
  await selectAll.check();
  assert.equal(await page.locator('.history-row input:checked').count(), 2);
  if (process.env.TWINLOG_SCREENSHOT) {
    await page.screenshot({ path: process.env.TWINLOG_SCREENSHOT });
  }
  await selectAll.uncheck();
  assert.equal(await page.locator('.history-row input:checked').count(), 0);
  await page.getByRole("checkbox", { name: "选择 未开始草稿", exact: true }).check();
  await page.getByRole("button", { name: "删除所选", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.delete-records').disabled);
  assert.equal(await page.locator('.history-row').count(), 2);
  assert.equal(await title.inputValue(), "未开始草稿");
  await notes.fill("删除前备注");
  await page.evaluate(() => (window.calls.deleteApproved = true));
  await page.getByRole("button", { name: "删除所选", exact: true }).click();
  await page.getByText("已将 1 条记录移入回收目录：test/.twinlog-trash/batch", { exact: true }).waitFor();
  assert.equal(await page.locator('.history-row').count(), 1);
  assert.equal(await title.inputValue(), "");
  assert.deepEqual(await page.evaluate(() => window.calls.deleted), ["test/new"]);
  assert.ok((await page.evaluate(() => window.calls.saves)).some((v) => v.notes === "删除前备注"));
  assert.ok(await page.getByRole("button", { name: "删除所选", exact: true }).isDisabled());
  await selectAll.check();
  await page.getByRole("button", { name: "删除所选", exact: true }).click();
  await page.getByText("还没有抓取记录", { exact: true }).waitFor();
  assert.ok(await selectAll.isDisabled());
  assert.equal(await selectAll.isChecked(), false);
  console.log(
    "PASS: capture flow, drafts, notes retry, history log switching/read failure, live isolation, return to live, selection/indeterminate/select all, active capture protection, delete cancellation, save before delete, selected view cleanup and empty list",
  );
} finally {
  await browser?.close();
  server.kill();
}
