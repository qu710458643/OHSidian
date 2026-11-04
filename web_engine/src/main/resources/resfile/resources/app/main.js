let path = require('path');
let util = require('util');
let os = require('os');
let crypto = require('crypto');
let fs = require('fs');
let zlib = require('zlib');
let EventEmitter = require('events');
let electron = require('electron');
let remote = electron.remote;
try {
	remote = require('@electron/remote/main');
	electron.remote = remote;
} catch (e) {
	console.warn('[HMOS-REMOTE] @electron/remote/main is unavailable, falling back to electron.remote', e);
	if (!remote) {
		remote = {
			initialize: () => {}
		};
		electron.remote = remote;
	}
}
let {app, protocol, net} = electron;

if (remote && typeof remote.initialize === 'function') {
	remote.initialize();
}

// ---------------------------------------------------------------------------
// Popout-modal compatibility fix (needed for obsidian.asar >= 1.15.0)
//
// Obsidian 1.15.0 ships `settingsPopoutWindow: true` as the DEFAULT vault
// config (the gne defaults table inside app.js). With that default, opening
// Settings (the gear at the bottom-left) takes the popout-modal path:
//
//     Setting.open() -> my.open() -> She() -> IV() ->
//     window.open('about:blank', '_blank', 'popup,width=900,height=700,...')
//
// i.e. it asks for a child BrowserWindow. This port cannot surface child
// BrowserWindows (no native window is created for them), so the settings UI
// renders into an invisible window: the gear appears dead (no error, no
// modal). Any other popout-capable modal is affected the same way.
//
// Fix: intercept window.open for the Obsidian popout protocol (about:blank +
// "popup..." features) in the renderer and return null. Obsidian's IV() is
// designed to handle that (`let s = window.open(...); if (!s) return null`),
// and my.open() then skips the popout branch, so the modal falls back to
// opening inside the main window. Non-popup window.open calls are untouched
// and keep flowing through the asar's own setWindowOpenHandler.
// ---------------------------------------------------------------------------
{
	const POPOUT_FIX = `(function(){
		if (window.__hmosPopoutFixed) return 'already';
		window.__hmosPopoutFixed = true;
		try {
			var origOpen = window.open ? window.open.bind(window) : null;
			window.open = function(u, n, f) {
				var us = String(u), fs = String(f || '');
				if (us.indexOf('about:blank') === 0 && fs.indexOf('popup') === 0) {
					try { console.log('[HMOS-POPOUT-FIX] blocked popup window.open:', fs); } catch (e) {}
					return null;
				}
				return origOpen ? origOpen.apply(window, arguments) : null;
			};
			return 'installed';
		} catch (e) {
			return 'error:' + e;
		}
	})();`;

	app.on('web-contents-created', (event, webContents) => {
		// Forward namespaced renderer diagnostics ([HMOS...]) to the main-process
		// console so they are visible in hilog (tag: Electron).
		try {
			webContents.on('console-message', (e, level, message) => {
				if (typeof message === 'string' && message.indexOf('[HMOS') === 0) {
					console.log('[RCON-FIX]', message);
				}
			});
		} catch (e) {}
		webContents.on('did-finish-load', () => {
			try {
				webContents.executeJavaScript(POPOUT_FIX, true).then((r) => {
					console.log('[HMOS-POPOUT-FIX] ' + r + ' (url=' + webContents.getURL() + ')');
				}).catch(() => {});
			} catch (e) {}
		});
	});
}

