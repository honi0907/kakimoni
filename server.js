const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const PORT = parseInt(process.env.KAKIMONI_PORT || '3000', 10) || 3000;
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 5e6,
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ============================================================
// サーバー状態管理
// ============================================================
const state = {
  // seatId -> { socketId, name, strokes: [], locked, revealed, animType, bgImageUrl, writingBlackout }
  clients: new Map(),
  // seatId -> socketId (子機のセカンド)
  clientDisplays: new Map(),
  // 親機ソケットID一覧
  hosts: new Set(),
  // 親機のセカンドソケットID一覧（グループ別）
  hostDisplayGroups: new Map(), // groupId -> Set<socketId>
  displayLayouts: {},           // groupId -> layout
  // 席番号別演者名 ( seatId -> name )
  seatNames: {},
  // ラベル設定（書き画面の名前表示）
  labelConfig: {
    enabled: false,
    fontSize: 32,
    fontFamily: 'sans-serif',
    x: 50,
    y: 88,
    textAlign: 'center',
    color: '#ffffff',
    bgColor: 'rgba(0,0,0,0)',
    bgPadding: 8,
    shadowEnabled: true,
    shadowColor: '#000000',
    shadowBlur: 4,
    shadowOffsetX: 0,
    shadowOffsetY: 2,
    bold: false,
    italic: false,
  },
  // タイマー
  timer: { duration: 30, remaining: 30, running: false },
  timerInterval: null,
  currentChoiceUrl: null,
  judgeColorMode: false,
  lockDarkness: 65,
  // 同時運用中のホストUI情報
  hostPanels: new Map(), // socketId -> { operatorName, uiType, connectedAt }
  lastHostAction: null,
};

function sanitizeOperatorName(raw) {
  const v = String(raw || '').trim();
  if (!v) return 'host-operator';
  return v.slice(0, 32);
}

function sanitizeUiType(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v === 'electron' || v === 'web') return v;
  return 'unknown';
}

function broadcastHostPanels() {
  const panels = [];
  for (const [socketId, info] of state.hostPanels.entries()) {
    panels.push({ socketId, ...info });
  }
  panels.sort((a, b) => String(a.connectedAt).localeCompare(String(b.connectedAt)));
  for (const id of state.hosts) io.to(id).emit('host-panels', { panels });
}

function trackHostAction(socket, action, detail = {}) {
  if (socket.role !== 'host') return;
  const panel = state.hostPanels.get(socket.id) || {
    operatorName: 'host-operator',
    uiType: 'unknown',
    connectedAt: new Date().toISOString(),
  };
  const payload = {
    action,
    detail,
    operatorName: panel.operatorName,
    uiType: panel.uiType,
    socketId: socket.id,
    at: new Date().toISOString(),
  };
  state.lastHostAction = payload;
  for (const id of state.hosts) io.to(id).emit('host-action-trace', payload);
}

// ============================================================
// 静的ファイル配信
// ============================================================
app.get(['/host', '/host/', '/hostweb', '/hostweb/', '/host/index.html'], (req, res) => {
  res.redirect(302, '/host-v2');
});

app.use(express.static(path.join(__dirname, 'public')));

