const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // window controls
  winMinimize: () => ipcRenderer.invoke('window:minimize'),
  winClose: () => ipcRenderer.invoke('window:close'),
  winToggleMax: () => ipcRenderer.invoke('window:toggle-max'),
  toggleCompact: () => ipcRenderer.invoke('toggle-compact'),
  setAlwaysOnTop: (v) => ipcRenderer.invoke('set-always-on-top', v),
  setOpacity: (v) => ipcRenderer.invoke('set-opacity', v),
  setClickThrough: (v) => ipcRenderer.invoke('set-click-through', v),

  // capture & audio
  listCaptureSources: () => ipcRenderer.invoke('list-capture-sources'),
  findPidsByTitle: (title) => ipcRenderer.invoke('find-pids-by-title', title),
  listAudioDevices: () => ipcRenderer.invoke('list-audio-devices'),
  routeAudio: (payload) => ipcRenderer.invoke('route-audio', payload),
  pickSVV: () => ipcRenderer.invoke('pick-svv'),

  // click forwarding
  forwardClickSmart: (payload) => ipcRenderer.invoke('forward-click-smart', payload),
  forwardClickSendInput: (payload) => ipcRenderer.invoke('forward-click-sendinput', payload),

  // hwnd resolvers (IMPORTANT)
  resolveHwndByTitle: (title) => ipcRenderer.invoke('resolve-hwnd-by-title', title),
  resolveHwndByPid:   (pid)   => ipcRenderer.invoke('resolve-hwnd-by-pid', pid),

  // debug log
  logAppend: (line) => ipcRenderer.invoke('log:append', line),
  openLogsFolder: () => ipcRenderer.invoke('log:open-folder'),
  onDebugLog: (cb) => ipcRenderer.on('debug:log', (_e, m) => cb(m)),
  onClickThroughUpdated: (cb) => ipcRenderer.on('clickthrough-updated', (_e, v) => cb(v)),
  onToggleCompact: (cb) => ipcRenderer.on('toggle-compact', () => cb()),
  listTopWindows: () => ipcRenderer.invoke('list-top-windows'),
  getWindowGeometry: (hwnd) => ipcRenderer.invoke('get-window-geometry', hwnd),
  forceTopMost: () => ipcRenderer.invoke('force-topmost'),
  mouseGeom:     (p) => ipcRenderer.invoke('mouse:geom', p),
  mouseSmart:    (p) => ipcRenderer.invoke('mouse:smart', p),
  mouseSendinput:(p) => ipcRenderer.invoke('mouse:sendinput', p),
  mouseMove:     (p) => ipcRenderer.invoke('mouse:move', p),
  mouseDown:     (p) => ipcRenderer.invoke('mouse:down', p),
  mouseUp:       (p) => ipcRenderer.invoke('mouse:up', p),
  mouseDbl:      (p) => ipcRenderer.invoke('mouse:dblclick', p),
  mouseWheel:    (p) => ipcRenderer.invoke('mouse:wheel', p),
  mouseDrag:     (p) => ipcRenderer.invoke('mouse:drag', p),
  keepAliveSet: (p) => ipcRenderer.invoke('keepalive:set', p)
});
