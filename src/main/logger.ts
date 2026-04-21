import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const LOG_DIR = path.join(os.homedir(), '.perch');
const LOG_FILE = path.join(LOG_DIR, 'perch.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

let logStream: fs.WriteStream | null = null;

function initLogFile() {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    if (fs.existsSync(LOG_FILE)) {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > MAX_LOG_SIZE) {
        const old = LOG_FILE + '.old';
        if (fs.existsSync(old)) fs.unlinkSync(old);
        fs.renameSync(LOG_FILE, old);
      }
    }

    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  } catch (e) {
    originalConsoleError('Failed to initialize log file:', e);
  }
}

function writeToFile(line: string) {
  if (logStream) {
    logStream.write(line + '\n');
  }
}

function formatArgs(args: any[]): string {
  return args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
}

initLogFile();
writeToFile(`\n${'='.repeat(60)}\nPerch started at ${new Date().toISOString()}\n${'='.repeat(60)}`);

// Override console to tee into log file
console.log = (...args: any[]) => {
  originalConsoleLog(...args);
  writeToFile(`[${new Date().toISOString()}] [INFO] ${formatArgs(args)}`);
};

console.warn = (...args: any[]) => {
  originalConsoleWarn(...args);
  writeToFile(`[${new Date().toISOString()}] [WARN] ${formatArgs(args)}`);
};

console.error = (...args: any[]) => {
  originalConsoleError(...args);
  writeToFile(`[${new Date().toISOString()}] [ERROR] ${formatArgs(args)}`);
};

export const logger = {
  close() {
    writeToFile(`[${new Date().toISOString()}] [INFO] Perch shutting down`);
    logStream?.end();
    logStream = null;
  }
};
