const express = require('express');
const multer = require('multer');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const port = 5050;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');

// 确保目录存在
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// 确定 ffmpeg 和 ffprobe 的路径
function getBinaryPath(name) {
  const platform = process.platform === 'win32' ? 'win' : 'mac';
  const binaryName = process.platform === 'win32' ? `${name}.exe` : name;
  
  // 1. 尝试开发环境路径 (项目根目录/bin/...)
  const devPath = path.join(__dirname, 'bin', platform, binaryName);
  if (fs.existsSync(devPath)) return devPath;

  // 2. 尝试打包后环境路径 (resources/bin/...)
  if (process.resourcesPath) {
    const prodPath = path.join(process.resourcesPath, 'bin', platform, binaryName);
    if (fs.existsSync(prodPath)) return prodPath;
  }

  // 3. 回退到系统 PATH 中的命令
  return name;
}

const FFMPEG_PATH = getBinaryPath('ffmpeg');
const FFPROBE_PATH = getBinaryPath('ffprobe');

console.log('使用 FFMPEG 路径:', FFMPEG_PATH);
console.log('使用 FFPROBE 路径:', FFPROBE_PATH);

// 配置上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = crypto.randomBytes(4).toString('hex');
    cb(null, `${uniqueSuffix}_${file.originalname}`);
  }
});
const upload = multer({ 
  storage, 
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const tasks = new Map();
let activeWorkers = 0;
const MAX_WORKERS = 3;
const taskQueue = [];

// 获取视频时长
function getVideoDuration(filepath) {
  return new Promise((resolve) => {
    execFile(FFPROBE_PATH, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filepath
    ], (err, stdout) => {
      if (err) resolve(null);
      else resolve(parseFloat(stdout.trim()));
    });
  });
}

function parseTimeSeconds(timeStr) {
  const match = timeStr.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (match) {
    return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
  }
  return parseFloat(timeStr) || 0;
}

function updateTask(taskId, data) {
  const task = tasks.get(taskId) || {};
  tasks.set(taskId, { ...task, ...data });
}

async function processQueue() {
  if (activeWorkers >= MAX_WORKERS || taskQueue.length === 0) return;
  activeWorkers++;
  const { taskId, inputPath, params } = taskQueue.shift();
  
  try {
    await runConversion(taskId, inputPath, params);
  } catch (err) {
    updateTask(taskId, { status: 'error', error: err.message });
  } finally {
    activeWorkers--;
    processQueue();
  }
}

async function runConversion(taskId, inputPath, params) {
  const outputName = `${taskId}.gif`;
  const outputPath = path.join(OUTPUT_DIR, outputName);
  const palettePath = path.join(OUTPUT_DIR, `${taskId}_palette.png`);

  const { fps, width, start, duration, quality, loop } = params;
  const vfScale = `scale=${width}:-1:flags=lanczos`;
  
  const timeArgs = [];
  if (start > 0) timeArgs.push('-ss', start.toString());
  if (duration > 0) timeArgs.push('-t', duration.toString());

  let totalDuration = await getVideoDuration(inputPath);
  if (duration > 0) totalDuration = duration;
  else if (totalDuration && start > 0) totalDuration -= start;

  const runFFmpeg = (args, onStderr, onExit) => {
    return new Promise((resolve, reject) => {
      const proc = spawn(FFMPEG_PATH, ['-y', ...args]);
      proc.stderr.on('data', (data) => onStderr && onStderr(data.toString()));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('FFmpeg failed'));
      });
      proc.on('error', reject);
    });
  };

  try {
    if (quality === 'high') {
      updateTask(taskId, { status: 'converting', progress: 0, stage: '正在生成调色板...' });
      
      await runFFmpeg([
        ...timeArgs,
        '-i', inputPath,
        '-vf', `fps=${fps},${vfScale},palettegen=stats_mode=diff`,
        '-update', '1',
        palettePath
      ]);

      updateTask(taskId, { progress: 30, stage: '正在使用调色板转换...' });
      
      await runFFmpeg([
        ...timeArgs,
        '-i', inputPath,
        '-i', palettePath,
        '-lavfi', `fps=${fps},${vfScale} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5`,
        '-loop', loop.toString(),
        outputPath
      ], (line) => {
        const match = line.match(/time=(\S+)/);
        if (match && totalDuration > 0) {
          const current = parseTimeSeconds(match[1]);
          const pct = Math.min(95, 30 + Math.floor((current / totalDuration) * 65));
          updateTask(taskId, { progress: pct });
        }
      });
      
      if (fs.existsSync(palettePath)) fs.unlinkSync(palettePath);
    } else {
      updateTask(taskId, { status: 'converting', progress: 0, stage: '正在转换...' });
      
      await runFFmpeg([
        ...timeArgs,
        '-i', inputPath,
        '-vf', `fps=${fps},${vfScale}`,
        '-loop', loop.toString(),
        outputPath
      ], (line) => {
        const match = line.match(/time=(\S+)/);
        if (match && totalDuration > 0) {
          const current = parseTimeSeconds(match[1]);
          const pct = Math.min(95, Math.floor((current / totalDuration) * 95));
          updateTask(taskId, { progress: pct });
        }
      });
    }

    if (!fs.existsSync(outputPath)) {
      throw new Error('输出文件未生成');
    }

    const stats = fs.statSync(outputPath);
    updateTask(taskId, {
      status: 'done',
      progress: 100,
      output: outputName,
      file_size: stats.size,
      stage: '已完成'
    });
  } catch (err) {
    if (fs.existsSync(palettePath)) fs.unlinkSync(palettePath);
    throw err;
  }
}

