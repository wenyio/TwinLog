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
        SaveConfig: async (next) => { Object.assign(config, next); window.savedPreviewLines = next.previewLines; },
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
    if (height === 720) {
      await page.getByRole("button", { name: "更多设置" }).click();
      const lineSetting = page.getByRole("combobox", { name: "预览行数" });
      assert.equal(await lineSetting.inputValue(), "2000");
      await lineSetting.selectOption("5000");
      await page.waitForFunction(() => window.savedPreviewLines === 5000 && !document.querySelector('.preview-lines-setting select').disabled);
      const pane = panes.nth(1), pre = pane.locator("pre");
      const clear = pane.getByRole("button", { name: "清空预览" });
      assert.equal(await clear.locator(".lucide-eraser").count(), 1);
      await clear.click();
      await page.evaluate(() => window.testLogs("android", 0, 5200));
      await pane.getByText("仅显示末尾 5000 行", { exact: true }).waitFor();
      assert.ok((await pre.textContent()).startsWith("android line 200\n"));
      const logBounds = await pre.boundingBox();
      const scrollAtOpen = await pre.evaluate((el) => el.scrollTop);
      await pre.focus();
      await page.keyboard.press("Control+f");
      const search = pane.getByRole("textbox", { name: "搜索当前预览" });
      await search.waitFor();
      assert.deepEqual(await pre.boundingBox(), logBounds, "search must not take up log space");
      assert.equal(await pre.evaluate((el) => el.scrollTop), scrollAtOpen, "opening search must not move the log");
      await search.fill("AndRoId line 201");
      await pane.getByText("1 / 11", { exact: true }).waitFor();
      const highlighted = () => page.evaluate(() => [...CSS.highlights.get("log-match")][0].toString());
      assert.equal(await highlighted(), "android line 201");
      await search.press("Enter");
      await pane.getByText("2 / 11", { exact: true }).waitFor();
      const match = await highlighted();
      const layout = page.getByRole("group", { name: "日志布局" });
      await layout.getByRole("button", { name: "上下", exact: true }).click();
      assert.equal(await search.inputValue(), "AndRoId line 201");
      assert.equal(await highlighted(), match);
      await layout.getByRole("button", { name: "MCU", exact: true }).click();
      assert.equal(await search.isVisible(), false);
      assert.equal(await page.evaluate(() => CSS.highlights.has("log-match")), false);
      await layout.getByRole("button", { name: "左右", exact: true }).click();
      await pane.getByText("2 / 11", { exact: true }).waitFor();
      assert.equal(await search.inputValue(), "AndRoId line 201");
      assert.equal(await highlighted(), match);
      await search.press("Shift+Enter");
      await pane.getByText("1 / 11", { exact: true }).waitFor();
      const snapshot = await pre.textContent();
      await page.evaluate(() => window.testLogs("android", 5200, 5500));
      await pane.getByText("1 / 11", { exact: true }).waitFor();
      assert.equal(await pre.textContent(), snapshot);
      await search.press("Escape");
      assert.equal(await search.count(), 0);
      assert.equal(await pre.textContent(), snapshot);
      await pane.getByRole("button", { name: "回到最新" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".log-pane pre")[1].textContent.endsWith("line 10699\n"));
      assert.ok(!(await pre.textContent()).includes("android line 201\n"));

      // A first-line match under the floating bar must be visible even at scrollTop = 0.
      await clear.click();
      await page.evaluate(() => window.testLogs("android" + " ".repeat(37) + "first-hit", 0, 100));
      await pre.getByText(/first-hit/).waitFor();
      await pane.getByRole("button", { name: "查找当前预览" }).click();
      await search.fill("first-hit line 0");
      const bar = pane.getByRole("search");
      await page.waitForFunction(() => document.querySelector(".log-search")?.hasAttribute("data-bottom"));
      assert.ok(await bar.evaluate((el) => {
        const hit = [...CSS.highlights.get("log-match")][0].getBoundingClientRect();
        const bar = el.getBoundingClientRect();
        return hit.bottom < bar.top;
      }));
      await page.setViewportSize({ width: 1080, height: 640 });
      await page.getByRole("separator", { name: "调整 MCU 与 Android 日志宽度" }).press("End");
      assert.ok(await bar.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const body = el.parentElement.getBoundingClientRect();
        const close = el.querySelector('[aria-label="关闭查找"]').getBoundingClientRect();
        return box.left >= body.left && box.right < body.right && close.right <= box.right;
      }), "search must fit the narrow split and keep close accessible");
      await search.press("Escape");
      await page.getByRole("button", { name: "MCU", exact: true }).click();
      await page.keyboard.press("Control+f");
      await panes.first().getByRole("textbox", { name: "搜索当前预览" }).waitFor();
      await page.keyboard.press("Escape");
    }
    await page.close();
    console.log("PASS: both panes scroll pause, return to latest/bottom, manual pause, eviction, clear and independence at height " + height);
  }
} finally {
  await browser?.close();
  server.kill();
}
