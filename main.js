const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
function dbg(msg) { try { if (win) win.webContents.send('debug:log', `[Audio] ${msg}`); } catch {} }
let win;

// Ensure a single running instance and proper AppUserModelID on Windows
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}
if (process.platform === 'win32') {
  app.setAppUserModelId('com.yourco.virtualmonitor');
}

// --- Persistent Click Worker (PowerShell) ---
const CLICK_WORKER_NAME = 'click_worker.ps1';
let clickWorker = null;
let clickWorkerBuf = '';
let clickWorkerReady = false;
let workerProc = null;
let workerReady = false;
let reqId = 1;
const pending = new Map();
let stderrTail = '';

function writeWorkerScript() {
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }

[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }

[StructLayout(LayoutKind.Sequential)]
public struct INPUT { public int type; public MOUSEINPUT mi; }

[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT {
  public int dx, dy, mouseData, dwFlags, time;
  public IntPtr dwExtraInfo;
}

public static class U {
  [DllImport("user32.dll")] public static extern bool  IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int   GetWindowText(IntPtr hWnd, StringBuilder sb, int nMax);
  [DllImport("user32.dll")] public static extern bool  ClientToScreen(IntPtr hWnd, ref POINT pt);
  [DllImport("user32.dll")] public static extern bool  ScreenToClient(IntPtr hWnd, ref POINT pt);
  [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr hWnd, POINT pt, uint flags);
  [DllImport("user32.dll")] public static extern bool  PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool  GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern bool  SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern uint  SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool  GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool  GetClientRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern int   MapWindowPoints(IntPtr hWndFrom, IntPtr hWndTo, ref POINT lpPoints, int cPoints);
  [DllImport("user32.dll")] public static extern bool  SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint  GetDpiForWindow(IntPtr hwnd);
  // NEW for keep-alive:
  [DllImport("user32.dll")] public static extern bool  IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool  ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool  SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

[void][U]::SetProcessDPIAware()

function Out-JsonLine($obj) {
  $j = $obj | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($j)
  [Console]::Out.Flush()
}

# Coalesce helpers
function CoalesceInt($v, $def)  { if ($null -ne $v) { [int]$v }  else { [int]$def } }
function CoalesceBool($v, $def) { if ($null -ne $v) { [bool]$v } else { [bool]$def } }

# Hit-test + convert coords once; reuse everywhere
function Resolve-ChildPoint {
  param([IntPtr]$hwnd,[int]$cx,[int]$cy)
  $ptClient = New-Object POINT; $ptClient.X = $cx; $ptClient.Y = $cy
  $flags = [uint32](0x0001 -bor 0x0002 -bor 0x0004) # SKIPINVISIBLE|SKIPDISABLED|SKIPTRANSPARENT
  $child = [U]::ChildWindowFromPointEx($hwnd, $ptClient, $flags)
  if ($child -eq [IntPtr]::Zero) { $child = $hwnd }

  $ptScr = $ptClient; [void][U]::ClientToScreen($hwnd, [ref]$ptScr)
  $ptChild = $ptScr;  [void][U]::ScreenToClient($child, [ref]$ptChild)

  $lParam = ((($ptChild.Y -band 0xFFFF) -shl 16) -bor ($ptChild.X -band 0xFFFF))

  [pscustomobject]@{
    child   = $child
    scrX    = $ptScr.X
    scrY    = $ptScr.Y
    childX  = $ptChild.X
    childY  = $ptChild.Y
    lParam  = $lParam
  }
}

# Keep worker alive on any runtime error
trap {
  try { Out-JsonLine(@{ type='error'; message = $_.Exception.Message }) } catch { }
  continue
}

# ----------------- Handlers -----------------

function Handle-Geom($req) {
  $hwnd = [IntPtr]([int64]$req.hwnd)
  if (-not [U]::IsWindow($hwnd)) { return @{ id=$req.id; ok=$false; err='bad hwnd' } }

  $wr = New-Object RECT
  $cr = New-Object RECT
  [void][U]::GetWindowRect($hwnd, [ref]$wr)
  [void][U]::GetClientRect($hwnd, [ref]$cr)

  $pt = New-Object POINT; $pt.X = 0; $pt.Y = 0
  [void][U]::MapWindowPoints($hwnd, [IntPtr]::Zero, [ref]$pt, 1)
  $offX = $pt.X - $wr.Left
  $offY = $pt.Y - $wr.Top

  $dpi = 96; try { $dpi = [U]::GetDpiForWindow($hwnd) } catch {}

  @{
    id = $req.id; ok = $true;
    win    = @{ x=$wr.Left; y=$wr.Top; w=($wr.Right-$wr.Left); h=($wr.Bottom-$wr.Top) };
    client = @{ w=($cr.Right-$cr.Left); h=($cr.Bottom-$cr.Top); offX=$offX; offY=$offY };
    dpi    = [int]$dpi
  }
}

function Handle-Smart($req) {
  $hwnd = [IntPtr]([int64]$req.hwnd)
  if (-not [U]::IsWindow($hwnd)) { return @{ id=$req.id; ok=$false; err='bad hwnd' } }
  $cx = [int]$req.x; $cy = [int]$req.y

  $info = Resolve-ChildPoint -hwnd $hwnd -cx $cx -cy $cy
  $child = $info.child; $lParam = [IntPtr]([int]$info.lParam)

  $WM_MOUSEMOVE   = 0x0200
  $WM_LBUTTONDOWN = 0x0201
  $WM_LBUTTONUP   = 0x0202
  $MK_LBUTTON     = 1

  [void][U]::PostMessage($child, $WM_MOUSEMOVE,   [IntPtr]::Zero,      $lParam)
  [void][U]::PostMessage($child, $WM_LBUTTONDOWN, [IntPtr]$MK_LBUTTON, $lParam)
  [void][U]::PostMessage($child, $WM_LBUTTONUP,   [IntPtr]::Zero,      $lParam)

  @{ id=$req.id; ok=$true }
}

function Handle-SendInput($req) {
  $hwnd = [IntPtr]([int64]$req.hwnd)
  if (-not [U]::IsWindow($hwnd)) { return @{ id=$req.id; ok=$false; err='bad hwnd' } }
  $cx = [int]$req.x; $cy = [int]$req.y

  $pt = New-Object POINT; $pt.X = $cx; $pt.Y = $cy
  [void][U]::ClientToScreen($hwnd, [ref]$pt)

  $old = New-Object POINT
  [void][U]::GetCursorPos([ref]$old)
  [void][U]::SetCursorPos($pt.X, $pt.Y)

  $INPUT_SIZE = [Runtime.InteropServices.Marshal]::SizeOf([type][INPUT])
  $down = New-Object INPUT; $down.type = 0; $down.mi = New-Object MOUSEINPUT; $down.mi.dwFlags = 0x0002
  $up   = New-Object INPUT; $up.type   = 0; $up.mi   = New-Object MOUSEINPUT; $up.mi.dwFlags   = 0x0004
  $arr = New-Object INPUT[] 1
  $arr[0] = $down; [void][U]::SendInput(1, $arr, $INPUT_SIZE)
  $arr[0] = $up;   [void][U]::SendInput(1, $arr, $INPUT_SIZE)

  [void][U]::SetCursorPos($old.X, $old.Y)
  @{ id=$req.id; ok=$true }
}

function Handle-Move($req) {
  $hwnd = [IntPtr]([int64]$req.hwnd)
  if (-not [U]::IsWindow($hwnd)) { return @{ id=$req.id; ok=$false; err='bad hwnd' } }
  $cx = [int]$req.x; $cy = [int]$req.y
  $info = Resolve-ChildPoint -hwnd $hwnd -cx $cx -cy $cy
  $WM_MOUSEMOVE = 0x0200
  [void][U]::PostMessage($info.child, $WM_MOUSEMOVE, [IntPtr]::Zero, [IntPtr]([int]$info.lParam))
  @{ id=$req.id; ok=$true }
}

function Get-ButtonPair($button) {
  switch (("$button").ToLowerInvariant()) {
    'right'  { @{ down=0x0204; up=0x0205; dbl=0x0206; mask=0x0002 } }
    'middle' { @{ down=0x0207; up=0x0208; dbl=0x0209; mask=0x0010 } }
    default  { @{ down=0x0201; up=0x0202; dbl=0x0203; mask=0x0001 } }
  }
}

function Handle-Down($req) {
  $hwnd = [IntPtr]([int64]$req.hwnd)
  if (-not [U]::IsWindow($hwnd)) { return @{ id=$req.id; ok=$false; err='bad hwnd' } }
  $cx = [int]$req.x; $cy = [int]$req.y; $btn = $req.button
  $info = Resolve-ChildPoint -hwnd $hwnd -cx $cx -cy $cy
  $pair = Get-ButtonPair $btn
  [void][U]::PostMessage($info.child, $pair.down, [IntPtr]([int]$pair.mask), [IntPtr]([int]$info.lParam))
  @{ id=$req.id; ok=$true }
}

function Handle-Up($req) {
  $hwnd = [IntPtr]([int64]$req.hwnd)
  if (-not [U]::IsWindow($hwnd)) { return @{ id=$req.id; ok=$false; err='bad hwnd' } }
  $cx = [int]$req.x; $cy = [int]$req.y; $btn = $req.button
  $info = Resolve-ChildPoint -hwnd $hwnd -cx $cx -cy $cy
  $pair = Get-ButtonPair $btn
  [void][U]::PostMessage($info.child, $pair.up, [IntPtr]::Zero, [IntPtr]([int]$info.lParam))
  @{ id=$req.id; ok=$true }
}

function Handle-DblClick($req) {
  $hwnd = [IntPtr]([int64]$req.hwnd)
  if (-not [U]::IsWindow($hwnd)) { return @{ id=$req.id; ok=$false; err='bad hwnd' } }
  $cx = [int]$req.x; $cy = [int]$req.y; $btn = $req.button
  $info = Resolve-ChildPoint -hwnd $hwnd -cx $cx -cy $cy
  $pair = Get-ButtonPair $btn

  [void][U]::PostMessage($info.child, $pair.down, [IntPtr]([int]$pair.mask), [IntPtr]([int]$info.lParam))
  Start-Sleep -Milliseconds 8
  [void][U]::PostMessage($info.child, $pair.up,   [IntPtr]::Zero,          [IntPtr]([int]$info.lParam))
  Start-Sleep -Milliseconds 8
  [void][U]::PostMessage($info.child, $pair.dbl,  [IntPtr]([int]$pair.mask), [IntPtr]([int]$info.lParam))
  Start-Sleep -Milliseconds 8
  [void][U]::PostMessage($info.child, $pair.up,   [IntPtr]::Zero,          [IntPtr]([int]$info.lParam))
  @{ id=$req.id; ok=$true }
}

function Handle-Wheel($req) {
  $hwnd = [IntPtr]([int64]$req.hwnd)
  if (-not [U]::IsWindow($hwnd)) { return @{ id=$req.id; ok=$false; err='bad hwnd' } }

  $cx = [int]$req.x
  $cy = [int]$req.y
  $delta = CoalesceInt $req.delta 120
  $horiz = CoalesceBool $req.horiz $false

  $pt = New-Object POINT; $pt.X = $cx; $pt.Y = $cy
  [void][U]::ClientToScreen($hwnd, [ref]$pt)
  $lParam = ((($pt.Y -band 0xFFFF) -shl 16) -bor ($pt.X -band 0xFFFF))
  $wParam = (([int]$delta -band 0xFFFF) -shl 16)

  $WM_MOUSEWHEEL  = 0x020A
  $WM_MOUSEHWHEEL = 0x020E
  $msg = if ($horiz) { $WM_MOUSEHWHEEL } else { $WM_MOUSEWHEEL }

  # Send wheel to top-level window to ensure scrolling even when the
  # child under the cursor does not process WM_MOUSEWHEEL.
  [void][U]::PostMessage($hwnd, $msg, [IntPtr]([int]$wParam), [IntPtr]([int]$lParam))
  @{ id=$req.id; ok=$true }
}

# NEW: Keepalive — restore if minimized, push to bottom, send benign mousemove
function Handle-KeepAlive($req) {
  $hwnd = [IntPtr]([int64]$req.hwnd)
  if (-not [U]::IsWindow($hwnd)) { return @{ id=$req.id; ok=$false; err='bad hwnd' } }

  # only restore if minimized; never steal focus
  if ([U]::IsIconic($hwnd)) { [void][U]::ShowWindowAsync($hwnd, 9) } # SW_RESTORE

  # optional: keep at bottom ONLY when requested AND not foreground
  $stick = CoalesceBool $req.stickBottom $false
  $isFg  = ([U]::GetForegroundWindow() -eq $hwnd)
  if ($stick -and -not $isFg) {
    $HWND_BOTTOM   = [IntPtr]1
    $SWP_NOMOVE    = 0x0002
    $SWP_NOSIZE    = 0x0001
    $SWP_NOACTIVATE= 0x0010
    [void][U]::SetWindowPos($hwnd, $HWND_BOTTOM, 0,0,0,0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE))
  }

  # gentle mousemove ping (keeps media alive)
  $cx = CoalesceInt $req.x 2
  $cy = CoalesceInt $req.y 2
  $info = Resolve-ChildPoint -hwnd $hwnd -cx $cx -cy $cy
  $WM_MOUSEMOVE = 0x0200
  [void][U]::PostMessage($info.child, $WM_MOUSEMOVE, [IntPtr]::Zero, [IntPtr]([int]$info.lParam))
  @{ id=$req.id; ok=$true }
}

# --- Ready ping ---
Out-JsonLine(@{ type='ready' })

# --- NDJSON main loop ---
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { Start-Sleep -Milliseconds 10; continue }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch { continue }
  if ($null -eq $req) { continue }

  $op = ("$($req.op)").ToLowerInvariant()
  try {
    $resp = switch ($op) {
      'geom'      { Handle-Geom $req }
      'smart'     { Handle-Smart $req }
      'sendinput' { Handle-SendInput $req }
      'move'      { Handle-Move $req }
      'down'      { Handle-Down $req }
      'up'        { Handle-Up $req }
      'dblclick'  { Handle-DblClick $req }
      'wheel'     { Handle-Wheel $req }
      'drag'      { Handle-Drag $req }
      'keepalive' { Handle-KeepAlive $req }   # <— NEW
      default     { @{ id=$req.id; ok=$false; err='unknown op' } }
    }
  } catch {
    $resp = @{ id=$req.id; ok=$false; err=$_.Exception.Message }
  }
  Out-JsonLine($resp)
}
`;
  const dir = app.getPath('userData');
  const f = path.join(dir, CLICK_WORKER_NAME);
  try { fs.writeFileSync(f, script, 'utf8'); } catch {}
  return f;
}

function logWorker(m) { try { win.webContents.send('debug:log', `[Worker] ${m}`); } catch {} }

function startClickWorker() {
  const workerPath = writeWorkerScript(); // your function that writes the PS1 to userData
  if (workerProc) { try { workerProc.kill(); } catch {} }
  workerReady = false;
  stderrTail = '';

  workerProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', workerPath], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  // line-buffered JSON from stdout
  let buf = '';
  workerProc.stdout.setEncoding('utf8');
  workerProc.stdout.on('data', chunk => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'ready') {
          workerReady = true;
          logWorker('ready');
          continue;
        }
        if (msg.type === 'error') {
          logWorker(`err: ${msg.message}`);
          continue;
        }
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve, reject, t } = pending.get(msg.id);
          clearTimeout(t);
          pending.delete(msg.id);
          msg.ok ? resolve(msg) : reject(new Error(msg.err || 'worker error'));
        }
      } catch (e) {
        logWorker(`bad json: ${line.slice(0, 200)}`);
      }
    }
  });

  workerProc.stderr.setEncoding('utf8');
  workerProc.stderr.on('data', chunk => {
    stderrTail = (stderrTail + chunk).slice(-400);
  });

  workerProc.on('close', (code, sig) => {
    logWorker(`exit code=${code} sig=${sig} stderrTail=${stderrTail.replace(/\r?\n/g,' | ')}`);
    workerReady = false;
    // fail all pending
    for (const [, v] of pending) { clearTimeout(v.t); v.reject(new Error('worker exit')); }
    pending.clear();
    // lazy restart next time someone calls sendToWorker
  });
}

function ensureWorker() {
  if (!workerProc || workerProc.killed) startClickWorker();
}

function sendToWorker(op, payload = {}, timeoutMs = 3000) {
  ensureWorker();
  if (!workerReady) {
    // queue a little until 'ready' arrives
    // small delay: try again in 50ms
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (workerReady) {
          sendToWorker(op, payload, timeoutMs).then(resolve, reject);
        } else if (!workerProc || workerProc.killed) {
          reject(new Error('worker not running'));
        } else {
          setTimeout(tick, 50);
        }
      };
      setTimeout(tick, 50);
    });
  }

  const id = reqId++;
  const msg = JSON.stringify({ id, op, ...payload }) + '\n';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error('worker timeout'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, t });
    try {
      workerProc.stdin.write(msg);
    } catch (e) {
      clearTimeout(t);
      pending.delete(id);
      reject(e);
    }
  });
}
// simple alias so older calls keep working
const workerCall = (op, payload, timeoutMs = 3000) => sendToWorker(op, payload, timeoutMs);

// kick it off when app is ready
app.whenReady().then(() => {
  startClickWorker();
});


// ---- optional: node-window-manager for PID by title ----
let windowManager = null;
try {
  ({ windowManager } = require('node-window-manager'));
} catch (_) {
  // If native module missing, we’ll still run (PID list may be empty).
}

// ---- settings persistence ----
let settingsPath, settings = {};
function stripBom(s){ return s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }
// NEW: smart text reader (detect BOM/UTF-16LE)
function readTextSmart(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 2) {
    // UTF-16LE BOM
    if (buf[0] === 0xFF && buf[1] === 0xFE) {
      dbg(`readTextSmart: detected UTF-16LE BOM`);
      return buf.toString('utf16le');
    }
    // UTF-16BE BOM (rare from NirSoft; convert by swapping bytes)
    if (buf[0] === 0xFE && buf[1] === 0xFF) {
      dbg(`readTextSmart: detected UTF-16BE BOM`);
      // swap to LE
      const swapped = Buffer.allocUnsafe(buf.length - 2);
      for (let i = 2; i < buf.length; i += 2) {
        swapped[i - 2] = buf[i + 1];
        swapped[i - 1] = buf[i];
      }
      return swapped.toString('utf16le');
    }
    // Heuristic: many zero bytes -> likely UTF-16LE without BOM
    const sample = buf.subarray(0, Math.min(buf.length, 64));
    let zeros = 0; for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeros++;
    if (zeros >= 10) {
      dbg(`readTextSmart: heuristic says UTF-16LE (no BOM)`);
      return buf.toString('utf16le');
    }
    // UTF-8 BOM
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      dbg(`readTextSmart: detected UTF-8 BOM`);
      return buf.subarray(3).toString('utf8');
    }
  }
  dbg(`readTextSmart: defaulting to UTF-8`);
  return buf.toString('utf8');
}

function getProfiles() { return settings.profiles || (settings.profiles = []); }
function setProfiles(arr) { settings.profiles = arr; saveSettings(); }

function loadSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { settings = {}; }
}
function saveSettings() {
  try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2)); } catch {}
}

function getSVVPath() {
  // 1) explicit setting 2) env 3) local alongside app
  const guesses = [
    settings.svvPath,
    process.env.SOUNDVOLUMEVIEW_PATH,
    path.join(process.resourcesPath || __dirname, 'SoundVolumeView.exe'),
    path.join(__dirname, 'bin', 'SoundVolumeView.exe'),
  ].filter(Boolean);
  for (const g of guesses) { try { if (fs.existsSync(g)) return g; } catch {} }
  return null;
}

function createWindow () {
  // restore bounds
  const b = settings.bounds || { width: 720, height: 460 };
  win = new BrowserWindow({
    ...b,
    minWidth: 480,
    minHeight: 360,
    frame: false,                 // modern look (custom titlebar)
    transparent: false,
    backgroundColor: '#0b0b0c',
    alwaysOnTop: settings.alwaysOnTop ?? true,
    vibrancy: 'under-window',     // Windows 11 acrylic-ish
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.setAlwaysOnTop(win.isAlwaysOnTop(), 'screen-saver');
  if (typeof settings.opacity === 'number') win.setOpacity(settings.opacity);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('close', () => {
    settings.bounds = win.getBounds();
    settings.alwaysOnTop = win.isAlwaysOnTop();
    saveSettings();
  });
}

// global hotkey to toggle click-through
function registerHotkeys() {
  globalShortcut.unregisterAll();
  globalShortcut.register('Control+Shift+I', () => {
    const flag = !(settings.clickThrough ?? false);
    if (win) win.setIgnoreMouseEvents(flag, { forward: true });
    settings.clickThrough = flag;
    saveSettings();
    if (win) win.webContents.send('clickthrough-updated', flag);
  });
}

let logFilePath;
function ensureLogFile() {
  if (logFilePath) return logFilePath;
  const logDir = path.join(app.getPath('userData'), 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  logFilePath = path.join(logDir, `virtual-monitor-${yyyy}-${mm}-${dd}.log`);
  return logFilePath;
}
function appendLog(line) {
  const file = ensureLogFile();
  const ts = new Date().toISOString();
  const text = `[${ts}] ${line}\n`;
  fs.appendFile(file, text, () => {});
}

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  registerHotkeys();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---- KeepAlive scheduler (no focus stealing) ----
const keepAliveTimers = new Map();

ipcMain.handle('keepalive:set', async (_evt, { hwnd, enable, x, y, periodMs }) => {
  if (!hwnd) return false;
  if (keepAliveTimers.has(hwnd)) {
    clearInterval(keepAliveTimers.get(hwnd));
    keepAliveTimers.delete(hwnd);
  }
  if (enable) {
    const ms = Math.max(1000, Number(periodMs) || 4000);
    const tick = () => workerCall('keepalive', { hwnd, x: x ?? 2, y: y ?? 2 }).catch(() => {});
    keepAliveTimers.set(hwnd, setInterval(tick, ms));
    tick(); // immediate
  }
  return true;
});

app.on('will-quit', () => { for (const t of keepAliveTimers.values()) clearInterval(t); keepAliveTimers.clear(); });



// LOGS

ipcMain.handle('log:append', (_evt, line) => {
  if (typeof line === 'string' && line.trim()) appendLog(line);
  return true;
});

ipcMain.handle('log:open-folder', () => {
  const file = ensureLogFile();
  // Show the current log file in Explorer
  shell.showItemInFolder(file);
  return true;
});

// ----------------- IPC: WINDOW CHROME -----------------
ipcMain.handle('window:minimize', () => win.minimize());
ipcMain.handle('window:close', () => win.close());
ipcMain.handle('window:toggle-max', () => {
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.handle('set-always-on-top', (_e, v) => {
  win.setAlwaysOnTop(!!v, 'screen-saver');
  settings.alwaysOnTop = !!v; saveSettings(); return true;
});
ipcMain.handle('set-opacity', (_e, value) => {
  const v = Math.max(0.3, Math.min(1, Number(value) || 1));
  win.setOpacity(v); settings.opacity = v; saveSettings(); return v;
});
ipcMain.handle('set-click-through', (_e, flag) => {
  win.setIgnoreMouseEvents(!!flag, { forward: true });
  settings.clickThrough = !!flag; saveSettings(); return !!flag;
});
ipcMain.handle('toggle-compact', () => { win.webContents.send('toggle-compact'); });

// ----------------- IPC: CAPTURE SOURCES -----------------
ipcMain.handle('list-capture-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    fetchWindowIcons: true,
    thumbnailSize: { width: 256, height: 256 }
  });
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    appIconDataUrl: s.appIcon ? s.appIcon.toDataURL() : null,
    thumbnailDataUrl: s.thumbnail ? s.thumbnail.toDataURL() : null
  }));
});

// ----------------- IPC: PID lookup (via node-window-manager) -------------
ipcMain.handle('find-pids-by-title', async (_evt, title) => {
  if (!windowManager) return [];
  const all = windowManager.getWindows();
  const pick = all.filter(w => (w.getTitle() || '').includes(title));
  const seen = new Set();
  const out = [];
  for (const w of pick) {
    const pid = w.processId;
    if (pid && !seen.has(pid)) {
      seen.add(pid);
      out.push({
        pid,
        title: w.getTitle(),
        hwnd: w.handle   // <— NEW (decimal number)
      });
    }
  }
  return out;
});

// ----------------- IPC: SoundVolumeView -----------------
ipcMain.handle('pick-svv', async () => {
  const ret = await dialog.showOpenDialog(win, {
    title: 'Locate SoundVolumeView.exe',
    filters: [{ name: 'Executable', extensions: ['exe'] }],
    properties: ['openFile']
  });
  if (ret.canceled || !ret.filePaths[0]) return null;
  const p = ret.filePaths[0];
  settings.svvPath = p; saveSettings();
  return p;
});

// ipcMain.handle('list-audio-devices', async () => {
//   const svv = getSVVPath();
//   if (!svv) return { error: 'SoundVolumeView.exe not found. Click the folder icon to locate it.' };

//   // write to temp file (SVV cannot write JSON to stdout)
//   const tmp = path.join(os.tmpdir(), `svv_${Date.now()}.json`);
//   const { spawn } = require('child_process');
//   return new Promise((resolve) => {
//     const args = ['/sjson', tmp];
//     const proc = spawn(svv, args, { windowsHide: true });
//     proc.on('close', () => {
//       try {
//         const raw = fs.readFileSync(tmp, 'utf8');
//         fs.unlink(tmp, () => {});
//         const json = JSON.parse(raw || '[]');

//         // Be tolerant to column names across versions
//         const devices = [];
//         for (const x of json) {
//           const type = (x.Type || x['Item Type'] || '').toString().toLowerCase();
//           const dir  = (x.Direction || '').toString().toLowerCase();
//           const state = (x['Device State'] || '').toString().toLowerCase();
//           const isDevice = type.includes('device');
//           const isRender = dir.includes('render') || dir.includes('playback') || dir.includes('output');
//           const isActive = !state || state.includes('active');

//           if (isDevice && isRender && isActive) {
//             devices.push({
//               name: x.Name || x['Device Name'] || x['Device Friendly Name'] || 'Unknown device',
//               id:  x['Command-Line Friendly ID'] || x['Command Line Friendly ID'] || x['Device ID'] || ''
//             });
//           }
//         }
//         resolve({ devices });
//       } catch (e) {
//         resolve({ error: 'Failed to read/parse SoundVolumeView JSON file.', details: String(e) });
//       }
//     });
//   });
// });

// ipcMain.handle('route-audio', async (_evt, { pid, deviceId }) => {
//   const svv = getSVVPath();
//   if (!svv) return { ok: false, error: 'SoundVolumeView.exe not found.' };
//   const { spawn } = require('child_process');
//   return new Promise((resolve) => {
//     // Route all roles (console/multimedia/communications)
//     const args = ['/SetAppDefault', deviceId, 'all', String(pid)];
//     const p = spawn(svv, args, { windowsHide: true });
//     p.on('close', code => resolve({ ok: code === 0, code }));
//   });
// });

ipcMain.handle('list-audio-devices', async () => {
  const svv = getSVVPath();
  if (!svv) {
    dbg('SVV path not found');
    return { error: 'SoundVolumeView.exe not found. Click the 📁 button to locate it.' };
  }

  function runSVV(args) {
    return new Promise((resolve) => {
      dbg(`Spawning: "${svv}" ${args.join(' ')}`);
      const { spawn } = require('child_process');
      const p = spawn(svv, args, { windowsHide: true });
      p.on('error', (err) => { dbg(`spawn error: ${err.message}`); resolve({ code: -1, error: err }); });
      p.on('close', (code) => { dbg(`exit code: ${code}`); resolve({ code }); });
    });
  }

  const tmpJson = path.join(os.tmpdir(), `svv_${Date.now()}.json`);
  let devices = [];
  try {
    const jsonArgs = [
      '/Columns','Name,Command-Line Friendly ID,Item Type,Type,Direction,Device State,Device ID,Device Name',
      '/sjson', tmpJson
    ];
    await runSVV(jsonArgs);
    if (fs.existsSync(tmpJson)) {
      const rawText = readTextSmart(tmpJson);
      dbg(`JSON chars: ${rawText.length}`);
      dbg(`JSON head: ${rawText.slice(0, 120).replace(/\n/g,'\\n')}`);
      const arr = JSON.parse(rawText || '[]');

      devices = (Array.isArray(arr) ? arr : [arr]).map(x => ({
        name: x.Name || x['Device Name'] || x['Device Friendly Name'] || 'Unknown device',
        id:   x['Command-Line Friendly ID'] || x['Command Line Friendly ID'] || x['Device ID'] || '',
        type: (x['Item Type'] || x.Type || '').toString().toLowerCase(),
        dir:  (x.Direction || '').toString().toLowerCase(),
        state:(x['Device State'] || '').toString().toLowerCase(),
      }))
      .filter(d => d.type.includes('device'))
      .filter(d => d.dir.includes('render') || d.dir.includes('playback') || d.dir.includes('output'))
      .filter(d => !d.state || d.state.includes('active'))
      .map(d => ({ name: d.name, id: d.id }));
      dbg(`JSON parsed devices: ${devices.length}`);
    }
  } catch (e) {
    dbg(`JSON parse error: ${e.message}`);
  } finally {
    try { fs.unlinkSync(tmpJson); } catch {}
  }

  if (!devices.length) {
    dbg('Falling back to /stab (TSV)');
    const tmpTab = path.join(os.tmpdir(), `svv_${Date.now()}.txt`);
    try {
      const tabArgs = [
        '/Columns','Name,Command-Line Friendly ID,Item Type,Type,Direction,Device State,Device ID,Device Name',
        '/stab', tmpTab
      ];
      await runSVV(tabArgs);
      if (fs.existsSync(tmpTab)) {
        const text = readTextSmart(tmpTab);
        dbg(`TSV chars: ${text.length}`);
        const lines = text.split(/\r?\n/).filter(Boolean);
        const header = lines.shift() || '';
        dbg(`TSV header: ${header}`);
        const cols = header.split('\t');
        const idx = {
          name: cols.findIndex(c => /^(Name|Device Name|Device Friendly Name)$/i.test(c)),
          id:   cols.findIndex(c => /(Command-?Line Friendly ID|Device ID)/i.test(c)),
          type: cols.findIndex(c => /(Item Type|^Type$)/i.test(c)),
          dir:  cols.findIndex(c => /^Direction$/i.test(c)),
          state:cols.findIndex(c => /^Device State$/i.test(c)),
        };
        devices = lines.map(ln => {
          const p = ln.split('\t');
          return {
            name: p[idx.name] || 'Unknown device',
            id:   p[idx.id] || '',
            type: (p[idx.type] || '').toLowerCase(),
            dir:  (p[idx.dir] || '').toLowerCase(),
            state:(p[idx.state] || '').toLowerCase(),
          };
        })
        .filter(d => d.type.includes('device'))
        .filter(d => d.dir.includes('render') || d.dir.includes('playback') || d.dir.includes('output'))
        .filter(d => !d.state || d.state.includes('active'))
        .map(d => ({ name: d.name, id: d.id }));
        dbg(`TSV parsed devices: ${devices.length}`);
      }
    } catch (e) {
      dbg(`TSV parse error: ${e.message}`);
    } finally {
      try { fs.unlinkSync(tmpTab); } catch {}
    }
  }

  if (!devices.length) {
    dbg('No devices found after JSON+TSV');
    return { error: 'No playback devices found. Try running SoundVolumeView manually.' };
  }
  return { devices };
});

ipcMain.handle('route-audio', async (_evt, { pid, deviceId }) => {
  const svv = getSVVPath();
  if (!svv) return { ok: false, error: 'SoundVolumeView.exe not found.' };
  return new Promise((resolve) => {
    const args = ['/SetAppDefault', deviceId, 'all', String(pid)];
    const p = spawn(svv, args, { windowsHide: true });
    p.on('close', code => resolve({ ok: code === 0, code }));
  });
});

// Forward smart click (non-blocking PostMessage)
ipcMain.handle('forward-click-smart', async (_evt, { hwnd, x, y }) => {
  try {
    const r = await workerCall('smart', { hwnd, x, y }, 1200);
    return { ok: !!r.ok };
  } catch (e) {
    return { ok:false, error: e.err || String(e) };
  }
});


// Replace get-window-geometry to avoid spawns too
ipcMain.handle('get-window-geometry', async (_evt, hwnd) => {
  try {
    const r = await workerCall('geom', { hwnd }, 1200);
    if (!r.ok) return null;
    try { win.webContents.send('debug:log', `[Geom] win ${r.win.w}x${r.win.h} client ${r.client.w}x${r.client.h} off(${r.client.offX},${r.client.offY}) dpi=${r.dpi}`);} catch {}
    return r;
  } catch {
    return null;
  }
});

// SendInput fallback
ipcMain.handle('forward-click-sendinput', async (_evt, { hwnd, x, y }) => {
  try {
    const r = await workerCall('sendinput', { hwnd, x, y }, 1200);
    return { ok: !!r.ok };
  } catch (e) {
    return { ok:false, error: e.err || String(e) };
  }
});

ipcMain.handle('profiles:list', () => getProfiles());
ipcMain.handle('profiles:save', (_e, profile) => {
  // profile = {name, windowTitle, crop, aspect, audioDeviceId, hwndHint, pidHint}
  const arr = getProfiles();
  const idx = arr.findIndex(p => p.name === profile.name);
  if (idx >= 0) arr[idx] = profile; else arr.push(profile);
  setProfiles(arr);
  return { ok: true };
});
ipcMain.handle('profiles:delete', (_e, name) => {
  setProfiles(getProfiles().filter(p => p.name !== name));
  return { ok: true };
});
ipcMain.handle('profiles:get', (_e, name) => {
  const p = getProfiles().find(p => p.name === name);
  return p || null;
});

ipcMain.handle('ensure-capturable', async (_evt, { hwnd }) => {
  function d(m){ try{win.webContents.send('debug:log', `[WGC] ${m}`);}catch{} }
  d(`ensure-capturable: hwnd=${hwnd}`);

  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@;

$hwnd = [IntPtr]${hwnd};
$valid = [W]::IsWindow($hwnd);
Write-Output ("PS: valid={0}" -f $valid);
if (-not $valid) { exit 1 }

# If minimized, restore (SW_RESTORE=9). Minimized windows cannot be captured by WGC.
if ([W]::IsIconic($hwnd)) {
  Write-Output "PS: window is minimized -> restoring"
  Start-Sleep -Milliseconds 120
}

# Nudge size small and send to bottom without activating (so it won't steal focus)
$HWND_BOTTOM = [IntPtr]1
$SWP_NOACTIVATE = 0x0010
# NOTE: We don't move it off-screen to avoid Windows minimizing it again.
[void][W]::SetWindowPos($hwnd, $HWND_BOTTOM, 20, 20, 320, 180, $SWP_NOACTIVATE)
Write-Output "PS: SetWindowPos -> bottom, 320x180 at (20,20)"
`;

  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', ps], { windowsHide: true });
    let out='', err='';
    p.stdout.on('data', d => out += d.toString('utf8'));
    p.stderr.on('data', d => err += d.toString('utf8'));
    p.on('close', code => {
      if (out) win.webContents.send('debug:log', `[WGC] ${out.trim()}`);
      if (err) win.webContents.send('debug:log', `[WGC][stderr] ${err.trim()}`);
      win.webContents.send('debug:log', `[WGC] ensure-capturable exit=${code}`);
      resolve({ ok: code === 0, code, error: err.trim() || undefined });
    });
  });
});

