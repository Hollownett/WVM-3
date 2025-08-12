// ============ DOM ============

const video         = document.getElementById('video');
const viewport      = document.getElementById('viewport');

const sourceSelect  = document.getElementById('sourceSelect');
const deviceSelect  = document.getElementById('deviceSelect');
const pidSelect     = document.getElementById('pidSelect');

const pin           = document.getElementById('pin');
const clickThrough  = document.getElementById('clickThrough');
const opacityRange  = document.getElementById('opacity');
const opacityVal    = document.getElementById('opacityVal');

const profilesSelect= document.getElementById('profilesSelect');
const profileName   = document.getElementById('profileName');

const refreshBtn    = document.getElementById('refresh');
const refreshAudioBtn= document.getElementById('refreshAudio');
const locateSVVBtn  = document.getElementById('locateSVV');
const mirrorBtn     = document.getElementById('mirror');
const routeBtn      = document.getElementById('route');
const fixCaptureBtn = document.getElementById('fixCapture');
const compactBtn    = document.getElementById('compactBtn');

const useSendInput  = document.getElementById('useSendInput'); // optional toggle

// debug (kept but non-intrusive)
const debugArea     = document.getElementById('debugArea');
const debugLogEl    = document.getElementById('debugLog');
const dbgClearBtn   = document.getElementById('dbgClear');
const dbgCopyBtn    = document.getElementById('dbgCopy');

// ============ State ============

let stream = null;
let capW = 0, capH = 0; // decoded frame size

const state = {
  hwnd: null,
  pid: null,
  windowTitle: '',
  audioDeviceId: null,
  active: false
};

const map = {
  scaleX: 1, scaleY: 1,
  invScaleX: 1, invScaleY: 1,
  offX: 0, offY: 0,
  clientW: 0, clientH: 0,
  winW: 0, winH: 0,
  mode: 'auto'
};

let lastMoveTs = 0;
let clickTimer = null;
let down = null;

const MOVE_THROTTLE_MS = 12;
const DRAG_PX = 4;
const CLICK_DELAY_MS = 260; // leave room for dblclick event

let keepAliveFor = null;
async function startKeepAlive(hwnd) {
  keepAliveFor = hwnd;
  try { await window.api.keepAliveSet({ hwnd, enable: true, periodMs: 3000, x: 6, y: 6,  stickBottom: false }); } catch {}
}
async function stopKeepAlive() {
  if (!keepAliveFor) return;
  try { await window.api.keepAliveSet({ hwnd: keepAliveFor, enable: false }); } catch {}
  keepAliveFor = null;
}


async function stopKeepAlive() {
  if (!keepAliveFor) return;
  try { await window.api.keepAliveSet({ hwnd: keepAliveFor, enable: false }); } catch {}
  keepAliveFor = null;
}


// ============ Utils ============

function dbg(msg) {
  const line = `[Renderer] ${msg}`;
  if (window.api?.logAppend) window.api.logAppend(line);
  if (!debugLogEl) return;
  const time = new Date().toLocaleTimeString();
  debugLogEl.textContent += `[${time}] ${msg}\n`;
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
}

if (dbgClearBtn) dbgClearBtn.onclick = () => { if (debugLogEl) debugLogEl.textContent = ''; };
if (dbgCopyBtn)  dbgCopyBtn.onclick  = async () => {
  if (!debugLogEl) return;
  await navigator.clipboard.writeText(debugLogEl.textContent);
  alert('Debug log copied');
};

if (window.api?.onDebugLog) {
  window.api.onDebugLog((msg) => {
    const time = new Date().toLocaleTimeString();
    if (debugLogEl) {
      debugLogEl.textContent += `[${time}] ${msg}\n`;
      debugLogEl.scrollTop = debugLogEl.scrollHeight;
    }
  });
}

// tiny pointer shadow to visualize mapping
const cursorShadow = document.createElement('div');
cursorShadow.style.cssText = `
  position:absolute; width:10px; height:10px; border-radius:50%;
  border:2px solid rgba(255,255,255,.85); box-shadow:0 0 10px rgba(0,0,0,.6);
  pointer-events:none; transform:translate(-50%,-50%); opacity:0; transition:opacity .08s;
  z-index: 3;
`;
viewport?.appendChild(cursorShadow);

function showShadow(x, y) {
  cursorShadow.style.left = `${x}px`;
  cursorShadow.style.top  = `${y}px`;
  cursorShadow.style.opacity = '1';
}
function hideShadow() { cursorShadow.style.opacity = '0'; }

