const express = require('express');
const path = require('path');
const os = require('os');

const app  = express();
const PORT = 3001;

// socket.io のクライアントスクリプトをローカルから配信
// （インターネット不要・CDN不使用）
app.use('/socket.io', express.static(
  path.join(__dirname, 'node_modules', 'socket.io', 'client-dist')
));

// 子機ページの静的ファイル配信（メインの public/ を共有）
app.use(express.static(path.join(__dirname, '..', 'public')));

// 子機タブレット向けランチャー
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name]) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('==================================================');
  console.log(' KakiMoni 子機サーバー 起動完了');
  console.log('==================================================');
  console.log(` ローカル: http://localhost:${PORT}`);
  console.log(` LAN:      http://${ip}:${PORT}`);
  console.log('--------------------------------------------------');
  console.log(' ★ タブレットのブラウザで上記URLを開き、');
  console.log('   親機サーバーのIPアドレスを入力してください。');
  console.log('==================================================');
});
