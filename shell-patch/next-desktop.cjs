#!/usr/bin/env node
/**
 * Transparency patch for anywhere-labs DSH NEXT (dsh-desktop-next).
 *
 * Upstream shell-patch/auto.cjs only matches @deepseek-ai/dsh-desktop. This
 * fork's window is created opaque on Windows (`windowMaterial()` returns "off",
 * then `setBackgroundColor` paints #1b1b1c), so the theme's already-transparent
 * boot plate has nothing to show through.
 *
 * What this changes, and only this:
 *   - primary Windows window: transparent + clear background, unless
 *     DSH_DESKTOP_BOOT_CHROME=0
 *   - applyWindowMaterial no longer paints an opaque plate over that window
 *   - caption overlay uses rgba(0,0,0,0); a boot-chrome IPC hides the glyphs
 *     while the theme asks, and ignores the shell's own palette repaint
 *   - packaged index.html forces a transparent first frame until the theme
 *     sets data-mar-boot, or the real app replaces the DSH boot plate
 *
 *   node shell-patch/next-desktop.cjs --app "C:/.../DSH NEXT"
 *   node shell-patch/next-desktop.cjs --app "C:/.../DSH NEXT" --revert
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const asar = require('./lib/asar.cjs');

const MARKER = 'dsh-theme-mls-next';
const APP_ASAR = 'resources/app.asar';

function fail(message) {
  console.error('next-desktop: ' + message);
  process.exit(1);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) fail('missing value for ' + flag);
  return value;
}

function replaceOnce(text, needle, replacement, label) {
  const count = text.split(needle).length - 1;
  if (count !== 1) fail(label + ': expected 1 match, found ' + count);
  return text.replace(needle, replacement);
}

function unpackedPaths(archive) {
  const { header } = asar.readHeader(archive);
  const out = [];
  const walk = (node, relative) => {
    const files = node.files || {};
    for (const name of Object.keys(files)) {
      const entry = files[name];
      const rel = relative ? relative + '/' + name : name;
      if (entry.files) walk(entry, rel);
      else if (entry.unpacked === true) out.push(rel);
    }
  };
  walk(header, '');
  return out;
}

function patchMain(text) {
  if (text.includes(MARKER)) return text;
  if (!/const WINDOWS_CAPTION_FILL = "#00000000";/.test(text)) {
    fail('WINDOWS_CAPTION_FILL anchor missing or already changed');
  }
  text = text.replace(
    'const WINDOWS_CAPTION_FILL = "#00000000";',
    [
      'const WINDOWS_CAPTION_FILL = "rgba(0, 0, 0, 0)";',
      '/** ' + MARKER + ': per-pixel boot window. Set DSH_DESKTOP_BOOT_CHROME=0 to keep the opaque shell. */',
      'function bootChromeEnabled() {',
      '\treturn process.env.DSH_DESKTOP_BOOT_CHROME !== "0";',
      '}'
    ].join('\n')
  );

  const windowAnchor = [
    '\t\t...process.platform === "win32" && primary ? {',
    '\t\t\ttitleBarStyle: "hidden",',
    '\t\t\ttitleBarOverlay: {'
  ].join('\n');
  text = replaceOnce(
    text,
    windowAnchor,
    [
      '\t\t...process.platform === "win32" && primary ? {',
      '\t\t\ttitleBarStyle: "hidden",',
      '\t\t\t...bootChromeEnabled() ? { transparent: true, backgroundColor: "#00000000" } : {},',
      '\t\t\ttitleBarOverlay: {'
    ].join('\n'),
    'createWindow transparent options'
  );

  const materialAnchor = 'window.setBackgroundColor(material === "off" ? nativeTheme.shouldUseDarkColors ? "#1b1b1c" : "#f9fafb" : "#00000000");';
  text = replaceOnce(
    text,
    materialAnchor,
    [
      'const opaqueFill = nativeTheme.shouldUseDarkColors ? "#1b1b1c" : "#f9fafb";',
      '\tconst keepAlpha = process.platform === "win32" && bootChromeEnabled();',
      '\twindow.setBackgroundColor(keepAlpha ? "#00000000" : material === "off" ? opaqueFill : "#00000000");'
    ].join('\n'),
    'applyWindowMaterial background'
  );

  const appearanceAnchor = [
    'if (validColor(symbolColor)) mainWindow.setTitleBarOverlay({',
    '\t\t\t\tcolor: WINDOWS_CAPTION_FILL,',
    '\t\t\t\tsymbolColor',
    '\t\t\t});'
  ].join('\n');
  text = replaceOnce(
    text,
    appearanceAnchor,
    [
      'if (validColor(symbolColor)) {',
      '\t\t\t\tparkedCaptionSymbol = symbolColor;',
      '\t\t\t\tif (!bootChromeSuppressed) mainWindow.setTitleBarOverlay({',
      '\t\t\t\t\tcolor: WINDOWS_CAPTION_FILL,',
      '\t\t\t\t\tsymbolColor,',
      '\t\t\t\t\theight: 40',
      '\t\t\t\t});',
      '\t\t\t}'
    ].join('\n'),
    'windowsAppearance guard'
  );

  const ipcAnchor = 'ipcMain.on(IPC.windowsAppearance, (event, language, sidebarFill, symbolColor) => {';
  text = replaceOnce(
    text,
    ipcAnchor,
    [
      'let bootChromeSuppressed = false;',
      '\tlet parkedCaptionSymbol = null;',
      '\tipcMain.on("dsh-desktop:boot-chrome", (event, visible) => {',
      '\t\tif (!bootChromeEnabled() || process.platform !== "win32") return;',
      '\t\tif (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;',
      '\t\tconst frame = event.senderFrame;',
      '\t\tif (frame && (frame !== mainWindow.webContents.mainFrame || !String(frame.url || "").startsWith("dsh-app://app/"))) return;',
      '\t\tif (typeof visible !== "boolean") return;',
      '\t\tbootChromeSuppressed = visible === false;',
      '\t\tconst symbol = parkedCaptionSymbol || (nativeTheme.shouldUseDarkColors ? "#f9fafb" : "#0f1115");',
      '\t\tconst hidden = "rgba(0, 0, 0, 0)";',
      '\t\ttry {',
      '\t\t\tmainWindow.setTitleBarOverlay(visible ? {',
      '\t\t\t\tcolor: WINDOWS_CAPTION_FILL,',
      '\t\t\t\tsymbolColor: symbol,',
      '\t\t\t\theight: 40',
      '\t\t\t} : {',
      '\t\t\t\tcolor: hidden,',
      '\t\t\t\tsymbolColor: hidden,',
      '\t\t\t\theight: 40',
      '\t\t\t});',
      '\t\t\tconsole.log("[dsh-theme-mls-next] boot chrome " + (visible ? "restored" : "hidden"));',
      '\t\t} catch (error) {',
      '\t\t\tconsole.error("[dsh-theme-mls-next] boot chrome failed", error);',
      '\t\t}',
      '\t});',
      '\tipcMain.on(IPC.windowsAppearance, (event, language, sidebarFill, symbolColor) => {'
    ].join('\n'),
    'boot-chrome ipc'
  );
  return upgradeMain(text);
}

