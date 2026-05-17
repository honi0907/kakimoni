const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e6,
  cors: { origin: '*' }, // 別PCの子機アプリからの接続を許可
});

const PORT = 3000;

// ============================================================
// サーバー状態管理
// ============================================================
const state = {
  clients: new Map(),       // seatId -> { socketId, name, strokes, locked, revealed, animType }
  clientDisplays: new Map(),// seatId -> socketId
  hosts: new Set(),
  hostDisplayGroups: new Map(), // groupId -> Set<socketId>
  displayLayouts: {},           // groupId -> layout
  seatNames: {},            // seatId -> name
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
  timer: { duration: 30, remaining: 30, running: false },
  timerInterval: null,
  currentChoiceUrl: null,
  judgeColorMode: false,
};

// ============================================================
// 静的ファイル配信（親機ページのみ）
// ============================================================
app.use(express.static(path.join(__dirname, '..', 'public')));
// 親機BG画像（メインのpublic/backgrounds_hostを共有）
app.use('/backgrounds_host', express.static(path.join(__dirname, '..', 'public', 'backgrounds_host')));
// 選択肢画像
app.use('/choice', express.static(path.join(__dirname, '..', 'public', 'choice')));
// レイアウトコントローラー（メインpublicと共有）
app.use('/layout-control', express.static(path.join(__dirname, '..', 'public', 'layout-control')));

const BG_HOST_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
app.get('/api/backgrounds-host', (req, res) => {
  const bgDir = path.join(__dirname, '..', 'public', 'backgrounds_host');
  try {
    const files = fs.readdirSync(bgDir).filter(f => BG_HOST_EXTS.includes(path.extname(f).toLowerCase()));
    res.json(files);
  } catch { res.json([]); }
});

// 選択肢画像一覧 API
app.get('/api/choice-images', (req, res) => {
  const dir = path.join(__dirname, '..', 'public', 'choice');
  try {
    const files = fs.readdirSync(dir)
      .filter(f => BG_HOST_EXTS.includes(path.extname(f).toLowerCase()))
      .sort();
    res.json(files.map(f => `/choice/${f}`));
  } catch { res.json([]); }
});

// IPアドレス取得API
app.get('/api/ip', (req, res) => {
  res.json({ ip: getLocalIP() });
});

app.get('/', (req, res) => {
  const ip = getLocalIP();
  res.send(`
    <!DOCTYPE html><html lang="ja"><head>
    <meta charset="UTF-8">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">
    <title>KakiMoni 親機サーバー</title>
    <style>
      body { font-family: 'Montserrat', sans-serif; background: #1a1a2e; color: #eee;
             display: flex; flex-direction: column; align-items: center;
             justify-content: center; min-height: 100vh; margin: 0; gap: 10px; }
      h1 { color: #a78bfa; margin-bottom: 10px; }
      .links { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; }
      a { display: block; padding: 20px 30px; background: #16213e; border: 2px solid #4a4a8a;
          color: #eee; text-decoration: none; border-radius: 12px; font-size: 1.2rem;
          transition: all 0.2s; text-align: center; }
      a:hover { background: #2d2d6a; border-color: #a78bfa; }
      .info { margin-top: 20px; background: #16213e; border: 1px solid #2d2d55;
              border-radius: 12px; padding: 20px 30px; font-size: 0.95rem;
              line-height: 2; color: #94a3b8; }
      .info strong { color: #fbbf24; }
      .tag { display: inline-block; background: #2d2d55; border-radius: 6px;
             padding: 1px 8px; font-size: 0.8rem; margin-left: 6px; color: #a78bfa; }
    </style></head>
    <body>
    <h1>🎛️ KakiMoni 親機サーバー</h1>
    <div class="links">
      <a href="/host">🎛️ 親機<br><small>操作パネル</small></a>
      <a href="/host-display">📺 親機のセカンド<br><small>LED・プロジェクター</small></a>
    </div>
    <div class="info">
      <div>このPC(サーバー)のIPアドレス： <strong>${ip}:${PORT}</strong></div>
      <div>子機アプリを起動したら、上記IPアドレスを入力して接続してください。</div>
    </div>
    </body></html>
  `);
});