// ---------------------------------------------------------------------------
// System window-decoration button overlap fix.
//
// Every BrowserWindow on this port surfaces as an OHOS free window whose ArkUI
// ContainerModal decorations (EnhanceMinimizeBtn / EnhanceMaximizeBtn /
// EnhanceCloseBtn) are drawn at the window's top-right corner. Obsidian also
// draws its own DOM window controls there (app.js tH titlebar, created because
// ipcRenderer.sendSync("frame") resolves to "hidden"), so the two button sets
// overlap at the top-right corner.
//
// Obsidian's own titlebar is the intended control surface: its buttons call
// BrowserWindow minimize/maximize/close through the port adapter
// (AppWindowAdapter::Maximize/Minimize/Close), and its title strip is a
// -webkit-app-region:drag surface implemented via
// AppWindowAdapter::StartWindowMoving. So hide the system decor buttons with
// Electron's setWindowButtonVisibility() (wired to AppWindowAdapter::
// SetWindowButtonVisibility) for every window as soon as it is created.
// ---------------------------------------------------------------------------
{
	let hideSystemDecorButtons = (win) => {
		if (!win || typeof win.setWindowButtonVisibility !== 'function') return false;
		try {
			win.setWindowButtonVisibility(false);
			return true;
		} catch (e) {
			console.warn('[HMOS-DECOR] setWindowButtonVisibility(false) failed:', e);
			return false;
		}
	};

	app.on('browser-window-created', (event, win) => {
		hideSystemDecorButtons(win);
		// The native window may not be fully wired when the event fires; retry
		// once the window is ready so the decor buttons stay hidden.
		try {
			win.once('ready-to-show', () => hideSystemDecorButtons(win));
		} catch (e) {}
	});

	// Titlebar probe: snapshots the web titlebar state at increasing delays and
	// on every body class change. The web window-control buttons have been
	// observed to disappear once the workspace finishes loading; this probe
	// records which body class flips (e.g. is-fullscreen hides .titlebar via
	// CSS) and what the titlebar/button geometry looks like at each stage.
	// v2: also records per-button svg presence/fill/computed color/visibility,
	// the mod-right container background, and elementFromPoint() at each
	// button center to detect overlapping covers.
	app.on('web-contents-created', (event, webContents) => {
		webContents.on('did-finish-load', () => {
			try {
				webContents.executeJavaScript(`(function(){
					if (window.__hmosTitlebarProbe) return;
					window.__hmosTitlebarProbe = true;
					var hmosTimer = null;
					function hmosCs(el, p) {
						try { return getComputedStyle(el).getPropertyValue(p).trim(); } catch (e) { return '?'; }
					}
					function hmosHit(el) {
						if (!el) return 'null';
						var cn = el.className;
						if (cn && cn.baseVal !== undefined) cn = cn.baseVal;
						return el.tagName + '.' + String(cn).split(' ').join('.');
					}
					function hmosBtnInfo(el){
						try {
							var r = el.getBoundingClientRect();
							var cs = getComputedStyle(el);
							var svg = el.querySelector('svg');
							var svgInfo = 'no-svg';
							if (svg) {
								var kid = svg.firstElementChild;
								svgInfo = 'svg:' + svg.outerHTML.length +
									' fill:' + hmosCs(svg, 'fill') +
									' kfill:' + (kid ? hmosCs(kid, 'fill') : '-') +
									' w:' + hmosCs(svg, 'width') + 'x' + hmosCs(svg, 'height');
							}
							var ex = Math.round(r.x + r.width / 2), ey = Math.round(r.y + r.height / 2);
							var hit = (r.width > 0 && r.height > 0) ? hmosHit(document.elementFromPoint(ex, ey)) : 'zero-rect';
							return el.className.split(' ').pop() + '@' + Math.round(r.x) + ',' + Math.round(r.y) +
								' ' + Math.round(r.width) + 'x' + Math.round(r.height) +
								' d:' + cs.display + ' o:' + cs.opacity +
								' v:' + cs.visibility + ' c:' + cs.color +
								' efp:' + hit + ' ' + svgInfo;
						} catch (e) {
							return 'err:' + e;
						}
					}
					function hmosSnap(tag){
						try {
							var b = document.body;
							var csB = getComputedStyle(b);
							var tb = document.querySelector('.titlebar');
							var tbInfo = 'none';
							if (tb) {
								var r = tb.getBoundingClientRect();
								var cs = getComputedStyle(tb);
								tbInfo = Math.round(r.x) + ',' + Math.round(r.y) +
									' ' + Math.round(r.width) + 'x' + Math.round(r.height) +
									' d:' + cs.display + ' h:' + cs.height +
									' hh:' + csB.getPropertyValue('--header-height');
							}
							var rc = document.querySelector('.titlebar-button-container.mod-right');
							var rcInfo = 'no-rc';
							if (rc) {
								var rr = rc.getBoundingClientRect();
								rcInfo = Math.round(rr.x) + ',' + Math.round(rr.y) +
									' ' + Math.round(rr.width) + 'x' + Math.round(rr.height) +
									' bg:' + hmosCs(rc, 'background-color') +
									' z:' + hmosCs(rc, 'z-index') +
									' pe:' + hmosCs(rc, 'pointer-events');
							}
							var tt = document.querySelector('.titlebar-text');
							var ttInfo = tt ? ('bg:' + hmosCs(tt, 'background-color') + ' z:' + hmosCs(tt, 'z-index')) : 'no-tt';
							var btns = [];
							document.querySelectorAll('.titlebar-button').forEach(function(el){
								btns.push(hmosBtnInfo(el));
							});
							console.log('[HMOS-TITLEBAR] ' + tag +
								' body=[' + b.className + ']' +
								' vw=' + window.innerWidth + 'x' + window.innerHeight +
								' dpr=' + window.devicePixelRatio +
								' tb=' + tbInfo +
								' rc=' + rcInfo +
								' tt=' + ttInfo +
								' btns=' + JSON.stringify(btns));
						} catch (e) {
							console.log('[HMOS-TITLEBAR] ' + tag + ' error: ' + e);
						}
					}
					hmosSnap('t0');
					[3, 8, 15, 25, 40, 60, 120, 180, 300].forEach(function(s){
						setTimeout(function(){ hmosSnap('t' + s + 's'); }, s * 1000);
					});
					new MutationObserver(function(){
						clearTimeout(hmosTimer);
						hmosTimer = setTimeout(function(){ hmosSnap('bodyclass'); }, 300);
					}).observe(document.body, { attributes: true, attributeFilter: ['class'] });
					var tb0 = document.querySelector('.titlebar');
					if (tb0) {
						new MutationObserver(function(){
							console.log('[HMOS-TB-MUT] titlebar subtree changed');
							clearTimeout(hmosTimer);
							hmosTimer = setTimeout(function(){ hmosSnap('tbmut'); }, 300);
						}).observe(tb0, { childList: true, subtree: true, characterData: true });
					}
				})();`, true).catch(() => {});
			} catch (e) {}
		});
	});
}

