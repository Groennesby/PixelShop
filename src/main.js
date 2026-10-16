// PixelShop — Native Desktop Application Main Process
// Cross-Platform: Linux, Windows, macOS
// Designed by Dave Groennesby — https://collabs-photography.com/software

const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

let splashWindow = null;
let mainWindow = null;
let localServer = null;
let serverPort = 8585;

function getAppIcon() {
  if (process.platform === 'win32') {
    return path.join(__dirname, 'icon.ico');
  } else if (process.platform === 'darwin') {
    return path.join(__dirname, 'icon.icns');
  }
  return path.join(__dirname, 'icon.png');
}

function startLocalServer() {
  return new Promise((resolve) => {
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.wasm': 'application/wasm',
      '.json': 'application/json'
    };

    localServer = http.createServer((req, res) => {
      let parsedUrl = decodeURIComponent(req.url.split('?')[0]);
      if (parsedUrl === '/') parsedUrl = '/app/index.html';

      let filePath = path.join(__dirname, parsedUrl);

      if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        res.writeHead(200, {
          'Content-Type': contentType,
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cache-Control': 'no-cache'
        });

        fs.createReadStream(filePath).pipe(res);
      });
    });

    localServer.listen(0, '127.0.0.1', () => {
      serverPort = localServer.address().port;
      resolve(serverPort);
    });
  });
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 860,
    height: 480,
    resizable: false,
    frame: false,
    center: true,
    alwaysOnTop: true,
    show: true,
    icon: getAppIcon(),
    backgroundColor: '#0A0A0C',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  splashWindow.loadFile(path.join(__dirname, 'app', 'splash.html'));
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1620,
    height: 980,
    minWidth: 1180,
    minHeight: 740,
    center: true,
    show: false,
    icon: getAppIcon(),
    title: 'PixelShop — Studio Edition',
    backgroundColor: '#111114',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  });

  Menu.setApplicationMenu(null);

  mainWindow.loadURL(`http://127.0.0.1:${port}/app/index.html?nosplash=1`);

  mainWindow.once('ready-to-show', () => {
    setTimeout(() => {
      if (splashWindow) {
        splashWindow.close();
      }
      mainWindow.show();
      mainWindow.focus();
    }, 3400);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  createSplashWindow();
  const port = await startLocalServer();
  createMainWindow(port);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(port);
    }
  });
});

app.on('window-all-closed', () => {
  if (localServer) {
    localServer.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