const FULLSCREEN_IPC = [
  'let bootFullscreenSnapshot = null;',
  'let bootFullscreenTimer = null;',
  'function restoreBootFullscreen() {',
  '\tif (bootFullscreenTimer) { clearTimeout(bootFullscreenTimer); bootFullscreenTimer = null; }',
  '\tif (!bootFullscreenSnapshot || !mainWindow || mainWindow.isDestroyed()) {',
  '\t\tbootFullscreenSnapshot = null;',
  '\t\treturn;',
  '\t}',
  '\tconst snap = bootFullscreenSnapshot;',
  '\tbootFullscreenSnapshot = null;',
  '\ttry { mainWindow.setAlwaysOnTop(false); } catch (error) {}',
  '\ttry {',
  '\t\tif (snap.fullScreen) mainWindow.setFullScreen(true);',
  '\t\telse {',
  '\t\t\tmainWindow.setBounds(snap.bounds);',
  '\t\t\tif (snap.maximized) mainWindow.maximize();',
  '\t\t}',
  '\t\tconsole.log("[dsh-theme-mls-next] boot fullscreen off");',
  '\t} catch (error) {',
  '\t\tconsole.error("[dsh-theme-mls-next] boot fullscreen restore failed", error);',
  '\t}',
  '}',
  'ipcMain.on("dsh-desktop:boot-fullscreen", (event, enabled) => {',
  '\tif (!bootChromeEnabled() || process.platform !== "win32") return;',
  '\tif (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;',
  '\tconst frame = event.senderFrame;',
  '\tif (frame && (frame !== mainWindow.webContents.mainFrame || !String(frame.url || "").startsWith("dsh-app://app/"))) return;',
  '\tif (typeof enabled !== "boolean") return;',
  '\ttry {',
  '\t\tif (enabled) {',
  '\t\t\tif (bootFullscreenSnapshot) return;',
  '\t\t\tconst display = screen.getDisplayMatching(mainWindow.getBounds());',
  '\t\t\tbootFullscreenSnapshot = {',
  '\t\t\t\tbounds: typeof mainWindow.getNormalBounds === "function" ? mainWindow.getNormalBounds() : mainWindow.getBounds(),',
  '\t\t\t\tmaximized: mainWindow.isMaximized(),',
  '\t\t\t\tfullScreen: mainWindow.isFullScreen()',
  '\t\t\t};',
  '\t\t\tconst cover = () => {',
  '\t\t\t\tmainWindow.setAlwaysOnTop(true, "screen-saver");',
  '\t\t\t\tmainWindow.setBounds(display.bounds);',
  '\t\t\t\tmainWindow.show();',
  '\t\t\t};',
  '\t\t\tif (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);',
  '\t\t\tif (mainWindow.isMaximized()) {',
  '\t\t\t\tmainWindow.once("unmaximize", cover);',
  '\t\t\t\tmainWindow.unmaximize();',
  '\t\t\t} else cover();',
  '\t\t\tbootFullscreenTimer = setTimeout(restoreBootFullscreen, 22000);',
  '\t\t\tconsole.log("[dsh-theme-mls-next] boot fullscreen on");',
  '\t\t} else restoreBootFullscreen();',
  '\t} catch (error) {',
  '\t\tconsole.error("[dsh-theme-mls-next] boot fullscreen failed", error);',
  '\t\trestoreBootFullscreen();',
  '\t}',
  '});',
  ''
].join('\n');

