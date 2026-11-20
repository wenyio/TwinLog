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
  page.setDefaultTimeout(12000);
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
    window.foregroundState = (next) => { Object.assign(state, next); emit("state"); };
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
      failDeletePartially: false,
      deleted: [],
      configSaves: [],
      connectConfigs: [],
      connectSessions: [],
      packageChanges: [],
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
          ListSessions: async () => records.length ? [{ path: "test", startedAt: records.at(-1).startedAt,
            managed: false, records: structuredClone(records), full: null }] : [],
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
            if (!window.calls.deleteApproved) return;
            const partial = window.calls.failDeletePartially;
            for (let i = records.length - 1; i >= 0; i--) {
              const { path } = records[i];
              if (paths.includes(path) && (!partial || path === "test/new")) {
                window.calls.deleted.push(path);
                records.splice(i, 1);
              }
            }
            if (partial) throw Error("模拟部分删除失败");
          },
          ListPorts: async () => [{ name: "COM1", description: "" }],
          ListDevices: async () => [{ serial: "test", state: "device", model: "Test Android" }],
          ListPackages: async () => ["com.example.app"],
          ForegroundPackage: async (adb, serial) => {
            window.calls.foregroundDevice = { adb, serial };
            if (window.holdForeground) await window.holdForeground;
            if (window.calls.failForeground) throw Error("模拟前台查询失败");
            return "com.example.foreground";
          },
          Connect: async (next, session) => {
            if (window.calls.failConnect) throw Error("模拟连接失败");
            window.calls.connectConfigs.push(structuredClone(next));
            window.calls.connectSessions.push(session);
            if (window.calls.androidUnavailable && next.androidSerial) throw Error("Android 连接失败：设备离线");
            state.config = next;
            state.connected = true;
            emit("state");
          },
          Disconnect: async () => {
            state.connected = false;
            emit("state");
          },
          SetPackage: async (pkg) => {
            if (window.calls.failPackage) throw Error("模拟切换应用失败");
            window.calls.packageChanges.push(pkg);
            state.config = { ...state.config, package: pkg };
            emit("state");
          },
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
            handlers.logs?.forEach((fn) => {
              fn({ source: "mcu", text: "上条记录延迟消息\n", recordPath: "test/old" });
              fn({ source: "mcu", text: "MCU 抓取首批\n", recordPath: r.path });
              fn({ source: "android", text: "Android 抓取首批\n", recordPath: r.path });
            });
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
          ExportLogs: async (paths) => {
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
  const savedTitle = () => page.locator('.saved-record-title strong');
  const renameRecord = async (text, fail = false) => {
    await capture.getByRole('button', { name: '重命名', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '重命名记录', exact: true });
    await dialog.getByRole('textbox', { name: '记录标题', exact: true }).fill(text);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    if (fail) {
      await dialog.getByRole('alert').waitFor();
      return dialog;
    }
    await dialog.waitFor({ state: 'hidden' });
  };
  const connection = page.getByRole("tabpanel", {
    name: "设备连接",
    exact: true,
  });
  await page.getByRole("button", { name: "展开操作栏", exact: true }).click();
  await connection.waitFor();
  const connectButton = connection.getByRole("button", { name: "连接设备", exact: true });
  const connect = async () => { await connectButton.click(); };
  assert.equal(await capture.isVisible(), false);
  await connection.getByRole("button", { name: "更多设置" }).click();
  const fullLogs = connection.getByRole("checkbox", { name: "保存完整日志" });
  assert.equal(await fullLogs.isChecked(), true, "legacy settings must default to enabled");
  await fullLogs.uncheck();
  await page.waitForFunction(() => window.calls.configSaves.at(-1)?.saveFullLogs === false);
  const notificationLogBounds = await page.locator(".logs-grid").boundingBox();
  await page.evaluate(() => (window.calls.failConnect = true));
  await connect();
  await page.getByText("Error: 模拟连接失败", { exact: true }).waitFor();
  assert.deepEqual(await page.locator(".logs-grid").boundingBox(), notificationLogBounds, "errors must not resize the log workspace");
  const errorToast = page.locator(".notification.error");
  assert.equal(await errorToast.getAttribute("role"), "alert");
  await errorToast.getByRole("button", { name: "关闭通知" }).click();
  assert.equal(await errorToast.count(), 0);
  const warning = page.locator(".notification.warning");
  await page.evaluate(() => window.foregroundState({ filterWarning: "模拟应用过滤失败" }));
  await warning.waitFor();
  const warningBox = await warning.boundingBox();
  assert.deepEqual(await page.locator(".logs-grid").boundingBox(), notificationLogBounds);
  await warning.getByRole("button", { name: "查看详情" }).click();
  await warning.locator(".notification-details").getByText("模拟应用过滤失败", { exact: true }).waitFor();
  await page.evaluate(() => window.foregroundState({ filterWarning: "模拟应用过滤重试失败" }));
  assert.equal(await warning.count(), 1, "retry updates the existing warning");
  await warning.locator(".notification-details").getByText("模拟应用过滤重试失败", { exact: true }).waitFor();
  await warning.getByRole("button", { name: "关闭通知" }).click();
  await page.evaluate(() => window.foregroundState({ filterWarning: "模拟应用过滤再次重试" }));
  assert.equal(await warning.count(), 0, "dismissed warning does not return on every retry");
  await page.evaluate(async () => {
    window.foregroundState({ filterWarning: "" });
    // Let React commit the recovery before emitting a separate new failure.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.evaluate(() => window.foregroundState({ filterWarning: "新一次过滤故障" }));
  await warning.waitFor();
  assert.deepEqual(await warning.boundingBox(), warningBox);
  await page.evaluate(() => window.foregroundState({ filterWarning: "" }));
  await warning.waitFor({ state: "hidden" });
  const longError = "模拟持久错误详情。".repeat(80);
  await page.evaluate((error) => window.foregroundState({ error }), longError);
  await errorToast.waitFor();
  await errorToast.getByRole("button", { name: "查看详情" }).click();
  assert.equal(await errorToast.locator(".notification-details").textContent(), longError);
  assert.deepEqual(await page.locator(".logs-grid").boundingBox(), notificationLogBounds);
  await errorToast.getByRole("button", { name: "关闭通知" }).click();
  await page.evaluate(() => window.foregroundState({ mcuBytes: 1 }));
  assert.equal(await errorToast.count(), 0, "state refresh must not revive a dismissed persistent error");
  await page.evaluate(() => window.foregroundState({ error: "" }));
  if (process.env.TWINLOG_SCREENSHOTS) {
    await page.evaluate(() => window.foregroundState({ error: "连接失败，请检查设备后重试。" }));
    await errorToast.waitFor();
    await page.screenshot({ path: "test-results/floating-notification.png" });
    await page.evaluate(() => window.foregroundState({ error: "" }));
  }
  assert.ok(await connection.isVisible());
  assert.equal(await page.evaluate(() => window.calls.start), 0);
  await page.evaluate(() => (window.calls.failConnect = false));
  await connect("  首次排查  ");
  await title.waitFor();
  await page.getByText("已连接 · 未保存完整日志", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.calls.connectConfigs.at(-1).saveFullLogs), false);
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "抓取标题",
  );
  assert.ok(await capture.getByText("新建抓取 · 待开始", { exact: true }).isVisible());
  assert.ok(
    await capture
      .getByRole("button", { name: "开始抓取", exact: true })
      .isEnabled(),
  );
  await title.fill("未开始草稿");
  await notes.fill("草稿备注");
  await page.evaluate(() => window.sendLogs());
  assert.equal(await newCapture.count(), 1);
  assert.equal(await page.evaluate(() => window.calls.start), 0);
  await page.getByRole("tab", { name: "设备连接", exact: true }).click();
  assert.equal(await fullLogs.isChecked(), false);
  assert.ok(await fullLogs.isDisabled());
  await page.getByRole("button", { name: "断开连接", exact: true }).click();
  await fullLogs.check();
  await page.waitForFunction(() => window.calls.configSaves.at(-1)?.saveFullLogs === true);
  const liveWorkspaceBounds = await page.locator(".logs-grid").boundingBox();
  await page.locator(".history-row button").first().click();
  assert.deepEqual(await page.locator(".logs-grid").boundingBox(), liveWorkspaceBounds, "history must not add a row above the logs");
  await newCapture.click();
  assert.ok(await capture.isVisible());
  await page.getByRole("tab", { name: "设备连接", exact: true }).click();
  await connect();
  await title.waitFor();
  await page.getByText("已连接 · 全量记录中", { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "抓取标题",
  );
  assert.equal(await title.inputValue(), "未开始草稿");
  assert.equal(await notes.inputValue(), "草稿备注");
  await page.locator(".history-row button").first().click();
  assert.equal(await title.count(), 0, 'history has no editable capture-title field');
  assert.equal(await savedTitle().textContent(), "旧记录");
  await savedTitle().dblclick();
  const titleEditDialog = page.getByRole("dialog", { name: "重命名记录", exact: true });
  await titleEditDialog.waitFor();
  assert.equal(await titleEditDialog.getByRole("textbox", { name: "记录标题", exact: true }).inputValue(), "旧记录");
  await titleEditDialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByText("test/old MCU 历史内容", { exact: false }).waitFor();
  assert.ok(await page.getByText("test/old Android 历史内容", { exact: false }).isVisible());
  const historyBanner = page.locator(".workspace-toolbar");
  assert.equal(await historyBanner.locator(".view-kind").textContent().then((text) => text.trim()), "历史日志");
  assert.equal(await historyBanner.locator(".view-kind").getAttribute("title"), "旧记录");
  assert.equal(await historyBanner.locator(".view-title").count(), 0);
  const returnToLive = historyBanner.getByRole("button", { name: "返回实时", exact: true });
  const assertReturnCentered = async () => {
    const banner = await historyBanner.boundingBox();
    const button = await returnToLive.boundingBox();
    assert.ok(banner && button);
    assert.ok(Math.abs((button.y - banner.y) - (banner.height - button.height) / 2) <= 1);
    assert.ok(button.x >= banner.x && button.x + button.width <= banner.x + banner.width, "return to live stays inside the narrow toolbar");
  };
  assert.equal(await historyBanner.locator(".history-info").count(), 0);
  assert.ok((await page.locator(".log-limit").first().getAttribute("title")).includes("全文请打开日志目录"));
  assert.equal(await page.locator(".history-banner").count(), 0);
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
  await renameRecord("这是一条用于检查窄窗口布局的很长历史记录标题".repeat(5));
  const historyToolbar = page.locator(".workspace-toolbar");
  assert.equal(await historyToolbar.locator(".view-kind").getAttribute("title"), "这是一条用于检查窄窗口布局的很长历史记录标题".repeat(5));
  assert.ok(await historyToolbar.evaluate((el) => el.scrollWidth <= el.clientWidth), "long history title must not overflow the toolbar");
  await assertReturnCentered();
  if (process.env.TWINLOG_SCREENSHOTS) {
    await page.getByRole("button", { name: "上下", exact: true }).click();
    await page.getByRole("button", { name: "收起记录栏", exact: true }).click();
    await page.getByRole("button", { name: "收起操作栏", exact: true }).click();
    assert.equal(await historyToolbar.locator(".view-title").count(), 0);
    assert.equal(await historyToolbar.locator(".view-kind").getAttribute("title"), "这是一条用于检查窄窗口布局的很长历史记录标题".repeat(5));
    await page.screenshot({ path: "test-results/history-workspace.png" });
    await page.getByRole("button", { name: "展开记录栏", exact: true }).click();
    await page.getByRole("button", { name: "展开操作栏", exact: true }).click();
    await page.getByRole("button", { name: "左右", exact: true }).click();
  }
  await renameRecord("旧记录");
  // Keep the later title-persistence assertions scoped to their own edits.
  await page.evaluate(() => { window.calls.titleSaves.length = 0; });
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
  await renameRecord("更新历史标题");
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
  assert.ok(await page.locator(".history-item").filter({ hasText: "更新历史标题" }).isVisible());
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
  await title.fill('下一条的标题');
  await notes.fill('下一条的备注');
  assert.deepEqual(await page.evaluate(() => window.calls.titleSaves), [{ path: 'test/old', title: '更新历史标题' }]);
  await page.evaluate(() => (window.calls.failStart = false));
  await title.fill("");
  await capture.getByRole("button", { name: "开始抓取", exact: true }).click();
  await capture.getByText("抓取中", { exact: true }).waitFor();
  await page.evaluate(() => window.sendLogs());
  for (const [index, source] of ["MCU", "Android"].entries()) {
    const preview = page.locator(".log-pane pre").nth(index);
    assert.match(await preview.textContent(), new RegExp(source + " 抓取首批"));
    assert.doesNotMatch(await preview.textContent(), /保留日志|上条记录延迟消息/);
  }
  assert.ok(await title.isEnabled());
  assert.equal(await newCapture.count(), 0);
  assert.equal(await page.locator('.history-row input').count(), 0);
  await page.getByRole('button', { name: '批量管理', exact: true }).click();
  assert.ok(await page.getByRole('checkbox', { name: '选择 未命名', exact: true }).isDisabled());
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
  assert.equal(await savedTitle().textContent(), "抓取中修改");
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
  await renameRecord("补充标题");
  await notes.fill("失败后重试备注");
  await newCapture.click();
  await page.getByText("Error: 模拟备注失败", { exact: true }).waitFor();
  assert.equal(await savedTitle().textContent(), "补充标题");
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
  await renameRecord("");
  await page.getByRole("button", { name: /导出所选/ }).click();
  await page.getByText("已导出：test/export.zip", { exact: true }).waitFor();
  await page.mouse.move(0, 0);
  await page.locator(".notification.success").waitFor({ state: "hidden", timeout: 5000 });
  assert.equal(await page.evaluate(() => window.calls.exported[0].find((r) => r.path === "test/new").title), "");
  await page.evaluate(() => (window.calls.failTitleSave = true));
  const failedRename = await renameRecord('退出前修改', true);
  assert.equal(await savedTitle().textContent(), '未命名');
  await page.evaluate(() => (window.calls.failTitleSave = false));
  await failedRename.getByRole('button', { name: '保存', exact: true }).click();
  await failedRename.waitFor({ state: 'hidden' });
  await notes.fill('退出前备注');
  await page.evaluate(() => window.requestClose());
  await page.waitForFunction(() => window.calls.closeAcks.at(-1)?.ok === true);
  assert.deepEqual(await page.evaluate(() => window.calls.closeAcks.at(-1)), { ok: true, title: '退出前修改' });
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
  assert.equal(await savedTitle().textContent(), "退出前修改");
  assert.equal(await page.locator('.history-row input:checked').count(), 1);
  assert.deepEqual(await page.evaluate(() => window.calls.deleted), []);
  await notes.fill("删除前备注");
  await selectAll.check();
  await page.evaluate(() => {
    window.calls.deleteApproved = true;
    window.calls.failDeletePartially = true;
  });
  await page.getByRole("button", { name: "删除所选", exact: true }).click();
  await page.getByText("模拟部分删除失败", { exact: false }).waitFor();
  assert.equal(await page.locator('.history-row').count(), 1);
  assert.equal(await title.inputValue(), "");
  assert.deepEqual(await page.evaluate(() => window.calls.deleted), ["test/new"]);
  assert.ok((await page.evaluate(() => window.calls.saves)).some((v) => v.notes === "删除前备注"));
  assert.ok(await selectAll.isChecked());
  await page.evaluate(() => (window.calls.failDeletePartially = false));
  await page.getByRole("button", { name: "删除所选", exact: true }).click();
  await page.getByText("已删除 1 条记录", { exact: true }).waitFor();
  await page.getByText("还没有日志连接", { exact: true }).waitFor();
  assert.ok(await selectAll.isDisabled());
  assert.equal(await selectAll.isChecked(), false);

  const connectionTab = page.getByRole("tab", { name: "设备连接", exact: true });
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
  await connect();
  await page.getByText(/Android 连接失败：设备离线/).waitFor();
  assert.equal(await disconnectButton.count(), 0, "do not silently connect only one source");
  await page.getByRole("button", { name: "仅连接串口", exact: true }).click();
  await title.waitFor();
  await assertSinglePane("MCU 串口");
  assert.equal(await capture.getByText("Android 应用").count(), 0);
  assert.equal(await page.evaluate(() => window.calls.connectConfigs.at(-1).androidSerial), "");
  assert.equal(await page.evaluate(() => window.calls.connectConfigs.slice(-2).length), 2);
  await title.fill("仅串口记录");
  await capture.getByRole("button", { name: "开始抓取", exact: true }).click();
  await page.evaluate(() => (window.calls.failRead = true));
  await stop.click();
  await page.getByText("Error: 模拟日志读取失败", { exact: true }).waitFor();
  assert.equal(await historyBanner.locator(".history-info").count(), 0);
  await assertReturnCentered();
  await page.evaluate(() => (window.calls.failRead = false));
  await page.locator(".history-item").filter({ hasText: "仅串口记录" }).click();
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
  await connect();
  await title.waitFor();
  await assertSinglePane("Android Logcat");
  assert.ok(await capture.getByText("Android 应用").isVisible());
  assert.equal(await page.evaluate(() => window.calls.connectConfigs.at(-1).serialPort), "");
  const packageField = capture.getByLabel("Android 应用", { exact: true });
  const clearPackage = capture.getByRole("button", { name: "清空 Android 应用", exact: true });
  await capture.getByRole("button", { name: "加载应用", exact: true }).click();
  await page.locator('#packages option[value="com.example.app"]').waitFor({ state: "attached" });
  assert.equal(await clearPackage.count(), 0);
  await packageField.fill("com.example.draft");
  await clearPackage.click();
  assert.equal(await packageField.inputValue(), "");
  assert.deepEqual(await page.evaluate(() => window.calls.packageChanges), []);
  await packageField.fill("com.example.app");
  await packageField.blur();
  await page.waitForFunction(() => window.calls.packageChanges.at(-1) === "com.example.app");
  await packageField.focus();
  await page.keyboard.press("Tab");
  assert.equal(await clearPackage.evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.id === "package");
  assert.equal(await packageField.inputValue(), "");
  assert.equal(await clearPackage.count(), 0);
  assert.deepEqual(await page.evaluate(() => window.calls.packageChanges), ["com.example.app", ""]);
  const foreground = capture.getByRole("button", { name: "获取前台应用", exact: true });
  await foreground.click();
  await page.waitForFunction(() => window.calls.packageChanges.at(-1) === "com.example.foreground");
  assert.equal(await packageField.inputValue(), "com.example.foreground");
  assert.deepEqual(await page.evaluate(() => window.calls.foregroundDevice), { adb: "adb", serial: "test" });
  const appSelector = capture.locator(".app-select");
  assert.ok(await packageField.evaluate((el) => el.clientWidth > 100), "package field remains usable beside both icons");
  assert.ok(await appSelector.evaluate((el) => el.scrollWidth <= el.clientWidth), "selector has no horizontal overflow");
  await appSelector.screenshot({ path: "test-results/foreground-selection.png" });
  await packageField.fill("com.example.draft");
  await page.evaluate(() => (window.calls.failForeground = true));
  const changesBeforeFailure = await page.evaluate(() => window.calls.packageChanges.length);
  await foreground.click();
  await page.getByText("Error: 模拟前台查询失败", { exact: true }).waitFor();
  assert.equal(await packageField.inputValue(), "com.example.draft", "failed query preserves even an unapplied draft");
  assert.equal(await page.evaluate(() => window.calls.packageChanges.length), changesBeforeFailure);
  await page.evaluate(() => (window.calls.failForeground = false));
  await foreground.click();
  await page.getByText("已选择前台应用：com.example.foreground", { exact: true }).waitFor();
  assert.equal(await packageField.inputValue(), "com.example.foreground", "same active package restores draft without switching");
  await clearPackage.click();
  await page.waitForFunction(() => window.calls.packageChanges.at(-1) === "");
  await page.evaluate(() => (window.calls.failPackage = true));
  await foreground.click();
  await page.getByText("Error: 模拟切换应用失败", { exact: true }).waitFor();
  assert.equal(await packageField.inputValue(), "", "failed filter change preserves selection");
  await page.evaluate(() => {
    window.calls.failPackage = false;
    window.holdForeground = new Promise((resolve) => (window.releaseForeground = resolve));
  });
  await foreground.click();
  assert.ok(await foreground.isDisabled());
  await page.evaluate(() => { window.foregroundState({ connected: false }); window.releaseForeground(); });
  await page.getByText("Error: 设备或连接状态已变化，请重新获取前台应用", { exact: true }).waitFor();
  assert.equal(await packageField.inputValue(), "");
  await foreground.click();
  await page.getByText("已选择前台应用：com.example.foreground", { exact: true }).waitFor();
  assert.equal(await packageField.inputValue(), "com.example.foreground");
  assert.equal(await page.evaluate(() => window.calls.configSaves.at(-1).package), "com.example.foreground");
  await page.evaluate(() => window.foregroundState({ connected: true, capturing: true }));
  await page.waitForFunction(() => document.querySelector('[aria-label="获取前台应用"]').disabled);
  await page.evaluate(() => window.foregroundState({ capturing: false }));
  await clearPackage.click();
  await page.waitForFunction(() => window.calls.packageChanges.at(-1) === "");
  await page.locator(".history-item").filter({ hasText: "仅串口记录" }).click();
  await assertSinglePane("MCU 串口");
  await page.keyboard.press("Control+f");
  const recordSearch = page.getByRole("textbox", { name: "搜索当前预览" });
  await recordSearch.fill("MCU");
  await page.getByText("1 / 1", { exact: true }).waitFor();
  await page.getByRole("button", { name: "返回实时", exact: true }).click();
  await assertSinglePane("Android Logcat");
  assert.equal(await recordSearch.count(), 0);
  await connectionTab.click();
  await disconnectButton.click();
  await mcuSelect.selectOption("COM1");
  await connect();
  await title.waitFor();
  assert.equal(await pane.count(), 2);
  assert.equal(await layouts.getByRole("button", { name: "上下", exact: true }).getAttribute("aria-pressed"), "true");
  console.log(
    "PASS: capture flow, title and notes, export and exit flush, history, deletion, single-source layout, package clearing and foreground selection/failure/stale result/locking",
  );

  const historyPage = await browser.newPage({ viewport: { width: 1080, height: 640 } });
  historyPage.setDefaultTimeout(12000);
  await historyPage.addInitScript(() => {
    const config = { outputDir: "test", adbPath: "adb", androidSerial: "device" };
    const record = (path, title) => ({ path, title, startedAt: "2026-11-17T02:00:00Z", endedAt: "2026-11-17T02:01:00Z", notes: "保留备注", package: "", source: "android" });
    const full = (path) => ({ path: path + "/full", source: "android", bytes: 1048576 });
    const sessions = [
      { path: "test/live", startedAt: "2026-11-18T02:00:00Z", managed: true, records: [], full: full("test/live") },
      { path: "test/old", startedAt: "2026-11-17T01:00:00Z", managed: true, records: [record("test/old/r1", "连接测试"), record("test/old/r2", "重连测试")], full: full("test/old") },
    ];
    sessions[1].records[0].package = 'com.example.application.with.a.very.long.package.name';
    sessions[1].records[0].filterGaps = true;
    sessions[1].records[1].interrupted = true;
    window.historyCalls = [];
    window.fullReads = [];
    window.sessionCalls = [];
    const handlers = {};
    const state = { connected: true, capturing: false, sessionDir: "test/live", activeRecord: null, config, error: "", mcuBytes: 0, androidBytes: 0 };
    window.emitHistoryEvent = (name, data) => handlers[name]?.forEach((fn) => fn(data));
    window.setCapturing = (capturing) => window.emitHistoryEvent("state", { ...state, capturing });
    window.pulseHistoryState = (next) => window.emitHistoryEvent("state", structuredClone({
      ...state, activeRecord: record("test/live/capture", "采集中"), ...next,
    }));
    window.go = { main: { App: {
      GetConfig: async () => config,
      GetState: async () => state,
      ListPorts: async () => [], ListDevices: async () => [],
      ListSessions: async () => structuredClone(sessions),
      Disconnect: async () => { state.connected = false; window.emitHistoryEvent("state", state); },
      Connect: async () => {
        window.sessionCalls.push("connect");
        const path = "test/reconnected";
        sessions.unshift({ path, startedAt: "2026-11-18T03:00:00Z", managed: true, records: [record(path + "/r1", "重连后记录")], full: full(path) });
        state.sessionDir = path;
        state.connected = true;
        window.emitHistoryEvent("state", state);
      },
      SetRecordArchived: async (path, archived) => {
        if (window.failArchive) throw Error('模拟归档失败');
        sessions.flatMap((s) => s.records).find((r) => r.path === path).archived = archived;
      },
      SetSessionArchived: async (path, archived) => {
        if (window.failArchive) throw Error('模拟归档失败');
        if (state.connected && state.sessionDir === path) throw Error('请先断开连接');
        sessions.find((s) => s.path === path).archived = archived;
      },
      ReadRecordLogs: async (path) => ({ mcu: { text: '', bytes: 0 }, android: { text: '记录日志 ' + path, bytes: 20 } }),
      SaveNotes: async (path, notes) => {
        if (window.failHistorySave) throw Error('模拟备注失败');
        sessions.flatMap((s) => s.records).find((r) => r.path === path).notes = notes;
      },
      SaveSessionTitle: async (path, title) => {
        sessions.find((s) => s.path === path).title = title;
        window.sessionCalls.push({ path, title });
      },
      ReadFullLogs: async (path) => {
        window.fullReads.push(path);
        return { mcu: { text: "", bytes: 0 }, android: { text: "完整 Android 日志 " + path, bytes: 30 } };
      },
      ExportLogs: async (...args) => { window.historyCalls.push(args); return "test/history.zip"; },
      DeleteSessionLogs: async (path, fullOnly) => {
        window.historyCalls.push([path, fullOnly]);
        const idx = sessions.findIndex((s) => s.path === path);
        if (fullOnly) sessions[idx].full = null;
        else sessions.splice(idx, 1);
      },
    } } };
    window.runtime = { EventsOn: (name, fn) => {
      (handlers[name] ??= new Set()).add(fn);
      return () => handlers[name].delete(fn);
    } };
  });
  await historyPage.goto(url);
  const groups = historyPage.locator(".session-group");
  await groups.nth(1).waitFor();
  const activeSession = groups.first();
  const oldSession = groups.nth(1);
  assert.equal(await activeSession.locator(".session-count").textContent(), "0");
  assert.equal(await activeSession.locator(".session-count").getAttribute("title"), "0 条记录");
  assert.equal(await oldSession.locator(".session-count").textContent(), "2");
  assert.match(await activeSession.locator('.session-toggle > span').textContent(), /11月18日/);
  assert.equal(await oldSession.evaluate((el) => getComputedStyle(el).borderTopWidth), '1px');
  assert.equal(await historyPage.locator('.export-panel').count(), 0);
  assert.equal(await historyPage.locator('.record-row input').count(), 0);
  await historyPage.getByRole('button', { name: '批量管理', exact: true }).click();
  const batch = historyPage.locator(".export-panel");
  const batchSelectAll = batch.getByRole("checkbox", { name: "全选记录", exact: true });
  const includeFull = batch.getByRole("checkbox", { name: "附带完整日志" });
  assert.equal((await batchSelectAll.boundingBox()).y, (await includeFull.boundingBox()).y);
  assert.ok(await oldSession.locator(".session-children").isHidden());
  await batchSelectAll.check();
  assert.equal(await oldSession.locator('input:checked').count(), 2, "select all includes collapsed connections");
  await batch.getByRole("button", { name: "导出所选 · 2", exact: true }).waitFor();
  await batchSelectAll.uncheck();
  // Mouse focus must not pin the icon after leaving the row. Keyboard focus can reveal it.
  await activeSession.locator('.session-toggle').click();
  await historyPage.mouse.move(500, 500);
  assert.equal(await activeSession.locator('.archive-action').evaluate((el) => getComputedStyle(el).opacity), '0');
  await historyPage.keyboard.press('Shift+Tab');
  await historyPage.keyboard.press('Tab');
  assert.equal(await activeSession.locator('.archive-action').evaluate((el) => getComputedStyle(el).opacity), '1');
  await activeSession.locator('.session-toggle').click();
  const activeToggle = activeSession.locator(".session-toggle");
  const showMenu = async (trigger) => {
    await trigger.click({ button: "right" });
  };
  assert.ok(await activeSession.locator(".full-row .session-writing").isVisible());
  await activeToggle.click();
  assert.ok(await activeToggle.locator(".session-writing").isVisible());
  const countBox = await activeToggle.locator(".session-count").boundingBox();
  const writingBox = await activeToggle.locator(".session-writing").boundingBox();
  assert.ok(writingBox.x + writingBox.width <= countBox.x, "writing indicator precedes the count without overlap");
  const toggleBox = await activeToggle.boundingBox();
  assert.ok(toggleBox.x + toggleBox.width - countBox.x - countBox.width <= 6, 'count aligns with the right edge');
  const toggleBounds = await activeToggle.boundingBox();
  const countBounds = await activeToggle.locator('.session-count').boundingBox();
  await activeSession.locator('.session-row').hover();
  const archiveBounds = await activeSession.locator('.archive-action').boundingBox();
  assert.ok(archiveBounds.x <= countBounds.x && archiveBounds.x + archiveBounds.width >= countBounds.x + countBounds.width, 'archive button covers the count');
  assert.deepEqual(await activeToggle.boundingBox(), toggleBounds, 'hover does not move the connection label');
  assert.deepEqual(await activeToggle.locator('.session-count').boundingBox(), countBounds, 'hover does not move the count');
  assert.ok(await activeSession.locator(".full-row").isHidden());
  await activeToggle.click();
  const fullRow = activeSession.locator(".full-row");
  const fullItem = fullRow.locator('.history-item');
  assert.equal(await historyPage.locator('.row-menu-trigger').count(), 0);
  const fullBounds = await fullItem.boundingBox();
  await fullRow.hover();
  assert.deepEqual(await fullItem.boundingBox(), fullBounds);
  await fullItem.focus();
  await historyPage.keyboard.press('Shift+F10');
  const action = (name) => historyPage.getByRole('menuitem', { name, exact: true });
  await action('打开目录').waitFor();
  assert.ok(await action('删除完整日志').isDisabled());
  assert.ok(await action('导出完整日志').isDisabled());
  await historyPage.keyboard.press('ArrowDown');
  await historyPage.keyboard.press('Escape');
  assert.ok(await fullItem.evaluate((el) => el === document.activeElement));
  const activeFull = activeSession.locator(".full-row .history-item");
  const oldFull = oldSession.locator(".full-row .history-item");
  const liveLog = historyPage.locator(".log-pane pre");
  const latest = historyPage.getByRole("button", { name: "回到最新", exact: true });
  const backToLive = historyPage.getByRole("button", { name: "返回实时", exact: true });
  assert.equal(await activeFull.getAttribute("title"), "返回实时预览");
  await historyPage.evaluate(() => window.emitHistoryEvent("logs", {
    source: "android", text: Array.from({ length: 200 }, (_, i) => "实时 Android " + i + "\n").join(""),
  }));
  await historyPage.getByText(/实时 Android 199/).waitFor();
  // A menu survives capture pulses and log auto-scroll, but still closes when
  // its own list scrolls or capture permissions change.
  const rowMenu = historyPage.getByRole("menu", { name: "行操作" });
  const settleMenu = () => historyPage.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await historyPage.evaluate(() => window.pulseHistoryState({ capturing: true }));
  await showMenu(activeSession.locator(".session-row"));
  await rowMenu.waitFor();
  for (let i = 0; i < 3; i++) {
    await historyPage.evaluate((androidBytes) => window.pulseHistoryState({ capturing: true, androidBytes }), i * 100);
    await settleMenu();
    assert.ok(await rowMenu.isVisible(), "capture state pulses keep the menu open");
  }
  const beforeAutoScroll = await liveLog.evaluate((el) => el.scrollTop);
  await historyPage.evaluate(() => window.emitHistoryEvent("logs", {
    source: "android", text: Array.from({ length: 20 }, (_, i) => "菜单期间日志 " + i + "\n").join(""),
  }));
  await historyPage.getByText(/菜单期间日志 19/).waitFor();
  await settleMenu();
  assert.ok(await liveLog.evaluate((el) => el.scrollTop) > beforeAutoScroll, "new logs auto-scroll while the menu is open");
  assert.ok(await rowMenu.isVisible(), "log auto-scroll keeps the menu open");
  await historyPage.keyboard.press("Escape");
  assert.ok(await rowMenu.isHidden(), "Escape still closes the menu");
  const historyList = historyPage.locator(".history-list");
  await historyList.evaluate((el) => { el.style.maxHeight = "60px"; });
  await showMenu(activeSession.locator(".session-row"));
  await rowMenu.waitFor();
  await historyList.evaluate((el) => { el.scrollTop = 10; });
  await rowMenu.waitFor({ state: "hidden" });
  assert.ok(await historyList.evaluate((el) => el.scrollTop > 0), "the row list actually scrolled");
  await historyList.evaluate((el) => { el.style.maxHeight = ""; el.scrollTop = 0; });
  await showMenu(activeSession.locator(".session-row"));
  await rowMenu.waitFor();
  await historyPage.evaluate(() => window.setCapturing(false));
  await rowMenu.waitFor({ state: "hidden" });
  console.log("PASS: capture pulses and log auto-scroll preserve row menus; list scrolling, Escape and capture changes close them");
  await liveLog.evaluate((el) => { el.scrollTop = 200; });
  await latest.waitFor();
  const frozen = await liveLog.textContent();
  const scrollTop = await liveLog.evaluate((el) => el.scrollTop);
  assert.ok(scrollTop > 0);
  await activeFull.click();
  assert.ok(await backToLive.isHidden());
  assert.ok(await latest.isVisible());
  assert.equal(await liveLog.textContent(), frozen);
  assert.equal(await liveLog.evaluate((el) => el.scrollTop), scrollTop);
  assert.deepEqual(await historyPage.evaluate(() => window.fullReads), []);
  await historyPage.evaluate(() => window.setCapturing(true));
  await historyPage.waitForFunction(() => document.querySelector(".full-row .history-item")?.disabled);
  await historyPage.evaluate(() => window.setCapturing(false));
  await oldSession.locator(".session-toggle").click();
  await oldSession.getByRole("checkbox", { name: "选择 重连测试" }).check();
  await oldFull.click();
  await historyPage.getByText(/完整 Android 日志 test\/old/).waitFor();
  await historyPage.evaluate(() => window.emitHistoryEvent("logs", { source: "android", text: "查看历史期间收到的实时日志\n" }));
  assert.ok(await historyPage.getByText(/查看历史期间收到的实时日志/).isHidden());
  await activeFull.click();
  await historyPage.getByText(/查看历史期间收到的实时日志/).waitFor();
  assert.ok(await backToLive.isHidden());
  assert.deepEqual(await historyPage.evaluate(() => window.fullReads), ["test/old"]);
  await oldFull.click();
  await historyPage.getByText(/完整 Android 日志 test\/old/).waitFor();
  const logBounds = await historyPage.locator(".log-pane").boundingBox();
  await showMenu(oldSession.locator(".full-row"));
  assert.deepEqual(await historyPage.locator(".log-pane").boundingBox(), logBounds);
  await action("导出完整日志").click();
  await historyPage.getByText("已导出：test/history.zip", { exact: true }).waitFor();
  assert.deepEqual(await historyPage.evaluate(() => window.historyCalls[0]), [[], ["test/old"]]);
  await showMenu(oldSession.locator(".record-row").filter({ hasText: "连接测试" }).first());
  await action("导出此记录").click();
  await historyPage.getByText("已导出：test/history.zip", { exact: true }).waitFor();
  assert.deepEqual(await historyPage.evaluate(() => window.historyCalls[1]), [["test/old/r1"], []]);
  await historyPage.getByRole("checkbox", { name: "附带完整日志" }).check();
  await historyPage.getByRole("button", { name: /导出所选/ }).click();
  await historyPage.getByText("已导出：test/history.zip", { exact: true }).waitFor();
  assert.deepEqual(await historyPage.evaluate(() => window.historyCalls[2]), [["test/old/r2"], ["test/old"]]);
  // Archive one record without hiding its sibling or the connection's full log.
  const firstRecord = oldSession.locator('.record-row').filter({ hasText: '连接测试' }).first();
  await firstRecord.locator('.history-item').click();
  const recordDetail = await firstRecord.locator('.history-item').getAttribute('title');
  assert.ok(recordDetail.includes('时间：2026/11/17'));
  assert.ok(recordDetail.includes('应用：com.example.application.with.a.very.long.package.name'));
  assert.ok(recordDetail.includes('状态：应用过滤有缺口'));
  assert.ok((await oldSession.locator('.record-row .history-item').last().getAttribute('title')).includes('状态：中断'));
  assert.equal(await firstRecord.locator('.history-item').textContent(), '连接测试', 'only the title is visible');
  assert.equal(await firstRecord.locator('strong').evaluate((el) => getComputedStyle(el).whiteSpace), 'nowrap');
  assert.equal(await firstRecord.evaluate((el) => getComputedStyle(el).borderLeftColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await firstRecord.evaluate((el) => getComputedStyle(el, '::before').content), 'none');
  const recordPreview = await historyPage.locator('.log-pane pre').textContent();
  await historyPage.mouse.move(500, 500);
  assert.equal(await firstRecord.locator('.archive-action').evaluate((el) => getComputedStyle(el).opacity), '0');
  const recordBounds = await firstRecord.locator('.history-item').boundingBox();
  await firstRecord.hover();
  assert.equal(await firstRecord.locator('.archive-action').evaluate((el) => getComputedStyle(el).opacity), '1');
  assert.deepEqual(await firstRecord.locator('.history-item').boundingBox(), recordBounds);
  const siblingRecord = oldSession.locator('.record-row').last();
  await siblingRecord.hover();
  const selectedBackground = await firstRecord.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(await siblingRecord.evaluate((el) => getComputedStyle(el).backgroundColor), selectedBackground, 'hover and selection use the same background');
  assert.equal(await siblingRecord.locator('.archive-action').evaluate((el) => getComputedStyle(el).backgroundColor), selectedBackground, 'archive action blends with the row background');
  await historyPage.mouse.move(500, 500);
  assert.equal(await siblingRecord.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'hover background clears after leaving the row');
  assert.equal(await firstRecord.evaluate((el) => getComputedStyle(el).backgroundColor), selectedBackground, 'selection remains after the pointer leaves');
  await firstRecord.hover();
  await historyPage.evaluate(() => { window.failArchive = true; });
  await firstRecord.getByRole('button', { name: '归档记录 · 连接测试', exact: true }).click();
  await historyPage.getByText('Error: 模拟归档失败', { exact: true }).waitFor();
  assert.equal(await oldSession.locator('.record-row').count(), 2);
  await historyPage.evaluate(() => { window.failArchive = false; });
  await firstRecord.hover();
  const listBounds = await historyPage.locator('.history-list').boundingBox();
  await firstRecord.getByRole('button', { name: '归档记录 · 连接测试', exact: true }).click();
  await historyPage.getByRole('status').getByText('已归档记录', { exact: true }).waitFor();
  assert.deepEqual(await historyPage.locator('.history-list').boundingBox(), listBounds, 'archive notice does not resize or move the list');
  const noticeBounds = await historyPage.locator('.notification.success').boundingBox();
  assert.ok(noticeBounds.x + noticeBounds.width <= 1080 && noticeBounds.y + noticeBounds.height <= 640 - 30, 'floating notice stays inside the window above the status bar');
  assert.equal(await oldSession.locator('.record-row').count(), 1);
  assert.ok(await oldSession.locator('.full-row').isVisible());
  assert.equal(await historyPage.locator('.log-pane pre').textContent(), recordPreview);
  await historyPage.getByRole('button', { name: '刷新连接', exact: true }).click();
  await historyPage.getByRole('button', { name: '已归档', exact: true }).click();
  assert.equal(await groups.count(), 1);
  assert.equal(await groups.first().locator('.record-row').count(), 1);
  assert.equal(await groups.first().locator('.full-row').count(), 0);
  await groups.first().locator('.session-row').hover();
  assert.equal(await groups.first().locator('.session-row .archive-action').count(), 0, 'partial archive group has no connection archive button');
  await showMenu(groups.first().locator('.session-row'));
  assert.equal(await action('归档连接').count(), 0, 'partial archive group cannot archive the unarchived connection');
  await historyPage.keyboard.press('Escape');
  await groups.first().locator('.record-row').hover();
  assert.ok(await groups.first().getByRole('button', { name: '取消记录归档 · 连接测试', exact: true }).isVisible());
  await batchSelectAll.check();
  assert.equal(await historyPage.locator('.record-row input:checked').count(), 1);
  await showMenu(groups.first().locator('.record-row'));
  await action('取消记录归档').click();
  await historyPage.getByText('还没有已归档连接', { exact: true }).waitFor();
  await historyPage.getByRole('button', { name: '当前', exact: true }).click();
  await firstRecord.waitFor();
  assert.equal(await oldSession.locator('.record-row').count(), 2);
  await firstRecord.hover();
  await firstRecord.getByRole('button', { name: '归档记录 · 连接测试', exact: true }).click();
  await historyPage.getByRole('button', { name: '撤销', exact: true }).click();
  await firstRecord.waitFor();
  await oldSession.getByRole('checkbox', { name: '选择 重连测试' }).check();
  // Archive retains viewed logs and notes; failures leave the list untouched.
  await oldSession.locator('.record-row .history-item').first().click();
  const historyNotes = historyPage.getByPlaceholder('输入备注', { exact: true });
  await historyPage.evaluate(() => { window.failHistorySave = true; });
  await historyNotes.fill('归档前备注');
  await oldSession.locator('.session-row').hover();
  await oldSession.getByRole('button', { name: /归档连接/ }).click();
  await historyPage.getByText('Error: 模拟备注失败', { exact: true }).waitFor();
  assert.equal(await groups.count(), 2);
  assert.equal(await historyNotes.inputValue(), '归档前备注');
  await historyPage.evaluate(() => { window.failHistorySave = false; window.failArchive = true; });
  await oldSession.locator('.session-row').hover();
  await oldSession.getByRole('button', { name: /归档连接/ }).click();
  await historyPage.getByText('Error: 模拟归档失败', { exact: true }).waitFor();
  assert.equal(await groups.count(), 2);
  await historyPage.evaluate(() => { window.failArchive = false; });
  const beforeArchive = await historyPage.locator('.log-pane pre').textContent();
  await oldSession.locator('.session-row').hover();
  const sessionBounds = await oldSession.locator('.session-toggle').boundingBox();
  await oldSession.getByRole('button', { name: /归档连接/ }).click();
  await historyPage.getByRole('status').getByText('已归档连接').waitFor();
  assert.equal(await groups.count(), 1);
  assert.equal(await historyPage.locator('.log-pane pre').textContent(), beforeArchive);
  assert.equal(await historyNotes.inputValue(), '归档前备注');
  assert.equal(await historyPage.locator('.record-row input:checked').count(), 0);
  await historyPage.getByRole('button', { name: '已归档', exact: true }).click();
  assert.equal(await groups.count(), 1);
  assert.equal(await groups.first().locator('.record-row input:checked').count(), 0);
  await groups.first().locator('.session-row').hover();
  assert.ok(await groups.first().getByRole('button', { name: /取消归档/ }).isEnabled());
  await batchSelectAll.check();
  assert.equal(await historyPage.locator('.record-row input:checked').count(), 2);
  await historyPage.getByRole('button', { name: '当前', exact: true }).click();
  assert.equal(await historyPage.locator('.record-row input:checked').count(), 0);
  await historyPage.getByRole('button', { name: '撤销', exact: true }).click();
  await groups.nth(1).waitFor();
  assert.deepEqual(await oldSession.locator('.session-toggle').boundingBox(), sessionBounds);
  await historyPage.getByRole('button', { name: '刷新连接', exact: true }).click();
  await groups.nth(1).waitFor();
  await oldSession.getByRole('checkbox', { name: '选择 重连测试' }).check();
  await oldSession.locator('.session-row').hover();
  await oldSession.getByRole('button', { name: /归档连接/ }).click();
  await groups.nth(1).waitFor({ state: 'detached' });
  await historyPage.getByRole('button', { name: '刷新连接', exact: true }).click();
  await historyPage.getByRole('button', { name: '已归档', exact: true }).click();
  await groups.first().locator('.session-row').hover();
  await groups.first().getByRole('button', { name: /取消归档/ }).click();
  await historyPage.getByText('还没有已归档连接', { exact: true }).waitFor();
  await historyPage.getByRole('button', { name: '当前', exact: true }).click();
  await groups.nth(1).waitFor();
  await oldSession.getByRole('checkbox', { name: '选择 重连测试' }).check();
  if (process.env.TWINLOG_ARCHIVE_SCREENSHOT) {
    await historyPage.getByRole('button', { name: '完成', exact: true }).click();
    await oldSession.locator('.session-row').hover();
    await historyPage.screenshot({ path: process.env.TWINLOG_ARCHIVE_SCREENSHOT });
    await historyPage.getByRole('button', { name: '批量管理', exact: true }).click();
    await oldSession.getByRole('checkbox', { name: '选择 重连测试' }).check();
  }
  // Right-click on another row keeps the current log and batch selection.
  await showMenu(oldSession.locator('.full-row'));
  assert.equal(await historyPage.locator('.log-pane pre').textContent(), beforeArchive);
  assert.ok(await oldSession.getByRole('checkbox', { name: '选择 重连测试' }).isChecked());
  await historyPage.keyboard.press('Escape');
  await showMenu(oldSession.locator(".full-row"));
  await action("删除完整日志").click();
  await historyPage.getByText("已删除完整日志", { exact: true }).waitFor();
  assert.ok(await oldSession.locator(".full-row").isHidden());
  assert.equal(await oldSession.locator(".record-row").count(), 2);
  assert.ok(await oldSession.getByRole("checkbox", { name: "选择 重连测试" }).isChecked());
  assert.ok(await historyPage.getByRole("checkbox", { name: "附带完整日志" }).isDisabled());
  await showMenu(oldSession.locator(".session-row"));
  await action("删除连接").click();
  await historyPage.getByText("已删除连接", { exact: true }).waitFor();
  assert.equal(await groups.count(), 1);
  assert.deepEqual(await historyPage.evaluate(() => window.historyCalls.slice(3)), [["test/old", true], ["test/old", false]]);
  const historyConnection = historyPage.getByRole("tabpanel", { name: "设备连接", exact: true });
  const renameDialog = historyPage.getByRole("dialog", { name: "重命名连接" });
  await showMenu(activeSession.locator(".session-row"));
  await action("重命名连接").click();
  await renameDialog.getByRole("textbox", { name: "连接名称" }).fill("参数下发失败");
  await renameDialog.getByRole("button", { name: "保存", exact: true }).click();
  const named = activeSession.getByRole("button", { name: "参数下发失败，0 条记录", exact: true });
  await named.waitFor();
  await historyPage.getByRole("tab", { name: "设备连接", exact: true }).click();
  await historyConnection.getByRole("button", { name: "断开连接", exact: true }).click();
  await historyConnection.getByRole("button", { name: "连接设备", exact: true }).click();
  await historyPage.waitForFunction(() => document.querySelectorAll(".session-group").length === 2);
  assert.equal(await historyPage.getByRole("dialog", { name: "连接设备" }).count(), 0);
  const reconnected = groups.first();
  const previous = groups.nth(1);
  assert.equal(await previous.locator(".session-toggle span").textContent(), "参数下发失败");
  assert.ok(await reconnected.locator(".full-row .session-writing").isVisible());
  await showMenu(previous.locator(".session-row"));
  await action("重命名连接").click();
  assert.equal(await renameDialog.getByRole("textbox", { name: "连接名称" }).inputValue(), "参数下发失败");
  await renameDialog.getByRole("textbox", { name: "连接名称" }).fill("复测同一问题");
  await renameDialog.getByRole("button", { name: "保存", exact: true }).click();
  await previous.getByRole("button", { name: "复测同一问题，0 条记录", exact: true }).waitFor();
  assert.deepEqual(await historyPage.evaluate(() => window.sessionCalls), [
    { path: "test/live", title: "参数下发失败" }, "connect",
    { path: "test/live", title: "复测同一问题" },
  ]);
  await showMenu(reconnected.locator(".session-row"));
  assert.ok(await action("删除连接").isDisabled());
  await historyPage.keyboard.press("Escape");
  await showMenu(previous.locator(".session-row"));
  await action("删除连接").click();
  await historyPage.getByText("已删除连接", { exact: true }).waitFor();
  assert.equal(await groups.count(), 1);
  assert.deepEqual(await historyPage.evaluate(() => window.historyCalls.at(-1)), ["test/live", false]);
  console.log("PASS: optional batch selection, context and keyboard menus, archive/undo/failure scope, live shortcut, preview, export and deletion");
  console.log("PASS: direct reconnect, independent connection names and separate full logs");
} finally {
  await browser?.close();
  server.kill();
}
