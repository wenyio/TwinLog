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
        ListSessions: async () => [], ListPorts: async () => [], ListDevices: async () => [],
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
    const layoutButtons = page.getByRole("group", { name: "日志布局" });
    assert.deepEqual(await layoutButtons.getByRole("button").allTextContents(), ["上下", "左右", "MCU", "Android"]);
    assert.equal(await layoutButtons.getByRole("button", { name: "上下", exact: true }).getAttribute("aria-pressed"), "true");
    if (height === 940) {
      for (const saved of ["invalid json", JSON.stringify({ mode: "unknown", left: false, right: false })]) {
        await page.evaluate((saved) => localStorage.setItem("twinlog.layout", saved), saved);
        await page.reload();
        await page.waitForFunction(() => window.testReady?.());
        assert.equal(await layoutButtons.getByRole("button", { name: "上下", exact: true }).getAttribute("aria-pressed"), "true");
      }
      await page.evaluate(() => localStorage.removeItem("twinlog.layout"));
      await page.reload();
      await page.waitForFunction(() => window.testReady?.());
    }
    // Continue the existing scrolling and search coverage in its original layout.
    await layoutButtons.getByRole("button", { name: "左右", exact: true }).click();
    const panes = page.locator(".log-pane");
    for (const [index, source] of ["mcu", "android"].entries()) {
      const pane = panes.nth(index), pre = pane.locator("pre");
      const originalBounds = await pre.boundingBox();
      await page.evaluate((source) => window.testLogs(source, 0, 2200), source);
      await pre.getByText(source + " line 2199", { exact: false }).waitFor();
      assert.deepEqual(await pre.boundingBox(), originalBounds, "truncation must not take up log space");
      assert.equal(await pane.locator("footer").count(), 0);
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

      // Save on release, then reload without waiting for a persistence timer.
      await layout.getByRole("button", { name: "上下", exact: true }).click();
      const rowDivider = page.getByRole("separator", { name: "调整 MCU 与 Android 日志高度" });
      const { x, y, width, height } = await rowDivider.boundingBox();
      await page.mouse.move(x + width / 2, y + height / 2);
      await page.mouse.down();
      await page.mouse.move(x + width / 2, y + height / 2 - 65);
      const rowRatio = Number(await rowDivider.getAttribute("aria-valuenow"));
      assert.ok(rowRatio < 50);
      await page.mouse.up();
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("twinlog.split")));
      assert.equal(Math.round(saved.rows), rowRatio);
      assert.equal(saved.columns, 80);
      await page.reload();
      await rowDivider.waitFor();
      assert.equal(await rowDivider.getAttribute("aria-valuenow"), String(rowRatio));
      await layout.getByRole("button", { name: "左右", exact: true }).click();
      assert.equal(await page.getByRole("separator", { name: "调整 MCU 与 Android 日志宽度" }).getAttribute("aria-valuenow"), "80");
      console.log("PASS: layout and independent split ratios survive immediate reload after drag");
    }
    await page.close();
    console.log("PASS: both panes scroll pause, return to latest/bottom, manual pause, eviction, clear and independence at height " + height);
  }
  // Connection context and full-log entry stay reachable while browsing long groups.
  const historyPage = await browser.newPage({ viewport: { width: 1080, height: 640 } });
  await historyPage.addInitScript(() => {
    const config = { outputDir: 'test' };
    const sessions = Array.from({ length: 3 }, (_, group) => ({
      path: `test/session${group}`, title: `连接 ${group}`, startedAt: '2026-11-19T06:00:00Z', managed: true,
      full: group === 1 ? null : { path: `test/session${group}/full`, bytes: 1024, source: 'android' },
      records: Array.from({ length: 35 }, (_, index) => ({
        path: `test/session${group}/record${index}`, title: `记录 ${group}-${index}`, notes: '',
        startedAt: '2026-11-19T06:00:00Z', endedAt: '2026-11-19T06:01:00Z', source: 'android',
      })),
    }));
    window.go = { main: { App: {
      GetConfig: async () => config,
      GetState: async () => ({ connected: false, capturing: false, sessionDir: '', config }),
      ListSessions: async () => sessions, ListPorts: async () => [], ListDevices: async () => [],
      ReadFullLogs: async (path) => {
        window.readFullPath = path;
        return { mcu: { text: '', bytes: 0 }, android: { text: '完整日志内容', bytes: 18 } };
      },
    } } };
  });
  await historyPage.goto(url);
  const groups = historyPage.locator('.session-group');
  await groups.nth(2).waitFor();
  await groups.nth(1).locator('.session-toggle').click();
  await groups.nth(2).locator('.session-toggle').click();
  const list = historyPage.locator('.history-list');
  const scrollGroup = async (index) => {
    await groups.nth(index).evaluate((el) => { el.closest('.history-list').scrollTop = el.offsetTop - el.closest('.history-list').offsetTop + 300; });
    await historyPage.waitForFunction((index) => {
      const list = document.querySelector('.history-list');
      const header = list.querySelectorAll('.session-header')[index];
      return Math.abs(header.getBoundingClientRect().top - list.getBoundingClientRect().top) < 1;
    }, index);
  };
  for (const width of [1080, 1440]) {
    await historyPage.setViewportSize({ width, height: 640 });
    for (const index of [0, 1, 2, 1, 0]) {
      await scrollGroup(index);
      const group = groups.nth(index);
      assert.ok(await group.locator('.session-toggle').isVisible());
      assert.ok(await group.locator('.record-row').first().evaluate((el) =>
        el.getBoundingClientRect().top < el.closest('.history-list').getBoundingClientRect().top));
      assert.ok(await group.locator('.session-header').evaluate((el) => {
        const box = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(box.left + box.width / 2, box.bottom - 4));
      }), 'scrolled records must stay behind the pinned header');
      if (index !== 1) {
        const row = await group.locator('.session-row').boundingBox();
        const full = await group.locator('.full-row').boundingBox();
        assert.equal(full.y, row.y + row.height, 'full logs stay immediately under connection');
      } else {
        assert.equal(await group.locator('.full-row').count(), 0);
      }
    }
  }
  await groups.first().locator('.full-row button').click();
  await historyPage.waitForFunction(() => window.readFullPath === 'test/session0');
  await groups.first().locator('.session-toggle').click();
  assert.ok(await groups.first().locator('.full-row').isHidden());
  assert.ok(await groups.first().locator('.session-children').isHidden());
  await groups.first().locator('.session-toggle').click();
  await scrollGroup(0);
  assert.ok(await groups.first().locator('.full-row').isVisible());
  await list.screenshot({ path: 'test-results/session-sticky-header.png' });
  await historyPage.close();
  console.log('PASS: pinned connection and full logs, group transitions in both directions, no-full group, collapse and full-log navigation');
} finally {
  await browser?.close();
  server.kill();
}
