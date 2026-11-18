import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

// Uses synthetic Wails log events; no devices or log files are touched.
const url = "http://127.0.0.1:5181";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5181", "--strictPort"], { stdio: "pipe" });
let output = "";
server.stdout.on("data", (b) => { output += b; });
server.stderr.on("data", (b) => { output += b; });
let browser;
try {
  for (let tries = 0; ; tries++) {
    if (server.exitCode !== null) throw new Error(output);
    try { if ((await fetch(url)).ok) break; } catch {}
    if (tries === 100) throw new Error("Vite did not become ready: " + output);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
  for (const height of [940, 720]) {
    const page = await browser.newPage({ viewport: { width: 1440, height } });
    await page.addInitScript(() => {
      const handlers = {};
      const config = { outputDir: "test", adbPath: "adb", serialPort: "COM1", androidSerial: "test", package: "", baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", dtr: false, rts: false };
      window.go = { main: { App: {
        GetConfig: async () => config,
        GetState: async () => ({ connected: false, capturing: false, sessionDir: "", activeRecord: null, config, error: "", mcuBytes: 0, androidBytes: 0 }),
        ListRecords: async () => [], ListPorts: async () => [], ListDevices: async () => [],
      } } };
      window.runtime = { EventsOn: (name, fn) => {
        (handlers[name] ??= new Set()).add(fn);
        return () => handlers[name].delete(fn);
      } };
      window.testLogs = (source, start, count) => {
        const text = Array.from({ length: count }, (_, i) => source + " line " + (start + i)).join("\n") + "\n";
        handlers.logs.forEach((fn) => fn({ source, text }));
      };
      window.testReady = () => !!handlers.logs?.size;
    });
    await page.goto(url);
    await page.waitForFunction(() => window.testReady?.());
    const panes = page.locator(".log-pane");
    for (const [index, source] of ["mcu", "android"].entries()) {
      const pane = panes.nth(index), pre = pane.locator("pre");
      await page.evaluate((source) => window.testLogs(source, 0, 2200), source);
      await pre.getByText(source + " line 2199", { exact: false }).waitFor();
      await page.waitForFunction((index) => {
        const el = document.querySelectorAll(".log-pane pre")[index];
        return el.scrollHeight > el.clientHeight && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2;
      }, index);
      await pre.evaluate((el) => { el.scrollTop = 200; });
      const latest = pane.getByRole("button", { name: "回到最新", exact: true });
      await latest.waitFor();
      const frozen = await pre.textContent();
      const scrollTop = await pre.evaluate((el) => el.scrollTop);
      await page.evaluate((source) => window.testLogs(source, 2200, 2500), source);
      await page.waitForTimeout(100);
      assert.equal(await pre.textContent(), frozen, source + ": paused preview changed after buffer eviction");
      assert.equal(await pre.evaluate((el) => el.scrollTop), scrollTop, source + ": paused scroll moved");
      if (source === "mcu") {
        await latest.click();
      } else {
        await pre.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      }
      await page.waitForFunction((index) => {
        const el = document.querySelectorAll(".log-pane pre")[index];
        return el.textContent.includes("line 4699") && Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2;
      }, index);
      assert.ok(!(await pre.textContent()).includes(source + " line 2199"));
      // Pause/clear must not unpause, nor reintroduce newly arriving lines.
      await pane.getByRole("button", { name: "暂停自动滚动", exact: true }).click();
      await pane.getByTitle("清空预览，不影响保存", { exact: true }).click();
      await page.evaluate((source) => window.testLogs(source, 5000, 30), source);
      await page.waitForTimeout(100);
      assert.ok(!(await pre.textContent()).includes("line 5029"));
      assert.ok(await latest.isVisible());
      await latest.click();
      await page.waitForFunction((index) => document.querySelectorAll(".log-pane pre")[index].textContent.includes("line 5029"), index);
    }
    // Each pane owns its pause state.
    await panes.first().getByRole("button", { name: "暂停自动滚动", exact: true }).click();
    const mcuFrozen = await panes.first().locator("pre").textContent();
    await page.evaluate(() => { window.testLogs("mcu", 6000, 10); window.testLogs("android", 6000, 10); });
    await page.waitForFunction(() => document.querySelectorAll(".log-pane pre")[1].textContent.includes("line 6009"));
    assert.equal(await panes.first().locator("pre").textContent(), mcuFrozen);
    await page.close();
    console.log("PASS: both panes scroll pause, return to latest/bottom, manual pause, eviction, clear and independence at height " + height);
  }
} finally {
  await browser?.close();
  server.kill();
}