// ============================================================
// Socket.io イベント
// ============================================================
io.on('connection', (socket) => {
  console.log(`[接続] ${socket.id}`);

  socket.on('register-client', ({ seatId, name }) => {
    if (!seatId) return;
    const existing = state.clients.get(seatId) || {};
    const assignedName = state.seatNames[seatId] || name || `席 ${seatId}`;
    state.clients.set(seatId, {
      socketId: socket.id,
      name: assignedName,
      strokes: existing.strokes || [],
      locked: existing.locked || false,
      revealed: existing.revealed || false,
      animType: existing.animType || 'slide-up',
    });
    socket.seatId = seatId;
    socket.role = 'client';
    console.log(`[子機登録] 席${seatId} "${assignedName}"`);
    socket.emit('restore-strokes', state.clients.get(seatId).strokes);
    if (state.clients.get(seatId).locked) socket.emit('lock');
    if (state.seatNames[seatId]) socket.emit('name-assigned', { name: state.seatNames[seatId] });
    // ラベル設定を配信（子機の書き画面にも表示）
    socket.emit('label-config', state.labelConfig);
    socket.emit('seat-label-name', { name: state.seatNames[seatId] || '' });
    broadcastStateToHosts();
  });

  socket.on('register-client-display', ({ seatId }) => {
    if (!seatId) return;
    state.clientDisplays.set(seatId, socket.id);
    socket.seatId = seatId;
    socket.role = 'client-display';
    console.log(`[子機セカンド登録] 席${seatId}`);
    const client = state.clients.get(seatId);
    if (client) {
      socket.emit('restore-strokes', client.strokes);
      if (client.revealed) socket.emit('reveal', { animType: client.animType });
    }
    // ラベル設定と名前を送信
    socket.emit('label-config', state.labelConfig);
    socket.emit('seat-label-name', { name: state.seatNames[seatId] || '' });
    // 選択肢画像を復元
    if (state.currentChoiceUrl) socket.emit('show-choice', { imageUrl: state.currentChoiceUrl });
  });

  socket.on('register-host', () => {
    state.hosts.add(socket.id);
    socket.role = 'host';
    console.log(`[親機登録] ${socket.id}`);
    socket.emit('full-state', buildFullState());
  });

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
    const groupId = (typeof group === 'string' && group.trim()) ? group.trim().slice(0, 32) : 'default';
    state.displayLayouts[groupId] = layout;
    const targets = state.hostDisplayGroups.get(groupId);
    if (targets) for (const socketId of targets) io.to(socketId).emit('display-layout', layout);
  });

  // ── 描画 ──
  socket.on('stroke', (strokeData) => {
    const seatId = socket.seatId;
    if (!seatId) return;
    const client = state.clients.get(seatId);
    if (!client || client.locked) return;
    client.strokes.push(strokeData);
    broadcastToHosts('stroke', { seatId, stroke: strokeData });
    const displaySocketId = state.clientDisplays.get(seatId);
    if (displaySocketId) io.to(displaySocketId).emit('stroke', strokeData);
  });

  socket.on('clear-canvas', () => {
    const seatId = socket.seatId;
    if (!seatId) return;
    const client = state.clients.get(seatId);
    if (!client || client.locked) return;
    _clearCanvasStrokesOnly(seatId);
  });

  // ── 親機コントロール ──
  socket.on('host-clear',     ({ seatId }) => _clearCanvasStrokesOnly(seatId));
  socket.on('host-clear-all', () => { for (const id of state.clients.keys()) _clearCanvas(id, true); });

  // 判定時描画色変換モード
  socket.on('host-set-judge-color-mode', ({ enabled }) => {
    state.judgeColorMode = !!enabled;
    io.emit('judge-color-mode', { enabled: state.judgeColorMode });
  });

  // 選択肢画像表示
  socket.on('host-show-choice', ({ imageUrl }) => {
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
    state.currentChoiceUrl = null;
    io.emit('clear-choice');
  });
  socket.on('host-clear-overlay', (data) => {
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

  socket.on('host-lock',   ({ seatId }) => setSeatLock(seatId, true));
  socket.on('host-unlock', ({ seatId }) => setSeatLock(seatId, false));
  socket.on('host-lock-all',   () => { for (const id of state.clients.keys()) setSeatLock(id, true);  broadcastToHosts('all-locked',   {}); });
  socket.on('host-unlock-all', () => { for (const id of state.clients.keys()) setSeatLock(id, false); broadcastToHosts('all-unlocked', {}); });

  socket.on('host-reveal', ({ seatId, animType }) => {
    const client = state.clients.get(seatId);
    if (!client) return;
    client.revealed = true;
    client.animType = animType || 'slide-up';
    const did = state.clientDisplays.get(seatId);
    if (did) io.to(did).emit('reveal', { animType: client.animType });
    broadcastToHosts('seat-revealed', { seatId, animType: client.animType });
  });

  socket.on('host-hide', ({ seatId }) => {
    const client = state.clients.get(seatId);
    if (!client) return;
    client.revealed = false;
    const did = state.clientDisplays.get(seatId);
    if (did) io.to(did).emit('hide');
    broadcastToHosts('seat-hidden', { seatId });
  });

  socket.on('host-reveal-all', ({ animType }) => {
    for (const [seatId, client] of state.clients) {
      client.revealed = true;
      client.animType = animType || 'slide-up';
      const did = state.clientDisplays.get(seatId);
      if (did) io.to(did).emit('reveal', { animType: client.animType });
    }
    broadcastToHosts('all-revealed', { animType });
  });

  socket.on('host-hide-all', () => {
    for (const [seatId, client] of state.clients) {
      client.revealed = false;
      const did = state.clientDisplays.get(seatId);
      if (did) io.to(did).emit('hide');
    }
    broadcastToHosts('all-hidden', {});
  });

  // 正誤判定
  socket.on('host-judge', ({ seatId, kind }) => {
    const imageUrl = kind === 'correct'
      ? '/overlays/correct/aka_fill.png'
      : '/overlays/incorrect/ao_fill.png';
    const client = state.clients.get(String(seatId));
    if (client?.socketId) io.to(client.socketId).emit('show-overlay', { imageUrl });
    const displaySocketId = state.clientDisplays.get(String(seatId));
    if (displaySocketId) io.to(displaySocketId).emit('show-overlay', { imageUrl });
    // 親機・親機セカンド画面にも通知
    broadcastToHosts('judge-result', { seatId: String(seatId), imageUrl });
  });

  socket.on('host-timer-start', ({ duration }) => {
    if (duration) { state.timer.duration = duration; state.timer.remaining = duration; }
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
        for (const [seatId, client] of state.clients) {
          client.locked = true;
          if (client.socketId) io.to(client.socketId).emit('lock');
        }
        broadcastToHosts('all-locked', {});
      }
    }, 1000);
    io.emit('timer-start', { duration: state.timer.duration, remaining: state.timer.remaining });
  });

  socket.on('host-timer-stop',  () => { clearInterval(state.timerInterval); state.timer.running = false; io.emit('timer-stop', { remaining: state.timer.remaining }); });
  socket.on('host-timer-reset', ({ duration }) => { clearInterval(state.timerInterval); state.timer.running = false; state.timer.remaining = duration || state.timer.duration; io.emit('timer-reset', { remaining: state.timer.remaining }); });

  // 名簿配信（親機から）
  socket.on('host-set-names', (names) => {
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
      const displaySocketId = state.clientDisplays.get(id);
      if (displaySocketId) io.to(displaySocketId).emit('seat-label-name', { name });
      // host-display にも seatId 付きで送信
      for (const hdId of allHostDisplayIds()) {
        io.to(hdId).emit('seat-label-name', { seatId: id, name });
      }
    }
    broadcastStateToHosts();
  });

  // ラベル設定（親機から）
  socket.on('host-set-label-config', (config) => {
    const allowed = ['enabled','fontSize','fontFamily','x','y','textAlign','color',
                     'bgColor','bgPadding','shadowEnabled','shadowColor','shadowBlur',
                     'shadowOffsetX','shadowOffsetY','bold','italic'];
    for (const key of allowed) {
      if (config[key] !== undefined) state.labelConfig[key] = config[key];
    }
    // client-display へ
    for (const socketId of state.clientDisplays.values()) {
      io.to(socketId).emit('label-config', state.labelConfig);
    }
    // client（書き画面）へ
    for (const [, client] of state.clients) {
      if (client.socketId) io.to(client.socketId).emit('label-config', state.labelConfig);
    }
    // host-display へ
    for (const socketId of allHostDisplayIds()) {
      io.to(socketId).emit('label-config', state.labelConfig);
    }
  });

  // ── 切断 ──
  socket.on('disconnect', () => {
    console.log(`[切断] ${socket.id} (${socket.role})`);
    if (socket.role === 'client') {
      const client = state.clients.get(socket.seatId);
      if (client && client.socketId === socket.id) { client.socketId = null; broadcastStateToHosts(); }
    } else if (socket.role === 'client-display') {
      if (state.clientDisplays.get(socket.seatId) === socket.id) state.clientDisplays.delete(socket.seatId);
    } else if (socket.role === 'host')         { state.hosts.delete(socket.id); }
    else if (socket.role === 'host-display')   {
      const gid = socket.hostDisplayGroup || 'default';
      const grp = state.hostDisplayGroups.get(gid);
      if (grp) grp.delete(socket.id);
    }
  });
});

