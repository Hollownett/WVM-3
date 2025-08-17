// ============ DOM ============

const viewport      = document.getElementById('viewport');
const stage         = document.getElementById('stage');

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
const embedBtn      = document.getElementById('embed');
const routeBtn      = document.getElementById('route');
const fixCaptureBtn = document.getElementById('fixCapture');
const compactBtn    = document.getElementById('compactBtn');


// debug (kept but non-intrusive)
const debugArea     = document.getElementById('debugArea');
const debugLogEl    = document.getElementById('debugLog');
const dbgClearBtn   = document.getElementById('dbgClear');
const dbgCopyBtn    = document.getElementById('dbgCopy');

// ============ State ============

const state = {
  hwnd: null,
  pid: null,
  windowTitle: '',
  audioDeviceId: null
};


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

let offDebugLog, offClickThroughUpdated, offToggleCompact;

function bindIpcEvents() {
  // remove old listeners if re-binding
  offDebugLog?.();
  offClickThroughUpdated?.();
  offToggleCompact?.();

  if (window.api?.onDebugLog) {
    offDebugLog = window.api.onDebugLog((msg) => {
      const time = new Date().toLocaleTimeString();
      if (debugLogEl) {
        debugLogEl.textContent += `[${time}] ${msg}\n`;
        debugLogEl.scrollTop = debugLogEl.scrollHeight;
      }
    });
  }

  if (window.api?.onClickThroughUpdated)
    offClickThroughUpdated = window.api.onClickThroughUpdated(v => { if (clickThrough) clickThrough.checked = !!v; });

  if (window.api?.onToggleCompact)
    offToggleCompact = window.api.onToggleCompact(() => document.body.classList.toggle('compact'));
}

function unbindIpcEvents() {
  offDebugLog?.();
  offClickThroughUpdated?.();
  offToggleCompact?.();
  offDebugLog = offClickThroughUpdated = offToggleCompact = null;
}

bindIpcEvents();
window.addEventListener('beforeunload', unbindIpcEvents);

// tiny pointer shadow to visualize mapping

// ============ Window chrome / toggles ============

const minBtn = document.getElementById('minBtn');
if (minBtn) minBtn.onclick = () => window.api.winMinimize();
const maxBtn = document.getElementById('maxBtn');
if (maxBtn) maxBtn.onclick = () => window.api.winToggleMax();
const closeBtn = document.getElementById('closeBtn');
if (closeBtn) closeBtn.onclick = () => window.api.winClose();
if (compactBtn) compactBtn.onclick = () => {
  document.body.classList.toggle('compact');
  queueEmbedBounds();
};

if (pin) pin.addEventListener('change', e => window.api.setAlwaysOnTop(e.target.checked));
if (clickThrough) clickThrough.addEventListener('change', e => window.api.setClickThrough(e.target.checked));
if (opacityRange) {
  opacityRange.addEventListener('input', e => {
    const v = Number(e.target.value);
    window.api.setOpacity(v);
    if (opacityVal) opacityVal.textContent = Math.round(v * 100) + '%';
  });
}

// bindings may be re-initialized if needed by calling bindIpcEvents again

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
  if (profilesSelect) await refreshProfiles();

})();

// ============ UI actions (auto-first) ============

if (refreshBtn) refreshBtn.addEventListener('click', refreshSources);
if (refreshAudioBtn) refreshAudioBtn.addEventListener('click', refreshAudioDevices);
if (locateSVVBtn) locateSVVBtn.addEventListener('click', async () => {
  await window.api.pickSVV();
  await refreshAudioDevices();
});

let embedObserver = null;
let stageObserver = null;
let resizeRaf = null;

function getScaledBounds() {
  const r = viewport.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  return {
    x: Math.round(r.left * scale),
    y: Math.round(r.top * scale),
    width: Math.round(r.width * scale),
    height: Math.round(r.height * scale)
  };
}

function sendEmbedBounds() {
  if (!viewport || !state.hwnd) return;
  window.api.setEmbeddedBounds(getScaledBounds());
}

function queueEmbedBounds() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      sendEmbedBounds();
    });
  });
}

if (embedBtn) embedBtn.addEventListener('click', async () => {
  const id = sourceSelect?.value || '';
  const parts = id.split(':');
  const hwnd = Number(parts[1]);
  const title = sourceSelect.options[sourceSelect.selectedIndex]?.text || '';
  if (!hwnd || !viewport) return;
  state.hwnd = hwnd;
  state.windowTitle = title;
    const bounds = getScaledBounds();
    await window.api.embedWindow(hwnd, bounds);
    await window.api.keepAliveSet({ hwnd, enable: true });
    embedObserver?.disconnect();
    stageObserver?.disconnect();
    queueEmbedBounds();
    embedObserver = new ResizeObserver(queueEmbedBounds);
    embedObserver.observe(viewport);
    if (stage) {
      stageObserver = new ResizeObserver(queueEmbedBounds);
      stageObserver.observe(stage);
    }
    window.addEventListener('resize', queueEmbedBounds);
    visualViewport?.addEventListener('resize', queueEmbedBounds);
    document.addEventListener('fullscreenchange', queueEmbedBounds);
    viewport.style.pointerEvents = 'none';
});

if (routeBtn) routeBtn.addEventListener('click', () => attemptAutoRoute());
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
  } else {
    // Force user interaction so the first click triggers a change event
    sourceSelect.selectedIndex = -1;
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

// ============ Profiles (localStorage, lightweight) ============

function loadProfiles() {
  try { return JSON.parse(localStorage.getItem('vm_profiles') || '[]'); } catch { return []; }
}
function saveProfiles(arr) { localStorage.setItem('vm_profiles', JSON.stringify(arr)); }

async function refreshProfiles() {
  if (!profilesSelect) return;
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


viewport?.addEventListener('contextmenu', (e) => {
  // keep native menus on target app, not our window
  e.preventDefault();
});