// Resolve HWND by window title (contains match, visible top-level)
// Find a visible top-level window whose title contains the substring
ipcMain.handle('resolve-hwnd-by-title', async (_evt, titleSubstr) => {
  const ts = String(titleSubstr||'').replace(/`/g,'``').replace(/"/g,'""');
  const ps = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int  GetWindowTextLength(IntPtr hWnd);
}
"@;

$needle = "${ts}".ToLowerInvariant()
$found = [IntPtr]::Zero

[W]::EnumWindows({ param($h,$l)
  if (-not [W]::IsWindowVisible($h)) { return $true }
  $len = [W]::GetWindowTextLength($h)
  if ($len -le 0 -or $len -gt 1024) { return $true }
  $sb = New-Object System.Text.StringBuilder ($len+2)
  [W]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
  $t = $sb.ToString()
  if ($t -and $t.ToLowerInvariant().Contains($needle)) { $found = $h; return $false }
  return $true
}, [IntPtr]::Zero) | Out-Null

Write-Output ($found -eq [IntPtr]::Zero ? "0" : $found.ToInt64().ToString())
`;
  return new Promise((resolve) => {
    const p = spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',ps],{ windowsHide:true });
    let out=''; p.stdout.on('data', d=>out+=d);
    p.on('close', () => {
      const v = (out||'').trim(); const hwnd = (/^\d+$/.test(v)?Number(v):0) || null;
      try { win.webContents.send('debug:log', `[HWND] resolve-by-title("${titleSubstr}") -> ${hwnd||0}`);} catch {}
      resolve({ hwnd });
    });
  });
});

// Find a visible top-level window that belongs to a PID
ipcMain.handle('resolve-hwnd-by-pid', async (_evt, pid) => {
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int  GetWindowTextLength(IntPtr hWnd);
}
"@;

uint target = ${Number(pid) || 0};
IntPtr found = IntPtr.Zero;

W.EnumWindows((h, l) => {
  if (!W.IsWindowVisible(h)) return true;
  uint p; W.GetWindowThreadProcessId(h, out p);
  if (p != target) return true;
  if (W.GetWindowTextLength(h) <= 0) return true; // avoid tool windows
  found = h; return false;
}, IntPtr.Zero);

Write-Output(found == IntPtr.Zero ? "0" : found.ToInt64().ToString());
`;
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', ps], { windowsHide: true });
    let out=''; p.stdout.on('data', d => out += d.toString('utf8'));
    p.on('close', () => {
      const val = (out||'').trim();
      const hwnd = /^\d+$/.test(val) ? Number(val) : 0;
      try { win.webContents.send('debug:log', `[HWND] resolve-by-pid(${pid}) -> ${hwnd}`);} catch {}
      resolve({ hwnd: hwnd || null });
    });
  });
});

ipcMain.handle('list-top-windows', async () => {
  const ps = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int  GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@;

let list = new System.Collections.Generic.List<string>();
W.EnumWindows((h, l) => {
  if (!W.IsWindowVisible(h)) return true;
  int len = W.GetWindowTextLength(h);
  if (len <= 0 || len > 1024) return true;
  let sb = new StringBuilder(len + 2);
  W.GetWindowText(h, sb, sb.Capacity);
  string t = sb.ToString();
  uint pid; W.GetWindowThreadProcessId(h, out pid);
  if (!string.IsNullOrWhiteSpace(t)) list.Add($"{h.ToInt64()}|{pid}|{t}");
  return true;
}, IntPtr.Zero);
list.ForEach(s => Console.WriteLine(s));
`;
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const p = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', ps], { windowsHide: true });
    let out=''; p.stdout.on('data', d => out += d.toString('utf8'));
    p.on('close', () => {
      const rows = out.trim().split(/\r?\n/).filter(Boolean).map(line => {
        const [hwnd, pid, ...rest] = line.split('|');
        return { hwnd: Number(hwnd), pid: Number(pid), title: rest.join('|') };
      });
      resolve(rows);
    });
  });
});

