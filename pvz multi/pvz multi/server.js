require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Storage } = require('megajs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const MEGA_EMAIL = process.env.MEGA_EMAIL;
const MEGA_PASSWORD = process.env.MEGA_PASSWORD;
const MEGA_ROOT_FOLDER = process.env.MEGA_ROOT_FOLDER || 'Videos';

if (!MEGA_EMAIL || !MEGA_PASSWORD) {
  console.error('❌ MEGA_EMAIL et MEGA_PASSWORD requis dans .env');
  process.exit(1);
}

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'OPTIONS', 'POST'],
  allowedHeaders: ['Range', 'Content-Type'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
}));
app.use(express.json());

// ─── Constants ───────────────────────────────────────────────────────────────
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ogv'];

const CONTENT_TYPES = {
  '.mp4':  'video/mp4',
  '.mkv':  'video/x-matroska',
  '.avi':  'video/x-msvideo',
  '.mov':  'video/quicktime',
  '.webm': 'video/webm',
  '.m4v':  'video/mp4',
  '.ogv':  'video/ogg',
};

function getContentType(filename) {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] || 'video/octet-stream';
}

function isVideo(filename) {
  return VIDEO_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}

// ─── Mega Storage ────────────────────────────────────────────────────────────
let storage = null;
let rootFolder = null;
let videoCache = new Map();
let cacheExpiry = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function connectMega() {
  console.log('🔐 Connexion à Mega.nz...');
  storage = await new Storage({
    email: MEGA_EMAIL,
    password: MEGA_PASSWORD,
  }).ready;
  console.log(`✅ Connecté en tant que ${MEGA_EMAIL}`);

  rootFolder = storage.root.children.find(
    c => c.name === MEGA_ROOT_FOLDER && c.directory
  );

  if (!rootFolder) {
    console.warn(`⚠️  Dossier "${MEGA_ROOT_FOLDER}" introuvable, création...`);
    rootFolder = await storage.root.mkdir(MEGA_ROOT_FOLDER);
  }

  console.log(`📁 Dossier racine : ${MEGA_ROOT_FOLDER}`);
  await refreshCache();
}

async function refreshCache() {
  console.log('🔄 Rafraîchissement du cache Mega...');
  videoCache.clear();

  function walk(folder, prefix = '') {
    if (!folder.children) return;
    folder.children.forEach(node => {
      if (node.directory) {
        walk(node, prefix ? `${prefix}/${node.name}` : node.name);
      } else if (isVideo(node.name)) {
        const fullPath = prefix ? `${prefix}/${node.name}` : node.name;
        videoCache.set(fullPath, node);
      }
    });
  }

  walk(rootFolder);
  cacheExpiry = Date.now() + CACHE_TTL;
  console.log(`✨ ${videoCache.size} vidéo(s) en cache`);
}

async function ensureCache() {
  if (Date.now() > cacheExpiry || videoCache.size === 0) {
    await refreshCache();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function nodeToVideo(node, channelName, relativePath) {
  return {
    name: node.name,
    title: node.name.replace(/\.[^/.]+$/, '').replace(/[_\-\.]+/g, ' ').trim(),
    channel: channelName,
    path: relativePath,
    size: node.size || 0,
    mtime: node.timestamp || 0,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Auto-réveil Render
app.get('/wake', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// Liste des chaînes (sous-dossiers de premier niveau)
app.get('/channels', async (req, res) => {
  try {
    await ensureCache();
    const channels = new Set();
    videoCache.forEach((_, p) => {
      const parts = p.split('/');
      if (parts.length > 1) channels.add(parts[0]);
    });
    res.json([...channels].sort());
  } catch (err) {
    console.error('GET /channels error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Liste des vidéos avec filtres
app.get('/videos', async (req, res) => {
  try {
    await ensureCache();

    const { channel = '', search = '', mode = 'video', sort = 'recent' } = req.query;

    let videos = [];
    videoCache.forEach((node, fullPath) => {
      const parts = fullPath.split('/');
      const channelName = parts.length > 1 ? parts[0] : '';
      videos.push(nodeToVideo(node, channelName, fullPath));
    });

    // Filtre par chaîne
    if (channel && channel !== 'all') {
      videos = videos.filter(v => v.channel === channel);
    }

    // Filtre par recherche
    if (search) {
      const q = search.toLowerCase();
      if (mode === 'channel') {
        videos = videos.filter(v => v.channel.toLowerCase().includes(q));
      } else {
        videos = videos.filter(v =>
          v.name.toLowerCase().includes(q) || v.title.toLowerCase().includes(q)
        );
      }
    }

    // Tri
    if (sort === 'name') {
      videos.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sort === 'size') {
      videos.sort((a, b) => b.size - a.size);
    } else {
      // recent (par défaut)
      videos.sort((a, b) => b.mtime - a.mtime);
    }

    res.json(videos);
  } catch (err) {
    console.error('GET /videos error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Streaming vidéo avec support Range
app.get('/stream/*', async (req, res) => {
  try {
    await ensureCache();

    const filePath = decodeURIComponent(req.params[0]);
    const node = videoCache.get(filePath);

    if (!node) {
      console.warn(`⚠️  Fichier introuvable: ${filePath}`);
      return res.sendStatus(404);
    }

    const fileSize = node.size || 0;
    const contentType = getContentType(node.name);
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const [startStr, endStr] = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   contentType,
      });

      const stream = node.download({ start, end });
      stream.on('error', err => {
        console.error('Stream error:', err);
        if (!res.headersSent) res.sendStatus(500);
      });
      stream.pipe(res);

    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type':   contentType,
        'Accept-Ranges':  'bytes',
      });

      const stream = node.download();
      stream.on('error', err => {
        console.error('Stream error:', err);
        if (!res.headersSent) res.sendStatus(500);
      });
      stream.pipe(res);
    }

  } catch (err) {
    console.error('GET /stream error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Forcer le refresh du cache
app.post('/refresh', async (req, res) => {
  try {
    await refreshCache();
    res.json({ ok: true, count: videoCache.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    await connectMega();
    app.listen(PORT, () => {
      console.log(`🚀 StreamVault server on port ${PORT}`);
    });
  } catch (err) {
    console.error('❌ Impossible de démarrer:', err);
    process.exit(1);
  }
})();