// ---------------------------------------------------------------------------
// Windows platform-class fix (titlebar covered by workspace tab header).
//
// app.js's platform normalizer maps window.process.platform to a body class:
//   win32 -> mod-windows, darwin -> mod-macos, linux -> mod-linux (nie()).
// This port reports none of those, so the body gets NO platform class, while
// the frame style still resolves to "hidden" (ipc "frame" unhandled ->
// Eoe()'s `|| "hidden"` fallback), i.e. is-hidden-frameless: the workspace
// tab header container overlays the titlebar strip.
//
// On stock Windows that layout works ONLY because .mod-windows unlocks:
//   - .is-hidden-frameless.mod-windows .titlebar { z-index:
//     var(--layer-popover); pointer-events: none; background: transparent }
//     -> the DOM min/max/close buttons paint ABOVE the tab bar;
//   - .titlebar-button-container { pointer-events: auto } -> clicks land;
//   - --frame-right-space: calc(126px - var(--frame-ribbon-right)) plus
//     .workspace-tab-header-container padding/:after -> tabs reserve the
//     button zone instead of sliding under it;
//   - .mod-windows .titlebar-button { padding: 0 16px; height: 100% } ->
//     Windows-sized hit areas (close hover turns red).
// Without the class the tab header (background rgb(40,40,40)) paints over
// the buttons: DOM says d:flex/o:1/visible but the button zone renders empty
// and elementFromPoint() at the button centers returns
// DIV.workspace-tab-header-spacer (probe v2 evidence, live6.log).
//
// app.js never reads mod-windows/mod-linux from JS (CSS hooks only, verified
// against asar 1.15), so adding the class is side-effect free. mod-windows
// and mod-linux are 100% identical in app.css; mod-windows matches this
// port's Windows-style right-side controls. Injected at did-finish-load,
// which fires before the workspace DOM mounts (~1.6s later), so the tab bar
// is laid out with the reserve rules already active (no visible reflow).
// ---------------------------------------------------------------------------
{
	const PLATFORM_CLASS_FIX = `(function(){
		if (window.__hmosPlatformClassFixed) return 'already';
		window.__hmosPlatformClassFixed = true;
		try {
			var b = document.body;
			if (!b) return 'error:no-body';
			if (b.classList.contains('mod-windows') || b.classList.contains('mod-linux') || b.classList.contains('mod-macos')) {
				return 'present';
			}
			b.classList.add('mod-windows');
			return 'added mod-windows';
		} catch (e) {
			return 'error:' + e;
		}
	})();`;

	app.on('web-contents-created', (event, webContents) => {
		webContents.on('did-finish-load', () => {
			try {
				webContents.executeJavaScript(PLATFORM_CLASS_FIX, true).then((r) => {
					console.log('[HMOS-PLATFORM-CLASS] ' + r + ' (url=' + webContents.getURL() + ')');
				}).catch(() => {});
			} catch (e) {}
		});
	});
}