// ============================================================
// ヘルパー
// ============================================================
function setSeatLock(seatId, locked) {
  const client = state.clients.get(seatId);
  if (!client) return;
  client.locked = locked;
  if (client.socketId) io.to(client.socketId).emit(locked ? 'lock' : 'unlock');
  broadcastToHosts(locked ? 'seat-locked' : 'seat-unlocked', { seatId });
}

function _clearCanvas(seatId, cover = false) {
  const client = state.clients.get(seatId);
  if (!client) return;
  client.strokes = [];
  if (client.socketId) io.to(client.socketId).emit('clear');
  const did = state.clientDisplays.get(seatId);
  if (did) io.to(did).emit('clear', { cover });
  broadcastToHosts('canvas-cleared', { seatId });
}

// 描画のみクリア（判定オーバーレイは消さない）
function _clearCanvasStrokesOnly(seatId) {
  const client = state.clients.get(seatId);
  if (!client) return;
  client.strokes = [];
  if (client.socketId) io.to(client.socketId).emit('clear-strokes-only');
  const did = state.clientDisplays.get(seatId);
  if (did) io.to(did).emit('clear-strokes-only');
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
  for (const id of state.hosts)        io.to(id).emit(event, data);
  for (const id of allHostDisplayIds()) io.to(id).emit(event, data);
}

