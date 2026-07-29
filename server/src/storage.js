import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, paths } from './config.js';

/**
 * 存储位置的运行时配置。
 *
 * 为什么不直接用 .env 的 DATA_DIR：改 .env 要登服务器、要重启。
 * 录制文件是会持续变大的东西（一场 2 小时 6 人的会几百 MB），
 * 迟早要挪到移动硬盘或 NAS 上，这个操作应该在界面上点两下就能完成。
 *
 * 录制和纪要分开配置的理由很实际：
 * 录制是几百 MB 的音视频，纪要是几十 KB 的文本。
 * 大文件放外置盘，纪要留在系统盘（跟着 Time Machine 一起备份），是很自然的分法。
 */

const FILE = path.join(config.dataDir, 'storage.json');

const DEFAULTS = {
  recordings: paths.recordings,
  minutes: '', // 留空表示跟录制放一起，保持默认行为
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function persist() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(cache, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

/**
 * 已经确认存在的目录。
 *
 * 这个缓存不是为了省几微秒 —— 是为了不在每次请求里都碰一次文件系统。
 * 如果录制目录指向一个掉线的网络盘，mkdirSync 会阻塞整个事件循环，
 * 那时候连「打开管理后台改回本地路径」都做不到，只能去服务器上手动改配置。
 */
const ensured = new Set();

function ensureOnce(dir) {
  if (ensured.has(dir)) return dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    ensured.add(dir);
  } catch { /* 盘不在，交给上层在实际读写时报错 */ }
  return dir;
}

export function recordingsRoot() {
  return ensureOnce(load().recordings || DEFAULTS.recordings);
}

/** 纪要目录。没单独配就跟录制放一起。 */
export function minutesRoot() {
  const m = load().minutes;
  return m ? ensureOnce(m) : recordingsRoot();
}

export function currentPaths() {
  const s = load();
  return {
    recordings: recordingsRoot(),
    minutes: s.minutes || '',
    minutesEffective: minutesRoot(),
    separate: Boolean(s.minutes),
    defaults: DEFAULTS,
  };
}

// 这些是系统的虚拟文件系统，往里写东西没有意义，而且探测它们容易卡住
const FORBIDDEN = ['/proc', '/sys', '/dev', '/run'];

/** 给可能卡住的文件操作套一个超时。掉线的网络盘是最常见的元凶。 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}超时（${ms / 1000} 秒无响应）。如果是网络盘，先确认它还连着。`)), ms)),
  ]);
}

/**
 * 校验一个目录能不能用。
 *
 * 全程用异步 + 超时：同步的 fs 调用碰上掉线的网络盘会阻塞整个事件循环，
 * 那时连正在开的会都会一起卡住。
 *
 * 只检查「能不能写」，不检查空间够不够 —— 磁盘满了是运行时的事，
 * 这里拦不住，界面上会单独显示剩余空间。
 */
export async function validateDir(dir) {
  if (!dir) return { ok: false, error: '路径不能为空' };
  if (!path.isAbsolute(dir)) return { ok: false, error: '需要填绝对路径，比如 /Volumes/移动硬盘/会议录制' };

  const norm = path.resolve(dir);
  if (FORBIDDEN.some((f) => norm === f || norm.startsWith(f + path.sep))) {
    return { ok: false, error: `${norm} 是系统目录，不能用来存文件` };
  }

  try {
    await withTimeout(fs.promises.mkdir(norm, { recursive: true }), 5000, '创建目录');
  } catch (e) {
    return { ok: false, error: `无法创建目录：${e.message}` };
  }

  const probe = path.join(norm, `.im-write-test-${Date.now()}`);
  try {
    await withTimeout(fs.promises.writeFile(probe, 'x'), 5000, '写入测试');
    await fs.promises.rm(probe, { force: true }).catch(() => {});
  } catch (e) {
    return { ok: false, error: `目录不可写：${e.message}` };
  }

  let free = null;
  try {
    const s = fs.statfsSync(norm);
    free = s.bavail * s.bsize;
  } catch { /* 某些文件系统不支持 */ }

  return { ok: true, dir: norm, freeBytes: free };
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let list;
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch { /* 忽略 */ }
      }
    }
  };
  walk(dir);
  return total;
}

/**
 * 把一个目录下的内容搬到另一个目录。
 * 同一个磁盘上用 rename 是瞬间完成的；跨磁盘则退化成复制再删，会慢。
 */