// ---------------------------------------------------------------------------
// BrowserWindow capability diagnostics.
//
// Proven so far: unmaximize() EXISTS and works when invoked from JS
// (state flips + window rect returns to normal; window ops bypass the ArkTS
// AppWindowAdapter entirely — zero LogMethodCall entries during
// maximize/unmaximize). Obsidian's window object === @electron/remote
// getCurrentWindow(), i.e. the same proxy we test. Remaining suspects for
// the earlier "unmaximize click does nothing" report: (1) devecocli ui click
// double-firing (toggle unmax+max = net maximized), (2) isMaximized state
// desync after restore() (JS test showed state=true with window at normal
// rect). Test v3 below tracks viewport/bounds per stage, logs REALCLICK
// isTrusted/detail on the maximize button, and clicks the real DOM button.
// ---------------------------------------------------------------------------
{
	try {
		const BW = electron.BrowserWindow;
		if (BW && BW.prototype) {
			console.log('[HMOS-BW-DBG] main BrowserWindow.prototype: ' +
				Object.getOwnPropertyNames(BW.prototype).join(','));
		} else {
			console.log('[HMOS-BW-DBG] no BrowserWindow/prototype (BW=' + typeof BW + ')');
		}
	} catch (e) {
		console.log('[HMOS-BW-DBG] err: ' + e);
	}

	const WIN_DBG = `(function(){
		try {
			var r = typeof require === 'function' ? require : null;
			if (!r) { console.log('[HMOS-WIN-DBG] no require in renderer'); return; }
			var remote = null;
			try { remote = r('@electron/remote'); } catch (e) {
				try { remote = r('electron').remote; } catch (e2) {}
			}
			if (!remote) { console.log('[HMOS-WIN-DBG] no remote module'); return; }
			var w = remote.getCurrentWindow();
			var o = w, depth = 0, chain = [];
			while (o && depth < 6) {
				chain.push('L' + depth + '[' + (o.constructor ? o.constructor.name : '?') + ']: ' + Object.getOwnPropertyNames(o).join(','));
				o = Object.getPrototypeOf(o); depth++;
			}
			console.log('[HMOS-WIN-DBG] chain: ' + chain.join(' || '));
			console.log('[HMOS-WIN-DBG] typeof: unmaximize=' + typeof w.unmaximize +
				' maximize=' + typeof w.maximize +
				' minimize=' + typeof w.minimize +
				' isMaximized=' + typeof w.isMaximized +
				' restore=' + typeof w.restore +
				' recover=' + typeof w.recover +
				' close=' + typeof w.close +
				' setWindowButtonVisibility=' + typeof w.setWindowButtonVisibility);
			if (!window.__hmosWinTest) {
				window.__hmosWinTest = true;
				var tlog = function(s){ console.log('[HMOS-WIN-TEST] ' + s); };
				var vp = function(){ return innerWidth + 'x' + innerHeight; };
				var st = function(){
					var s = 'vp=' + vp();
					try { s += ' isMax=' + w.isMaximized(); } catch (e) { s += ' isMax=ERR'; }
					if (typeof w.isMinimized === 'function') { try { s += ' isMin=' + w.isMinimized(); } catch (e) {} }
					if (typeof w.getBounds === 'function') { try { var b = w.getBounds(); s += ' bounds=' + b.x + ',' + b.y + ' ' + b.width + 'x' + b.height; } catch (e) {} }
					return s;
				};
				var eremote = 'n/a';
				try {
					var _e = r('electron');
					if (_e && _e.remote && _e.remote.getCurrentWindow) eremote = 'same=' + (_e.remote.getCurrentWindow() === w);
					else if (_e) eremote = 'no-remote-getCW remoteType=' + typeof _e.remote;
				} catch (e) { eremote = 'ERR:' + e.message; }
				tlog('electron.remote ' + eremote);
				tlog('typeof getBounds=' + typeof w.getBounds + ' isMinimized=' + typeof w.isMinimized + ' isMaximized=' + typeof w.isMaximized + ' unmaximize=' + typeof w.unmaximize);
				var attach = function(n){
					var btn = document.querySelector('.titlebar-button.mod-maximize');
					if (btn) {
						btn.addEventListener('click', function(ev){ tlog('REALCLICK trusted=' + ev.isTrusted + ' detail=' + ev.detail); }, true);
						btn.addEventListener('dblclick', function(ev){ tlog('REALDBLCLICK'); }, true);
						tlog('listeners on ' + btn.className);
						return;
					}
					if (n < 24) setTimeout(function(){ attach(n + 1); }, 500);
					else tlog('listeners: no btn');
				};
				attach(0);
				var seq = [
					['A0 initial', null],
					['A1 after maximize()', 'max'],
					['A2 after unmaximize()', 'unmax'],
					['A3 after restore()', 'restore'],
					['A4 after unmaximize()', 'unmax'],
					['B1 after maximize()', 'max'],
					['B2 after btn.click()', 'btn'],
					['B3 after btn.click()', 'btn'],
					['B4 after btn.click()', 'btn']
				];
				var i = 0;
				var step = function(){
					if (i >= seq.length) return;
					var act = seq[i][1];
					try {
						if (act === 'max') w.maximize();
						else if (act === 'unmax') w.unmaximize();
						else if (act === 'restore') w.restore();
						else if (act === 'btn') {
							var btn = document.querySelector('.titlebar-button.mod-maximize');
							if (btn) btn.click();
							else tlog('btn NOT FOUND at step ' + i);
						}
					} catch (e) { tlog('step ' + i + ' err: ' + e); }
					setTimeout(function(){
						i++;
						if (i < seq.length) { try { tlog(seq[i][0] + ': ' + st()); } catch (e) { tlog(seq[i][0] + ' st err: ' + e); } step(); }
						else { try { tlog('FINAL: ' + st()); } catch (e) {} }
					}, 3000);
				};
				setTimeout(function(){
					try { tlog('A0 initial: ' + st()); } catch (e) { tlog('A0 st err: ' + e); }
					step();
				}, 5000);
			}
		} catch (e) {
			console.log('[HMOS-WIN-DBG] err: ' + e);
		}
	})();`;

	app.on('web-contents-created', (event, webContents) => {
		webContents.on('did-finish-load', () => {
			try {
				webContents.executeJavaScript(WIN_DBG, true).catch(() => {});
			} catch (e) {}
		});
	});
}

protocol.registerSchemesAsPrivileged([
	{scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true}}
]);

let updateEvents = new EventEmitter();

let insider = false;
let disable = false;
let silence = false;
updateEvents.on('insider', (arg) => {
	insider = arg;
});
updateEvents.on('disable', (arg) => {
	disable = arg;
});
updateEvents.on('silence', (arg) => {
	silence = arg;
});

let APP_PATH = (() => {
	let path = app.getAppPath();
	let asar_index = path.indexOf('app.asar');
	if (asar_index >= 0) {
		return path.slice(0, asar_index);
	}
	return path;
})();

let currentBaseVersion = require('./package.json').version || app.getVersion();
let currentPackageVersion = currentBaseVersion;
let dataPath = app.getPath('userData');

function itemExists(filePath) {
	try {
		fs.accessSync(filePath);
		return true;
	} catch (e) {
		return false;
	}
}