function upgradeMain(text) {
  const importNeedle = 'safeStorage, session, shell, systemPreferences } from "electron";';
  if (!text.includes('screen, session, shell, systemPreferences } from "electron";')) {
    text = replaceOnce(text, importNeedle, 'safeStorage, screen, session, shell, systemPreferences } from "electron";', 'screen import');
  }
  if (!text.includes('dsh-desktop:boot-fullscreen')) {
    text = replaceOnce(
      text,
      'ipcMain.on("dsh-desktop:boot-chrome"',
      FULLSCREEN_IPC + 'ipcMain.on("dsh-desktop:boot-chrome"',
      'boot fullscreen ipc'
    );
  }
  return text;
}

function upgradePreload(text) {
  if (text.includes('dsh-desktop:boot-fullscreen')) return text;
  const oldBridge = [
    'const bootChrome = (visible, who) => electron.ipcRenderer.send("dsh-desktop:boot-chrome", visible, who);',
    '\t\ttry {',
    '\t\t\telectron.contextBridge.exposeInMainWorld("dshDesktopBootChrome", { chrome: bootChrome });'
  ].join('\n');
  const newBridge = [
    'const bootChrome = (visible, who) => electron.ipcRenderer.send("dsh-desktop:boot-chrome", visible, who);',
    '\t\tconst bootFullscreen = (enabled) => electron.ipcRenderer.send("dsh-desktop:boot-fullscreen", enabled);',
    '\t\ttry {',
    '\t\t\telectron.contextBridge.exposeInMainWorld("dshDesktopBootChrome", { chrome: bootChrome, fullscreen: bootFullscreen });'
  ].join('\n');
  return replaceOnce(text, oldBridge, newBridge, 'preload fullscreen');
}

function patchPreload(text) {
  if (text.includes(MARKER)) return upgradePreload(text);
  const anchor = 'if (location.protocol === "dsh-app:" && location.hostname === "app") {';
  return replaceOnce(
    text,
    anchor,
    [
      'if (location.protocol === "dsh-app:" && location.hostname === "app") {',
      '\tif (process.platform === "win32" && process.env.DSH_DESKTOP_BOOT_CHROME !== "0") {',
      '\t\t// ' + MARKER + ': theme calls dshDesktopBootChrome.chrome(visible, who).',
      '\t\tconst bootChrome = (visible, who) => electron.ipcRenderer.send("dsh-desktop:boot-chrome", visible, who);',
      '\t\ttry {',
      '\t\t\telectron.contextBridge.exposeInMainWorld("dshDesktopBootChrome", { chrome: bootChrome });',
      '\t\t} catch (error) {',
      '\t\t\tconsole.error("Desktop boot chrome bridge failed", error);',
      '\t\t}',
      '\t}'
    ].join('\n'),
    'preload bridge'
  );
}

