import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const url = "http://127.0.0.1:5189";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5189", "--strictPort"], { stdio: "pipe" });
let output = "", browser, page;
server.stdout.on("data", b => output += b); server.stderr.on("data", b => output += b);
try {
  for (let i = 0; ; i++) { if (server.exitCode !== null) throw Error(output); try { if ((await fetch(url)).ok) break; } catch {} if (i === 100) throw Error(output); await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ headless: true, channel: process.platform === "win32" ? "msedge" : undefined });
  page = await browser.newPage({ viewport: { width: 1440, height: 780 } });
  const errors = []; page.on("pageerror", e => { errors.push(e.message); console.error("Page error:", e.message); });
  await page.addInitScript(() => {
    const handlers = {}, files = {}, calls = [];
    const config = { outputDir: "test", serialPort: "COM1", androidSerial: "", baudRate: 115200, previewLines: 2000, saveFullLogs: true };
    const old = { path: "test/session/old", title: "历史记录", notes: "", startedAt: "2026-11-20T01:00:00Z", endedAt: "2026-11-20T01:01:00Z", source: "mcu" };
    const records = [old], state = { connected: true, capturing: false, sessionDir: "test/session", activeRecord: null, config, error: "" };
    const emit = (name, value) => handlers[name]?.forEach(fn => fn(structuredClone(value)));
    window.attachmentTest = { calls, files, records, state, emit, pending: null, nativeKind: "files", failOpen: false };
    const test = window.attachmentTest;
    window.runtime = { EventsOn(name, fn) { (handlers[name] ??= new Set()).add(fn); return () => handlers[name].delete(fn); } };
    window.go = { main: { App: {
      GetConfig: async () => config, GetState: async () => structuredClone(state), ListPorts: async () => [], ListDevices: async () => [],
      ListSessions: async () => [{ path: "test/session", startedAt: old.startedAt, managed: true, records: structuredClone(records), full: null }],
      SaveNotes: async (path, notes) => { records.find(r => r.path === path).notes = notes; }, SaveTitle: async () => {},
      StartCapture: async (title, notes) => { const r = { ...old, path: "test/session/new", title, notes, endedAt: "" }; records.unshift(r); state.activeRecord = r; state.capturing = true; emit("state", state); return r; },
      StopCapture: async () => { calls.push("stop"); const r = state.activeRecord; r.endedAt = old.endedAt; state.activeRecord = null; state.capturing = false; emit("state", state); return r; },
      ReadRecordLogs: async () => ({ mcu: { text: "test", bytes: 4 }, android: { text: "", bytes: 0 } }),
      ListAttachments: async path => structuredClone(files[path] || []), ClipboardAttachmentKind: async () => test.nativeKind,
      PasteAttachments: async path => { calls.push(["paste", path]); return new Promise((resolve, reject) => { test.pending = { path, resolve, reject }; emit("attachment-progress", { path, name: "截图.png", copied: 5, total: 10 }); }); },
      CancelAttachmentImport: async () => { calls.push("cancel"); test.pending?.reject(Error("context canceled")); test.pending = null; },
      ImportAttachmentFiles: async path => { calls.push(["select", path]); const item = { name: "device.json", bytes: 2 }; (files[path] ??= []).push(item); return [item]; },
      RenameAttachment: async (path, name, base) => { calls.push(["rename", path, name, base]); if (base === "冲突") throw Error("已存在同名附件"); files[path].find(f => f.name === name).name = base + ".png"; },
      RemoveAttachment: async (path, name) => { files[path] = files[path].filter(f => f.name !== name); }, OpenAttachment: async (...args) => { calls.push(["open", ...args]); if (test.failOpen) throw Error("无法打开附件：没有关联应用\n请安装可以打开此文件的程序后重试。"); }, SaveResult: async () => {},
    } } };
    test.complete = () => { const p = test.pending; const item = { name: "截图.png", bytes: 10 }; (files[p.path] ??= []).push(item); p.resolve([item]); test.pending = null; };
    test.paste = (selector, type = "image") => { const data = new DataTransfer(); if (type === "text") data.setData("text/plain", "普通文本"); if (type === "image") data.items.add(new File(["image"], "image.png", { type: "image/png" })); const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }); document.querySelector(selector).dispatchEvent(event); return event.defaultPrevented; };
  });
  await page.goto(url); await page.getByRole("tab", { name: "抓取", exact: true }).click();
  const notes = page.getByRole("textbox", { name: "备注", exact: true });
  const notesTab = page.getByRole("tab", { name: "备注", exact: true });
  const attachmentsTab = page.getByRole("tab", { name: /^附件 ·/ });
  assert.equal(await notes.getAttribute("placeholder"), "输入备注，可粘贴图片或文件作为附件");
  assert.equal(await page.evaluate(() => attachmentTest.paste(".notes-card textarea", "text")), false);
  assert.equal(await page.evaluate(() => attachmentTest.paste(".title-input")), false);
  assert.equal(await page.evaluate(() => attachmentTest.calls.length), 0);
  await page.getByRole("button", { name: "开始抓取", exact: true }).click();
  assert.equal(await page.evaluate(() => attachmentTest.paste(".notes-card textarea")), true);
  await page.waitForFunction(() => !!attachmentTest.pending);
  assert.ok(await page.getByRole("button", { name: "停止并保存", exact: true }).isEnabled());
  await page.getByRole("button", { name: "停止并保存", exact: true }).click();
  await page.getByRole("button", { name: "历史记录", exact: true }).click();
  await page.evaluate(() => attachmentTest.complete());
  await page.waitForFunction(() => attachmentTest.files["test/session/new"]?.length === 1);
  assert.equal(await notesTab.getAttribute("aria-selected"), "true", "background import does not switch the current record tab");
  assert.equal(await page.locator(".attachment-list li").count(), 0, "old target does not leak into selected record");
  // Native fallback for Explorer's empty DOM clipboard payload.
  await page.evaluate(() => attachmentTest.paste(".notes-card textarea", "empty"));
  await page.waitForFunction(() => attachmentTest.pending?.path === "test/session/old");
  await page.evaluate(() => attachmentTest.complete());
  await page.getByRole("button", { name: "打开附件：截图.png", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector(".attachment-feedback").textContent.includes("已添加 1 个"));
  assert.equal(await page.locator(".notifications .notification").count(), 0, "attachment success stays local");
  const successGeometry = await page.locator(".attachment-list").boundingBox();
  await page.waitForFunction(() => !document.querySelector(".attachment-feedback").textContent);
  assert.deepEqual(await page.locator(".attachment-list").boundingBox(), successGeometry, "success expiry does not move files");
  await page.getByRole("button", { name: "打开附件：截图.png", exact: true }).click({ button: "right" }); await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const dialog = page.getByRole("dialog"); const name = dialog.getByRole("textbox", { name: "附件文件名" });
  assert.equal(await name.inputValue(), "截图"); await name.fill("冲突"); await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "已存在同名附件" }).waitFor(); assert.equal(await name.inputValue(), "冲突");
  await name.fill("现场超时"); await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "打开附件：现场超时.png", exact: true }).waitFor();
  assert.equal(await page.locator(".attachment-feedback").textContent(), "", "rename succeeds without a notice");
  const file = page.getByRole("button", { name: "打开附件：现场超时.png", exact: true });
  const openCount = () => page.evaluate(() => attachmentTest.calls.filter(c => c[0] === "open").length);
  const initialOpens = await openCount();
  await file.click();
  await page.waitForFunction(n => attachmentTest.calls.filter(c => c[0] === "open").length === n + 1, initialOpens);
  await file.dblclick(); await page.getByRole("dialog").waitFor();
  await page.waitForTimeout(600); assert.equal(await openCount(), initialOpens + 1, "double click only renames");
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await file.focus(); await page.keyboard.press("Shift+F10"); await page.getByRole("menu", { name: "附件操作" }).waitFor();
  await page.keyboard.press("Escape"); assert.equal(await file.evaluate(el => el === document.activeElement), true);
  // Attachment failures stay in their section, without replacing device errors.
  await page.evaluate(() => { attachmentTest.failOpen = true; attachmentTest.emit("error", "测试设备连接错误"); });
  await file.press("Enter");
  const localError = page.locator(".attachment-error"); await localError.waitFor();
  assert.equal(await page.locator(".notifications .notification").count(), 1);
  assert.ok((await page.locator(".notifications").textContent()).includes("测试设备连接错误"));
  await localError.getByRole("button", { name: "详情", exact: true }).press("Enter");
  assert.ok((await page.locator(".attachment-error-details").textContent()).includes("请安装"));
  await localError.getByRole("button", { name: "关闭附件错误", exact: true }).press("Enter");
  await localError.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".notifications .notification").count(), 1, "dismissing a local error preserves device notification");
  await page.locator(".notifications .notification .icon").click();
  await page.evaluate(() => { attachmentTest.failOpen = false; });
  await file.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".attachment-file").disabled);
  assert.equal(await localError.count(), 0, "retry can succeed");
  const add = page.getByRole("button", { name: "添加附件", exact: true });
  const panelBefore = await page.locator(".attachment-container").boundingBox();
  await add.click();
  const addMenu = page.getByRole("menu", { name: "添加附件", exact: true }); await addMenu.waitFor();
  assert.deepEqual(await page.locator(".attachment-container").boundingBox(), panelBefore, "floating menu does not consume panel space");
  await page.keyboard.press("ArrowDown"); assert.ok(await addMenu.getByRole("menuitem", { name: /从剪贴板粘贴/ }).evaluate(el => el === document.activeElement));
  await page.keyboard.press("Escape"); assert.ok(await add.evaluate(el => el === document.activeElement));
  await add.click(); await addMenu.waitFor(); await add.click(); await addMenu.waitFor({ state: "hidden" });
  await add.click(); await notesTab.click(); await addMenu.waitFor({ state: "hidden" });
  await add.click(); await addMenu.getByRole("menuitem", { name: "选择文件…", exact: true }).click();
  await page.getByRole("button", { name: "打开附件：device.json", exact: true }).waitFor();
  const remove = page.getByRole("button", { name: "移除附件：device.json", exact: true });
  await page.mouse.move(0, 0); await add.focus(); assert.equal(await remove.evaluate(el => getComputedStyle(el).opacity), "0");
  await page.getByRole("button", { name: "打开附件：device.json", exact: true }).hover(); assert.equal(await remove.evaluate(el => getComputedStyle(el).opacity), "1");
  await remove.click(); await page.waitForFunction(() => !attachmentTest.files["test/session/old"].some(f => f.name === "device.json"));
  assert.equal(await openCount(), initialOpens + 3, "remove does not open the file");
  assert.equal(await page.locator(".attachment-feedback").textContent(), "", "remove succeeds without a notice");
  assert.equal(await page.locator(".notifications .notification").count(), 0);
  await notesTab.click();
  await page.evaluate(() => attachmentTest.paste(".notes-card textarea")); await page.waitForFunction(() => !!attachmentTest.pending);
  await page.getByRole("button", { name: "取消附件导入", exact: true }).click(); await page.waitForFunction(() => attachmentTest.calls.includes("cancel"));
  await page.waitForFunction(() => !attachmentTest.pending);
  // Explorer may produce no DOM paste event. A shortcut-only native fallback
  // must still import once; plain text's DOM event must suppress that fallback.
  await page.evaluate(() => { document.querySelector(".notes-card textarea").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "v", ctrlKey: true })); });
  await page.waitForFunction(() => !!attachmentTest.pending);
  await page.evaluate(() => attachmentTest.complete());
  await page.getByRole("button", { name: "打开附件：截图.png", exact: true }).waitFor();
  const beforePaste = await page.evaluate(() => attachmentTest.calls.filter(c => c[0] === "paste").length);
  await notesTab.click();
  await page.evaluate(() => { document.querySelector(".notes-card textarea").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "v", ctrlKey: true })); attachmentTest.paste(".notes-card textarea", "text"); });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => attachmentTest.calls.filter(c => c[0] === "paste").length), beforePaste);
  await attachmentsTab.click();
  await page.setViewportSize({ width: 282, height: 560 }); await page.locator(".desktop-frame").evaluate(el => el.classList.add("mini-window"));
  await page.locator(".attachment-container").scrollIntoViewIfNeeded();
  // A long basename truncates while the complete extension remains visible.
  await page.getByRole("button", { name: "打开附件：截图.png", exact: true }).dblclick();
  await page.getByRole("dialog").getByRole("textbox", { name: "附件文件名" }).fill("很长的现场截图文件名".repeat(8));
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  const longFile = page.locator(".attachment-file").filter({ hasText: "很长的现场" }); await longFile.waitFor();
  const filename = await longFile.evaluate(el => { const base = el.querySelector(".attachment-basename"), ext = el.querySelector(".attachment-extension"); return { truncated: base.scrollWidth > base.clientWidth, ext: ext.textContent, extFits: ext.scrollWidth <= ext.clientWidth + 1 }; });
  assert.deepEqual(filename, { truncated: true, ext: ".png", extFits: true });
  assert.equal(await page.locator(".notifications .notification").count(), 0, "attachment actions never create global notifications");
  await page.mouse.move(0, 0); await add.focus();
  assert.equal(await notes.isVisible(), false);
  const geometry = await page.locator(".attachments-card").evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth, right: el.getBoundingClientRect().right }));
  assert.ok(geometry.scroll <= geometry.width + 1 && geometry.right <= 282, JSON.stringify(geometry));
  await mkdir("../.tools/attachment-qa", { recursive: true }); await page.screenshot({ path: "../.tools/attachment-qa/mini-attachments.png" });
  const beforeAdd = await page.locator(".attachment-container").boundingBox();
  await add.click(); await addMenu.waitFor();
  const menuRect = await addMenu.boundingBox();
  assert.ok(menuRect.x >= 0 && menuRect.y >= 0 && menuRect.x + menuRect.width <= 282 && menuRect.y + menuRect.height <= 560, JSON.stringify(menuRect));
  assert.deepEqual(await page.locator(".attachment-container").boundingBox(), beforeAdd);
  await page.screenshot({ path: "../.tools/attachment-qa/mini-add-menu.png" });
  await addMenu.getByRole("menuitem", { name: /从剪贴板粘贴/ }).click();
  await page.waitForFunction(() => !!attachmentTest.pending); await addMenu.waitFor({ state: "hidden" });
  await page.evaluate(() => attachmentTest.complete());
  await page.waitForFunction(() => document.querySelector(".attachment-feedback").textContent.includes("已添加"));
  await page.getByRole("button", { name: "打开附件：截图.png", exact: true }).waitFor();
  await add.focus(); await page.mouse.move(0, 0);
  await page.screenshot({ path: "../.tools/attachment-qa/mini-attachment-feedback.png" });
  const feedbackGeometry = await page.locator(".attachment-list").boundingBox();
  const headerGeometry = await page.locator(".attachments-card > header").evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(headerGeometry.scroll <= headerGeometry.width + 1, JSON.stringify(headerGeometry));
  await page.waitForFunction(() => !document.querySelector(".attachment-feedback").textContent);
  assert.deepEqual(await page.locator(".attachment-list").boundingBox(), feedbackGeometry);
  assert.equal(await page.locator(".notifications .notification").count(), 0);
  await page.evaluate(() => { attachmentTest.failOpen = true; });
  await page.getByRole("button", { name: "打开附件：截图.png", exact: true }).press("Enter");
  await localError.waitFor();
  await localError.getByRole("button", { name: "详情", exact: true }).click();
  const errorGeometry = await localError.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(errorGeometry.scroll <= errorGeometry.width + 1, JSON.stringify(errorGeometry));
  await page.screenshot({ path: "../.tools/attachment-qa/mini-attachment-error.png" });
  await localError.getByRole("button", { name: "关闭附件错误", exact: true }).click();
  await localError.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log("PASS: local success expiry without layout shifts, local error details/dismiss/retry, preserved device notifications, silent rename/remove, add menu, paste target, stop during import, context menu, single open/double rename, hover remove, extension, cancellation and 282px layout");
} catch (e) {
  if (page) console.error("Page at failure:", await page.locator("body").innerText().catch(() => "unavailable"));
  throw e;
} finally { await browser?.close(); server.kill(); }
