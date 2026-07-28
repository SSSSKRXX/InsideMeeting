import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { Mesh, createLevelMeter } from '../lib/mesh.js';
import { TrackRecorder, LiveChunker, createLiveCaption, screenShareSupported } from '../lib/recorder.js';
import { renderMarkdown } from '../lib/md.js';
import { MicProcessor } from '../lib/audio.js';
import { BackgroundProcessor, backgroundSupported } from '../lib/video.js';

const SPEAK_THRESHOLD = 0.1;
const SPEAKER_HOLD_MS = 2000; // 说话人切换的迟滞，避免画面来回跳

function Video({ stream, muted, mirror, className, label, contain }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream || null;
  }, [stream]);
  const hasVideo = stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
  return (
    <div className={`video-wrap ${className || ''}`}>
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        className={`${mirror ? 'mirror' : ''} ${contain ? 'contain' : ''}`}
        style={{ opacity: hasVideo ? 1 : 0 }}
      />
      {!hasVideo && <div className="avatar">{(label || '?').slice(0, 1)}</div>}
    </div>
  );
}

function RemoteAudio({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline style={{ display: 'none' }} />;
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`;
}

const clock = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5);

export default function Room({ roomId, name, password, prefs, serverConfig, onLeave, onArchive }) {
  const [status, setStatus] = useState('连接中…');
  const [self, setSelf] = useState(null);
  const [meetingId, setMeetingId] = useState(null);
  const [peers, setPeers] = useState([]);
  const [tick, forceRender] = useState(0);

  const [muted, setMuted] = useState(!prefs.micOn);
  const [camOn, setCamOn] = useState(Boolean(prefs.camOn));
  const [sharing, setSharing] = useState(false);
  const [localScreen, setLocalScreen] = useState(null);
  const [handRaised, setHandRaised] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recStats, setRecStats] = useState({ bytes: 0, pending: 0, seg: 0 });

  const [liveOn, setLiveOn] = useState(false);
  const [liveSummary, setLiveSummary] = useState({ text: '', at: 0 });
  const [liveLines, setLiveLines] = useState([]);
  const [liveErr, setLiveErr] = useState('');

  const [chat, setChat] = useState([]);
  const [captions, setCaptions] = useState([]);
  const [captionOn, setCaptionOn] = useState(false);
  const [sidebar, setSidebar] = useState('live');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  const [levels, setLevels] = useState({});
  const [activeSpeaker, setActiveSpeaker] = useState(null);
  const [layout, setLayout] = useState('auto'); // auto | gallery | speaker
  const [pinned, setPinned] = useState(null);

  const [startedAt, setStartedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [toast, setToast] = useState('');

  // 主持人 / 等候室
  const [isHost, setIsHost] = useState(false);
  const [waitingList, setWaitingList] = useState([]);
  const [roomSettings, setRoomSettings] = useState({ hasPassword: false, waitingRoom: false, locked: false });
  const [gate, setGate] = useState(null); // { state:'waiting'|'denied'|'kicked'|'timeout', text }

  // 音视频增强
  const [denoise, setDenoise] = useState(false);
  const [bgMode, setBgMode] = useState('off');
  const [bgBusy, setBgBusy] = useState(false);

  const socketRef = useRef(null);
  const meshRef = useRef(null);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const recordersRef = useRef({});
  const liveRef = useRef(null);
  const captionStopRef = useRef(null);
  const meetingIdRef = useRef(null);
  const selfRef = useRef(null);
  const speakerHoldRef = useRef({ id: null, at: 0 });
  const levelsSelfRef = useRef(0);
  const micProcRef = useRef(null);
  const bgProcRef = useRef(null);
  const rawCamTrackRef = useRef(null);

  const hostTokenKey = `im.host.${roomId}`;

  const isMobile = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches,
    []
  );
  const canShare = screenShareSupported();
  const liveAvailable = Boolean(serverConfig.live?.enabled);

  const rerender = useCallback(() => forceRender((n) => n + 1), []);
  const flash = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // 音量轮询 → 当前说话人。放在定时器里而不是每帧 setState，避免渲染风暴。
  useEffect(() => {
    const t = setInterval(() => {
      const remote = meshRef.current?.levels() || {};
      const all = { ...remote, self: levelsSelfRef.current };
      setLevels(all);

      let best = null;
      let bestV = SPEAK_THRESHOLD;
      for (const [id, v] of Object.entries(all)) {
        if (v > bestV) {
          bestV = v;
          best = id;
        }
      }
      const hold = speakerHoldRef.current;
      if (best && best !== hold.id) {
        hold.id = best;
        hold.at = Date.now();
        setActiveSpeaker(best);
      } else if (!best && hold.id && Date.now() - hold.at > SPEAKER_HOLD_MS) {
        // 没人说话时保留最后一位，画面不至于空掉
      }
    }, 250);
    return () => clearInterval(t);
  }, []);

  // ---------- 建立连接 ----------
  useEffect(() => {
    let disposed = false;
    const socket = io({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    (async () => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: prefs.micId ? { exact: prefs.micId } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: prefs.camOn
            ? {
                deviceId: prefs.camId ? { exact: prefs.camId } : undefined,
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 24 },
                facingMode: 'user',
              }
            : false,
        });
      } catch (e) {
        setStatus(`无法获取麦克风：${e.message}`);
        return;
      }
      if (disposed) return stream.getTracks().forEach((t) => t.stop());

      localStreamRef.current = stream;
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = Boolean(prefs.micOn);
      rawCamTrackRef.current = stream.getVideoTracks()[0] || null;

      // 麦克风统一走处理链。即使降噪关着也走，
      // 这样开关降噪时输出轨不变，不用重新协商、也不打断录制。
      const proc = new MicProcessor(stream);
      micProcRef.current = proc;
      if (prefs.denoise) {
        proc.setEnabled(true);
        setDenoise(true);
      }

      createLevelMeter(stream, (v) => {
        levelsSelfRef.current = v;
      });

      const mesh = new Mesh({ socket, iceServers: serverConfig.iceServers, onUpdate: rerender });
      meshRef.current = mesh;
      mesh.setLocalTrack('mic', proc.track || audioTrack || null);
      mesh.setLocalTrack('cam', rawCamTrackRef.current);

      const applyJoined = (res) => {
        setSelf(res.self);
        selfRef.current = res.self;
        setIsHost(Boolean(res.self.isHost));
        setMeetingId(res.room.meetingId);
        meetingIdRef.current = res.room.meetingId;
        setStartedAt(res.room.startedAt);
        setPeers(res.room.peers.filter((p) => p.peerId !== res.self.peerId));
        if (res.room.settings) setRoomSettings(res.room.settings);
        if (res.waiting) setWaitingList(res.waiting);
        if (res.hostToken) localStorage.setItem(hostTokenKey, res.hostToken);
        setStatus('');
        setGate(null);
        for (const id of res.initiateTo) mesh.connect(id);

        // 中途加入也能立刻看到前面聊了什么
        if (res.live) {
          if (res.live.summary) setLiveSummary({ text: res.live.summary, at: res.live.summaryAt });
          if (res.live.utterances?.length) {
            setLiveLines(res.live.utterances.map((u) => ({ ...u, t: u.absStart || u.t })));
          }
        }
        if (serverConfig.live?.enabled) startLive(res.room.meetingId, res.self.peerId);
      };

      // 被主持人放行后走这条路
      socket.on('admitted', applyJoined);

      socket.emit(
        'join',
        {
          roomId,
          name,
          password,
          globalPassword: password,
          hostToken: localStorage.getItem(hostTokenKey) || undefined,
          muted: !prefs.micOn,
          videoOn: Boolean(prefs.camOn),
        },
        (res) => {
          if (res?.waiting) {
            setGate({ state: 'waiting', text: res.error, hostName: res.hostName });
            return;
          }
          if (!res?.ok) {
            // 密码错了就把可能过期的主持人令牌清掉，避免一直用错的重试
            if (res?.reason === 'room-password') localStorage.removeItem(hostTokenKey);
            return setStatus(res?.error || '加入失败');
          }
          applyJoined(res);
        }
      );
    })();

    socket.on('peer-joined', ({ peer }) => {
      setPeers((ps) => (ps.some((p) => p.peerId === peer.peerId) ? ps : [...ps, peer]));
      flash(`${peer.name} 加入了会议`);
    });
    socket.on('peer-left', ({ peerId }) => {
      setPeers((ps) => ps.filter((p) => p.peerId !== peerId));
      meshRef.current?.close(peerId);
    });
    socket.on('peer-state', ({ peerId, patch }) => {
      setPeers((ps) => ps.map((p) => (p.peerId === peerId ? { ...p, ...patch } : p)));
    });
    socket.on('chat', (msg) => {
      setChat((c) => [...c, msg]);
      setUnread((u) => (msg.peerId === selfRef.current?.peerId ? u : u + 1));
    });
    socket.on('caption', (c) => {
      setCaptions((list) => {
        const next = [...list];
        const last = next[next.length - 1];
        if (last && last.peerId === c.peerId && !last.final) next[next.length - 1] = c;
        else next.push(c);
        return next.slice(-60);
      });
    });
    socket.on('live-transcript', ({ added }) => {
      setLiveLines((l) => [...l, ...added].slice(-300));
    });
    socket.on('live-summary', ({ summary, at }) => {
      setLiveSummary({ text: summary, at });
      setLiveErr('');
    });
    socket.on('live-error', ({ error }) => setLiveErr(error));
    socket.on('force-mute', ({ by }) => {
      toggleMic(true);
      flash(`${by} 请求你静音`);
    });
    socket.on('rec-control', ({ on, by, meetingId: mid }) => {
      meetingIdRef.current = mid || meetingIdRef.current;
      flash(`${by} ${on ? '开始' : '停止'}了会议录制`);
      if (on) startMyRecording(mid);
      else stopMyRecording();
    });
    socket.on('waiting-list', ({ list }) => setWaitingList(list || []));
    socket.on('room-settings', (s) => setRoomSettings(s));
    socket.on('host-granted', ({ token, reason }) => {
      if (token) localStorage.setItem(hostTokenKey, token);
      setIsHost(true);
      flash(`你现在是主持人（${reason}）`);
    });
    socket.on('op-denied', ({ error }) => flash(error));
    socket.on('denied', ({ error }) => setGate({ state: 'denied', text: error }));
    socket.on('waiting-timeout', () =>
      setGate({ state: 'timeout', text: '等待超时，主持人一直没有响应。可以稍后重试或直接联系他。' })
    );
    socket.on('kicked', ({ by }) => setGate({ state: 'kicked', text: `${by} 把你移出了会议` }));

    socket.on('disconnect', () => setStatus('与服务器断开，正在重连…'));
    socket.on('connect', () => setStatus(''));

    return () => {
      disposed = true;
      captionStopRef.current?.();
      liveRef.current?.stop();
      micProcRef.current?.destroy();
      bgProcRef.current?.destroy();
      Object.values(recordersRef.current).forEach((r) => r.stop());
      meshRef.current?.destroy();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      socket.emit('leave');
      socket.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 控制 ----------

  const toggleMic = (forceMute) => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    const next = forceMute === true ? true : !muted;
    track.enabled = !next;
    setMuted(next);
    socketRef.current?.emit('state', { muted: next });
  };

  const toggleCam = async () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    if (camOn) {
      // 摄像头关掉后虚拟背景的输入源就没了，直接销毁，下次开再重建
      bgProcRef.current?.destroy();
      bgProcRef.current = null;
      setBgMode('off');
      stream.getVideoTracks().forEach((t) => {
        t.stop();
        stream.removeTrack(t);
      });
      rawCamTrackRef.current = null;
      meshRef.current?.setLocalTrack('cam', null);
      setCamOn(false);
      socketRef.current?.emit('state', { videoOn: false });
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: prefs.camId ? { exact: prefs.camId } : undefined,
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'user',
          },
        });
        const track = s.getVideoTracks()[0];
        stream.addTrack(track);
        rawCamTrackRef.current = track;
        meshRef.current?.setLocalTrack('cam', track);
        setCamOn(true);
        socketRef.current?.emit('state', { videoOn: true });
      } catch (e) {
        flash(`打开摄像头失败：${e.message}`);
      }
    }
  };

  const toggleShare = async () => {
    if (sharing) {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      setLocalScreen(null);
      meshRef.current?.setLocalTrack('screen', null);
      recordersRef.current.screen?.stop();
      delete recordersRef.current.screen;
      setSharing(false);
      socketRef.current?.emit('state', { sharing: false });
      return;
    }
    if (!canShare) return flash('当前设备不支持屏幕共享（手机浏览器普遍不支持）');
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15, width: 1920, height: 1080 },
        audio: true,
      });
      screenStreamRef.current = s;
      const track = s.getVideoTracks()[0];
      track.onended = () => toggleShare();
      meshRef.current?.setLocalTrack('screen', track);
      setLocalScreen(new MediaStream([track]));
      setSharing(true);
      socketRef.current?.emit('state', { sharing: true });
      if (recording && meetingIdRef.current) startScreenRecorder(meetingIdRef.current, s);
    } catch {
      /* 用户取消 */
    }
  };

  const toggleHand = () => {
    const next = !handRaised;
    setHandRaised(next);
    socketRef.current?.emit('state', { handRaised: next });
  };

  // ---------- 实时纪要 ----------

  /** 录制和实时转写都用处理后的音轨（降噪对识别准确率有帮助） */
  const micStream = () => {
    const proc = micProcRef.current;
    if (proc?.ok && proc.track) return new MediaStream([proc.track]);
    return new MediaStream(localStreamRef.current?.getAudioTracks() || []);
  };

  const startLive = (mid, peerId) => {
    if (liveRef.current) return;
    const stream = localStreamRef.current;
    if (!stream || !mid) return;
    const chunker = new LiveChunker({
      meetingId: mid,
      roomId,
      peerId: peerId || selfRef.current?.peerId,
      name,
      stream: micStream(),
      chunkSeconds: serverConfig.live?.chunkSeconds || 15,
    });
    liveRef.current = chunker;
    chunker.start();
    setLiveOn(true);
  };

  const toggleLive = () => {
    if (liveOn) {
      liveRef.current?.stop();
      liveRef.current = null;
      setLiveOn(false);
      flash('已停止实时纪要（会后仍可生成完整纪要）');
    } else {
      startLive(meetingIdRef.current, selfRef.current?.peerId);
      flash('实时纪要已开启');
    }
  };

  const refreshSummary = async () => {
    if (!meetingIdRef.current) return;
    flash('正在刷新摘要…');
    await fetch(`/api/live/${meetingIdRef.current}/summarize`, { method: 'POST' }).catch(() => {});
  };

  // ---------- 录制 ----------

  const startScreenRecorder = (mid, stream) => {
    if (recordersRef.current.screen) return;
    const rec = new TrackRecorder({
      meetingId: mid,
      roomId,
      peerId: selfRef.current.peerId,
      name,
      kind: 'screen',
      stream,
      segmentMinutes: serverConfig.settings?.segmentMinutes || 60,
      chunkSeconds: serverConfig.settings?.chunkSeconds || 5,
    });
    recordersRef.current.screen = rec;
    rec.start();
  };

  const startMyRecording = (mid) => {
    const meeting = mid || meetingIdRef.current;
    const stream = localStreamRef.current;
    if (!meeting || !stream || !selfRef.current || recordersRef.current.mic) return;

    const micOnly = micStream();
    const rec = new TrackRecorder({
      meetingId: meeting,
      roomId,
      peerId: selfRef.current.peerId,
      name,
      kind: 'mic',
      stream: micOnly,
      segmentMinutes: serverConfig.settings?.segmentMinutes || 60,
      chunkSeconds: serverConfig.settings?.chunkSeconds || 5,
      onEvent: (e) => {
        if (e.type === 'progress') setRecStats((s) => ({ ...s, bytes: e.bytes, pending: e.pending }));
        if (e.type === 'rotate') {
          setRecStats((s) => ({ ...s, seg: e.seg }));
          flash(`录制文件已切分，开始第 ${e.seg + 1} 段`);
        }
        if (e.type === 'retry') setRecStats((s) => ({ ...s, pending: e.pending }));
      },
    });
    recordersRef.current.mic = rec;
    rec.start();
    setRecording(true);
    socketRef.current?.emit('state', { recording: true });
    if (screenStreamRef.current) startScreenRecorder(meeting, screenStreamRef.current);
  };

  const stopMyRecording = async () => {
    const recs = Object.values(recordersRef.current);
    if (!recs.length) return;
    recordersRef.current = {};
    setRecording(false);
    socketRef.current?.emit('state', { recording: false });
    await Promise.all(recs.map((r) => r.stop()));
    flash('录制已停止，文件已保存到服务器');
  };

  const toggleRecording = () => socketRef.current?.emit('rec-control', { on: !recording });

  // ---------- 音视频增强 ----------

  const toggleDenoise = () => {
    const proc = micProcRef.current;
    if (!proc?.ok) return flash('当前浏览器不支持音频处理');
    proc.resume();
    const next = !denoise;
    proc.setEnabled(next);
    setDenoise(next);
    flash(next ? '增强降噪已开启' : '增强降噪已关闭');
  };

  /** 切换虚拟背景。第一次开启时才创建处理器并换一次轨，之后切模式不再动轨。 */
  const changeBackground = async (mode) => {
    if (!backgroundSupported()) return flash('当前浏览器不支持虚拟背景');
    if (!camOn) return flash('请先打开摄像头');
    setBgBusy(true);
    try {
      if (!bgProcRef.current) {
        const raw = rawCamTrackRef.current || localStreamRef.current?.getVideoTracks()[0];
        if (!raw) return flash('没有可用的摄像头画面');
        bgProcRef.current = new BackgroundProcessor(raw);
        // 换成处理后的轨。只在第一次启用时发生一次。
        meshRef.current?.setLocalTrack('cam', bgProcRef.current.track);
      }
      const r = await bgProcRef.current.setMode(mode);
      if (!r.ok) {
        setBgMode('off');
        return flash(r.error || '虚拟背景启用失败');
      }
      setBgMode(mode);
      flash(mode === 'off' ? '已关闭虚拟背景' : mode === 'blur' ? '背景模糊已开启' : '背景图片已开启');
    } finally {
      setBgBusy(false);
    }
  };

  const pickBackgroundImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      if (!bgProcRef.current) await changeBackground('blur');
      await bgProcRef.current?.setImage(url);
      await changeBackground('image');
    };
    input.click();
  };

  // ---------- 主持人操作 ----------

  const updateRoomSettings = (patch) =>
    new Promise((resolve) => {
      socketRef.current?.emit('room-settings', patch, (r) => {
        if (r?.ok) setRoomSettings(r.settings);
        else flash(r?.error || '设置失败');
        resolve(r);
      });
    });

  const toggleCaption = () => {
    if (captionOn) {
      captionStopRef.current?.();
      captionStopRef.current = null;
      setCaptionOn(false);
      return;
    }
    const stop = createLiveCaption({
      onResult: ({ text, final }) => socketRef.current?.emit('caption', { text, final }),
    });
    if (!stop) return flash('当前浏览器不支持实时字幕（建议使用 Chrome / Edge）');
    captionStopRef.current = stop;
    setCaptionOn(true);
  };

  // ---------- 画面编排 ----------

  const sharingPeer = peers.find((p) => p.sharing);
  const screenStream = sharing ? localScreen : sharingPeer ? meshRef.current?.getRemote(sharingPeer.peerId).screen : null;
  const someoneSharing = Boolean(sharing || sharingPeer);

  const tiles = useMemo(() => {
    return [
      {
        id: 'self',
        name: `${name}（我）`,
        stream: localStreamRef.current,
        muted: true,
        mirror: true,
        isMuted: muted,
        hand: handRaised,
      },
      ...peers.map((p) => ({
        id: p.peerId,
        name: p.name,
        stream: meshRef.current?.getRemote(p.peerId).cam,
        audioStream: meshRef.current?.getRemote(p.peerId).mic,
        muted: false,
        isMuted: p.muted,
        hand: p.handRaised,
        sharing: p.sharing,
        state: meshRef.current?.getRemote(p.peerId).state,
      })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peers, muted, handRaised, camOn, tick]);

  // 决定当前用哪种布局：
  //   有人共享 → 共享画面占主位（这是 auto 模式的第一优先级）
  //   否则 speaker 模式 → 当前说话人占主位
  //   否则 → 画廊
  const effectiveLayout =
    layout === 'gallery' ? 'gallery' : someoneSharing ? 'share' : layout === 'speaker' ? 'speaker' : 'gallery';

  const focusId = pinned || activeSpeaker || tiles[1]?.id || 'self';
  const focusTile = tiles.find((t) => t.id === focusId) || tiles[0];
  const cols = tiles.length <= 1 ? 1 : tiles.length <= 4 ? 2 : tiles.length <= 9 ? 3 : 4;

  // 等候室 / 被拒 / 被踢：都不进会议界面
  if (gate) {
    const title = {
      waiting: '正在等待主持人允许',
      denied: '主持人拒绝了你的加入请求',
      kicked: '你已被移出会议',
      timeout: '等待超时',
    }[gate.state];
    return (
      <div className="boot gate">
        {gate.state === 'waiting' && <div className="spinner" />}
        <h3>{title}</h3>
        <p className="muted">{gate.text}</p>
        {gate.state === 'waiting' && gate.hostName && <p className="muted">主持人：{gate.hostName}</p>}
        {gate.state === 'waiting' && (
          <p className="hint">保持这个页面开着，主持人点了允许你就会自动进入会议。</p>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          {gate.state !== 'waiting' && (
            <button className="primary" onClick={() => window.location.reload()}>
              重试
            </button>
          )}
          <button className="ghost" onClick={onLeave}>
            返回
          </button>
        </div>
      </div>
    );
  }

  if (status && !self) {
    return (
      <div className="boot">
        <p>{status}</p>
        <button className="primary" onClick={onLeave}>
          返回
        </button>
      </div>
    );
  }

  const sidebarBody = (
    <>
      <nav className="tabs">
        <button className={sidebar === 'live' ? 'on' : ''} onClick={() => setSidebar('live')}>
          实时纪要
        </button>
        <button className={sidebar === 'people' ? 'on' : ''} onClick={() => setSidebar('people')}>
          成员 {tiles.length}
        </button>
        <button
          className={sidebar === 'chat' ? 'on' : ''}
          onClick={() => {
            setSidebar('chat');
            setUnread(0);
          }}
        >
          聊天 {unread > 0 && <em>{unread}</em>}
        </button>
        <button className={sidebar === 'settings' ? 'on' : ''} onClick={() => setSidebar('settings')}>
          设置 {isHost && waitingList.length > 0 && <em>{waitingList.length}</em>}
        </button>
      </nav>

      {sidebar === 'settings' && (
        <div className="panel">
          {isHost && (
            <>
              <div className="sec-title">
                主持人
                {waitingList.length > 0 && <span className="badge">{waitingList.length} 人等候中</span>}
              </div>

              {waitingList.length > 0 && (
                <div className="waiting-box">
                  {waitingList.map((w) => (
                    <div className="person" key={w.peerId}>
                      <span className="pname">{w.name}</span>
                      <button className="link" onClick={() => socketRef.current?.emit('admit-peer', { peerId: w.peerId })}>
                        允许
                      </button>
                      <button className="link danger" onClick={() => socketRef.current?.emit('deny-peer', { peerId: w.peerId })}>
                        拒绝
                      </button>
                    </div>
                  ))}
                  <button className="chip" onClick={() => socketRef.current?.emit('admit-peer', { all: true })}>
                    全部允许
                  </button>
                </div>
              )}

              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={roomSettings.waitingRoom}
                  onChange={(e) => updateRoomSettings({ waitingRoom: e.target.checked })}
                />
                <span>启用等候室<i>新人需要你点允许才能进</i></span>
              </label>

              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={roomSettings.locked}
                  onChange={(e) => updateRoomSettings({ locked: e.target.checked })}
                />
                <span>锁定会议<i>任何人都无法再加入</i></span>
              </label>

              <div className="switch-row">
                <span>
                  房间密码<i>{roomSettings.hasPassword ? '已设置' : '未设置'}</i>
                </span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="link"
                    onClick={() => {
                      const pw = prompt('设置房间密码（留空则取消密码）', '');
                      if (pw !== null) updateRoomSettings({ password: pw });
                    }}
                  >
                    修改
                  </button>
                </span>
              </div>
              <hr />
            </>
          )}

          <div className="sec-title">画面与声音</div>

          <label className="switch-row">
            <input type="checkbox" checked={denoise} onChange={toggleDenoise} />
            <span>增强降噪<i>压掉空调声和说话间隙的底噪</i></span>
          </label>

          <div className="switch-row col">
            <span>
              虚拟背景<i>{bgBusy ? '正在加载模型…' : '需要摄像头开启'}</i>
            </span>
            <div className="seg">
              {[
                ['off', '关闭'],
                ['blur', '模糊'],
              ].map(([k, label]) => (
                <button key={k} className={bgMode === k ? 'on' : ''} disabled={bgBusy} onClick={() => changeBackground(k)}>
                  {label}
                </button>
              ))}
              <button className={bgMode === 'image' ? 'on' : ''} disabled={bgBusy} onClick={pickBackgroundImage}>
                选图片
              </button>
            </div>
          </div>

          <hr />
          <div className="sec-title">会议</div>
          <div className="switch-row">
            <span>
              房间号<i>{roomId}</i>
            </span>
            <button className="link" onClick={() => navigator.clipboard?.writeText(window.location.href)}>
              复制链接
            </button>
          </div>
          <p className="hint">
            {isHost ? '你是本场会议的主持人。' : `主持人：${roomSettings.hostName || '—'}`}
            {roomSettings.hasPassword && ' 本房间已设密码。'}
          </p>
        </div>
      )}

      {sidebar === 'live' && (
        <div className="panel live">
          <div className="live-head">
            <button className={liveOn ? 'chip on' : 'chip'} onClick={toggleLive} disabled={!liveAvailable}>
              {liveOn ? '实时纪要运行中' : '开启实时纪要'}
            </button>
            <button className="link" onClick={refreshSummary} disabled={!liveOn}>
              立即刷新
            </button>
          </div>

          {!liveAvailable && <p className="hint">服务端未配置转写服务，实时纪要不可用。</p>}
          {liveErr && <div className="error">{liveErr}</div>}

          {liveSummary.text ? (
            <div className="live-summary">
              <div className="live-summary-meta">摘要更新于 {clock(liveSummary.at)}</div>
              <div className="doc" dangerouslySetInnerHTML={{ __html: renderMarkdown(liveSummary.text) }} />
            </div>
          ) : (
            liveOn && <p className="hint">正在积累发言内容，约 1 分钟后出现第一版摘要。</p>
          )}

          <details className="live-raw" open={!liveSummary.text}>
            <summary>实时逐字流（{liveLines.length}）</summary>
            <div className="captions">
              {liveLines.slice(-80).map((u, i) => (
                <div className="cap" key={i}>
                  <span className="ts">{clock(u.t)}</span> <b className="mention">@{u.speaker}</b> {u.text}
                </div>
              ))}
              {!liveLines.length && <p className="hint">还没有识别到发言。</p>}
            </div>
          </details>
        </div>
      )}

      {sidebar === 'people' && (
        <div className="panel">
          {tiles.map((t) => (
            <div className="person" key={t.id}>
              <span className="dot" style={{ opacity: (levels[t.id] || 0) > SPEAK_THRESHOLD ? 1 : 0.25 }} />
              <span className="pname">{t.name}</span>
              {t.sharing && <span className="muted">共享中</span>}
              {t.isMuted && <span className="muted">静音</span>}
              {t.id !== 'self' && (
                <button className="link" onClick={() => socketRef.current?.emit('request-mute', { peerId: t.id })}>
                  请他静音
                </button>
              )}
              {isHost && t.id !== 'self' && (
                <button className="link danger" onClick={() => {
                  if (confirm(`确定把 ${t.name} 移出会议？`)) socketRef.current?.emit('kick-peer', { peerId: t.id });
                }}>
                  移出
                </button>
              )}
            </div>
          ))}
          <hr />
          <button className={captionOn ? 'chip on' : 'chip'} onClick={toggleCaption}>
            {captionOn ? '关闭我的浏览器字幕' : '开启我的浏览器字幕'}
          </button>
          <div className="captions">
            {captions.slice(-20).map((c, i) => (
              <div key={i} className={c.final ? 'cap' : 'cap interim'}>
                <b>@{c.name}</b> {c.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {sidebar === 'chat' && <ChatPanel chat={chat} onSend={(text) => socketRef.current?.emit('chat', { text })} />}
    </>
  );

  return (
    <div className={`room ${isMobile ? 'mobile' : ''}`}>
      <header className="room-head">
        <div className="room-title">
          <strong>{roomId}</strong>
          <span className="muted">{fmtElapsed(now - startedAt)}</span>
          {recording && (
            <span className="rec-dot" title={`已上传 ${(recStats.bytes / 1048576).toFixed(1)} MB，待传 ${recStats.pending} 片`}>
              ● 录制中 第 {recStats.seg + 1} 段
            </span>
          )}
          {liveOn && <span className="live-dot">实时纪要</span>}
          {isHost && <span className="host-tag">主持人</span>}
          {roomSettings.locked && <span className="muted">已锁定</span>}
          {isHost && waitingList.length > 0 && (
            <button className="wait-alert" onClick={() => { setSidebar('settings'); setSidebarOpen(true); }}>
              {waitingList.length} 人等待加入
            </button>
          )}
        </div>
        <div className="room-head-right">
          {status && <span className="warn-inline">{status}</span>}
          <div className="layout-switch">
            {[
              ['auto', '自动'],
              ['gallery', '画廊'],
              ['speaker', '演讲者'],
            ].map(([k, label]) => (
              <button key={k} className={layout === k ? 'on' : ''} onClick={() => setLayout(k)}>
                {label}
              </button>
            ))}
          </div>
          <span className="muted hide-sm">{tiles.length} 人</span>
        </div>
      </header>

      <div className="room-body">
        <main className={`stage layout-${effectiveLayout}`}>
          {effectiveLayout === 'share' && (
            <div className="focus">
              <Video stream={screenStream} muted contain label="屏幕" />
              <div className="focus-label">{sharing ? '你正在共享屏幕' : `${sharingPeer?.name} 正在共享屏幕`}</div>
            </div>
          )}

          {effectiveLayout === 'speaker' && focusTile && (
            <div className="focus">
              <Video stream={focusTile.stream} muted={focusTile.muted} mirror={focusTile.mirror} label={focusTile.name} />
              <div className="focus-label">
                {focusTile.name}
                {pinned ? '（已固定）' : ' · 当前发言'}
              </div>
            </div>
          )}

          <div
            className={effectiveLayout === 'gallery' ? 'grid' : 'grid filmstrip'}
            style={effectiveLayout === 'gallery' ? { '--cols': cols } : undefined}
          >
            {tiles.map((t) => (
              <div
                key={t.id}
                className={`tile ${pinned === t.id ? 'pinned' : ''} ${(levels[t.id] || 0) > SPEAK_THRESHOLD ? 'speaking' : ''}`}
                onDoubleClick={() => setPinned(pinned === t.id ? null : t.id)}
                title="双击固定/取消固定"
              >
                <Video stream={t.stream} muted={t.muted} mirror={t.mirror} label={t.name} />
                {t.audioStream && <RemoteAudio stream={t.audioStream} />}
                <div className="tile-bar">
                  <span className="tname">{t.name}</span>
                  <span className="tile-icons">
                    {t.sharing && <b title="正在共享">🖥</b>}
                    {t.hand && <b title="举手">✋</b>}
                    {t.isMuted && <b title="已静音">🔇</b>}
                    {t.state && t.state !== 'connected' && <i className="muted">{t.state}</i>}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </main>

        {!isMobile && <aside className="sidebar">{sidebarBody}</aside>}
      </div>

      {isMobile && sidebarOpen && (
        <div className="sheet">
          <div className="sheet-head">
            <button className="ghost" onClick={() => setSidebarOpen(false)}>
              收起
            </button>
          </div>
          {sidebarBody}
        </div>
      )}

      <footer className="toolbar">
        <button className={muted ? 'tool off' : 'tool'} onClick={() => toggleMic()}>
          {muted ? '🔇' : '🎤'}
          <i>{muted ? '取消静音' : '静音'}</i>
        </button>
        <button className={camOn ? 'tool' : 'tool off'} onClick={toggleCam}>
          {camOn ? '📹' : '📷'}
          <i>{camOn ? '关摄像头' : '开摄像头'}</i>
        </button>
        {canShare && (
          <button className={sharing ? 'tool on' : 'tool'} onClick={toggleShare}>
            🖥<i>{sharing ? '停止共享' : '共享屏幕'}</i>
          </button>
        )}
        <button className={recording ? 'tool rec' : 'tool'} onClick={toggleRecording}>
          {recording ? '⏹' : '⏺'}
          <i>{recording ? '停止录制' : '开始录制'}</i>
        </button>
        <button className={handRaised ? 'tool on' : 'tool'} onClick={toggleHand}>
          ✋<i>举手</i>
        </button>
        {isMobile && (
          <button className="tool" onClick={() => setSidebarOpen(true)}>
            📝<i>纪要/聊天{unread > 0 ? ` (${unread})` : ''}</i>
          </button>
        )}
        <div className="spacer" />
        {meetingId && !isMobile && (
          <button className="ghost" onClick={() => onArchive(meetingId)}>
            会议记录
          </button>
        )}
        <button
          className="tool leave"
          onClick={async () => {
            liveRef.current?.stop();
            await stopMyRecording();
            onLeave();
          }}
        >
          📴<i>离开</i>
        </button>
      </footer>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function ChatPanel({ chat, onSend }) {
  const [text, setText] = useState('');
  const boxRef = useRef(null);
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [chat.length]);
  return (
    <div className="panel chat">
      <div className="chat-list" ref={boxRef}>
        {chat.map((m, i) => (
          <div key={i} className="msg">
            <b>{m.name}</b>
            <span className="muted">{clock(m.t)}</span>
            <p>{m.text}</p>
          </div>
        ))}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          onSend(text.trim());
          setText('');
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="发送消息…" />
        <button className="primary" type="submit">
          发送
        </button>
      </form>
    </div>
  );
}