// ルートアクセス時はトップページへ
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html><html lang="ja"><head>
    <meta charset="UTF-8">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">
    <title>KakiMoni - サーバー起動中</title>
    <style>
      body { font-family: 'Montserrat', sans-serif; background: #1a1a2e; color: #eee;
             display: flex; flex-direction: column; align-items: center;
             justify-content: center; min-height: 100vh; margin: 0; }
      h1 { color: #e94560; }
      .links { display: flex; gap: 20px; flex-wrap: wrap; justify-content: center; margin-top: 20px; }
      a { display: block; padding: 20px 30px; background: #16213e; border: 2px solid #0f3460;
          color: #eee; text-decoration: none; border-radius: 12px; font-size: 1.2rem;
          transition: all 0.2s; }
      a:hover { background: #0f3460; border-color: #e94560; }
      .ip { margin-top: 30px; color: #888; font-size: 0.9rem; }
    </style></head>
    <body>
    <h1>🎯 KakiMoni クイズ書きシステム</h1>
    <div class="links">
      <a href="/host">🎛️ 親機（ホスト操作画面）</a>
      <a href="/host-v2">🆕 親機（ホスト操作画面 V2）</a>
      <a href="/host-display">📺 親機のセカンド（一覧表示）</a>
      <a href="/client">✏️ 子機（回答書き）</a>
      <a href="/client-mobile">📱 子機（スマホ簡易版）</a>
      <a href="/client-display">🪟 子機のセカンド（大型モニター）</a>
    </div>
    <p class="ip">サーバーIPアドレス: <strong>${getLocalIP()}</strong>:${PORT}</p>
    </body></html>
  `);
});

app.get('/host-v2', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host', 'index-v2.html'));
});

// ============================================================
// セーブ機能
// ============================================================
const savesDir = path.join(__dirname, 'saves');
if (!fs.existsSync(savesDir)) fs.mkdirSync(savesDir);
// 席ごとのサブフォルダを事前作成（ID01〜ID10）
for (let i = 1; i <= 10; i++) {
  const subDir = path.join(savesDir, `ID${String(i).padStart(2, '0')}`);
  if (!fs.existsSync(subDir)) fs.mkdirSync(subDir);
}

const saveStatePath = path.join(savesDir, '.state.json');
let saveState = { session: 1, counter: 0 };
try {
  if (fs.existsSync(saveStatePath)) {
    saveState = JSON.parse(fs.readFileSync(saveStatePath, 'utf-8'));
  }
} catch {}
function persistSaveState() {
  fs.writeFileSync(saveStatePath, JSON.stringify(saveState));
}

const clientSettingsDir = path.join(savesDir, 'client_settings');
if (!fs.existsSync(clientSettingsDir)) fs.mkdirSync(clientSettingsDir, { recursive: true });

function normalizeSeatId(raw) {
  const n = parseInt(String(raw || ''), 10);
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  return n;
}

function clientSettingsPathBySeat(seatId) {
  return path.join(clientSettingsDir, `ID${String(seatId).padStart(2, '0')}.json`);
}

app.get('/api/client-settings/:seatId', (req, res) => {
  try {
    const seatId = normalizeSeatId(req.params.seatId);
    if (!seatId) return res.status(400).json({ ok: false, error: 'invalid seatId' });

    const filePath = clientSettingsPathBySeat(seatId);
    if (!fs.existsSync(filePath)) {
      return res.json({ ok: true, seatId, settings: null });
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return res.json({ ok: true, seatId, settings: data.settings || null, updatedAt: data.updatedAt || null });
  } catch (e) {
    console.error('[ClientSettings] load error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/client-settings/:seatId', express.json({ limit: '1mb' }), (req, res) => {
  try {
    const seatId = normalizeSeatId(req.params.seatId);
    if (!seatId) return res.status(400).json({ ok: false, error: 'invalid seatId' });

    const settings = req.body && req.body.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return res.status(400).json({ ok: false, error: 'invalid settings payload' });
    }

    const record = {
      seatId,
      updatedAt: new Date().toISOString(),
      settings,
    };
    const filePath = clientSettingsPathBySeat(seatId);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    res.json({ ok: true, seatId, updatedAt: record.updatedAt });
  } catch (e) {
    console.error('[ClientSettings] save error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// アプリアップデート配信 API
// ============================================================
const updateChannels = ['client', 'host', 'layout'];
const updateStores = {};

for (const channel of updateChannels) {
  const channelDir = path.join(__dirname, 'updates', channel);
  const filesDir = path.join(channelDir, 'files');
  const latestPath = path.join(channelDir, 'latest.json');
  if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });
  updateStores[channel] = { filesDir, latestPath };
}

app.get('/api/update/:channel/latest', (req, res) => {
  try {
    const channel = String(req.params.channel || '').toLowerCase();
    const store = updateStores[channel];
    if (!store) {
      return res.status(404).json({ ok: false, error: 'unknown update channel' });
    }
    if (!fs.existsSync(store.latestPath)) {
      return res.status(404).json({ ok: false, error: 'latest manifest not found' });
    }

    const data = JSON.parse(fs.readFileSync(store.latestPath, 'utf-8'));
    if (!data || !data.version || !data.fileName) {
      return res.status(500).json({ ok: false, error: 'invalid latest manifest' });
    }

    res.json({
      ok: true,
      channel,
      version: data.version,
      fileName: data.fileName,
      size: data.size || 0,
      sha256: data.sha256 || '',
      notes: data.notes || '',
      publishedAt: data.publishedAt || null,
      downloadPath: `/api/update/${channel}/file/${encodeURIComponent(data.fileName)}`,
    });
  } catch (e) {
    console.error('[Updater] latest error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/update/:channel/file/:fileName', (req, res) => {
  try {
    const channel = String(req.params.channel || '').toLowerCase();
    const store = updateStores[channel];
    if (!store) {
      return res.status(404).json({ ok: false, error: 'unknown update channel' });
    }

    const rawName = req.params.fileName || '';
    const safeName = path.basename(rawName);
    if (!safeName || safeName !== rawName) {
      return res.status(400).json({ ok: false, error: 'invalid file name' });
    }

    const filePath = path.join(store.filesDir, safeName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: 'file not found' });
    }

    res.download(filePath, safeName);
  } catch (e) {
    console.error('[Updater] file error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/save-state', (req, res) => {
  res.json({ session: saveState.session, counter: saveState.counter });
});
app.post('/api/save-next-counter', express.json(), (req, res) => {
  saveState.counter++;
  persistSaveState();
  res.json({ session: saveState.session, counter: saveState.counter });
});
app.post('/api/save-bump-session', express.json(), (req, res) => {
  saveState.session++;
  saveState.counter = 0;
  persistSaveState();
  res.json({ session: saveState.session, counter: saveState.counter });
});
app.post('/api/save-set-session', express.json(), (req, res) => {
  const n = parseInt(req.body && req.body.session);
  if (!n || n < 1 || n > 99) return res.status(400).json({ error: 'invalid session' });
  saveState.session = n;
  saveState.counter = 0;
  persistSaveState();
  res.json({ session: saveState.session, counter: saveState.counter });
});
app.post('/api/save-set-counter', express.json(), (req, res) => {
  const n = parseInt(req.body && req.body.counter);
  if (isNaN(n) || n < 0 || n > 9999) return res.status(400).json({ error: 'invalid counter' });
  saveState.counter = n;
  persistSaveState();
  res.json({ session: saveState.session, counter: saveState.counter });
});
app.post('/api/save-snapshot', express.json({ limit: '20mb' }), (req, res) => {
  const { seatId, session, counter, type, imageData } = req.body;
  const s  = String(session).padStart(2, '0');
  const c  = String(counter).padStart(3, '0');
  const id = String(seatId).padStart(2, '0');
  const filename = `ID${id}_${s}_${c}_${type}.png`;
  const base64 = (imageData || '').replace(/^data:image\/png;base64,/, '');
  try {
    const seatDir = path.join(savesDir, `ID${id}`);
    if (!fs.existsSync(seatDir)) fs.mkdirSync(seatDir);
    fs.writeFileSync(path.join(seatDir, filename), Buffer.from(base64, 'base64'));
    console.log(`[Save] ${filename}`);
    res.json({ ok: true, filename });
  } catch (e) {
    console.error('[Save Error]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// 背景画像一覧 API
// ============================================================
const SUPPORTED_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
app.get('/api/backgrounds', (req, res) => {
  const bgDir = path.join(__dirname, 'public', 'backgrounds');
  try {
    const files = fs.readdirSync(bgDir).filter(f => SUPPORTED_EXT.includes(path.extname(f).toLowerCase()));
    res.json(files);
  } catch { res.json([]); }
});

// ロゴ API
app.get('/api/logo', (req, res) => {
  const dir = path.join(__dirname, 'public', 'logo');
  try {
    const file = fs.readdirSync(dir).find(f => SUPPORTED_EXT.includes(path.extname(f).toLowerCase()));
    res.json(file ? { url: '/logo/' + encodeURIComponent(file) } : { url: null });
  } catch { res.json({ url: null }); }
});

// ロゴ一覧 API
app.get('/api/logo-list', (req, res) => {
  const dir = path.join(__dirname, 'public', 'logo');
  try {
    const files = fs.readdirSync(dir).filter(f => SUPPORTED_EXT.includes(path.extname(f).toLowerCase()));
    res.json(files);
  } catch { res.json([]); }
});

// ============================================================
// レイアウトパターン保存 API (saves/rayout_data/patterns.json)
// ============================================================
const layoutDataDir = path.join(__dirname, 'saves', 'rayout_data');
if (!fs.existsSync(layoutDataDir)) fs.mkdirSync(layoutDataDir, { recursive: true });
const layoutPatternsPath = path.join(layoutDataDir, 'patterns.json');

app.get('/api/layout-patterns', (req, res) => {
  try {
    if (!fs.existsSync(layoutPatternsPath)) return res.json([]);
    const data = JSON.parse(fs.readFileSync(layoutPatternsPath, 'utf-8'));
    res.json(Array.isArray(data) ? data : []);
  } catch (e) {
    console.error('[LayoutPatterns] load error', e);
    res.json([]);
  }
});

app.post('/api/layout-patterns', express.json({ limit: '2mb' }), (req, res) => {
  try {
    const pats = req.body;
    if (!Array.isArray(pats)) return res.status(400).json({ ok: false, error: 'invalid data' });
    fs.writeFileSync(layoutPatternsPath, JSON.stringify(pats, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    console.error('[LayoutPatterns] save error', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 親機BG画像一覧 API
const SUPPORTED_EXT_BG = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
app.get('/api/backgrounds-host', (req, res) => {
  const bgDir = path.join(__dirname, 'public', 'backgrounds_host');
  try {
    const files = fs.readdirSync(bgDir).filter(f => SUPPORTED_EXT_BG.includes(path.extname(f).toLowerCase()));
    res.json(files);
  } catch { res.json([]); }
});

// オーバーレイ画像一覧 API
app.get('/api/overlays', (req, res) => {
  const load = (type) => {
    const dir = path.join(__dirname, 'public', 'overlays', type);
    try { return fs.readdirSync(dir).filter(f => SUPPORTED_EXT.includes(path.extname(f).toLowerCase())); }
    catch { return []; }
  };
  res.json({ correct: load('correct'), incorrect: load('incorrect') });
});

// 選択肢画像一覧 API
app.get('/api/choice-images', (req, res) => {
  const dir = path.join(__dirname, 'public', 'choice');
  try {
    const files = fs.readdirSync(dir)
      .filter(f => SUPPORTED_EXT.includes(path.extname(f).toLowerCase()))
      .sort();
    res.json(files.map(f => `/choice/${f}`));
  } catch { res.json([]); }
});

// ============================================================
// Socket.io イベント
// ============================================================
io.on('connection', (socket) => {
  console.log(`[接続] ${socket.id}`);

  // ---------- 登録 ----------

  // 子機登録
  socket.on('register-client', ({ seatId, bgImageUrl }) => {
    if (!seatId) return;

    // 重複接続チェック：同じIDで別のソケットがすでにアクティブなら拒否
    const existingClient = state.clients.get(seatId);
    if (existingClient && existingClient.socketId && existingClient.socketId !== socket.id) {
      const existingSocket = io.sockets.sockets.get(existingClient.socketId);
      if (existingSocket) {
        console.log(`[重複拒否] 席${seatId} - 既存ソケット: ${existingClient.socketId}, 拒否ソケット: ${socket.id}`);
        socket.emit('duplicate-seat', { seatId });
        return;
      }
    }

    const existing = state.clients.get(seatId) || {};
    // 親機から事前登録された名前があればそちらを優先
    const assignedName = state.seatNames[seatId] || existing.name || `席 ${seatId}`;
    state.clients.set(seatId, {
      socketId: socket.id,
      name: assignedName,
      strokes: existing.strokes || [],
      locked: existing.locked || false,
      revealed: existing.revealed || false,
      animType: existing.animType || 'slide-up',
      bgImageUrl: bgImageUrl || existing.bgImageUrl || '',
      writingBlackout: !!existing.writingBlackout,
    });
    socket.seatId = seatId;
    socket.role = 'client';
    console.log(`[子機登録] 席${seatId}`);

    // 既存ストロークを送り返す（再接続時の復元）
    socket.emit('restore-strokes', state.clients.get(seatId).strokes);
    // ロック状態を送信
    if (state.clients.get(seatId).locked) socket.emit('lock');
    // 書き画面黒隠し状態を送信
    socket.emit('writing-blackout', { enabled: !!state.clients.get(seatId).writingBlackout });
    // 演者名を配信
    if (state.seatNames[seatId]) socket.emit('name-assigned', { name: state.seatNames[seatId] });
    // ラベル設定を配信（子機の書き画面にも表示）
    socket.emit('label-config', state.labelConfig);
    socket.emit('seat-label-name', { name: state.seatNames[seatId] || '' });

    // 子機セカンドに背景を即時通知
    const bgUrl = state.clients.get(seatId).bgImageUrl;
    const displaySocketId = state.clientDisplays.get(seatId);
    if (displaySocketId && bgUrl) io.to(displaySocketId).emit('bg-changed', { bgImageUrl: bgUrl });

    broadcastStateToHosts();
  });

  // 子機の背景変更通知
  socket.on('client-bg-changed', ({ bgImageUrl }) => {
    const seatId = socket.seatId;
    if (!seatId) return;
    const client = state.clients.get(seatId);
    if (!client) return;
    client.bgImageUrl = bgImageUrl || '';
    // client-display にも即時通知
    const displaySocketId = state.clientDisplays.get(seatId);
    if (displaySocketId) io.to(displaySocketId).emit('bg-changed', { bgImageUrl: client.bgImageUrl });
    broadcastStateToHosts();
  });

  // 親機から名簿配信
  socket.on('host-set-names', (names) => {
    // names: { '1': '田中太郎', '2': '山田花子', ... }
    for (const [id, name] of Object.entries(names)) {
      if (!name) continue;
      state.seatNames[id] = name;
      const client = state.clients.get(id);
      if (client) {
        client.name = name;
        if (client.socketId) {
          io.to(client.socketId).emit('name-assigned', { name });
          io.to(client.socketId).emit('seat-label-name', { name });
        }
      }
      // client-display にも名前を通知
      const displaySocketId = state.clientDisplays.get(id);
      if (displaySocketId) io.to(displaySocketId).emit('seat-label-name', { name });
      // host-display にも名前を通知
      for (const hdId of allHostDisplayIds()) {
        io.to(hdId).emit('seat-label-name', { seatId: id, name });
      }
    }
    broadcastStateToHosts();
  });

  // 子機のセカンド登録
  socket.on('register-client-display', ({ seatId }) => {
    if (!seatId) return;
    state.clientDisplays.set(seatId, socket.id);
    socket.seatId = seatId;
    socket.role = 'client-display';
    console.log(`[子機セカンド登録] 席${seatId}`);

    // 既存状態を送信
    const client = state.clients.get(seatId);
    if (client) {
      socket.emit('restore-strokes', client.strokes);
      if (client.bgImageUrl) socket.emit('bg-changed', { bgImageUrl: client.bgImageUrl });
      if (client.revealed) socket.emit('reveal', { animType: client.animType });
    }
    // ラベル設定と名前を送信
    socket.emit('label-config', state.labelConfig);
    socket.emit('seat-label-name', { name: state.seatNames[seatId] || '' });
    // 選択肢画像を復元
    if (state.currentChoiceUrl) socket.emit('show-choice', { imageUrl: state.currentChoiceUrl });
  });

  // 親機登録
  socket.on('register-host', (meta = {}) => {
    state.hosts.add(socket.id);
    socket.role = 'host';
    state.hostPanels.set(socket.id, {
      operatorName: sanitizeOperatorName(meta.operatorName),
      uiType: sanitizeUiType(meta.uiType),
      connectedAt: new Date().toISOString(),
    });
    console.log(`[親機登録] ${socket.id}`);
    socket.emit('full-state', buildFullState());
    if (state.lastHostAction) socket.emit('host-action-trace', state.lastHostAction);
    broadcastHostPanels();
  });

  // 親機のセカンド登録
  socket.on('register-host-display', ({ group } = {}) => {
    const groupId = (typeof group === 'string' && group.trim()) ? group.trim().slice(0, 32) : 'default';
    if (!state.hostDisplayGroups.has(groupId)) state.hostDisplayGroups.set(groupId, new Set());
    state.hostDisplayGroups.get(groupId).add(socket.id);
    socket.role = 'host-display';
    socket.hostDisplayGroup = groupId;
    console.log(`[親機セカンド登録] ${socket.id} グループ:${groupId}`);
    socket.emit('full-state', buildFullState());
    if (state.displayLayouts[groupId]) socket.emit('display-layout', state.displayLayouts[groupId]);
    // ラベル設定を送信
    socket.emit('label-config', state.labelConfig);
    // 全席の名前を送信
    for (const [id, name] of Object.entries(state.seatNames)) {
      socket.emit('seat-label-name', { seatId: id, name });
    }
  });

  // レイアウト設定（親機から）
  socket.on('display-layout', ({ group, ...layout }) => {
    trackHostAction(socket, 'display-layout', { group: group || 'default' });
    const groupId = (typeof group === 'string' && group.trim()) ? group.trim().slice(0, 32) : 'default';
    state.displayLayouts[groupId] = layout;
    const targets = state.hostDisplayGroups.get(groupId);
    if (targets) for (const socketId of targets) io.to(socketId).emit('display-layout', layout);
  });

  // ラベル設定（親機から）
  socket.on('host-set-label-config', (config) => {
    trackHostAction(socket, 'host-set-label-config');
    const allowed = ['enabled','fontSize','fontFamily','x','y','textAlign','color',
                     'bgColor','bgPadding','shadowEnabled','shadowColor','shadowBlur',
                     'shadowOffsetX','shadowOffsetY','bold','italic'];
    for (const key of allowed) {
      if (config[key] !== undefined) state.labelConfig[key] = config[key];
    }
    // client-displayへ
    for (const socketId of state.clientDisplays.values()) {
      io.to(socketId).emit('label-config', state.labelConfig);
    }
    // client（書き画面）へ
    for (const [, client] of state.clients) {
      if (client.socketId) io.to(client.socketId).emit('label-config', state.labelConfig);
    }
    // host-displayへ
    for (const socketId of allHostDisplayIds()) {
      io.to(socketId).emit('label-config', state.labelConfig);
    }
  });

  // ---------- 描画 ----------

  // ストロークデータ受信（リアルタイム分割方式）
  socket.on('stroke-start', (strokeData) => {
    const seatId = socket.seatId;
    if (!seatId) return;
    const client = state.clients.get(seatId);
    if (!client || client.locked) return;
    client.currentStroke = strokeData;
    broadcastToHosts('stroke-start', { seatId, stroke: strokeData });
    const displaySocketId = state.clientDisplays.get(seatId);
    if (displaySocketId) io.to(displaySocketId).emit('stroke-start', strokeData);
  });

  socket.on('stroke-point', ({ point }) => {
    const seatId = socket.seatId;
    if (!seatId) return;
    const client = state.clients.get(seatId);
    if (!client || client.locked || !client.currentStroke) return;
    client.currentStroke.points.push(point);
    broadcastToHosts('stroke-point', { seatId, point });
    const displaySocketId = state.clientDisplays.get(seatId);
    if (displaySocketId) io.to(displaySocketId).emit('stroke-point', point);
  });

  socket.on('stroke-end', () => {
    const seatId = socket.seatId;
    if (!seatId) return;
    const client = state.clients.get(seatId);
    if (!client || !client.currentStroke) return;
    client.strokes.push(client.currentStroke);
    broadcastToHosts('stroke-end', { seatId });
    const displaySocketId = state.clientDisplays.get(seatId);
    if (displaySocketId) io.to(displaySocketId).emit('stroke-end');
    client.currentStroke = null;
  });

  // 子機側「決定」ボタン → 自席をロック
  socket.on('client-confirm', () => {
    const seatId = socket.seatId;
    if (!seatId) return;
    const client = state.clients.get(seatId);
    if (!client || client.locked) return;
    client.locked = true;
    // 子機自身には lock イベントを送らない（自前でロック表示済み）
    // 親機・親機セカンドへ通知（確定フラグ付き）
    broadcastToHosts('seat-locked', { seatId, confirmedByClient: true });
    console.log(`[子機確定] 席${seatId}`);
  });

  // キャンバスクリア（子機から）
  socket.on('clear-canvas', () => {
    const seatId = socket.seatId;
    if (!seatId) return;
    const client = state.clients.get(seatId);
    if (!client || client.locked) return;
    _clearCanvasStrokesOnly(seatId);
  });

  // アンドゥ（子機から）
  socket.on('undo-stroke', ({ strokes }) => {
    const seatId = socket.seatId;
    if (!seatId) return;
    const client = state.clients.get(seatId);
    if (!client || client.locked) return;
    client.strokes = Array.isArray(strokes) ? strokes : [];
    const displaySocketId = state.clientDisplays.get(seatId);
    if (displaySocketId) io.to(displaySocketId).emit('restore-strokes', client.strokes);
    broadcastToHosts('seat-strokes-updated', { seatId, strokes: client.strokes });
  });

  // ---------- 親機コントロール ----------

  socket.on('host-clear', ({ seatId }) => {
    trackHostAction(socket, 'host-clear', { seatId });
    _clearCanvasStrokesOnly(seatId);
  });

  // 全席クリア
  socket.on('host-clear-all', () => {
    trackHostAction(socket, 'host-clear-all');
    for (const seatId of state.clients.keys()) {
      _clearCanvas(seatId, true);
    }
  });

  // ロック
  socket.on('host-lock', ({ seatId }) => {
    trackHostAction(socket, 'host-lock', { seatId });
    const client = state.clients.get(seatId);
    if (client) {
      client.locked = true;
      const clientSocketId = client.socketId;
      if (clientSocketId) io.to(clientSocketId).emit('lock');
      broadcastToHosts('seat-locked', { seatId });
    }
  });

  // アンロック
  socket.on('host-unlock', ({ seatId }) => {
    trackHostAction(socket, 'host-unlock', { seatId });
    const client = state.clients.get(seatId);
    if (client) {
      client.locked = false;
      const clientSocketId = client.socketId;
      if (clientSocketId) io.to(clientSocketId).emit('unlock');
      broadcastToHosts('seat-unlocked', { seatId });
    }
  });

  // 全席ロック
  socket.on('host-lock-all', () => {
    trackHostAction(socket, 'host-lock-all');
    for (const [seatId, client] of state.clients) {
      client.locked = true;
      if (client.socketId) io.to(client.socketId).emit('lock');
    }
    broadcastToHosts('all-locked', {});
  });

  // 全席アンロック
  socket.on('host-unlock-all', () => {
    trackHostAction(socket, 'host-unlock-all');
    for (const [seatId, client] of state.clients) {
      client.locked = false;
      if (client.socketId) io.to(client.socketId).emit('unlock');
    }
    broadcastToHosts('all-unlocked', {});
  });

  // 書き画面黒隠し（子機書き画面のみ）
  socket.on('host-set-writing-blackout', ({ seatId, enabled }) => {
    trackHostAction(socket, 'host-set-writing-blackout', { seatId, enabled: !!enabled });
    const id = String(seatId || '');
    if (!id) return;
    const client = state.clients.get(id);
    if (!client) return;

    const nextEnabled = !!enabled;
    client.writingBlackout = nextEnabled;
    if (client.socketId) {
      io.to(client.socketId).emit('writing-blackout', { enabled: nextEnabled });
    }
    broadcastToHosts('seat-writing-blackout', { seatId: id, enabled: nextEnabled });
  });

  // 回答オープン（特定席）
  socket.on('host-reveal', ({ seatId, animType }) => {
    trackHostAction(socket, 'host-reveal', { seatId, animType: animType || 'slide-up' });
    const anim = animType || 'slide-up';
    const client = state.clients.get(seatId);
    if (client) {
      client.revealed = true;
      client.animType = anim;
    }
    const displaySocketId = state.clientDisplays.get(seatId);
    if (displaySocketId) {
      io.to(displaySocketId).emit('reveal', { animType: anim });
    }
    broadcastToHosts('seat-revealed', { seatId, animType: anim });
  });

  // 回答を隠す（フタを閉じる）
  socket.on('host-hide', ({ seatId }) => {
    trackHostAction(socket, 'host-hide', { seatId });
    const client = state.clients.get(seatId);
    if (client) client.revealed = false;
    const displaySocketId = state.clientDisplays.get(seatId);
    if (displaySocketId) io.to(displaySocketId).emit('hide');
    broadcastToHosts('seat-hidden', { seatId });
  });

  // 全席オープン
  socket.on('host-reveal-all', ({ animType }) => {
    trackHostAction(socket, 'host-reveal-all', { animType: animType || 'slide-up' });
    for (const [seatId, client] of state.clients) {
      client.revealed = true;
      client.animType = animType || 'slide-up';
      const displaySocketId = state.clientDisplays.get(seatId);
      if (displaySocketId) {
        io.to(displaySocketId).emit('reveal', { animType: client.animType });
      }
    }
    broadcastToHosts('all-revealed', { animType });
  });

  // 全席フタ閉じ
  socket.on('host-hide-all', () => {
    trackHostAction(socket, 'host-hide-all');
    for (const [seatId, client] of state.clients) {
      client.revealed = false;
      const displaySocketId = state.clientDisplays.get(seatId);
      if (displaySocketId) io.to(displaySocketId).emit('hide');
    }
    broadcastToHosts('all-hidden', {});
  });

  // 正誤判定（書き画面：色フラッシュ、セカンド：画像オーバーレイ）
  socket.on('host-judge', ({ seatId, kind, imageUrl }) => {
    trackHostAction(socket, 'host-judge', { seatId, kind: kind || 'correct' });
    const resolvedUrl = imageUrl ||
      (kind === 'correct' ? '/overlays/correct/aka_fill.png' : '/overlays/incorrect/ao_fill.png');
    const client = state.clients.get(String(seatId));
    if (client?.socketId) io.to(client.socketId).emit('show-overlay', { imageUrl: resolvedUrl });
    const displaySocketId = state.clientDisplays.get(String(seatId));
    if (displaySocketId) io.to(displaySocketId).emit('show-overlay', { imageUrl: resolvedUrl });
    // 親機セカンド画面にも通知
    broadcastToHosts('judge-result', { seatId: String(seatId), imageUrl: resolvedUrl });
  });

  // 判定時描画色変換モード
  socket.on('host-set-judge-color-mode', ({ enabled }) => {
    trackHostAction(socket, 'host-set-judge-color-mode', { enabled: !!enabled });
    state.judgeColorMode = !!enabled;
    io.emit('judge-color-mode', { enabled: state.judgeColorMode });
  });

  // ロック暗転の濃さ
  socket.on('host-set-lock-darkness', ({ value }) => {
    const v = Number(value);
    if (isNaN(v) || v < 0 || v > 100) return;
    trackHostAction(socket, 'host-set-lock-darkness', { value: v });
    state.lockDarkness = v;
    io.emit('lock-darkness', { value: state.lockDarkness });
  });

  // 選択肢画像表示
  socket.on('host-show-choice', ({ imageUrl }) => {
    trackHostAction(socket, 'host-show-choice', { hasImage: !!imageUrl });
    state.currentChoiceUrl = imageUrl || null;
    for (const [, client] of state.clients) {
      if (client.socketId) io.to(client.socketId).emit('show-choice', { imageUrl });
    }
    for (const socketId of state.clientDisplays.values()) {
      io.to(socketId).emit('show-choice', { imageUrl });
    }
    for (const id of state.hosts)                io.to(id).emit('show-choice', { imageUrl });
    for (const id of allHostDisplayIds()) io.to(id).emit('show-choice', { imageUrl });
  });

  // 選択肢画像消去
  socket.on('host-clear-choice', () => {
    trackHostAction(socket, 'host-clear-choice');
    state.currentChoiceUrl = null;
    io.emit('clear-choice');
  });

  // 正解／不正解オーバーレイ
  socket.on('host-show-overlay', ({ seatId, kind, imageUrl }) => {
    trackHostAction(socket, 'host-show-overlay', { seatId: seatId || 'all', kind: kind || null, hasImage: !!imageUrl });
    if (!seatId) {
      // 全席
      for (const [, client] of state.clients) {
        if (client.socketId) io.to(client.socketId).emit('show-overlay', { kind, imageUrl });
      }
      for (const displaySocketId of state.clientDisplays.values()) {
        io.to(displaySocketId).emit('show-overlay', { kind, imageUrl });
      }
    } else {
      const client = state.clients.get(String(seatId));
      if (client?.socketId) io.to(client.socketId).emit('show-overlay', { kind, imageUrl });
      const displaySocketId = state.clientDisplays.get(String(seatId));
      if (displaySocketId) io.to(displaySocketId).emit('show-overlay', { kind, imageUrl });
    }
  });

  socket.on('host-clear-overlay', (data) => {
    trackHostAction(socket, 'host-clear-overlay', { seatId: data?.seatId || 'all' });
    const seatId = data?.seatId;
    if (!seatId) {
      for (const [, client] of state.clients) {
        if (client.socketId) io.to(client.socketId).emit('clear-overlay');
      }
      for (const displaySocketId of state.clientDisplays.values()) {
        io.to(displaySocketId).emit('clear-overlay');
      }
      for (const id of state.hosts)                io.to(id).emit('clear-overlay');
      for (const id of allHostDisplayIds()) io.to(id).emit('clear-overlay');
    } else {
      const client = state.clients.get(String(seatId));
      if (client?.socketId) io.to(client.socketId).emit('clear-overlay');
      const displaySocketId = state.clientDisplays.get(String(seatId));
      if (displaySocketId) io.to(displaySocketId).emit('clear-overlay');
      for (const id of state.hosts)                io.to(id).emit('clear-overlay', { seatId });
      for (const id of allHostDisplayIds()) io.to(id).emit('clear-overlay', { seatId });
    }
  });

  // タイマー開始
  socket.on('host-timer-start', ({ duration }) => {
    trackHostAction(socket, 'host-timer-start', { duration: duration || state.timer.duration });
    if (duration) {
      state.timer.duration = duration;
      state.timer.remaining = duration;
    }
    state.timer.running = true;
    clearInterval(state.timerInterval);
    state.timerInterval = setInterval(() => {
      if (state.timer.remaining > 0) {
        state.timer.remaining--;
        io.emit('timer-tick', { remaining: state.timer.remaining });
      } else {
        clearInterval(state.timerInterval);
        state.timer.running = false;
        io.emit('timer-end', {});
        // タイムアップ時に全席自動ロック
        for (const [seatId, client] of state.clients) {
          client.locked = true;
          if (client.socketId) io.to(client.socketId).emit('lock');
        }
        broadcastToHosts('all-locked', {});
      }
    }, 1000);
    io.emit('timer-start', { duration: state.timer.duration, remaining: state.timer.remaining });
  });

  // タイマー停止
  socket.on('host-timer-stop', () => {
    trackHostAction(socket, 'host-timer-stop');
    clearInterval(state.timerInterval);
    state.timer.running = false;
    io.emit('timer-stop', { remaining: state.timer.remaining });
  });

  // タイマーリセット
  socket.on('host-timer-reset', ({ duration }) => {
    trackHostAction(socket, 'host-timer-reset', { duration: duration || state.timer.duration });
    clearInterval(state.timerInterval);
    state.timer.running = false;
    state.timer.remaining = duration || state.timer.duration;
    io.emit('timer-reset', { remaining: state.timer.remaining });
  });

  // ---------- 切断処理 ----------
  socket.on('disconnect', () => {
    console.log(`[切断] ${socket.id} (${socket.role})`);

    if (socket.role === 'client') {
      // 子機は状態(strokes等)は保持、socketIdだけ無効化
      const client = state.clients.get(socket.seatId);
      if (client && client.socketId === socket.id) {
        client.socketId = null;
        broadcastStateToHosts();
      }
    } else if (socket.role === 'client-display') {
      const displayEntry = state.clientDisplays.get(socket.seatId);
      if (displayEntry === socket.id) {
        state.clientDisplays.delete(socket.seatId);
      }
    } else if (socket.role === 'host') {
      state.hosts.delete(socket.id);
      state.hostPanels.delete(socket.id);
      broadcastHostPanels();
    } else if (socket.role === 'host-display') {
      const gid = socket.hostDisplayGroup || 'default';
      const grp = state.hostDisplayGroups.get(gid);
      if (grp) grp.delete(socket.id);
    }
  });
});

// ============================================================
// ヘルパー関数
// ============================================================
function _clearCanvas(seatId, cover = false) {
  const client = state.clients.get(seatId);
  if (!client) return;
  client.strokes = [];
  if (client.socketId) io.to(client.socketId).emit('clear');
  const displaySocketId = state.clientDisplays.get(seatId);
  if (displaySocketId) io.to(displaySocketId).emit('clear', { cover });
  broadcastToHosts('canvas-cleared', { seatId });
}

// 描画のみクリア（判定オーバーレイは消さない）
function _clearCanvasStrokesOnly(seatId) {
  const client = state.clients.get(seatId);
  if (!client) return;
  client.strokes = [];
  if (client.socketId) io.to(client.socketId).emit('clear-strokes-only');
  const displaySocketId = state.clientDisplays.get(seatId);
  if (displaySocketId) io.to(displaySocketId).emit('clear-strokes-only');
  broadcastToHosts('canvas-cleared-strokes', { seatId });
}

function allHostDisplayIds() {
  const ids = [];
  for (const sockets of state.hostDisplayGroups.values()) {
    for (const id of sockets) ids.push(id);
  }
  return ids;
}

function broadcastToHosts(event, data) {
  for (const socketId of state.hosts) io.to(socketId).emit(event, data);
  for (const socketId of allHostDisplayIds()) io.to(socketId).emit(event, data);
}

function buildFullState() {
  const seats = [];
  for (const [seatId, client] of state.clients) {
    seats.push({
      seatId,
      name: client.name,
      connected: !!client.socketId,
      locked: client.locked,
      revealed: client.revealed,
      animType: client.animType,
      strokes: client.strokes,
      bgImageUrl: client.bgImageUrl || '',
      writingBlackout: !!client.writingBlackout,
    });
  }
  return {
    seats,
    timer: state.timer,
    seatNames: state.seatNames,
    labelConfig: state.labelConfig,
    choiceImageUrl: state.currentChoiceUrl || null,
    judgeColorMode: state.judgeColorMode,
    lockDarkness: state.lockDarkness,
  };
}

function broadcastStateToHosts() {
  const fullState = buildFullState();
  for (const socketId of state.hosts) io.to(socketId).emit('full-state', fullState);
  for (const socketId of allHostDisplayIds()) io.to(socketId).emit('full-state', fullState);
}

function getLocalIP() {
  if (process.env.KAKIMONI_IP) return process.env.KAKIMONI_IP;
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// ============================================================
// 起動
// ============================================================
httpServer.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('==================================================');
  console.log(' KakiMoni クイズ書きシステム 起動完了');
  console.log('==================================================');
  console.log(` ローカル: http://localhost:${PORT}`);
  console.log(` LAN:      http://${ip}:${PORT}`);
  console.log('--------------------------------------------------');
  console.log(' 各ページURL:');
  console.log(`  親機:           http://${ip}:${PORT}/host`);
  console.log(`  親機のセカンド: http://${ip}:${PORT}/host-display`);
  console.log(`  子機:           http://${ip}:${PORT}/client`);
  console.log(`  子機のセカンド: http://${ip}:${PORT}/client-display`);
  console.log('==================================================');
});