function patchIndex(text) {
  if (text.includes(MARKER)) return text;
  const anchor = '  <head>\n    <meta charset="utf-8" />';
  const injection = [
    '  <head>',
    '    <script>/* ' + MARKER + ' first frame. The window is transparent; this document must not paint an opaque plate before the theme sets data-mar-boot. */',
    '(function () {',
    '  var bridge = window.dshDesktopBootChrome;',
    '  if (!bridge || typeof bridge.chrome !== "function") return;',
    '  var root = document.documentElement;',
    '  if (root === null) return;',
    '  root.setAttribute("data-dsh-desktop", "");',
    '  try { bridge.chrome(false, "first-frame"); } catch (error) {}',
    '  var start = Date.now();',
    '  var release = function () {',
    '    root.removeAttribute("data-dsh-desktop");',
    '    try { bridge.chrome(true, "first-frame"); } catch (error) {}',
    '  };',
    '  var tick = function () {',
    '    if (root.hasAttribute("data-mar-boot")) {',
    '      root.removeAttribute("data-dsh-desktop");',
    '      return;',
    '    }',
    '    var host = document.getElementById("root");',
    '    var mounted = host !== null && host.childElementCount > 0 && host.querySelector("[data-dsh-boot]") === null;',
    '    if (Date.now() - start > 15000 || mounted) {',
    '      release();',
    '      return;',
    '    }',
    '    setTimeout(tick, 100);',
    '  };',
    '  setTimeout(tick, 100);',
    '})();<\/script>',
    '    <style>html[data-dsh-desktop],html[data-dsh-desktop] body,html[data-dsh-desktop] #root{background:transparent!important}',
    'html[data-dsh-desktop] [data-dsh-boot]{background:transparent!important}',
    'html[data-dsh-desktop] [data-dsh-boot]:has([data-dsh-boot-spinner]) > *{display:none!important}</style>',
    '    <meta charset="utf-8" />'
  ].join('\n');
  return replaceOnce(text, anchor, injection, 'index.html first frame');
}

function syntaxCheck(file) {
  const { spawnSync } = require('child_process');
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) fail(path.basename(file) + ' failed node --check\n' + (result.stderr || result.stdout));
}

function swapArchive(live, staged) {
  const backup = live + '.bak-mls-next';
  if (!fs.existsSync(backup)) fs.copyFileSync(live, backup);
  const retired = live + '.pre-mls-next';
  try {
    if (fs.existsSync(retired)) fs.rmSync(retired, { force: true });
    fs.renameSync(live, retired);
    fs.renameSync(staged, live);
    console.log('next-desktop: installed. Previous archive kept at');
    console.log('  ' + retired);
    console.log('  backup ' + backup);
    return true;
  } catch (error) {
    console.error('next-desktop: could not replace the live archive (' + error.message + ')');
    console.error('next-desktop: staged archive is at');
    console.error('  ' + staged);
    console.error('Quit DSH NEXT completely (tray → 退出), then re-run this command.');
    return false;
  }
}

function revert(appDir) {
  const live = path.join(appDir, APP_ASAR);
  const backup = live + '.bak-mls-next';
  if (!fs.existsSync(backup)) fail('no backup at ' + backup);
  const retired = live + '.reverted-from';
  fs.renameSync(live, retired);
  fs.copyFileSync(backup, live);
  console.log('next-desktop: restored backup over ' + live);
}

function apply(appDir) {
  const live = path.join(appDir, APP_ASAR);
  if (!fs.existsSync(live)) fail('missing ' + live);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-next-mls-'));
  const extracted = path.join(stage, 'extracted');
  console.log('next-desktop: extracting ' + live);
  const count = asar.extractAll(live, extracted);
  console.log('next-desktop: extracted ' + count + ' entries');

  const mainPath = path.join(extracted, 'lib', 'main.js');
  const preloadPath = path.join(extracted, 'lib', 'preload-app.cjs');
  const indexPath = path.join(extracted, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html');
  for (const file of [mainPath, preloadPath, indexPath]) {
    if (!fs.existsSync(file)) fail('missing extracted file ' + file);
  }

  fs.writeFileSync(mainPath, upgradeMain(patchMain(fs.readFileSync(mainPath, 'utf8'))));
  fs.writeFileSync(preloadPath, upgradePreload(patchPreload(fs.readFileSync(preloadPath, 'utf8'))));
  fs.writeFileSync(indexPath, patchIndex(fs.readFileSync(indexPath, 'utf8')));
  syntaxCheck(mainPath);
  syntaxCheck(preloadPath);

  const unpacked = unpackedPaths(live);
  const staged = path.join(stage, 'app.asar');
  console.log('next-desktop: packing (' + unpacked.length + ' unpacked paths preserved)');
  const packed = asar.createPackage(extracted, staged, { unpacked, unpackedMirror: false });
  console.log('next-desktop: packed ' + packed.files + ' files, ' + packed.bytes + ' bytes');
  const swapped = swapArchive(live, staged);
  if (!swapped) process.exitCode = 2;
}

function main() {
  const appDir = argValue('--app');
  if (!appDir) fail('pass --app "<DSH NEXT install dir>"');
  const resolved = path.resolve(appDir);
  if (process.argv.includes('--revert')) revert(resolved);
  else apply(resolved);
}

main();
