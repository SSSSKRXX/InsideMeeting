import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { config, iceServers } from './config.js';
import { ensureMeeting, updateMeeting } from './store.js';
import { endLive, liveState } from './live.js';

/** roomId -> { meetingId, startedAt, peers: Map<socketId, Peer>, endTimer } */
const rooms = new Map();

const MEETING_GRACE_MS = 2 * 60 * 1000; // 全员离开 2 分钟后才判定会议结束

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeRoomId(raw) {
  return String(raw || '').trim().replace(/[^\w一-龥-]/g, '').slice(0, 40);
}

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    const startedAt = Date.now();
    const meetingId = `${roomId}_${stamp(new Date(startedAt))}`;
    room = { roomId, meetingId, startedAt, peers: new Map(), endTimer: null };
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
  };
}

function roomSnapshot(room) {
  return {
    roomId: room.roomId,
    meetingId: room.meetingId,
    startedAt: room.startedAt,
    peers: [...room.peers.values()].map(publicPeer),
  };
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

    socket.on('join', (payload = {}, ack = () => {}) => {
      const roomId = safeRoomId(payload.roomId);
      const name = String(payload.name || '').trim().slice(0, 24) || '匿名';

      if (!roomId) return ack({ ok: false, error: '房间号无效' });
      if (config.joinPassword && payload.password !== config.joinPassword) {
        return ack({ ok: false, error: '入会口令错误' });
      }

      const room = getRoom(roomId);
      const peer = {
        peerId: randomUUID().slice(0, 8),
        socketId: socket.id,
        name,
        muted: Boolean(payload.muted),
        videoOn: Boolean(payload.videoOn),
        sharing: false,
        handRaised: false,
        recording: false,
        joinedAt: Date.now(),
      };
      room.peers.set(socket.id, peer);
      socket.join(roomId);
      joined = { room, peer };

      updateMeeting(room.meetingId, (m) => {
        m.participants[peer.peerId] = { name: peer.name, joinedAt: peer.joinedAt, leftAt: null };
        return m;
      });

      // 已在房间里的人：由「后进来的人」发起 offer，避免双方同时 offer
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
        // 中途加入的人立刻拿到前面已经聊过的实时纪要，不用问"刚才说到哪了"
        live: liveState(room.meetingId),
      });

      socket.to(roomId).emit('peer-joined', { peer: publicPeer(peer) });
      updateMeeting(room.meetingId, (m) => {
        m.chat.push({ t: Date.now(), system: true, text: `${peer.name} 加入了会议` });
        return m;
      });
    });

    // WebRTC 信令中转（offer / answer / candidate 原样透传）
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

    // 实时字幕（前端浏览器本地识别的结果，广播给所有人）
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

    // 录制开关：任何人点「开始录制」，全房间同步开始录各自的音轨
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

    // 主持人操作：请求某人静音
    socket.on('request-mute', ({ peerId } = {}) => {
      if (!joined) return;
      const target = [...joined.room.peers.values()].find((p) => p.peerId === peerId);
      if (target) io.to(target.socketId).emit('force-mute', { by: joined.peer.name });
    });

    const cleanup = () => {
      if (!joined) return;
      const { room, peer } = joined;
      room.peers.delete(socket.id);
      socket.to(room.roomId).emit('peer-left', { peerId: peer.peerId });
      updateMeeting(room.meetingId, (m) => {
        if (m.participants[peer.peerId]) m.participants[peer.peerId].leftAt = Date.now();
        m.chat.push({ t: Date.now(), system: true, text: `${peer.name} 离开了会议` });
        return m;
      });
      scheduleEnd(room);
      joined = null;
    };

    socket.on('leave', cleanup);
    socket.on('disconnect', cleanup);
  });

  return io;
}

export function activeRooms() {
  return [...rooms.values()].map(roomSnapshot);
}

export function meetingIdForRoom(roomId) {
  return rooms.get(safeRoomId(roomId))?.meetingId || null;
}
