import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * 房间配置的持久化存储。
 *
 * 和「会议」不同：会议是一次性的（每次开会生成一个新 meetingId），
 * 房间是长期的（weekly 这个房间号下周还会再用）。
 * 密码、等候室开关这些属于房间，所以要单独存。
 *
 * 但「长期」不等于「永远」。所有人都退出之后这个房间就没有意义了，
 * 由 signaling.js 在会议结束时调 dropRoom() 把它删掉，
 * 免得 rooms.json 无限膨胀。**只删这一条配置记录，
 * 录音、逐字稿、纪要都在 data/recordings/<meetingId>/ 下，完全不受影响。**
 */

const FILE = path.join(config.dataDir, 'rooms.json');

/**
 * 服务启动时把所有房间配置清空。
 *
 * 理由：服务刚起来的时候一场会都没有，按「所有人退出就清空」的规则，
 * 每个房间都该是空的。不这么做的话，服务在会议进行中被重启（崩溃、
 * 开机自启、手动重启服务）留下的那些带主持人令牌的条目就永远清不掉了。
 *
 * 代价：房间密码不会跨重启保留。如果你希望密码长期有效，把这里改成 false，
 * 那样只有「开完会正常散场」才会清，重启留下的残留需要手动处理。
 */
const WIPE_ON_START = true;

let cache = null;

/**
 * 这条记录里有没有值得留下来的东西。
 * 没密码、没主持人令牌、没锁定、没开等候室 —— 那它和不存在是等价的。
 */
function isDefault(r) {
  if (!r || typeof r !== 'object') return true;
  const tokens = Array.isArray(r.hostTokenHashes)
    ? r.hostTokenHashes.length
    : r.hostTokenHash
      ? 1
      : 0;
  return !r.passwordHash && !r.waitingRoom && !r.locked && tokens === 0;
}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = {};
  }

  // 启动时清一次历史垃圾。
  //
  // 以前 getRoom() 在「读」的时候也会建条目并落盘，而大厅那个
  // 「边输房间号边查这个房间要不要密码」的轮询会命中每一个输入前缀 ——
  // 打一次「产品评审」就可能凭空多出好几个房间。这些条目全是默认值，
  // 删掉没有任何损失。
  const before = Object.keys(cache).length;
  for (const [id, r] of Object.entries(cache)) {
    if (WIPE_ON_START || isDefault(r)) delete cache[id];
  }
  const removed = before - Object.keys(cache).length;
  if (removed > 0) {
    console.log(`[roomstore] 启动清理：移除 ${removed} 个房间配置（录制文件不受影响）`);
    persist();
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

/**
 * 只读地取房间配置。**不会创建、不会落盘。**
 *
 * 原来这里是「查不到就建一个并写盘」，于是任何一次读取都会留下痕迹。
 * 读操作产生副作用是这个文件无限膨胀的根本原因。
 */
export function getRoom(roomId) {
  const db = load();
  return db[roomId] || defaultSettings();
}

/** 要改东西时才真正建条目 */
function ensureRoom(roomId) {
  const db = load();
  if (!db[roomId]) db[roomId] = defaultSettings();
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
  const r = ensureRoom(roomId);
  if (!password) {
    r.passwordHash = null;
    r.passwordSalt = null;
  } else {
    r.passwordSalt = crypto.randomBytes(16).toString('hex');
    r.passwordHash = hash(password, r.passwordSalt);
  }
  r.updatedAt = Date.now();
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
  const r = ensureRoom(roomId);
  if ('waitingRoom' in patch) r.waitingRoom = Boolean(patch.waitingRoom);
  if ('locked' in patch) r.locked = Boolean(patch.locked);
  if ('hostName' in patch) r.hostName = String(patch.hostName || '').slice(0, 24);
  r.updatedAt = Date.now();
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
  const r = ensureRoom(roomId);
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
  if (!db[roomId]) return;
  const r = db[roomId];
  r.hostTokenHashes = [];
  delete r.hostTokenHash;
  r.updatedAt = Date.now();
  persist();
}

/**
 * 删掉一个房间的全部配置：密码、等候室、锁定状态、主持人令牌。
 *
 * 由 signaling.js 在「所有人都退出、并且过了宽限期」时调用，
 * 下一次有人用同一个房间号进来，就是彻底全新的一场会。
 *
 * 再强调一次：这里只动 rooms.json 这一个文件里的一条记录。
 * 录音（data/recordings/<meetingId>/*.webm）、逐字稿、纪要、manifest
 * 全部在别的目录，跟这个函数没有任何关系，一个字节都不会少。
 */
export function dropRoom(roomId) {
  const db = load();
  if (!(roomId in db)) return false;
  delete db[roomId];
  persist();
  return true;
}

export function listRooms() {
  const db = load();
  return Object.keys(db).map((id) => publicSettings(id));
}