async function moveContents(from, to) {
  if (path.resolve(from) === path.resolve(to)) return { moved: 0, bytes: 0 };
  if (!fs.existsSync(from)) return { moved: 0, bytes: 0 };

  await fs.promises.mkdir(to, { recursive: true });
  let moved = 0;
  let bytes = 0;

  for (const name of await fs.promises.readdir(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (fs.existsSync(dst)) continue; // 同名的不覆盖，宁可留下也不弄丢
    const st = await fs.promises.stat(src);
    const size = st.isDirectory() ? dirSize(src) : st.size;
    try {
      await fs.promises.rename(src, dst);
    } catch {
      // 跨设备时 rename 会失败，退化成复制 + 删除
      await fs.promises.cp(src, dst, { recursive: true });
      await fs.promises.rm(src, { recursive: true, force: true });
    }
    moved++;
    bytes += size;
  }
  return { moved, bytes };
}

// 纪要产物的固定文件名。搬移纪要时只认这几个。
const ARTIFACT_FILES = ['transcript.md', 'transcript.json', 'summary.md', 'actions.json'];

/**
 * 只搬「纪要产物」，不碰录制文件和 manifest。
 *
 * 不能直接复用 moveContents：没分离配置时纪要目录就等于录制目录，
 * 整目录搬过去会把音视频和 manifest 一起带走，
 * 结果是录制目录被搬空、所有历史会议从界面上消失。
 */
async function moveMinutes(fromRoot, toRoot) {
  if (path.resolve(fromRoot) === path.resolve(toRoot)) return { moved: 0, bytes: 0 };
  if (!fs.existsSync(fromRoot)) return { moved: 0, bytes: 0 };

  await fs.promises.mkdir(toRoot, { recursive: true });
  let moved = 0;
  let bytes = 0;

  for (const meetingId of await fs.promises.readdir(fromRoot)) {
    const srcDir = path.join(fromRoot, meetingId);
    try {
      if (!(await fs.promises.stat(srcDir)).isDirectory()) continue;
    } catch {
      continue;
    }

    let madeDir = false;
    for (const name of ARTIFACT_FILES) {
      const src = path.join(srcDir, name);
      if (!fs.existsSync(src)) continue;
      const dstDir = path.join(toRoot, meetingId);
      const dst = path.join(dstDir, name);
      if (fs.existsSync(dst)) continue;

      if (!madeDir) {
        await fs.promises.mkdir(dstDir, { recursive: true });
        madeDir = true;
      }
      const size = (await fs.promises.stat(src)).size;
      try {
        await fs.promises.rename(src, dst);
      } catch {
        await fs.promises.cp(src, dst);
        await fs.promises.rm(src, { force: true });
      }
      moved++;
      bytes += size;
    }
  }
  return { moved, bytes };
}

/**
 * 修改存储位置。
 * @param {object} o
 * @param {string} [o.recordings] 新的录制目录
 * @param {string} [o.minutes]    新的纪要目录，传空字符串表示跟录制放一起
 * @param {boolean} [o.migrate]   是否把已有文件搬过去
 */
export async function setPaths({ recordings, minutes, migrate = false } = {}) {
  const s = load();
  const result = { changed: [], migrated: null, warnings: [] };

  if (recordings !== undefined && recordings !== s.recordings) {
    const v = await validateDir(recordings);
    if (!v.ok) return { ok: false, error: `录制目录不可用：${v.error}` };

    if (migrate) {
      try {
        const r = await moveContents(recordingsRoot(), v.dir);
        result.migrated = { ...(result.migrated || {}), recordings: r };
      } catch (e) {
        return { ok: false, error: `搬移录制文件失败：${e.message}。位置未改动。` };
      }
    } else {
      const old = recordingsRoot();
      if (fs.existsSync(old) && fs.readdirSync(old).length) {
        result.warnings.push('已有的录制文件仍留在旧目录，历史会议在界面上会看不到。想一起挪过去请勾选「同时搬移已有文件」。');
      }
    }
    s.recordings = v.dir;
    result.changed.push('recordings');
  }

  if (minutes !== undefined && minutes !== s.minutes) {
    let target = '';
    if (minutes) {
      const v = await validateDir(minutes);
      if (!v.ok) return { ok: false, error: `纪要目录不可用：${v.error}` };
      target = v.dir;
    }
    if (migrate && target) {
      try {
        const r = await moveMinutes(minutesRoot(), target);
        result.migrated = { ...(result.migrated || {}), minutes: r };
      } catch (e) {
        result.warnings.push(`搬移纪要失败：${e.message}`);
      }
    }
    s.minutes = target;
    result.changed.push('minutes');
  }

  cache = s;
  ensured.clear(); // 路径变了，重新确认一次目录存在
  persist();
  return { ok: true, ...result, paths: currentPaths() };
}

/**
 * 列出可以放东西的候选位置。
 * 浏览器没法浏览服务器的目录，所以由服务端把常用位置和外接磁盘列出来，
 * 用户在界面上点一下就行，不用手敲路径。
 */
export function suggestLocations() {
  const home = os.homedir();
  const out = [];

  const add = (label, dir, kind = 'preset') => {
    if (!dir) return;
    let free = null;
    let exists = fs.existsSync(dir);
    try {
      const s = fs.statfsSync(exists ? dir : path.dirname(dir));
      free = s.bavail * s.bsize;
    } catch { /* 忽略 */ }
    out.push({ label, dir, kind, exists, freeBytes: free });
  };

  add('默认位置（项目目录内）', DEFAULTS.recordings, 'default');
  add('用户文稿', path.join(home, 'Documents', 'InsideMeeting'));
  add('用户影片', path.join(home, 'Movies', 'InsideMeeting'));

  // macOS 的外接磁盘都挂在 /Volumes 下
  const volumes = '/Volumes';
  if (fs.existsSync(volumes)) {
    for (const name of fs.readdirSync(volumes)) {
      const p = path.join(volumes, name);
      try {
        if (!fs.statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      add(`外接磁盘：${name}`, path.join(p, 'InsideMeeting'), 'volume');
    }
  }

  // Linux 常见的挂载点
  for (const base of ['/mnt', '/media']) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const p = path.join(base, name);
      try {
        if (!fs.statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      add(`挂载点：${name}`, path.join(p, 'InsideMeeting'), 'volume');
    }
  }

  return out;
}