// ipcMain.handle('force-topmost', async () => {
//   if (!win) return false;
//   const hwnd = win.getNativeWindowHandle().readInt32LE(0); // 32-bit HWND on Win x64 Electron
//   const ps = `
// Add-Type @"
// using System;
// using System.Runtime.InteropServices;
// public static class U {
//   [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
// }
// "@;
// $HWND_TOPMOST = [IntPtr](-1)
// $SWP_NOMOVE = 0x0002; $SWP_NOSIZE = 0x0001; $SWP_NOACTIVATE = 0x0010
// [U]::SetWindowPos([IntPtr]${hwnd}, $HWND_TOPMOST, 0,0,0,0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE) | Out-Null
// Write-Output "OK";
// `;
//   return new Promise((resolve) => {
//     const p = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', ps], { windowsHide: true });
//     p.on('close', () => resolve(true));
//   });
// });

// --- mouse op helper ---
function wrapMouse(op, t = 2000) {
  return async (_evt, payload) => {
    try {
      const r = await workerCall(op, payload, t);
      return r && r.ok ? r : { ok: false, err: r?.err || 'worker error' };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  };
}

// Matches channels used by preload.js
ipcMain.handle('mouse:geom',      wrapMouse('geom'));
ipcMain.handle('mouse:smart',     wrapMouse('smart'));
ipcMain.handle('mouse:sendinput', wrapMouse('sendinput'));
ipcMain.handle('mouse:move',      wrapMouse('move'));
ipcMain.handle('mouse:down',      wrapMouse('down'));
ipcMain.handle('mouse:up',        wrapMouse('up'));
ipcMain.handle('mouse:dblclick',  wrapMouse('dblclick'));
ipcMain.handle('mouse:wheel',     wrapMouse('wheel'));
ipcMain.handle('mouse:drag',      wrapMouse('drag'));

// --- Settings IPC ---
ipcMain.handle('settings:get', () => {
  try { return settings || {}; } catch { return {}; }
});

ipcMain.handle('settings:update', (_evt, patch = {}) => {
  try {
    settings = Object.assign(settings || {}, patch);
    saveSettings();
  } catch {}
  return settings;
});


// --- Force topmost “screen-saver” level (used by auto-compact loop) ---
ipcMain.handle('force-topmost', () => { 
  try { if (win) win.setAlwaysOnTop(true, 'screen-saver'); } catch {}
  return true; 
});