// ============ Window chrome / toggles ============

const minBtn = document.getElementById('minBtn');
if (minBtn) minBtn.onclick = () => window.api.winMinimize();
const maxBtn = document.getElementById('maxBtn');
if (maxBtn) maxBtn.onclick = () => window.api.winToggleMax();
const closeBtn = document.getElementById('closeBtn');
if (closeBtn) closeBtn.onclick = () => window.api.winClose();
if (compactBtn) compactBtn.onclick = () => document.body.classList.toggle('compact');

if (pin) pin.addEventListener('change', e => window.api.setAlwaysOnTop(e.target.checked));
if (clickThrough) clickThrough.addEventListener('change', e => window.api.setClickThrough(e.target.checked));
if (opacityRange) {
  opacityRange.addEventListener('input', e => {
    const v = Number(e.target.value);
    window.api.setOpacity(v);
    if (opacityVal) opacityVal.textContent = Math.round(v * 100) + '%';
  });
}

if (window.api?.onClickThroughUpdated)
  window.api.onClickThroughUpdated(v => { if (clickThrough) clickThrough.checked = !!v; });

if (window.api?.onToggleCompact)
  window.api.onToggleCompact(() => document.body.classList.toggle('compact'));

// ============ Init ============

(async function init() {
  if (pin) pin.checked = true;
  // keep top-most if enabled
  let keep = null;
  async function applyTopMost(ena){
    await window.api.setAlwaysOnTop(ena);
    if (ena) await window.api.forceTopMost();
    if (keep) clearInterval(keep);
    if (ena) keep = setInterval(() => window.api.forceTopMost().catch(()=>{}), 5000);
  }
  pin?.addEventListener('change', e => applyTopMost(e.target.checked));
  if (pin?.checked) applyTopMost(true);

  if (opacityRange && opacityVal) opacityVal.textContent = Math.round(Number(opacityRange.value) * 100) + '%';

  await refreshSources();
  await refreshAudioDevices();
  await refreshProfiles();

  // Auto compact when active (manual toggle still works)
  updateActiveUI(false);
})();

// ============ UI actions (auto-first) ============

if (refreshBtn) refreshBtn.addEventListener('click', refreshSources);
if (refreshAudioBtn) refreshAudioBtn.addEventListener('click', refreshAudioDevices);
if (locateSVVBtn) locateSVVBtn.addEventListener('click', async () => {
  await window.api.pickSVV();
  await refreshAudioDevices();
});

if (mirrorBtn) mirrorBtn.addEventListener('click', () => autoMirrorFromSelection());
if (routeBtn) routeBtn.addEventListener('click', () => attemptAutoRoute());

if (sourceSelect) sourceSelect.addEventListener('change', () => autoMirrorFromSelection());
if (deviceSelect) deviceSelect.addEventListener('change', () => attemptAutoRoute());
if (pidSelect)    pidSelect.addEventListener('change', () => attemptAutoRoute());

if (fixCaptureBtn) fixCaptureBtn.addEventListener('click', async () => {
  if (!state.hwnd) return alert('No source hwnd yet.');
  dbg('[WGC] Manual fix requested');
  await window.api.ensureCapturable?.({ hwnd: state.hwnd });
});

// ============ Sources & audio ============

async function refreshSources() {
  sourceSelect.innerHTML = '';
  const sources = await window.api.listCaptureSources();
  for (const s of sources) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sourceSelect.appendChild(opt);
  }
  if (!sources.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No windows found';
    sourceSelect.appendChild(opt);
  }
}

async function refreshAudioDevices() {
  dbg('Refreshing audio devices…');
  const res = await window.api.listAudioDevices();
  deviceSelect.innerHTML = '';
  if (res.error) {
    dbg(`Error: ${res.error}`);
    const opt = document.createElement('option');
    opt.textContent = res.error;
    deviceSelect.appendChild(opt);
    debugArea && (debugArea.open = true);
    return;
  }
  dbg(`Devices loaded: ${res.devices.length}`);
  for (const d of res.devices) {
    if (!d.id) continue;
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    deviceSelect.appendChild(opt);
  }
  // if we already have a PID, try route
  attemptAutoRoute();
}

function fillPidSelect(list) {
  pidSelect.innerHTML = '';
  if (!list || !list.length) {
    const opt = document.createElement('option');
    opt.textContent = 'PID not found (use Volume Mixer)';
    pidSelect.appendChild(opt);
    return;
  }
  for (const x of list) {
    const opt = document.createElement('option');
    opt.value = x.pid;
    opt.textContent = `${x.pid} — ${x.title}`;
    pidSelect.appendChild(opt);
  }
}