function buildFullState() {
  const seats = [];
  for (const [seatId, client] of state.clients) {
    seats.push({ seatId, name: client.name, connected: !!client.socketId,
                 locked: client.locked, revealed: client.revealed,
                 animType: client.animType, strokes: client.strokes });
  }
  return { seats, timer: state.timer, seatNames: state.seatNames, labelConfig: state.labelConfig, choiceImageUrl: state.currentChoiceUrl || null, judgeColorMode: state.judgeColorMode };
}

function broadcastStateToHosts() {
  const s = buildFullState();
  for (const id of state.hosts)        io.to(id).emit('full-state', s);
  for (const id of allHostDisplayIds()) io.to(id).emit('full-state', s);
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name]) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

// ============================================================
// 起動
// ============================================================
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('==================================================');
  console.log(' KakiMoni 親機サーバー 起動完了');
  console.log('==================================================');
  console.log(` ローカル:  http://localhost:${PORT}`);
  console.log(` LAN:       http://${ip}:${PORT}`);
  console.log('--------------------------------------------------');
  console.log(` 親機:          http://${ip}:${PORT}/host`);
  console.log(` 親機セカンド:  http://${ip}:${PORT}/host-display`);
  console.log('--------------------------------------------------');
  console.log(` ★ 子機から接続するIPアドレス: ${ip}:${PORT}`);
  console.log('==================================================');
});
