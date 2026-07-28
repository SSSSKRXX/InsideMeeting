import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * 房间配置的持久化存储。
 *
 * 和「会议」不同：会议是一次性的（每次开会生成一个新 meetingId），
 * 房间是长期的（weekly 这个房间号下周还会再用）。
 * 密码、等候室开关这些属于房间，所以要单独存，服务重启也不能丢。
 */

const FILE = path.join(config.dataDir, 'rooms.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function persist() {
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(cache, null, 2));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch {
    /* 磁盘写失败不影响会议进行 */
  }
}

function hash(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}

export function defaultSettings() {
  return {
    passwordHash: null,
    passwordSalt: null,
    waitingRoom: false, // 等候室：新人需主持人放行
    locked: false,      // 锁定：谁都进不来
    // 多个主持人令牌并存。原因见 issueHostToken 注释。
    hostTokenHashes: [],
    hostName: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function getRoom(roomId) {
  const db = load();
  if (!db[roomId]) {
    db[roomId] = defaultSettings();
    persist();
  }
  return db[roomId];
}

/** 对外暴露的房间状态，不含任何哈希 */
export function publicSettings(roomId) {
  const r = getRoom(roomId);
  return {
    roomId,
    hasPassword: Boolean(r.passwordHash),
    waitingRoom: Boolean(r.waitingRoom),
    locked: Boolean(r.locked),
    hostName: r.hostName || '',
  };
}

export function setPassword(roomId, password) {
  const db = load();
  const r = getRoom(roomId);
  if (!password) {
    r.passwordHash = null;
    r.passwordSalt = null;
  } else {
    r.passwordSalt = crypto.randomBytes(16).toString('hex');
    r.passwordHash = hash(password, r.passwordSalt);
  }
  r.updatedAt = Date.now();
  db[roomId] = r;
  persist();
  return publicSettings(roomId);
}

export function hasHost(roomId) {
  const r = getRoom(roomId);
  return (r.hostTokenHashes?.length || 0) > 0 || Boolean(r.hostTokenHash);
}

export function checkPassword(roomId, password) {
  const r = getRoom(roomId);
  if (!r.passwordHash) return true; // 没设密码
  if (!password) return false;
  const got = Buffer.from(hash(password, r.passwordSalt), 'hex');
  const want = Buffer.from(r.passwordHash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export function updateRoom(roomId, patch = {}) {
  const db = load();
  const r = getRoom(roomId);
  if ('waitingRoom' in patch) r.waitingRoom = Boolean(patch.waitingRoom);
  if ('locked' in patch) r.locked = Boolean(patch.locked);
  if ('hostName' in patch) r.hostName = String(patch.hostName || '').slice(0, 24);
  r.updatedAt = Date.now();
  db[roomId] = r;
  persist();
  return publicSettings(roomId);
}

/**
 * 签发主持人令牌。存在客户端 localStorage 里，
 * 主持人刷新页面或断线重连后还能拿回主持人身份。
 *
 * 为什么保留多个令牌而不是只留最新的一个：
 * 主持人掉线时会把主持权临时移交给下一个人（否则会议失控）。
 * 如果新令牌覆盖旧令牌，原主持人重连回来就变成普通成员了——
 * 这在「网络抖了一下」的场景下非常难受。所以多个令牌并存，
 * 谁持有有效令牌谁就是主持人，相当于联席主持人模型。
 */
export function issueHostToken(roomId, hostName) {
  const db = load();
  const r = getRoom(roomId);
  // 兼容早期单令牌格式
  if (!Array.isArray(r.hostTokenHashes)) {
    r.hostTokenHashes = r.hostTokenHash ? [r.hostTokenHash] : [];
    delete r.hostTokenHash;
  }
  const token = crypto.randomBytes(24).toString('hex');
  r.hostTokenHashes.push(crypto.createHash('sha256').update(token).digest('hex'));
  if (r.hostTokenHashes.length > 10) r.hostTokenHashes.splice(0, r.hostTokenHashes.length - 10);
  r.hostName = String(hostName || '').slice(0, 24);
  r.updatedAt = Date.now();
  db[roomId] = r;
  persist();
  return token;
}

export function checkHostToken(roomId, token) {
  if (!token) return false;
  const r = getRoom(roomId);
  const list = Array.isArray(r.hostTokenHashes) ? r.hostTokenHashes : r.hostTokenHash ? [r.hostTokenHash] : [];
  if (!list.length) return false;
  const got = crypto.createHash('sha256').update(String(token)).digest('hex');
  return list.some((h) => h.length === got.length && crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(h, 'hex')));
}

/** 主持人可以吊销所有已签发的令牌（比如令牌泄露了） */
export function revokeHostTokens(roomId) {
  const db = load();
  const r = getRoom(roomId);
  r.hostTokenHashes = [];
  delete r.hostTokenHash;
  r.updatedAt = Date.now();
  db[roomId] = r;
  persist();
}

export function listRooms() {
  const db = load();
  return Object.keys(db).map((id) => publicSettings(id));
}