async function attemptAutoRoute() {
  const pid = pidSelect.value;
  const deviceId = deviceSelect.value;
  if (!pid || !deviceId) return;
  const res = await window.api.routeAudio({ pid, deviceId });
  if (!res?.ok) dbg(`Audio route failed (pid=${pid})`);
  else dbg(`Audio routed pid=${pid}`);
}

// ============ Mirroring ============

async function autoMirrorFromSelection() {
  const id = sourceSelect.value;
  if (!id) return;
  await startMirror(id);
}

function parseHwndFromChromeId(id) {
  const m = /^window:(\d+):/.exec(id || '');
  return m ? Number(m[1]) : null;
}

async function startMirror(sourceId) {
  try {
    // stop previous
    if (stream) { stream.getTracks().forEach(t => t.stop?.()); stream = null; }
    await stopKeepAlive();

    // start capture
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } }
    });
    video.srcObject = stream;

    await new Promise(res => (video.readyState >= 1 ? res() : (video.onloadedmetadata = () => res())));
    try { await video.play(); } catch {}

    capW = video.videoWidth  || stream.getVideoTracks()[0]?.getSettings?.().width  || 1920;
    capH = video.videoHeight || stream.getVideoTracks()[0]?.getSettings?.().height || 1080;

    state.hwnd = parseHwndFromChromeId(sourceId);
    const title = sourceSelect.options[sourceSelect.selectedIndex]?.text || '';
    state.windowTitle = title;

    dbg(`[HWND] from chromeMediaSourceId -> ${state.hwnd}`);

    // pid candidates by title
    const candidates = await window.api.findPidsByTitle(title);
    fillPidSelect(candidates);
    state.pid = candidates[0]?.pid ?? null;

    // compute mapping
    await recalcMap(true);

    dbg(`Mirror started: ${capW}x${capH} hwnd=${state.hwnd} pid=${state.pid} title="${title}"`);
    updateActiveUI(true);
    // ensure audio routing & KEEPALIVE
    attemptAutoRoute();
    startKeepAlive(state.hwnd);
  } catch (e) {
    dbg(`startMirror error: ${e.message}`);
  }
}

function updateActiveUI(isActive) {
  state.active = !!isActive;
  document.body.classList.toggle('compact', state.active); // auto-compact when active
}

// ============ Mapping ============