function normalizeForPrefix(filePath) {
	return path.resolve(filePath).replace(/\\/g, '/');
}

function getVaultTrashDir(targetPath) {
	try {
		let obsidianConfigPath = path.join(dataPath, 'obsidian.json');
		if (fs.existsSync(obsidianConfigPath)) {
			let obsidianConfig = JSON.parse(fs.readFileSync(obsidianConfigPath, 'utf8'));
			let vaults = obsidianConfig && obsidianConfig.vaults;
			if (vaults) {
				let normalizedTarget = normalizeForPrefix(targetPath);
				let matchedVaultPath = null;
				for (let id of Object.keys(vaults)) {
					let vaultPath = vaults[id] && vaults[id].path;
					if (!vaultPath || !fs.existsSync(vaultPath)) continue;
					let normalizedVault = normalizeForPrefix(vaultPath);
					if (normalizedTarget === normalizedVault || normalizedTarget.startsWith(normalizedVault + '/')) {
						if (!matchedVaultPath || normalizedVault.length > normalizeForPrefix(matchedVaultPath).length) {
							matchedVaultPath = vaultPath;
						}
					}
				}
				if (matchedVaultPath) return path.join(matchedVaultPath, '.trash');
			}
		}
		return getVaultTrashDirByFilesystem(targetPath);
	} catch (e) {
		console.error('[HMOS-TRASH] failed to resolve vault trash dir', e);
		return getVaultTrashDirByFilesystem(targetPath);
	}
}

function getVaultTrashDirByFilesystem(targetPath) {
	try {
		let dir = fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath);
		while (dir && path.dirname(dir) !== dir) {
			if (fs.existsSync(path.join(dir, '.obsidian'))) {
				return path.join(dir, '.trash');
			}
			dir = path.dirname(dir);
		}
	} catch (e) {
	}
	return path.join(path.dirname(targetPath), '.trash');
}

function moveToVaultTrash(targetPath) {
	let trashDir = getVaultTrashDir(targetPath);
	if (!trashDir) return false;
	fs.mkdirSync(trashDir, {recursive: true});
	let parsed = path.parse(targetPath);
	let targetName = parsed.base;
	let trashPath = path.join(trashDir, targetName);
	if (fs.existsSync(trashPath)) {
		trashPath = path.join(trashDir, parsed.name + '-' + Date.now() + parsed.ext);
	}
	fs.renameSync(targetPath, trashPath);
	console.log('[HMOS-TRASH] moved to vault trash fallback', targetPath, '->', trashPath);
	return true;
}

async function waitForMissing(filePath, timeoutMs) {
	let deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!itemExists(filePath)) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return !itemExists(filePath);
}

function installHarmonyTrashCompat() {
	if (!electron.shell || typeof electron.shell.trashItem !== 'function') return;
	let nativeTrashItem = electron.shell.trashItem.bind(electron.shell);
	electron.shell.trashItem = async function(targetPath) {
		let existedBefore = itemExists(targetPath);
		try {
			let result = await nativeTrashItem(targetPath);
			if (!existedBefore || await waitForMissing(targetPath, 3000)) {
				console.log('[HMOS-TRASH] native trash succeeded', targetPath);
				return result;
			}
			throw new Error('HarmonyOS native trash returned but the file still exists');
		} catch (e) {
			console.error('[HMOS-TRASH] native trash failed', e);
			if (existedBefore && itemExists(targetPath) && moveToVaultTrash(targetPath)) {
				return;
			}
			throw e;
		}
	};
}

installHarmonyTrashCompat();

async function runHarmonyTrashSelfTest() {
	let obsidianConfigPath = path.join(dataPath, 'obsidian.json');
	let originalConfig = null;
	try {
		await app.whenReady();
		let testRoot = path.join(dataPath, 'harmony-trash-self-test');
		let testVault = path.join(testRoot, 'vault');
		fs.mkdirSync(testVault, {recursive: true});
		fs.mkdirSync(path.join(testVault, '.obsidian'), {recursive: true});
		if (fs.existsSync(obsidianConfigPath)) {
			originalConfig = fs.readFileSync(obsidianConfigPath, 'utf8');
		}
		let config = originalConfig ? JSON.parse(originalConfig) : {};
		config.vaults = config.vaults || {};
		config.vaults['hmos-trash-self-test'] = {path: testVault, ts: Date.now()};
		fs.writeFileSync(obsidianConfigPath, JSON.stringify(config, null, 2), 'utf8');
		let testFile = path.join(testVault, 'delete-me-' + Date.now() + '.md');
		fs.writeFileSync(testFile, 'HarmonyOS trash self test', 'utf8');
		await electron.shell.trashItem(testFile);
		let removed = await waitForMissing(testFile, 3000);
		console.log('[HMOS-TRASH-TEST]', removed ? 'pass' : 'fail', testFile);
	} catch (e) {
		console.error('[HMOS-TRASH-TEST] fail', e);
	} finally {
		try {
			if (originalConfig === null) {
				fs.rmSync(obsidianConfigPath, {force: true});
			} else {
				fs.writeFileSync(obsidianConfigPath, originalConfig, 'utf8');
			}
			fs.rmSync(path.join(dataPath, 'harmony-trash-self-test'), {recursive: true, force: true});
		} catch (e) {
			console.error('[HMOS-TRASH-TEST] cleanup failed', e);
		}
	}
}

