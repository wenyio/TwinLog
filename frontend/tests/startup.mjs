import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

// Test the production bundle with controlled pending bridge calls. No devices
// or user records are accessed, and no wall-clock performance threshold is used.
const url = "http://127.0.0.1:5185";
const server = spawn(process.execPath, [
  "node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1",
  "--port", "5185", "--strictPort",
], { stdio: "pipe" });
let output = "", browser;
server.stdout.on("data", (b) => output += b);
server.stderr.on("data", (b) => output += b);
try {
  for (let i = 0; ; i++) {
    if (server.exitCode !== null) throw Error(output);
    try { if ((await fetch(url)).ok) break; } catch {}
    if (i === 100) throw Error(output);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, channel: process.platform === "win32" ? "msedge" : undefined });
  for (const scenario of ["config", "history", "adb", "history-error", "ports-error", "adb-error", "directory"]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript((scenario) => {
      const config = { outputDir: "old", adbPath: "custom-adb", serialPort: "", androidSerial: "", package: "", baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", dtr: false, rts: false };
      const record = (root) => ({ path: root + "/record", title: root + "记录", notes: "", package: "", startedAt: "2026-11-18T01:00:00Z", endedAt: "2026-11-18T01:01:00Z" });
      let release;
      const pending = new Promise((resolve) => release = resolve);
      window.startup = { calls: [], release };
      const wait = async (name) => {
        window.startup.calls.push(name);
        if (scenario === name || ((scenario === "directory") && name === "history")) await pending;
        if (scenario === name + "-error") throw Error("模拟" + name + "失败");
      };
      window.go = { main: { App: {
        GetConfig: async () => { await wait("config"); return config; },
        GetState: async () => ({ connected: false, capturing: false, sessionDir: "", activeRecord: null, config, error: "", mcuBytes: 0, androidBytes: 0 }),
        ListPorts: async () => { await wait("ports"); return [{ name: "COM7", description: "测试串口" }]; },
        ListDevices: async (adb) => {
          if (adb !== "custom-adb") throw Error("未使用保存的 ADB 路径");
          await wait("adb"); return [{ serial: "test-device", state: "device", model: "测试设备" }];
        },
        ListSessions: async (root) => {
          if (root === "old") await wait("history");
          const r = record(root);
          return [{ path: root, startedAt: r.startedAt, managed: false, records: [r], full: null }];
        },
        SelectDirectory: async () => "new",
        SaveConfig: async () => {},
      } } };
      window.runtime = { EventsOn: () => () => {} };
    }, scenario);
    await page.goto(url);
    const ports = page.getByRole("combobox", { name: "串口", exact: true });
    const devices = page.getByRole("combobox", { name: "Android 设备", exact: true });
    const portReady = () => page.waitForFunction(() => !!document.querySelector('option[value="COM7"]'));
    const deviceReady = () => page.waitForFunction(() => !!document.querySelector('option[value="test-device"]'));
    if (scenario !== "ports-error") await portReady();
    if (scenario === "config") {
      assert.deepEqual(await page.evaluate(() => window.startup.calls), ["ports", "config"]);
    } else {
      await page.waitForFunction(() => ["history", "adb"].every((name) => window.startup.calls.includes(name)));
      if (scenario !== "adb" && scenario !== "adb-error") await deviceReady();
      if (scenario === "adb" || scenario === "ports-error" || scenario === "adb-error") {
        await page.getByText("old记录", { exact: true }).waitFor();
      }
      if (scenario === "history-error") await page.getByText("Error: 模拟history失败", { exact: true }).waitFor();
      if (scenario === "history" || scenario === "directory") assert.equal(await page.locator(".history-row").count(), 0);
      if (scenario === "adb") assert.equal(await devices.locator("option").count(), 1);
      if (scenario === "ports-error") assert.equal(await ports.locator("option").count(), 1);
      if (scenario === "directory") {
        await page.locator(".path-row .input-button button").click();
        await page.getByText("new记录", { exact: true }).waitFor();
      }
    }
    await page.evaluate(() => window.startup.release());
    if (scenario === "directory") {
      // Wait beyond the pending request's continuation and React commit.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator(".history-row strong").textContent(), "new记录");
    } else if (scenario !== "history-error") {
      await page.getByText("old记录", { exact: true }).waitFor();
    }
    if (scenario !== "adb-error") await deviceReady();
    assert.deepEqual(errors, [], scenario + ": unhandled browser errors");
    console.log("PASS: independent startup / " + scenario);
    await page.close();
  }

  const page = await browser.newPage();
  await page.addInitScript(() => {
    const config = JSON.parse(localStorage.getItem("test-baud-config")) ?? {
      outputDir: "test", adbPath: "adb", serialPort: "COM7", baudRate: 250000,
    };
    const handlers = {};
    const state = { connected: false, capturing: false, sessionDir: "", activeRecord: null, config, error: "", mcuBytes: 0, androidBytes: 0 };
    window.emitConnected = () => handlers.state({ ...state, connected: true });
    window.go = { main: { App: {
      GetConfig: async () => config,
      GetState: async () => state,
      ListPorts: async () => [{ name: "COM7", description: "测试串口" }],
      ListDevices: async () => [],
      ListSessions: async () => [],
      SaveConfig: async (next) => {
        if (window.failBaudSave) throw Error("模拟写入失败");
        localStorage.setItem("test-baud-config", JSON.stringify(next));
      },
    } } };
    window.runtime = { EventsOn: (name, handler) => { handlers[name] = handler; return () => {}; } };
  });
  await page.goto(url);
  const baud = page.getByRole("combobox", { name: "波特率", exact: true });
  const modal = page.getByRole("dialog", { name: "新增波特率", exact: true });
  const entry = modal.getByRole("textbox", { name: "波特率", exact: true });
  const save = modal.getByRole("button", { name: "保存", exact: true });
  const options = () => baud.locator("option").evaluateAll((items) => items.map((opt) => opt.value));
  const savedConfig = () => page.evaluate(() => JSON.parse(localStorage.getItem("test-baud-config")));
  await baud.locator('option[value="250000"]').waitFor({ state: "attached" });
  assert.equal(await baud.inputValue(), "250000");
  assert.deepEqual(await options(), ["9600", "19200", "115200", "250000", "460800", "1500000", "add"]);
  await baud.selectOption("1500000");
  await baud.selectOption("add");
  await entry.press("Escape");
  await modal.waitFor({ state: "hidden" });
  assert.equal(await baud.inputValue(), "1500000");
  assert.equal(await savedConfig(), null);

  await baud.selectOption("add");
  for (const invalid of ["0", "1.5", "4294967296"]) {
    await entry.fill(invalid);
    await save.click();
    await modal.getByRole("alert").getByText(/之间的整数/).waitFor();
  }
  assert.equal(await savedConfig(), null);
  await entry.fill("921600");
  await page.evaluate(() => { window.failBaudSave = true; });
  await save.click();
  await modal.getByRole("alert").getByText(/模拟写入失败/).waitFor();
  assert.equal(await entry.inputValue(), "921600");
  assert.equal(await savedConfig(), null);
  await page.evaluate(() => { window.failBaudSave = false; });
  await entry.press("Enter");
  await modal.waitFor({ state: "hidden" });
  assert.equal(await baud.inputValue(), "921600");
  assert.deepEqual((await savedConfig()).customBaudRates, [250000, 921600]);

  await page.reload();
  await baud.locator('option[value="921600"]').waitFor({ state: "attached" });
  assert.equal(await baud.inputValue(), "921600");
  await baud.selectOption("add");
  await entry.fill("250000");
  await save.click();
  await modal.waitFor({ state: "hidden" });
  assert.equal(await baud.inputValue(), "250000");
  assert.deepEqual(await options(), ["9600", "19200", "115200", "250000", "460800", "921600", "1500000", "add"]);
  assert.deepEqual((await savedConfig()).customBaudRates, [250000, 921600]);
  await page.evaluate(() => window.emitConnected());
  await page.locator('select:disabled').and(baud).waitFor();
  console.log("PASS: baud presets, legacy value, validation, retry, persistence and connection lock");
} finally {
  await browser?.close();
  server.kill();
}