// 路由
app.post('/upload', upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: '未提供文件' });
  }

  const uploaded = [];
  for (const f of req.files) {
    const duration = await getVideoDuration(f.path);
    // 尝试正确处理中文文件名
    let originalName = f.originalname;
    try {
      originalName = decodeURIComponent(escape(f.originalname));
    } catch (e) {
      originalName = f.originalname;
    }
    uploaded.push({
      filename: f.filename,
      original_name: originalName,
      size: f.size,
      duration
    });
  }
  res.json({ files: uploaded });
});

app.post('/convert', (req, res) => {
  const data = req.body;
  if (!data || !data.files) {
    return res.status(400).json({ error: '未指定要转换的文件' });
  }

  const params = {
    fps: Math.max(1, Math.min(30, parseInt(data.fps || 10))),
    width: Math.max(100, Math.min(1920, parseInt(data.width || 480))),
    start: parseFloat(data.start || 0),
    duration: parseFloat(data.duration || 0),
    quality: data.quality || 'high',
    loop: Math.max(0, parseInt(data.loop || 0)),
  };

  const taskIds = [];
  for (const filename of data.files) {
    const inputPath = path.join(UPLOAD_DIR, path.basename(filename));
    if (!fs.existsSync(inputPath)) {
      return res.status(404).json({ error: `文件未找到: ${filename}` });
    }

    const taskId = crypto.randomBytes(6).toString('hex');
    tasks.set(taskId, {
      status: 'queued',
      progress: 0,
      output: null,
      error: null,
      filename,
      stage: '排队中',
      file_size: 0
    });

    taskQueue.push({ taskId, inputPath, params });
    taskIds.push({ task_id: taskId, filename });
  }

  processQueue();
  res.json({ tasks: taskIds });
});

app.get('/status/:taskId', (req, res) => {
  const { taskId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const intervalId = setInterval(() => {
    const task = tasks.get(taskId);
    if (!task) {
      res.write(`data: ${JSON.stringify({ error: '任务未找到' })}\n\n`);
      clearInterval(intervalId);
      return res.end();
    }

    res.write(`data: ${JSON.stringify(task)}\n\n`);

    if (task.status === 'done' || task.status === 'error') {
      clearInterval(intervalId);
      res.end();
    }
  }, 500);

  req.on('close', () => clearInterval(intervalId));
});

app.get('/download/:filename', (req, res) => {
  const filepath = path.join(OUTPUT_DIR, path.basename(req.params.filename));
  res.download(filepath);
});

app.get('/preview/:filename', (req, res) => {
  const filepath = path.join(OUTPUT_DIR, path.basename(req.params.filename));
  res.sendFile(filepath);
});

app.delete('/clean', (req, res) => {
  let count = 0;
  [UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).forEach(file => {
        fs.unlinkSync(path.join(dir, file));
        count++;
      });
    }
  });
  tasks.clear();
  taskQueue.length = 0;
  res.json({ deleted: count });
});

function cleanupOldFiles() {
  [UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).forEach(file => {
        try { fs.unlinkSync(path.join(dir, file)); } catch (e) {}
      });
    }
  });
}

cleanupOldFiles();
app.listen(port, '127.0.0.1', () => {
  console.log(`视频转 GIF 服务已启动: http://127.0.0.1:${port}`);
});