if (fs.existsSync(path.join(APP_PATH, 'harmonyos-trash-test.enabled'))) {
	runHarmonyTrashSelfTest();
}

function pad(number) {
	if (number < 10) {
		return '0' + number;
	}
	return number;
}

function stamp() {
	let d = new Date();
	return d.getUTCFullYear() +
		'-' + pad(d.getUTCMonth() + 1) +
		'-' + pad(d.getUTCDate()) +
		' ' + pad(d.getUTCHours()) +
		':' + pad(d.getUTCMinutes()) +
		':' + pad(d.getUTCSeconds());
}

function logger(logfile) {
	let fileout = fs.openSync(logfile, 'a');
	let stdout = process.stdout;

	stdout.on('error', function(e) {
		// `write` failed. Do nothing...
	});

	let fn = function () {
		let data = stamp() + ' ' + util.format.apply(null, arguments) + os.EOL;

		try {
			fs.writeSync(fileout, data);
			// Don't output to stdout if the app requests silence mode (to avoid polluting CLI outputs)
			if (!silence) stdout.write(data);
		}
		catch (e) {
			// Failed to write to log
		}
	};

	fn.end = function () {
		fs.closeSync(fileout);
	};

	return fn;
}

let log = logger(path.join(dataPath, 'obsidian.log'));

let idFile = path.join(dataPath, 'id');
let id;
try {
	if (fs.existsSync(idFile)) {
		id = fs.readFileSync(idFile, 'utf8');
	}
} catch (e) {
}
try {
	if (!id || id.length < 16) {
		id = crypto.randomBytes(16).toString('hex');
		fs.writeFileSync(idFile, id, 'utf8');
	}
} catch (e) {
}

// Only start the updater when electron is ready, because the net module requires that.
let updatePromise = app.whenReady();
let queueUpdate = (manual) => {
	log('HarmonyOS port: desktop auto-update is disabled');
	updateEvents.emit('check-end');
	return;
	let fn = () => update(manual);
	updatePromise = updatePromise.then(fn, fn);
};

// Used for verifying signatures of downloaded asar files
const SIGNATURE_CERT = '-----BEGIN CERTIFICATE-----\n' +
	'MIIDjzCCAnegAwIBAgIJAOFHLJ2gTCBzMA0GCSqGSIb3DQEBCwUAMF4xCzAJBgNV\n' +
	'BAYTAlVTMRMwEQYDVQQIDApTb21lLVN0YXRlMREwDwYDVQQKDAhEeW5hbGlzdDER\n' +
	'MA8GA1UECwwIRHluYWxpc3QxFDASBgNVBAMMC2R5bmFsaXN0LmlvMB4XDTE2MDUx\n' +
	'NjAyMTA1NFoXDTQwMDUxMDAyMTA1NFowXjELMAkGA1UEBhMCVVMxEzARBgNVBAgM\n' +
	'ClNvbWUtU3RhdGUxETAPBgNVBAoMCER5bmFsaXN0MREwDwYDVQQLDAhEeW5hbGlz\n' +
	'dDEUMBIGA1UEAwwLZHluYWxpc3QuaW8wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAw\n' +
	'ggEKAoIBAQDcodSNp30B0oE+2vRUdr//SGfbDow+67OtGuRYQSjn86bn55fQXhMJ\n' +
	'b5xgZ0natiCriCyllLWgPf+4PnxGRSJZGbm38QSArb0MWR8/yXA+q+7nZisIsN2d\n' +
	'Xih8B3APImxJ4A50nsK/C+fl7nYdo04iz3oerP0UhLDrsLbL+9rdmshjB1boLPf6\n' +
	'QpAAC57OTPQpFBd2hFoS6xAnIb708SHOndsrWDIFEFVCPDYcme3WF5jznuT05OFG\n' +
	'MIX8SZe2jXpg2Vco/1oKRPC7mYFN5B0JTZ7mOH48vB/zPNIsVz8KHh3P9Ru2fC2r\n' +
	'3nPDXFGKzcUZneJmXh4LIUVqwdEPw7hvAgMBAAGjUDBOMB0GA1UdDgQWBBTF2xMx\n' +
	'8xVDZ2wteJPsHUe0OCu18TAfBgNVHSMEGDAWgBTF2xMx8xVDZ2wteJPsHUe0OCu1\n' +
	'8TAMBgNVHRMEBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQB6rgBF+DvDHifP+U6Z\n' +
	'FqJ4mX1nalEXEPI1jvRZaOheKpkOEBbhkCAosbBEmYxfj8xay1GGgB9nkJk2dodR\n' +
	'sGVhrZz+CwGR+hSEfYDQwMBvmzm3OcETfEtvwEAU1P93prbxul2oSWP48AVDDYKe\n' +
	'pxTZvW/yZcnoHI9XzhLNMYIEvOs+wKWAOF0+BjsIukQouaXs6gklul2J99IqpdPh\n' +
	'w2l4l7mkPx8htCbTE47GTraHt2i2mwyBZSKbfqzi73Fj5SFRtZlWJDNPKoWxcFg2\n' +
	'91B7IHumd5jwAUdVJit3K5Tgt/q4OzwokcDZcrh5lJg0+Kstsz4RDWDbfzTNJuKn\n' +
	'oueR\n' +
	'-----END CERTIFICATE-----';

