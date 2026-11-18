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
      titleSaves: [],
      closeAcks: [],
      exported: [],
      failConnect: false,
      failStart: false,
      failSave: false,
      failTitleSave: false,
      failRead: false,
      deleteApproved: false,
      deleted: [],
      configSaves: [],
      connectConfigs: [],
    };
    window.go = {
      main: {
        App: {
          GetConfig: async () => config,
          SaveConfig: async (next) => {
            window.calls.configSaves.push(structuredClone(next));
            Object.assign(config, next);
          },
          GetState: async () => structuredClone(state),
          ListRecords: async () => structuredClone(records),
          ReadRecordLogs: async (path) => {
            if (window.calls.failRead) throw Error("模拟日志读取失败");
            const source = records.find((r) => r.path === path)?.source;
            return {
              mcu: source === "android" ? { text: "", bytes: 0, truncated: false }
                : { text: path + " MCU 历史内容\n", bytes: path === "test/old" ? 600000 : 90, truncated: path === "test/old" },
              android: source === "mcu" ? { text: "", bytes: 0, truncated: false }
                : { text: path + " Android 历史内容\n", bytes: 90, truncated: false },
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
          ListPorts: async () => [{ name: "COM1", description: "" }],
          ListDevices: async () => [{ serial: "test", state: "device", model: "Test Android" }],
          Connect: async (next) => {
            if (window.calls.failConnect) throw Error("模拟连接失败");
            window.calls.connectConfigs.push(structuredClone(next));
            if (window.calls.androidUnavailable && next.androidSerial) throw Error("Android 连接失败：设备离线");
            state.config = next;
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
              title: title.trim(),
              notes,
              package: "",
              source: state.config.serialPort ? (state.config.androidSerial ? undefined : "mcu") : "android",
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
          SaveTitle: async (path, text) => {
            if (window.calls.failTitleSave) throw Error("模拟标题保存失败");
            if (window.holdTitleSave) await window.holdTitleSave;
            const title = text.trim();
            window.calls.titleSaves.push({ path, title });
            records.find((r) => r.path === path).title = title;
          },
          ExportRecords: async (paths) => {
            window.calls.exported.push(structuredClone(records.filter((r) => paths.includes(r.path))));
            return "test/export.zip";
          },
          ConfirmClose: async (ok) => {
            window.calls.closeAcks.push({ ok, title: records.find((r) => r.path === "test/new")?.title });
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
    window.requestClose = () => emit("before-close");
  });
  await page.goto(url);
  const capture = page.getByRole("tabpanel", { name: "抓取", exact: true });
  const title = page.getByRole("textbox", { name: "抓取标题", exact: true });
  const notes = page.getByPlaceholder("输入备注", { exact: true });
  const newCapture = capture.getByRole("button", { name: "新建抓取", exact: true });
  const connection = page.getByRole("tabpanel", {
    name: "设备连接",
    exact: true,
  });
  await page.getByRole("button", { name: "展开操作栏", exact: true }).click();
  await connection.waitFor();
  assert.equal(await capture.isVisible(), false);
  await connection.getByRole("button", { name: "更多设置" }).click();
  const fullLogs = connection.getByRole("checkbox", { name: "保存完整日志" });
  assert.equal(await fullLogs.isChecked(), true, "legacy settings must default to enabled");
  await fullLogs.uncheck();
  await page.waitForFunction(() => window.calls.configSaves.at(-1)?.saveFullLogs === false);
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
  await page.getByText("已连接 · 未保存完整日志", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.connectConfigs.at(-1).saveFullLogs), false);
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "抓取标题",
  );
  assert.ok(await capture.getByText("待开始", { exact: true }).isVisible());
  assert.ok(
    await capture
      .getByRole("button", { name: "开始抓取", exact: true })
      .isEnabled(),
  );
  await title.fill("未开始草稿");
  await notes.fill("草稿备注");
  await page.evaluate(() => window.sendLogs());
  assert.equal(await newCapture.count(), 0);
  assert.equal(await page.evaluate(() => window.calls.start), 0);
  await page.getByRole("tab", { name: "设备连接", exact: true }).click();
  assert.equal(await fullLogs.isChecked(), false);
  assert.ok(await fullLogs.isDisabled());
  await page.getByRole("button", { name: "断开连接", exact: true }).click();
  await fullLogs.check();
  await page.waitForFunction(() => window.calls.configSaves.at(-1)?.saveFullLogs === true);
  await page.locator(".history-row button").first().click();
  await newCapture.click();
  assert.ok(await connection.isVisible());
  assert.equal(await capture.isVisible(), false);
  await connection
    .getByRole("button", { name: "连接设备", exact: true })
    .click();
  await title.waitFor();
  await page.getByText("已连接 · 全量记录中", { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "抓取标题",
  );
  assert.equal(await title.inputValue(), "未开始草稿");
  assert.equal(await notes.inputValue(), "草稿备注");
  await page.locator(".history-row button").first().click();
  assert.equal(await title.inputValue(), "旧记录");
  await page.getByText("test/old MCU 历史内容", { exact: false }).waitFor();
  assert.ok(await page.getByText("test/old Android 历史内容", { exact: false }).isVisible());
  const historyBanner = page.locator(".history-banner");
  const returnToLive = historyBanner.getByRole("button", { name: "返回实时", exact: true });
  const assertReturnCentered = async () => {
    const banner = await historyBanner.boundingBox();
    const button = await returnToLive.boundingBox();
    assert.ok(banner && button);
    assert.ok(Math.abs((button.y - banner.y) - (banner.height - button.height) / 2) <= 1);
  };
  assert.equal(await historyBanner.locator("small").textContent(), "仅预览日志末尾，全文请打开记录目录");
  const historyPanes = page.locator(".log-pane");
  assert.equal(await historyPanes.getByRole("button", { name: "清空预览" }).count(), 0);
  await historyPanes.nth(1).locator("pre").focus();
  await page.keyboard.press("Control+f");
  const historySearch = historyPanes.nth(1).getByRole("textbox", { name: "搜索当前预览" });
  await historySearch.fill("android 历史内容");
  await historyPanes.nth(1).getByText("1 / 1", { exact: true }).waitFor();
  await historySearch.press("Escape");
  assert.equal(await historySearch.count(), 0);
  await assertReturnCentered();
  await page.evaluate(() => window.sendLogs());
  assert.ok(!(await page.locator(".log-pane pre").first().textContent()).includes("MCU 保留日志"));
  assert.equal(
    await capture
      .getByRole("button", { name: "开始抓取", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "新建抓取", exact: true }).count(),
    1,
  );
  assert.ok(await newCapture.isVisible());
  await title.fill("更新历史标题");
  await notes.fill("历史补充备注");
  await page.getByRole("button", { name: "收起操作栏", exact: true }).click();
  await returnToLive.click();
  await title.waitFor();
  assert.equal(await title.inputValue(), "未开始草稿");
  assert.equal(await notes.inputValue(), "草稿备注");
  assert.deepEqual(await page.evaluate(() => window.calls.saves), [
    { path: "test/old", notes: "历史补充备注" },
  ]);
  assert.deepEqual(await page.evaluate(() => window.calls.titleSaves), [
    { path: "test/old", title: "更新历史标题" },
  ]);
  assert.ok(await page.getByRole("button", { name: /更新历史标题/ }).isVisible());
  await page.evaluate(() => (window.calls.failStart = true));
  await capture.getByRole("button", { name: "开始抓取", exact: true }).click();
  await page.getByText("Error: 模拟开始失败", { exact: true }).waitFor();
  assert.equal(await title.inputValue(), "未开始草稿");
  await page.locator(".history-row button").first().click();
  await newCapture.click();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "抓取标题",
  );
  assert.equal(await notes.inputValue(), "草稿备注");
  await page.evaluate(() => (window.calls.failStart = false));
  await title.fill("");
  await capture.getByRole("button", { name: "开始抓取", exact: true }).click();
  await capture.getByText("抓取中", { exact: true }).waitFor();
  assert.ok(await title.isEnabled());
  assert.equal(await newCapture.count(), 0);
  assert.ok(await page.getByRole("checkbox", { name: "选择 未命名", exact: true }).isDisabled());
  await page.getByRole("checkbox", { name: "全选记录", exact: true }).check();
  assert.equal(await page.locator('.history-row input:checked').count(), 1);
  assert.ok(await page.getByRole("button", { name: "删除所选", exact: true }).isDisabled());
  assert.equal(
    await page.locator(".history-row.active strong").textContent(),
    "未命名",
  );
  await page.evaluate(() => { window.holdTitleSave = new Promise((resolve) => { window.releaseTitleSave = resolve; }); });
  await title.fill("抓取中修改");
  await notes.fill("抓取中补充");
  const stop = page.locator(".workspace-toolbar").getByRole("button", { name: "停止并保存", exact: true });
  assert.ok(await stop.isVisible());
  await page.getByRole("tab", { name: "设备连接", exact: true }).click();
  assert.ok(await stop.isEnabled());
  assert.ok(await stop.evaluate((el) => el.getBoundingClientRect().right <= el.parentElement.getBoundingClientRect().right));
  await page.getByRole("tab", { name: "抓取", exact: true }).click();
  await page.getByRole("button", { name: "收起操作栏", exact: true }).click();
  await stop.click();
  assert.equal(await page.evaluate(() => window.calls.stop), 0, "stop must wait for the pending save");
  await page.evaluate(() => window.releaseTitleSave());
  await page.getByRole("button", { name: "展开操作栏", exact: true }).click();
  await capture.getByText("已保存", { exact: true }).first().waitFor();
  assert.equal(await title.inputValue(), "抓取中修改");
  assert.equal(await notes.inputValue(), "抓取中补充");
  await notes.fill("停止后补充");
  await newCapture.click();
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
  await title.fill("补充标题");
  await notes.fill("失败后重试备注");
  await newCapture.click();
  await page.getByText("Error: 模拟备注失败", { exact: true }).waitFor();
  assert.equal(await title.inputValue(), "补充标题");
  assert.equal(await notes.inputValue(), "失败后重试备注");
  await page.evaluate(() => (window.calls.failSave = false));
  await newCapture.click();
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
  assert.equal(await historyBanner.locator("small").count(), 0);
  await assertReturnCentered();
  await returnToLive.click();
  await page.getByText("MCU 保留日志", { exact: false }).first().waitFor();
  await page.locator(".history-row button").first().click();
  const selectAll = page.getByRole("checkbox", { name: "全选记录", exact: true });
  assert.equal(await selectAll.evaluate((el) => el.indeterminate), true);
  const selectedRecord = page.getByRole("checkbox", { name: "选择 补充标题", exact: true });
  await selectedRecord.check();
  await title.fill("");
  await page.getByRole("button", { name: /导出所选/ }).click();
  await page.getByText("已导出：test/export.zip", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.exported[0].find((r) => r.path === "test/new").title), "");
  await page.evaluate(() => (window.calls.failTitleSave = true));
  await title.fill("退出前修改");
  await page.evaluate(() => window.requestClose());
  await page.waitForFunction(() => window.calls.closeAcks.at(-1)?.ok === false);
  await capture.getByText("未保存", { exact: true }).waitFor();
  assert.equal(await title.inputValue(), "退出前修改");
  await page.evaluate(() => {
    window.calls.failTitleSave = false;
    window.requestClose();
  });
  await page.waitForFunction(() => window.calls.closeAcks.at(-1)?.ok === true);
  assert.deepEqual(await page.evaluate(() => window.calls.closeAcks.at(-1)), { ok: true, title: "退出前修改" });
  await selectAll.uncheck();
  await selectAll.check();
  assert.equal(await page.locator('.history-row input:checked').count(), 2);
  if (process.env.TWINLOG_SCREENSHOT) {
    await page.screenshot({ path: process.env.TWINLOG_SCREENSHOT });
  }
  await selectAll.uncheck();
  assert.equal(await page.locator('.history-row input:checked').count(), 0);
  await page.getByRole("checkbox", { name: "选择 退出前修改", exact: true }).check();
  await page.getByRole("button", { name: "删除所选", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.delete-records').disabled);
  assert.equal(await page.locator('.history-row').count(), 2);
  assert.equal(await title.inputValue(), "退出前修改");
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

  const connectionTab = page.getByRole("tab", { name: "设备连接", exact: true });
  const connectButton = connection.getByRole("button", { name: "连接设备", exact: true });
  const disconnectButton = connection.getByRole("button", { name: "断开连接", exact: true });
  const mcuSelect = connection.getByRole("combobox", { name: "串口", exact: true });
  const androidSelect = connection.getByRole("combobox", { name: "Android 设备", exact: true });
  const layouts = page.getByRole("group", { name: "日志布局" });
  const pane = page.locator(".log-pane");
  const assertSinglePane = async (name) => {
    await pane.getByText(name, { exact: true }).waitFor();
    assert.equal(await pane.count(), 1);
    assert.equal(await layouts.count(), 0);
    assert.ok(await pane.evaluate((el) => el.getBoundingClientRect().width === el.parentElement.getBoundingClientRect().width));
  };
  await layouts.getByRole("button", { name: "上下", exact: true }).click();
  await connectionTab.click();
  await disconnectButton.click();
  await page.evaluate(() => (window.calls.androidUnavailable = true));
  await connectButton.click();
  await page.getByText(/Android 连接失败：设备离线/).waitFor();
  assert.equal(await disconnectButton.count(), 0, "do not silently connect only one source");
  await page.getByRole("button", { name: "仅连接串口", exact: true }).click();
  await title.waitFor();
  await assertSinglePane("MCU 串口");
  assert.equal(await capture.getByText("Android 应用").count(), 0);
  assert.equal(await page.evaluate(() => window.calls.connectConfigs.at(-1).androidSerial), "");
  await title.fill("仅串口记录");
  await capture.getByRole("button", { name: "开始抓取", exact: true }).click();
  await page.evaluate(() => (window.calls.failRead = true));
  await stop.click();
  await page.getByText("Error: 模拟日志读取失败", { exact: true }).waitFor();
  assert.equal(await historyBanner.locator("small").textContent(), "日志未加载，可重新点击记录重试");
  await assertReturnCentered();
  await page.evaluate(() => (window.calls.failRead = false));
  await page.getByRole("button", { name: /仅串口记录/ }).click();
  await page.getByText("test/new MCU 历史内容", { exact: false }).waitFor();
  await assertSinglePane("MCU 串口");
  await page.getByRole("button", { name: "返回实时", exact: true }).click();
  await connectionTab.click();
  await disconnectButton.click();
  await mcuSelect.selectOption("");
  assert.ok(await connectButton.isDisabled(), "no selected devices");
  await androidSelect.selectOption("test");
  await assertSinglePane("Android Logcat");
  await page.evaluate(() => (window.calls.androidUnavailable = false));
  await connectButton.click();
  await title.waitFor();
  await assertSinglePane("Android Logcat");
  assert.ok(await capture.getByText("Android 应用").isVisible());
  assert.equal(await page.evaluate(() => window.calls.connectConfigs.at(-1).serialPort), "");
  await page.getByRole("button", { name: /仅串口记录/ }).click();
  await assertSinglePane("MCU 串口");
  await page.getByRole("button", { name: "返回实时", exact: true }).click();
  await assertSinglePane("Android Logcat");
  await connectionTab.click();
  await disconnectButton.click();
  await mcuSelect.selectOption("COM1");
  await connectButton.click();
  await title.waitFor();
  assert.equal(await pane.count(), 2);
  assert.equal(await layouts.getByRole("button", { name: "上下", exact: true }).getAttribute("aria-pressed"), "true");
  console.log(
    "PASS: capture flow, title and notes, export and exit flush, history, deletion and single-source layout",
  );
} finally {
  await browser?.close();
  server.kill();
}
