const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { format } = require('date-fns');
const checkDiskSpace = require('check-disk-space').default;

const app = express();

// ===============================
// ⭐ CORS + เพิ่ม charset support
// ===============================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===============================
// CONFIG
// ===============================
const PORT = 5000;
const FFMPEG_PATH = path.join(__dirname, 'ffmpeg.exe');
const RECORD_DIR = path.join(__dirname, 'recordings');

// 🔴 Disk safety (ปรับได้)
const MIN_FREE_GB = 20; // แนะนำ 20–50GB กันดิสก์เต็มระหว่างอัด

// ===============================
// INIT
// ===============================
if (!fs.existsSync(RECORD_DIR)) fs.mkdirSync(RECORD_DIR);

// ✅ แยก process ตาม camId
const recordProcesses = {}; // { [camId]: ChildProcess }
const activeCameras = {};   // { [camId]: { user, billId, startTime, streamId, filename, outputPath } }

// ===============================
// ⭐ Helper: ทำความสะอาดชื่อไฟล์ (รองรับไทย)
// ===============================
function sanitizeFilename(text) {
  if (!text) return 'Unknown';
  return text.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}

// ===============================
// ⭐ Helper: เช็คพื้นที่ว่างในดิสก์ (Windows/Linux)
// ===============================
async function getFreeSpaceGB(dirPath) {
  const root = path.parse(dirPath).root; // Windows: "C:\", Linux: "/"
  const { free } = await checkDiskSpace(root);
  return free / (1024 ** 3);
}

async function ensureEnoughDiskSpaceOrThrow() {
  const freeGB = await getFreeSpaceGB(RECORD_DIR);
  if (freeGB < MIN_FREE_GB) {
    const err = new Error(`พื้นที่ไม่พอ เหลือ ${freeGB.toFixed(2)} GB (ต้องเหลืออย่างน้อย ${MIN_FREE_GB} GB)`);
    err.code = 'INSUFFICIENT_DISK';
    err.freeGB = freeGB;
    throw err;
  }
  return freeGB;
}

// ===============================
// AUTO CLEANUP (14 days)
// ===============================
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL = 60 * 60 * 1000;

function cleanupOldFiles() {
  console.log(`[CLEANUP] Checking files older than ${MAX_AGE_MS / 1000} seconds...`);

  fs.readdir(RECORD_DIR, (err, files) => {
    if (err) {
      console.error('[CLEANUP] Error reading directory:', err);
      return;
    }

    const now = Date.now();

    files.forEach(file => {
      if (!file.endsWith('.mp4')) return;
      const filePath = path.join(RECORD_DIR, file);

      fs.stat(filePath, (err, stat) => {
        if (err) return;

        // ใช้ birthtimeMs ตามเดิม (Windows ok) — ถ้าอยากชัวร์ขึ้น แนะนำเปลี่ยนเป็น stat.mtimeMs
        const fileAge = now - stat.birthtimeMs;

        if (fileAge > MAX_AGE_MS) {
          fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr) console.error(`[CLEANUP] Failed to delete ${file}:`, unlinkErr);
            else console.log(`[CLEANUP] 🗑️ Deleted old file: ${file}`);
          });
        }
      });
    });
  });
}

cleanupOldFiles();
setInterval(cleanupOldFiles, CHECK_INTERVAL);

// ===============================
// ⭐ STATIC (รองรับ UTF-8 encoding)
// ===============================
app.get('/recordings/:file', (req, res) => {
  const filename = decodeURIComponent(req.params.file);
  const filePath = path.join(RECORD_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  const parts = range.replace(/bytes=/, '').split('-');
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

  if (start >= fileSize) {
    return res.status(416).send('Range Not Satisfiable');
  }

  const chunkSize = end - start + 1;

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': 'video/mp4',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
  });

  fs.createReadStream(filePath, { start, end }).pipe(res);
});

