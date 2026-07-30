import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { config, iceServers } from './config.js';
import { ensureMeeting, updateMeeting } from './store.js';
import { endLive, liveState } from './live.js';
import {
  publicSettings,
  checkPassword,
  setPassword,
  updateRoom,
  issueHostToken,
  checkHostToken,
  getRoom,
} from './roomstore.js';

/** roomId -> { meetingId, startedAt, peers: Map, waiting: Map, hostPeerId, endTimer } */
const rooms = new Map();

const MEETING_GRACE_MS = 2 * 60 * 1000;
const WAIT_TIMEOUT_MS = 5 * 60 * 1000; // 等候超过 5 分钟自动放弃

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeRoomId(raw) {
  return String(raw || '').trim().replace(/[^\w一-龥-]/g, '').slice(0, 40);
}

function getLiveRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    const startedAt = Date.now();
    const meetingId = `${roomId}_${stamp(new Date(startedAt))}`;
    room = {
      roomId,
      meetingId,
      startedAt,
      peers: new Map(),   // socketId -> peer
      waiting: new Map(), // socketId -> { peerId, name, socket, at, timer }
      hostPeerId: null,
      endTimer: null,
    };
    rooms.set(roomId, room);
    ensureMeeting(meetingId, { roomId, startedAt });
  }
  if (room.endTimer) {
    clearTimeout(room.endTimer);
    room.endTimer = null;
  }
  return room;
}

function publicPeer(p) {
  return {
    peerId: p.peerId,
    name: p.name,
    muted: p.muted,
    videoOn: p.videoOn,
    sharing: p.sharing,
    handRaised: p.handRaised,
    joinedAt: p.joinedAt,
    recording: p.recording,
    isHost: p.isHost,
  };
}

function roomSnapshot(room) {
  return {
    roomId: room.roomId,
    meetingId: room.meetingId,
    startedAt: room.startedAt,
    peers: [...room.peers.values()].map(publicPeer),
    settings: publicSettings(room.roomId),
  };
}

function waitingList(room) {
  return [...room.waiting.values()].map((w) => ({ peerId: w.peerId, name: w.name, at: w.at }));
}

function notifyHostOfWaiting(io, room) {
  const list = waitingList(room);
  for (const p of room.peers.values()) {
    if (p.isHost) io.to(p.socketId).emit('waiting-list', { list });
  }
}

