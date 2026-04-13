const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const inProcessLocks = new Map();

function normalizeString(value) {
  return String(value || "").trim();
}

function sanitizeScope(scope) {
  const normalized = normalizeString(scope).toLowerCase();
  if (!normalized) return "telegram";
  return normalized.replace(/[^a-z0-9_-]/g, "_");
}

function getLockDir() {
  const customDir = normalizeString(process.env.TELEGRAM_SESSION_LOCK_DIR);
  if (customDir) return customDir;
  return path.join(os.tmpdir(), "yamaha-telegram-locks");
}

function getSessionFingerprint(sessionString) {
  return crypto
    .createHash("sha1")
    .update(normalizeString(sessionString))
    .digest("hex")
    .slice(0, 16);
}

function isProcessAlive(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;

  try {
    process.kill(parsed, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function readLockPayload(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function removeFileIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function writeLockPayload(filePath, payload) {
  const handle = await fs.open(filePath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

function buildReleaseHandle(state) {
  let released = false;

  return {
    filePath: state.filePath,
    async release() {
      if (released) return;
      released = true;

      const current = inProcessLocks.get(state.filePath);
      if (!current) return;

      current.refs = Math.max(0, Number(current.refs || 0) - 1);
      if (current.refs > 0) return;

      inProcessLocks.delete(state.filePath);
      if (Number(current.ownerPid || 0) === process.pid) {
        await removeFileIfExists(state.filePath);
      }
    },
  };
}

async function acquireTelegramSessionLock({
  scope = "telegram",
  sessionString = "",
} = {}) {
  const session = normalizeString(sessionString);
  if (!session) {
    return {
      filePath: "",
      async release() {},
    };
  }

  const safeScope = sanitizeScope(scope);
  const fingerprint = getSessionFingerprint(session);
  const lockDir = getLockDir();
  const filePath = path.join(lockDir, `${safeScope}-${fingerprint}.lock`);

  const existingInProcess = inProcessLocks.get(filePath);
  if (existingInProcess) {
    existingInProcess.refs += 1;
    return buildReleaseHandle(existingInProcess);
  }

  await fs.mkdir(lockDir, { recursive: true });

  const payload = {
    pid: process.pid,
    scope: safeScope,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  };

  let ownerPayload = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeLockPayload(filePath, payload);
      ownerPayload = payload;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const existingPayload = await readLockPayload(filePath);
      const ownerPid = Number(existingPayload?.pid || 0);

      if (ownerPid === process.pid) {
        ownerPayload = existingPayload || payload;
        break;
      }

      if (!isProcessAlive(ownerPid)) {
        await removeFileIfExists(filePath);
        continue;
      }

      const ownerHost = normalizeString(existingPayload?.hostname) || "unknown-host";
      throw new Error(
        `Session band: ${safeScope} allaqachon boshqa processda ishlayapti (pid=${ownerPid}, host=${ownerHost}).`,
      );
    }
  }

  if (!ownerPayload) {
    throw new Error(`Session lock olinmadi: ${safeScope}.`);
  }

  const state = {
    filePath,
    ownerPid: Number(ownerPayload?.pid || process.pid),
    refs: 1,
  };
  inProcessLocks.set(filePath, state);

  return buildReleaseHandle(state);
}

module.exports = {
  acquireTelegramSessionLock,
};