function getDisplayedVideoRect() {
  // Trust the browser's layout instead of re-implementing object-fit math.
  const r = video.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function chooseBestMode(g) {
  const capR = (capW || 16) / (capH || 9);
  const winR = Math.max(1, g.win.w)    / Math.max(1, g.win.h);
  const cliR = Math.max(1, g.client.w) / Math.max(1, g.client.h);

  const errWin = Math.abs(Math.log(capR / winR));
  const errCli = Math.abs(Math.log(capR / cliR));

  const offX = Math.max(0, g.client.offX || 0);
  const offY = Math.max(0, g.client.offY || 0);
  const hasFrame = (offX >= 4) || (offY >= 16);

  if (hasFrame && errCli <= errWin * 1.2) return 'client';
  if (Math.abs(errCli - errWin) <= (Math.max(errCli, errWin) * 0.05)) return 'client';
  return (errCli < errWin) ? 'client' : 'win';
}


function applyMapFromGeometry(g, firstRun=false) {
  const mode = chooseBestMode(g);
  if (mode === 'win') {
    map.scaleX = capW / Math.max(1, g.win.w);
    map.scaleY = capH / Math.max(1, g.win.h);
    map.invScaleX = 1 / map.scaleX;
    map.invScaleY = 1 / map.scaleY;
    map.offX = g.client.offX || 0;
    map.offY = g.client.offY || 0;
    map.clientW = g.client.w || capW;
    map.clientH = g.client.h || capH;
    map.winW = g.win.w || capW;
    map.winH = g.win.h || capH;
    map.mode = 'win';
  } else {
    map.scaleX = capW / Math.max(1, g.client.w);
    map.scaleY = capH / Math.max(1, g.client.h);
    map.invScaleX = 1 / map.scaleX;
    map.invScaleY = 1 / map.scaleY;
    map.offX = 0;
    map.offY = 0;
    map.clientW = g.client.w || capW;
    map.clientH = g.client.h || capH;
    map.winW = g.win.w || capW;
    map.winH = g.win.h || capH;
    map.mode = 'client';
  }

  if (firstRun) {
    dbg(`[Map] mode=${map.mode} cap=${capW}x${capH} win=${map.winW}x${map.winH} client=${map.clientW}x${map.clientH}`);
    dbg(`[Map] scaleX=${map.scaleX.toFixed(6)} scaleY=${map.scaleY.toFixed(6)} off(${map.offX},${map.offY})`);
  } else {
    dbg(`[Map] (recalc) mode=${map.mode} scale=(${map.scaleX.toFixed(6)},${map.scaleY.toFixed(6)}) off(${map.offX},${map.offY}) client=${map.clientW}x${map.clientH}`);
  }
}

async function recalcMap(firstRun=false) {
  if (!state.hwnd || !capW || !capH) return;
  const g = await window.api.getWindowGeometry(state.hwnd);
  if (g && g.win && g.client) applyMapFromGeometry(g, firstRun);
  else if (firstRun) {
    map.scaleX = map.scaleY = 1; map.invScaleX = map.invScaleY = 1;
    map.offX = map.offY = 0; map.clientW = capW; map.clientH = capH;
    map.mode = 'win';
    dbg('[Map] geometry unavailable, using identity mapping');
  }
}

// css-px -> capture -> window -> client; return integers clamped to client
function mapPoint(e, rect) {
  const r = rect || getDisplayedVideoRect();
  const u = (e.clientX - r.x) / r.w;
  const v = (e.clientY - r.y) / r.h;
  const capX = u * capW;
  const capY = v * capH;

  const winX = capX * map.invScaleX;
  const winY = capY * map.invScaleY;

  const cxFloat = winX - (map.offX || 0);
  const cyFloat = winY - (map.offY || 0);

  const cx = Math.min(Math.max(0, Math.round(cxFloat)), Math.max(0, (map.clientW || capW) - 1));
  const cy = Math.min(Math.max(0, Math.round(cyFloat)), Math.max(0, (map.clientH || capH) - 1));

  return { cx, cy, capX, capY, winX, winY, r };
}

function haveTarget() { return !!(state.hwnd && capW && capH); }

function insideVideo(e) {
  const r = getDisplayedVideoRect();
  if (e.clientX < r.x || e.clientX > r.x + r.w || e.clientY < r.y || e.clientY > r.y + r.h) return null;
  return r;
}

function btnNameFromMouseEvent(e) { return e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left'; }

// ============ Pointer handling ============

// keep hover moves even when not dragging
viewport.addEventListener('mousemove', async (e) => {
  if (!haveTarget() || clickThrough?.checked) return;
  const r = insideVideo(e);
  if (!r) { hideShadow(); return; }

  const now = performance.now();
  if (now - lastMoveTs < MOVE_THROTTLE_MS) return;

  // stay fresh (window moved, DPI change, etc.)
  recalcMap().catch(()=>{});

  const p = mapPoint(e, r);
  lastMoveTs = now;

  // visualize (map back to viewport)
  // const vx = r.x + (p.capX / capW) * r.w;
  // const vy = r.y + (p.capY / capH) * r.h;
  // showShadow(vx, vy);

  await window.api.mouseMove({ hwnd: state.hwnd, x: p.cx, y: p.cy, mode: 'real' });

  if (down && !down.sentDown && down.button === 'left') {
    const dx = Math.abs(p.cx - down.startCX);
    const dy = Math.abs(p.cy - down.startCY);
    if (dx >= DRAG_PX || dy >= DRAG_PX) {
      await window.api.mouseDown({ hwnd: state.hwnd, x: down.startCX, y: down.startCY, button: 'left' });
      down.sentDown = true;
      down.dragging = true;
    }
  }
});

viewport.addEventListener('mouseleave', () => hideShadow());

viewport.addEventListener('mousedown', async (e) => {
  if (!haveTarget() || clickThrough?.checked) return;
  const r = insideVideo(e);
  if (!r) return;
  e.preventDefault();

  await recalcMap(); // fresh geom each gesture

  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; } // cancel pending single

  const { cx, cy } = mapPoint(e, r);
  const button = btnNameFromMouseEvent(e);

  down = {
    button,
    startCX: cx, startCY: cy,
    lastCX: cx,  lastCY: cy,
    sentDown: false,
    dragging: false,
    t0: performance.now()
  };

  // Right/middle: press immediately
  if (button !== 'left') {
    await window.api.mouseDown({ hwnd: state.hwnd, x: cx, y: cy, button });
    down.sentDown = true;
  }
});

viewport.addEventListener('mouseup', async (e) => {
  if (!haveTarget() || !down || clickThrough?.checked) return;
  const r = insideVideo(e);
  if (!r) return;
  e.preventDefault();

  const { cx, cy } = mapPoint(e, r);

  // If we already started a drag, finish it
  if (down.sentDown) {
    await window.api.mouseUp({ hwnd: state.hwnd, x: cx, y: cy, button: down.button });
    down = null;
    return;
  }

  // Otherwise this is a "click" (no drag). Defer to allow dblclick detection.
  const sx = down.startCX, sy = down.startCY, btn = down.button;
  down = null;

  clickTimer = setTimeout(async () => {
    clickTimer = null;
    if (btn === 'left' && useSendInput?.checked) {
      // "Real" click on screen
      await window.api.mouseSendinput({ hwnd: state.hwnd, x: sx, y: sy });
    } else {
      // PostMessage sequence
      await window.api.mouseDown({ hwnd: state.hwnd, x: sx, y: sy, button: btn });
      await window.api.mouseUp({ hwnd: state.hwnd, x: sx, y: sy, button: btn });
    }
  }, CLICK_DELAY_MS);
});

// Native dblclick from the renderer view (cancel pending single)
viewport.addEventListener('dblclick', async (e) => {
  if (!haveTarget() || clickThrough?.checked) return;
  const r = insideVideo(e);
  if (!r) return;
  e.preventDefault();
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

  await recalcMap();
  const { cx, cy } = mapPoint(e, r);
  await window.api.mouseDbl({ hwnd: state.hwnd, x: cx, y: cy, button: 'left' });
});

// Wheel -> forward as wheel to worker (vertical only here)
viewport.addEventListener('wheel', async (e) => {
  if (!haveTarget() || clickThrough?.checked) return;
  const r = insideVideo(e);
  if (!r) return;
  e.preventDefault();

  const { cx, cy } = mapPoint(e, r);
  const delta = Math.max(-120, Math.min(120, (e.deltaY < 0 ? 120 : -120)));
  await window.api.mouseWheel({ hwnd: state.hwnd, x: cx, y: cy, delta, horiz:false });
});

// ============ Profiles (localStorage, lightweight) ============

function loadProfiles() {
  try { return JSON.parse(localStorage.getItem('vm_profiles') || '[]'); } catch { return []; }
}
function saveProfiles(arr) { localStorage.setItem('vm_profiles', JSON.stringify(arr)); }

async function refreshProfiles() {
  const list = loadProfiles();
  profilesSelect.innerHTML = '';
  if (!list.length) {
    const opt = document.createElement('option');
    opt.textContent = 'No profiles yet';
    profilesSelect.appendChild(opt);
    return;
  }
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    profilesSelect.appendChild(opt);
  }
}