async function update(manual) {
	if (!manual && disable) {
		return;
	}
	updateEvents.emit('check-start');
	try {
		// Hopefully this can help us catch any updater failures
		// Or any old buggy versions that may still be operating in the wild.
		// Don't wait on the async result
		httpGetBinary('https://releases.obsidian.md/desktop?id=' + id + '&v=' + currentPackageVersion + '&p=' + process.platform).then(() => null, () => null);
	} catch (e) {
	}

	try {
		await runUpdate();
	} catch (e) {
		log('Failed to perform update');
		console.error(e);
	}
	updateEvents.emit('check-end');
}

async function runUpdate() {
	let updateJson = null;

	try {
		log('Checking for update using Github');
		updateJson = JSON.parse(await httpGet('https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/desktop-releases.json'));
		log('Success.');
	} catch (e) {
		log(`Failed to check for update using Github (${e.message})`);
		console.error(e);
	}

	if (updateJson) {
		try {
			await downloadUpdate(updateJson);
			return;
		} catch (e) {
			if (e.code !== 'ETIMEDOUT') {
				throw e;
			}
			log('Failed to download update from Github');
		}
	}

	try {
		log('Checking for update using obsidian.md');
		updateJson = JSON.parse(await httpGet('https://releases.obsidian.md/desktop-releases.json'));
		log('Success.');
	} catch (e) {
		log(`Failed to check for update using obsidian.md (${e.message})`);
		console.error(e);
	}

	if (updateJson) {
		await downloadUpdate(updateJson);
	}
}

async function downloadUpdate(updateJson) {
	let usingInsider = false;
	if (insider && updateJson.beta) {
		updateJson = updateJson.beta;
		usingInsider = true;
	}
	let {minimumVersion, latestVersion, downloadUrl, hash, signature} = updateJson;

	if (!minimumVersion || !latestVersion || !downloadUrl || !hash || !signature) {
		log('Update failed: info incomplete', updateJson);
		return;
	}

	log('Latest version is ' + latestVersion + (usingInsider ? ' (insider)' : ''));

	// If minimum version is higher than current electron version, we will require a manual full reinstall
	if (isV2MoreRecent(app.getVersion(), minimumVersion)) {
		updateEvents.emit('update-manual-required');
		log('Update failed: minimum version mismatch. App must be manually updated');
		return;
	}

	// A new version is posted, go get it!
	if (isV2MoreRecent(currentPackageVersion, latestVersion)) {
		// Download file only if it's not already here
		let downloadPath = path.join(dataPath, 'obsidian-' + latestVersion + '.asar');
		if (!fs.existsSync(downloadPath)) {
			log('Downloading update from', downloadUrl);
			// Download to a buffer so we can check its signature
			let compressedBuffer = await httpGetBinary(downloadUrl);

			log('Verifying hash & signature. Size=', compressedBuffer.byteLength);
			let newHash = crypto.createHash('SHA256')
				.update(compressedBuffer)
				.digest('base64')
			let verifiedHash = hash === newHash;
			let verifiedSignature =
				crypto.createVerify('RSA-SHA256')
					.update(compressedBuffer)
					.verify(SIGNATURE_CERT, signature, 'base64');

			if (verifiedHash && verifiedSignature) {
				log('Saving file');
				let tempDownloadPath = path.join(dataPath, 'obsidian.asar.tmp');
				let decompressedBuffer = await new Promise((resolve, reject) => {
					zlib.gunzip(compressedBuffer, {}, (err, data) => {
						if (err) {
							return reject(err);
						}
						resolve(data);
					});
				});

				await fs.promises.writeFile(tempDownloadPath, decompressedBuffer);
				await fs.promises.rename(tempDownloadPath, downloadPath);
				log('Update complete.');
				updateEvents.emit('update-downloaded');
			}
			else {
				if (!verifiedHash) {
					log('Hash check failed!', newHash);
				}
				if (!verifiedSignature) {
					log('Signature check failed!');
				}
			}
		}
		else {
			log('An update is already downloaded.');
		}
	}
	else {
		log('App is up to date.');
	}

	// Clean up old updates now that we have the latest version
	let files = fs.readdirSync(dataPath, {withFileTypes: true});
	for (let file of files) {
		let filename = file.name;

		// Delete temporary file
		if (filename === 'obsidian.asar.tmp') {
			await fs.promises.unlink(path.join(dataPath, filename));
		}

		// Delete all versions that aren't the latest version.
		if (file.isFile() && filename.startsWith('obsidian-') && filename.endsWith('.asar')) {
			let newVersion = extractVersion(filename);
			// Make an exception for the current running version.
			if (newVersion !== currentPackageVersion &&
				newVersion !== latestVersion) {
				await fs.promises.unlink(path.join(dataPath, filename));
			}
		}
	}
}