// ===============================
// ⭐ START RECORD (รองรับหลายคนพร้อมกัน แยกตาม camId)
// + ✅ เช็คพื้นที่ก่อนเริ่มอัด
// ===============================
app.post('/api/start-record', async (req, res) => {
  const { camId, streamId, user, billId, recordType } = req.body;

  if (!camId) {
    return res.status(400).json({ error: 'camId is required' });
  }

  // ⭐ เช็คว่ากล้องนี้กำลังอัดอยู่หรือไม่
  if (recordProcesses[camId]) {
    return res.status(409).json({
      error: `กล้องนี้กำลังถูกใช้งานโดย: ${activeCameras[camId]?.user || 'Unknown'}`
    });
  }

  // ✅ เช็คพื้นที่ว่างก่อนเริ่มอัด
  try {
    const freeGB = await ensureEnoughDiskSpaceOrThrow();
    console.log(`[DISK] Free space: ${freeGB.toFixed(2)} GB`);
  } catch (e) {
    console.error('[DISK] Not enough space:', e?.message || e);
    const msg = e?.code === 'INSUFFICIENT_DISK'
      ? `พื้นที่เซิร์ฟเวอร์ไม่เพียงพอ: เหลือ ${Number(e.freeGB || 0).toFixed(2)} GB (ต้องเหลืออย่างน้อย ${MIN_FREE_GB} GB)`
      : 'ไม่สามารถตรวจสอบพื้นที่ดิสก์ได้';
    return res.status(507).json({ error: msg });
  }

  const safeUser = sanitizeFilename(user || 'Unknown');
  const safeBill = sanitizeFilename(billId || 'NoBill');
  const typeLabel = recordType === "out" ? "OUT" : "IN";
  const dateStr = format(new Date(), 'yyyy-MM-dd_HH-mm-ss');

  const filename = `CCTV_Cam${camId}_${safeUser}_${safeBill}_${typeLabel}_${dateStr}.mp4`;
  const outputPath = path.join(RECORD_DIR, filename);

  const streams = {
    '1': 'rtsp://localhost:8554/tapo2',
    '2': 'rtsp://localhost:8554/tapo3',
    '3': 'rtsp://localhost:8554/tapo1',
  };
  const streamUrl = streams[streamId] || streams['1'];

  console.log(`[REC] Starting cam ${camId}: ${filename} from ${streamUrl}`);

  // ⭐ บันทึกสถานะ
  activeCameras[camId] = {
    user: safeUser,
    billId: safeBill,
    startTime: new Date(),
    streamId,
    filename,
    outputPath
  };

  const proc = spawn(FFMPEG_PATH, [
    '-rtsp_transport', 'tcp',
    '-i', streamUrl,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ar', '8000',
    '-ac', '1',
    '-movflags', '+faststart',
    '-y',
    outputPath
  ], {
    stdio: ['pipe', 'pipe', 'pipe'] // สำคัญ: เพื่อให้ส่ง 'q' ได้
  });

  recordProcesses[camId] = proc;

  proc.stdout.on('data', data => console.log(`ffmpeg[cam ${camId}]: ${data}`));
  proc.stderr.on('data', data => console.error(`ffmpeg err[cam ${camId}]: ${data}`));

  proc.on('close', code => {
    console.log(`FFmpeg cam ${camId} exited with code ${code}`);
    delete recordProcesses[camId];
    delete activeCameras[camId];
  });

  res.json({ status: 'started', camId, filename });
});

// ===============================
// STOP RECORD (หยุดเฉพาะ camId ที่ส่งมา / หรือหยุดทั้งหมด)
// ===============================
app.post('/api/stop-record', (req, res) => {
  const { camId, stopAll } = req.body || {};

  // ✅ stopAll = true -> หยุดทุกตัว
  if (stopAll) {
    const cams = Object.keys(recordProcesses);
    if (cams.length === 0) return res.json({ status: 'not recording', stopped: [] });

    cams.forEach(id => {
      try {
        console.log(`[REC] Stopping cam ${id}...`);
        recordProcesses[id].stdin.write('q');
      } catch (e) {
        console.error(`[REC] Stop cam ${id} failed:`, e);
      }
    });

    return res.json({ status: 'stopping_all', stopped: cams });
  }

  // ✅ หยุดเฉพาะ camId
  if (!camId) {
    return res.status(400).json({ error: 'camId is required (or use stopAll=true)' });
  }

  const proc = recordProcesses[camId];
  if (!proc) {
    return res.json({ status: 'not recording', camId });
  }

  console.log(`[REC] Stopping cam ${camId} (clean)...`);
  try {
    proc.stdin.write('q');
  } catch (e) {
    console.error(`[REC] Stop cam ${camId} failed:`, e);
    return res.status(500).json({ status: 'error', camId, error: String(e) });
  }

  // ลบสถานะทันที (หรือจะรอ close ก็ได้)
  delete recordProcesses[camId];
  delete activeCameras[camId];

  res.json({ status: 'stopping', camId });
});

// ===============================
// ⭐ LIST VIDEOS
// ===============================
app.get('/api/videos', (req, res) => {
  fs.readdir(RECORD_DIR, (err, files) => {
    if (err) return res.json([]);

    const videos = files
      .filter(f => f.endsWith('.mp4'))
      .map(file => {
        const filePath = path.join(RECORD_DIR, file);
        const stat = fs.statSync(filePath);
        if (stat.size === 0) return null;

        const encodedFilename = encodeURIComponent(file);
        const createdDate = new Date(stat.birthtime);
        const thaiDate = format(createdDate, 'dd/MM/yyyy');
        const thaiTime = format(createdDate, 'HH:mm:ss');
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);

        return {
          filename: file,
          url: `/recordings/${encodedFilename}`,
          size: stat.size,
          sizeMB: `${sizeMB} MB`,
          date: thaiDate,
          time: thaiTime,
          datetime: `${thaiDate} ${thaiTime}`,
          created: stat.birthtime
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.created - a.created);

    res.json(videos);
  });
});

app.get('/api/recording-status', (req, res) => {
  const recordingCamIds = Object.keys(recordProcesses);
  res.json({ activeCameras, recordingCamIds });
});

// ===============================
app.listen(PORT, () => {
  console.log(`>>> CCTV Recorder Ready on port ${PORT} <<<`);
  console.log(`>>> UTF-8 Thai filename support enabled <<<`);
  console.log(`>>> Disk guard enabled: MIN_FREE_GB=${MIN_FREE_GB} <<<`);
});