document.getElementById('saveProfile')?.addEventListener('click', () => {
  const name = (profileName?.value || '').trim();
  if (!name) return alert('Enter a profile name.');
  const id = String(Date.now());
  const profile = {
    id, name,
    sourceId: sourceSelect.value || '',
    windowTitle: state.windowTitle || '',
    audioDeviceId: deviceSelect.value || ''
  };
  const list = loadProfiles();
  list.push(profile);
  saveProfiles(list);
  refreshProfiles();
});

document.getElementById('applyProfile')?.addEventListener('click', async () => {
  const list = loadProfiles();
  const id = profilesSelect.value;
  const p = list.find(x => x.id === id);
  if (!p) return;
  // pick source by name match if id changed between runs
  let found = false;
  for (const opt of sourceSelect.options) {
    if (opt.value === p.sourceId || opt.text === p.windowTitle) {
      sourceSelect.value = opt.value;
      found = true; break;
    }
  }
  if (found) await autoMirrorFromSelection();
  // audio
  for (const opt of deviceSelect.options) {
    if (opt.value === p.audioDeviceId || opt.text === p.audioDeviceName) {
      deviceSelect.value = opt.value; break;
    }
  }
  attemptAutoRoute();
});

document.getElementById('deleteProfile')?.addEventListener('click', () => {
  const list = loadProfiles();
  const id = profilesSelect.value;
  const i = list.findIndex(x => x.id === id);
  if (i >= 0) {
    list.splice(i, 1);
    saveProfiles(list);
    refreshProfiles();
  }
});

// ============ Misc ============

video?.addEventListener('loadedmetadata', () => {
  capW = video.videoWidth;
  capH = video.videoHeight;
});

viewport?.addEventListener('contextmenu', (e) => {
  // keep native menus on target app, not our window
  e.preventDefault();
});