function loadApp(asarPath) {
	// Execute asar content
	let main = path.join(asarPath, 'main.js');

	let fn;
	try {
		fn = require(main);
	} catch (e) {
		log('Failed to require app package', asarPath);
		console.error(e);
		return false;
	}

	if (fn) {
		fn(asarPath, updateEvents);
		return true;
	}
	return false;
}

function extractVersion(filename) {
	if (filename.startsWith('obsidian-') && filename.endsWith('.asar')) {
		return filename.substring('obsidian-'.length, filename.length - '.asar'.length);
	}
	return null;
}

function parseVersion(string) {
	if (!string) {
		return null;
	}
	let valid = true;
	let parts = string.split('.').map((part) => {
		part = parseInt(part);
		if (isNaN(part)) {
			valid = false;
		}
		return part;
	});
	if (valid) {
		return parts;
	}
	return null;
}

function isMoreRecent(version1, version2) {
	let length = Math.min(version1.length, version2.length);
	for (let i = 0; i < length; i++) {
		if (version1[i] < version2[i]) {
			return true;
		}
		if (version1[i] > version2[i]) {
			return false;
		}
	}
	if (version1.length < version2.length) {
		return true;
	}
	if (version1.length > version2.length) {
		return false;
	}
	return false;
}

function isV2MoreRecent(v1, v2) {
	let version1 = parseVersion(v1);
	let version2 = parseVersion(v2);
	if (!version2) {
		return false;
	}
	if (!version1) {
		return true;
	}
	return isMoreRecent(version1, version2);
}

function httpGet(url) {
	return httpGetBinary(url).then(buffer => buffer.toString('utf8'));
}

function httpGetBinary(url) {
	return new Promise((resolve, reject) => {
		let request = net.request({
			method: 'GET',
			url: url,
			redirect: 'follow',
		});
		request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.183 Safari/537.36');
		request.on('login', (authInfo, callback) => callback());
		request.on('error', reject);
		request.on('response', (res) => {
			let data = [];
			res.on('data', (chunk) => data.push(chunk));
			res.on('end', () => resolve(Buffer.concat(data)));
		})
		request.end();
	});
}

// Source: https://github.com/electron/electron/blob/19954126e08c67022b89a886cadb10471ac853ae/lib/browser/init.ts#L20
process.on('uncaughtException', function (error) {
	// Don't emit errors for updater
	if (error.message && error.message.indexOf('net::ERR') !== -1) {
		return;
	}

	console.error('Uncaught Exception', error);

	// Show error in GUI.
	// We can't import { dialog } at the top of this file as this file is
	// responsible for setting up the require hook for the "electron" module
	// so we import it inside the handler down here
	import('electron')
		.then(({dialog}) => {
			const stack = error.stack ? error.stack : `${error.name}: ${error.message}`;
			const message = 'Uncaught Exception:\n' + stack;
			dialog.showErrorBox('A JavaScript error occurred in the main process', message);
		});
});

// Actual startup routine
setInterval(queueUpdate, 60 * 60 * 1000);

let asarPath = path.join(APP_PATH, 'obsidian.asar');
let updatedAsarPath = '';
let updatedAsarVersion = '';

// Check if we have an updated asar to replace the built-in one
try {
	let candidateFile = '';
	let version = '';
	let stat = fs.statSync(dataPath);
	if (stat.isDirectory()) {
		let files = fs.readdirSync(dataPath, {withFileTypes: true});
		for (let file of files) {
			let filename = file.name;
			if (file.isFile() && filename.startsWith('obsidian-') && filename.endsWith('.asar')) {
				let newVersion = extractVersion(filename);
				if (isV2MoreRecent(version, newVersion)) {
					candidateFile = filename;
					version = newVersion;
				}
			}
		}
	}

	// We found an updated asar
	if (isV2MoreRecent(app.getVersion(), version)) {
		updatedAsarPath = path.join(dataPath, candidateFile);
		updatedAsarVersion = version;
	}
} catch (e) {
	if (e.code !== 'ENOENT') {
		console.error(e);
	}
}

// Remap the port's own version string ("5.0.0-Release") to the upstream Electron
// version this engine is actually based on (34.5.0 / Chromium 132.0.6834.161 /
// Node 20.18.1 / V8 13.2.152), so version gates inside obsidian.asar (which require
// Electron >= 18) do not reject the app. Applied late — right before the asar is
// loaded — in case requiring the electron module re-populates process.versions.
try {
	Object.defineProperty(process.versions, 'electron', {value: '34.5.0', writable: true, configurable: true});
} catch (e) {
	try { process.versions.electron = '34.5.0'; } catch (e2) {
		console.warn('[HMOS-VERSION] failed to remap process.versions.electron', e2);
	}
}

let success = false;
if (updatedAsarPath) {
	success = loadApp(updatedAsarPath);
	currentPackageVersion = updatedAsarVersion;
	log('Loaded updated app package', updatedAsarPath);
}

if (!success) {
	success = loadApp(asarPath);
	log('Loaded main app package', asarPath);
}

if (!success) {
	log('Failed to load both app packages.');
}

queueUpdate();
updateEvents.on('check', () => queueUpdate(true));