/** 主持人离开后，把主持人身份交给最早进来的人，避免会议失去控制 */
function reassignHost(io, room) {
  const remaining = [...room.peers.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  const next = remaining[0];
  room.hostPeerId = next ? next.peerId : null;
  if (next) {
    next.isHost = true;
    const token = issueHostToken(room.roomId, next.name);
    io.to(next.socketId).emit('host-granted', { token, reason: '原主持人已离开' });
    io.to(room.roomId).emit('peer-state', { peerId: next.peerId, patch: publicPeer(next) });
    notifyHostOfWaiting(io, room);
  }
}

/** 把等候室里的人放进会议。admit-peer、关闭等候室、主持人离场兜底都走这里。 */
function admitWaiting(io, room, entries) {
  for (const w of entries) {
    clearTimeout(w.timer);
    room.waiting.delete(w.socket.id);

    const wsock = w.socket;
    wsock.join(room.roomId);
    room.peers.set(wsock.id, w.peer);

    // 房间里一个主持人都没有的话，让被放行的第一个人接管，
    // 否则会出现「有人在会但没人能管」的状态
    if (![...room.peers.values()].some((p) => p.isHost)) {
      w.peer.isHost = true;
      room.hostPeerId = w.peer.peerId;
      const token = issueHostToken(room.roomId, w.peer.name);
      wsock.emit('host-granted', { token, reason: '房间里没有主持人，已由你接管' });
    }

    w.onAdmit?.(room, w.peer);

    updateMeeting(room.meetingId, (m) => {
      m.participants[w.peer.peerId] = { name: w.peer.name, joinedAt: Date.now(), leftAt: null };
      m.chat.push({ t: Date.now(), system: true, text: `${w.peer.name} 加入了会议` });
      return m;
    });

    const existing = [...room.peers.values()].filter((p) => p.socketId !== wsock.id);
    wsock.emit('admitted', {
      self: publicPeer(w.peer),
      room: roomSnapshot(room),
      iceServers: iceServers(),
      settings: {
        segmentMinutes: config.recording.segmentMinutes,
        chunkSeconds: config.recording.chunkSeconds,
        recordVideoDefault: config.recording.recordVideoDefault,
      },
      initiateTo: existing.map((p) => p.peerId),
      live: liveState(room.meetingId),
    });
    wsock.to(room.roomId).emit('peer-joined', { peer: publicPeer(w.peer) });
  }
  notifyHostOfWaiting(io, room);
}

function scheduleEnd(room) {
  if (room.peers.size > 0) return;
  room.endTimer = setTimeout(() => {
    updateMeeting(room.meetingId, (m) => {
      m.endedAt = Date.now();
      m.status = 'ended';
      return m;
    });
    endLive(room.meetingId);
    for (const w of room.waiting.values()) clearTimeout(w.timer);
    rooms.delete(room.roomId);
  }, MEETING_GRACE_MS);
}

export function attachSignaling(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
    maxHttpBufferSize: 2 * 1024 * 1024,
  });

  io.on('connection', (socket) => {
    let joined = null; // { room, peer }

    /** 真正把人放进会议 */
    function admit(room, peer, ack) {
      room.peers.set(socket.id, peer);
      socket.join(room.roomId);
      joined = { room, peer };

      updateMeeting(room.meetingId, (m) => {
        m.participants[peer.peerId] = { name: peer.name, joinedAt: peer.joinedAt, leftAt: null };
        m.chat.push({ t: Date.now(), system: true, text: `${peer.name} 加入了会议` });
        return m;
      });

      const existing = [...room.peers.values()].filter((p) => p.socketId !== socket.id);

      ack({
        ok: true,
        self: publicPeer(peer),
        room: roomSnapshot(room),
        iceServers: iceServers(),
        settings: {
          segmentMinutes: config.recording.segmentMinutes,
          chunkSeconds: config.recording.chunkSeconds,
          recordVideoDefault: config.recording.recordVideoDefault,
        },
        initiateTo: existing.map((p) => p.peerId),
        live: liveState(room.meetingId),
        hostToken: peer.hostToken || null,
        // 字段名必须和「被拦在等候室」那条的 waiting 区分开。
        // 之前两者都叫 waiting：被拦时是 true，正常入会时是数组。
        // 空数组在 JS 里是 truthy，前端一律判成被拦，
        // 结果是任何人成功入会后都看到「正在等待主持人允许」。
        waitingList: peer.isHost ? waitingList(room) : [],
      });

      socket.to(room.roomId).emit('peer-joined', { peer: publicPeer(peer) });
    }

    socket.on('join', (payload = {}, ack = () => {}) => {
      const roomId = safeRoomId(payload.roomId);
      const name = String(payload.name || '').trim().slice(0, 24) || '匿名';

      if (!roomId) return ack({ ok: false, error: '房间号无效' });

      // 全局口令（.env 里的 JOIN_PASSWORD）——所有房间通用的第一道门
      if (config.joinPassword && payload.globalPassword !== config.joinPassword) {
        return ack({ ok: false, error: '入会口令错误', reason: 'global-password' });
      }

      const settings = publicSettings(roomId);
      const room = getLiveRoom(roomId);
      const cfg = getRoom(roomId);
      const everHadHost = (cfg.hostTokenHashes?.length || 0) > 0 || Boolean(cfg.hostTokenHash);
      const isFirstEver = room.peers.size === 0 && !everHadHost;
      const claimsHost = checkHostToken(roomId, payload.hostToken);

      // 房间密码
      if (settings.hasPassword && !claimsHost && !checkPassword(roomId, payload.password)) {
        return ack({ ok: false, error: '房间密码错误', reason: 'room-password' });
      }

      // 会议已锁定
      if (settings.locked && !claimsHost) {
        return ack({ ok: false, error: '会议已被主持人锁定，暂不接受新成员', reason: 'locked' });
      }

      const peerId = randomUUID().slice(0, 8);
      const becomesHost = claimsHost || isFirstEver || room.peers.size === 0;

      const peer = {
        peerId,
        socketId: socket.id,
        name,
        muted: Boolean(payload.muted),
        videoOn: Boolean(payload.videoOn),
        sharing: false,
        handRaised: false,
        recording: false,
        isHost: becomesHost,
        joinedAt: Date.now(),
      };

      if (becomesHost) {
        room.hostPeerId = peerId;
        peer.hostToken = issueHostToken(roomId, name);
      }

      // 等候室只在「主持人真的在场」时才生效。
      // 否则会死锁：主持人中途退出后再回来，会被自己设的等候室拦在外面，
      // 而房间里没有任何人有权放行他。等候室的意义是让主持人审批，
      // 主持人不在的时候它没有意义，只会把所有人挡在门外。
      const hostPresent = [...room.peers.values()].some((p) => p.isHost);

      if (settings.waitingRoom && !becomesHost && hostPresent) {
        const entry = {
          peerId,
          name,
          socket,
          peer,
          at: Date.now(),
          // 关键：被放行时要在「等候者自己的连接上下文」里设置 joined，
          // 否则他之后发的 signal / chat / state 都会因为 joined 为空被丢掉。
          onAdmit: (r, p) => {
            joined = { room: r, peer: p };
          },
          timer: setTimeout(() => {
            room.waiting.delete(socket.id);
            socket.emit('waiting-timeout');
            notifyHostOfWaiting(io, room);
          }, WAIT_TIMEOUT_MS),
        };
        room.waiting.set(socket.id, entry);
        notifyHostOfWaiting(io, room);
        return ack({
          ok: false,
          waiting: true, // 只有这里才是布尔值，表示「被拦在门外」

          peerId,
          error: '正在等待主持人允许你加入',
          reason: 'waiting-room',
          hostName: settings.hostName,
        });
      }

      admit(room, peer, ack);
    });

    // ---------- 主持人操作 ----------

    function requireHost() {
      if (!joined?.peer?.isHost) {
        socket.emit('op-denied', { error: '只有主持人可以执行这个操作' });
        return null;
      }
      return joined;
    }

    socket.on('admit-peer', ({ peerId, all } = {}) => {
      const j = requireHost();
      if (!j) return;
      const { room } = j;
      const targets = all
        ? [...room.waiting.values()]
        : [...room.waiting.values()].filter((w) => w.peerId === peerId);
      admitWaiting(io, room, targets);
    });

    socket.on('deny-peer', ({ peerId } = {}) => {
      const j = requireHost();
      if (!j) return;
      const { room } = j;
      for (const w of [...room.waiting.values()]) {
        if (w.peerId !== peerId) continue;
        clearTimeout(w.timer);
        room.waiting.delete(w.socket.id);
        w.socket.emit('denied', { error: '主持人拒绝了你的加入请求' });
      }
      notifyHostOfWaiting(io, room);
    });

    socket.on('kick-peer', ({ peerId } = {}) => {
      const j = requireHost();
      if (!j) return;
      const target = [...j.room.peers.values()].find((p) => p.peerId === peerId);
      if (!target || target.isHost) return;
      io.to(target.socketId).emit('kicked', { by: j.peer.name });
      const s = io.sockets.sockets.get(target.socketId);
      s?.leave(j.room.roomId);
      j.room.peers.delete(target.socketId);
      io.to(j.room.roomId).emit('peer-left', { peerId });
    });

    socket.on('room-settings', (patch = {}, ack = () => {}) => {
      const j = requireHost();
      if (!j) return ack({ ok: false, error: '需要主持人权限' });
      const { room } = j;
      if ('password' in patch) setPassword(room.roomId, patch.password);
      updateRoom(room.roomId, patch);
      const s = publicSettings(room.roomId);
      io.to(room.roomId).emit('room-settings', s);
      // 关掉等候室时，把还在门外等的人一次性全放进来
      if (patch.waitingRoom === false && room.waiting.size) {
        admitWaiting(io, room, [...room.waiting.values()]);
      }
      ack({ ok: true, settings: s });
    });

    // ---------- WebRTC 信令 ----------

    socket.on('signal', ({ to, data } = {}) => {
      if (!joined || !to) return;
      const target = [...joined.room.peers.values()].find((p) => p.peerId === to);
      if (!target) return;
      io.to(target.socketId).emit('signal', { from: joined.peer.peerId, data });
    });

    socket.on('state', (patch = {}) => {
      if (!joined) return;
      const { peer, room } = joined;
      for (const k of ['muted', 'videoOn', 'sharing', 'handRaised', 'recording']) {
        if (k in patch) peer[k] = Boolean(patch[k]);
      }
      io.to(room.roomId).emit('peer-state', { peerId: peer.peerId, patch: publicPeer(peer) });
    });

    socket.on('chat', ({ text } = {}) => {
      if (!joined || !text) return;
      const msg = {
        t: Date.now(),
        peerId: joined.peer.peerId,
        name: joined.peer.name,
        text: String(text).slice(0, 4000),
      };
      io.to(joined.room.roomId).emit('chat', msg);
      updateMeeting(joined.room.meetingId, (m) => {
        m.chat.push(msg);
        return m;
      });
    });

    socket.on('caption', ({ text, final } = {}) => {
      if (!joined || !text) return;
      io.to(joined.room.roomId).emit('caption', {
        peerId: joined.peer.peerId,
        name: joined.peer.name,
        text: String(text).slice(0, 500),
        final: Boolean(final),
        t: Date.now(),
      });
    });

    socket.on('rec-control', ({ on } = {}) => {
      if (!joined) return;
      io.to(joined.room.roomId).emit('rec-control', {
        on: Boolean(on),
        by: joined.peer.name,
        meetingId: joined.room.meetingId,
      });
      updateMeeting(joined.room.meetingId, (m) => {
        m.chat.push({ t: Date.now(), system: true, text: `${joined.peer.name} ${on ? '开始' : '停止'}了录制` });
        return m;
      });
    });

    socket.on('request-mute', ({ peerId } = {}) => {
      if (!joined) return;
      const target = [...joined.room.peers.values()].find((p) => p.peerId === peerId);
      if (target) io.to(target.socketId).emit('force-mute', { by: joined.peer.name });
    });

    const cleanup = () => {
      // 还在等候室里就断开的情况
      for (const room of rooms.values()) {
        const w = room.waiting.get(socket.id);
        if (w) {
          clearTimeout(w.timer);
          room.waiting.delete(socket.id);
          notifyHostOfWaiting(io, room);
        }
      }

      if (!joined) return;
      const { room, peer } = joined;
      room.peers.delete(socket.id);
      socket.to(room.roomId).emit('peer-left', { peerId: peer.peerId });
      updateMeeting(room.meetingId, (m) => {
        if (m.participants[peer.peerId]) m.participants[peer.peerId].leftAt = Date.now();
        m.chat.push({ t: Date.now(), system: true, text: `${peer.name} 离开了会议` });
        return m;
      });
      if (peer.isHost) reassignHost(io, room);

      // 主持人走了、房间也空了，但还有人在等候室干等 —— 直接放他们进来，
      // 否则这些人会一直等到超时，而永远不会有人来放行
      if (room.waiting.size && ![...room.peers.values()].some((p) => p.isHost)) {
        admitWaiting(io, room, [...room.waiting.values()]);
      }

      scheduleEnd(room);
      joined = null;
    };

    socket.on('leave', cleanup);
    socket.on('disconnect', cleanup);
  });

  return io;
}

export function activeRooms() {
  return [...rooms.values()].map((r) => ({
    ...roomSnapshot(r),
    waitingCount: r.waiting.size,
  }));
}

export function meetingIdForRoom(roomId) {
  return rooms.get(safeRoomId(roomId))?.meetingId || null;
}
