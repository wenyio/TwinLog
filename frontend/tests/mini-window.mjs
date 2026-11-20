import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const url = "http://127.0.0.1:5187";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5187", "--strictPort"], { stdio: "pipe" });
let output = "", browser;
server.stdout.on("data", (data) => output += data);
server.stderr.on("data", (data) => output += data);
try {
  for (let tries = 0; ; tries++) {
    if (server.exitCode !== null) throw Error(output);
    try { if ((await fetch(url)).ok) break; } catch {}
    if (tries === 100) throw Error(output);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, channel: process.platform === "win32" ? "msedge" : undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 780 }, screen: { width: 1920, height: 1080 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("resizeWindow", async (w, h) => page.setViewportSize({ width: Math.round(w), height: Math.round(h) }));
  await page.addInitScript(() => {
    localStorage.setItem("twinlog.mini-size", JSON.stringify({ w: 700, h: 620 }));
    const handlers = {};
    const config = { outputDir: "test", adbPath: "adb", serialPort: "COM1", androidSerial: "device", package: "com.example.audio", baudRate: 115200, saveFullLogs: true, previewLines: 2000 };
    const records = [];
    const state = { connected: true, capturing: false, sessionDir: "test/session", activeRecord: null, config, error: "", mcuBytes: 0, androidBytes: 0 };
    const emit = (name, value) => handlers[name]?.forEach((fn) => fn(structuredClone(value)));
    window.miniTest = { state, records, windowCalls: [], failSave: false, failStart: false, starts: 0, max: false, position: { x: 100, y: 80 } };
    const test = window.miniTest;
    window.runtime = {
      EventsOn(name, fn) { (handlers[name] ??= new Set()).add(fn); return () => handlers[name].delete(fn); },
      WindowGetSize: async () => ({ w: innerWidth, h: innerHeight }),
      WindowGetPosition: async () => test.position,
      WindowIsMaximised: async () => test.max,
      WindowSetMinSize: (w, h) => test.windowCalls.push(["min", w, h]),
      WindowSetSize: (w, h) => { test.windowCalls.push(["size", w, h]); window.resizeWindow(w, h); },
      WindowSetPosition: (x, y) => { test.position = { x, y }; },
      WindowSetAlwaysOnTop: (value) => test.windowCalls.push(["pin", value]),
      WindowUnmaximise: () => { test.max = false; },
      WindowMaximise: () => { test.max = true; },
      WindowToggleMaximise: () => { test.max = !test.max; },
      WindowMinimise: () => test.windowCalls.push(["minimise"]),
      Quit: () => emit("before-close"),
    };
    window.go = { main: { App: {
      SetCompactWindow: async (compact, w, h, pinned) => {
        if (compact) {
          test.original = { w: innerWidth, h: innerHeight, pinned, max: test.max };
          test.max = false;
          await window.resizeWindow(w, h);
          window.runtime.WindowSetAlwaysOnTop(true);
        } else {
          await window.resizeWindow(test.original.w, test.original.h);
          test.max = test.original.max;
          window.runtime.WindowSetAlwaysOnTop(test.original.pinned);
        }
      },
      GetConfig: async () => config, SaveConfig: async () => {}, GetState: async () => structuredClone(state),
      ListPorts: async () => [{ name: "COM1", description: "Test" }], ListDevices: async () => [{ serial: "device", state: "device", model: "Test" }],
      ListSessions: async () => [{ path: state.sessionDir, startedAt: new Date().toISOString(), managed: true, records: structuredClone(records), full: null }],
      StartCapture: async (title, notes) => {
        test.starts++;
        if (test.failStart) throw Error("模拟开始失败");
        const record = { path: "test/session/record", title, notes, package: config.package, startedAt: new Date().toISOString(), endedAt: "" };
        records.unshift(record); state.capturing = true; state.activeRecord = record; emit("state", state); return structuredClone(record);
      },
      StopCapture: async () => {
        const record = state.activeRecord; record.endedAt = new Date().toISOString(); state.activeRecord = null; state.capturing = false; emit("state", state); return structuredClone(record);
      },
      SaveNotes: async (path, notes) => { if (test.failSave) throw Error("模拟备注失败"); records.find((r) => r.path === path).notes = notes; },
      SaveTitle: async (path, title) => { records.find((r) => r.path === path).title = title; },
      SaveResult: async (path, result) => { records.find((r) => r.path === path).result = result; },
      ReadRecordLogs: async () => ({ mcu: { text: "MCU", bytes: 3 }, android: { text: "Android", bytes: 7 } }),
      ConfirmClose: async (ok) => { test.closeAck = ok; },
    } } };
  });
  await page.goto(url);
  await page.getByRole("tab", { name: "抓取", exact: true }).click();
  const title = page.getByRole("textbox", { name: "抓取标题", exact: true });
  const notes = page.getByPlaceholder("输入备注", { exact: true });
  await title.fill("切换小窗测试"); await notes.fill("草稿备注");
  const layout = await page.evaluate(() => localStorage.getItem("twinlog.layout"));
  const panelWidth = await page.locator(".operations").evaluate((panel) => panel.getBoundingClientRect().width);
  assert.equal(panelWidth, 308);
  await page.getByRole("button", { name: "切换小窗", exact: true }).click();
  await page.locator(".mini-window").waitFor();
  await page.waitForFunction((width) => innerWidth === width && innerHeight === 620, panelWidth);
  assert.equal(await title.inputValue(), "切换小窗测试"); assert.equal(await notes.inputValue(), "草稿备注");
  assert.ok(await notes.isVisible()); assert.ok(await page.getByRole("button", { name: "取消置顶", exact: true }).isVisible());
  const height = await page.evaluate(() => innerHeight);
  const before = (await notes.boundingBox()).height;
  await page.getByRole("button", { name: "开始抓取", exact: true }).click();
  await page.getByRole("button", { name: "停止并保存", exact: true }).waitFor();
  await title.fill("小窗中的标题"); await notes.fill("小窗中的备注");
  await page.getByRole("button", { name: "停止并保存", exact: true }).click();
  await page.getByRole("button", { name: "FAIL", exact: true }).click();
  assert.equal(await page.evaluate(() => innerHeight), height);
  assert.ok((await notes.boundingBox()).height < before, "results consume notes space without resizing the window");
  assert.equal(await page.evaluate(() => window.miniTest.records[0].result), "FAIL");
  await page.setViewportSize({ width: 282, height: 560 });
  const geometry = await page.evaluate(() => {
    const pane = document.querySelector("#operations-panel-capture"), field = pane.querySelector("textarea");
    return { overflow: pane.scrollHeight - pane.clientHeight, bottom: field.getBoundingClientRect().bottom, viewport: innerHeight, horizontal: document.documentElement.scrollWidth - innerWidth };
  });
  assert.ok(geometry.overflow <= 1, JSON.stringify(geometry)); assert.ok(geometry.bottom <= geometry.viewport); assert.equal(geometry.horizontal, 0);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/mini-saved.png" });
  await page.getByRole("button", { name: "展开主窗口", exact: true }).click();
  await page.waitForFunction(() => innerWidth === 1440 && innerHeight === 780);
  assert.equal(await notes.inputValue(), "小窗中的备注");
  assert.equal(await page.locator(".saved-record-title strong").textContent(), "小窗中的标题");
  assert.equal(await page.getByRole("button", { name: "FAIL", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.evaluate(() => localStorage.getItem("twinlog.layout")), layout);
  assert.deepEqual(await page.evaluate(() => window.miniTest.windowCalls.filter((v) => v[0] === "pin").map((v) => v[1])), [true, false]);
  await page.getByRole("button", { name: "切换小窗", exact: true }).click();
  await page.waitForFunction(() => innerWidth === 308 && innerHeight === 560);
  const grip = page.getByRole("button", { name: "调整小窗宽高", exact: true });
  await grip.focus(); await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => innerWidth === 318);
  await page.setViewportSize({ width: 350, height: 620 });
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 23, box.y + box.height - 23); await page.mouse.up();
  await page.waitForFunction(() => innerWidth === 330 && innerHeight === 600);
  await page.evaluate(() => { window.miniTest.failSave = true; });
  await notes.fill("保存失败应保留");
  await page.getByRole("button", { name: "展开主窗口", exact: true }).click();
  await page.getByText("Error: 模拟备注失败", { exact: true }).waitFor();
  assert.ok(await page.locator(".mini-window").isVisible()); assert.equal(await notes.inputValue(), "保存失败应保留");
  await page.evaluate(() => { window.miniTest.failSave = false; });
  await page.getByRole("button", { name: "展开主窗口", exact: true }).click();
  await page.waitForFunction(() => innerWidth === 1440);
  await page.evaluate(() => { window.miniTest.max = true; });
  await page.getByRole("button", { name: "切换小窗", exact: true }).click();
  await page.locator(".mini-window").waitFor();
  assert.equal(await page.evaluate(() => window.miniTest.max), false);
  await page.getByRole("button", { name: "展开主窗口", exact: true }).click();
  await page.waitForFunction(() => window.miniTest.max === true && innerWidth === 1440);
  await page.setViewportSize({ width: 1080, height: 780 });
  await page.getByRole("button", { name: "切换小窗", exact: true }).click();
  await page.waitForFunction(() => innerWidth === 282);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.waitForFunction(() => window.miniTest.closeAck === true);
  assert.equal(await page.evaluate(() => window.miniTest.records[0].notes), "保存失败应保留");
  assert.deepEqual(errors, []);
  console.log("PASS: panel-matched 308/282px entry width overrides old width, fixed height with flexible notes, result persistence, restore, resize, failed-save switch blocking and close flush");
} finally { await browser?.close(); server.kill(); }
