import { useEffect, useRef, useState } from 'react';
import { recordingSupported } from '../lib/recorder.js';

export default function Lobby({ serverConfig, defaults, presetRoom, onJoin, onArchive }) {
  const [name, setName] = useState(defaults?.name || '');
  const [roomId, setRoomId] = useState(presetRoom || defaults?.roomId || '');
  const [password, setPassword] = useState('');
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [devices, setDevices] = useState({ mics: [], cams: [] });
  const [micId, setMicId] = useState('');
  const [camId, setCamId] = useState('');
  const [error, setError] = useState('');
  const [stream, setStream] = useState(null);
  const [denoise, setDenoise] = useState(true);
  const [roomInfo, setRoomInfo] = useState(null);
  const videoRef = useRef(null);

  // 房间号变了就去问一下这个房间要不要密码、有没有等候室，
  // 免得人填完一堆东西点进去才被弹回来
  useEffect(() => {
    const id = roomId.trim();
    if (!id) return setRoomInfo(null);
    const t = setTimeout(() => {
      fetch(`/api/rooms/${encodeURIComponent(id)}/settings`)
        .then((r) => (r.ok ? r.json() : null))
        .then(setRoomInfo)
        .catch(() => setRoomInfo(null));
    }, 350);
    return () => clearTimeout(t);
  }, [roomId]);

  // 预览本地画面并列出设备
  useEffect(() => {
    let cancelled = false;
    let s;
    (async () => {
      try {
        s = await navigator.mediaDevices.getUserMedia({
          audio: micId ? { deviceId: { exact: micId } } : true,
          video: camOn ? (camId ? { deviceId: { exact: camId } } : { width: 1280, height: 720 }) : false,
        });
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        setStream(s);
        if (videoRef.current) videoRef.current.srcObject = s;
        const list = await navigator.mediaDevices.enumerateDevices();
        setDevices({
          mics: list.filter((d) => d.kind === 'audioinput'),
          cams: list.filter((d) => d.kind === 'videoinput'),
        });
      } catch (e) {
        setError(`无法访问摄像头/麦克风：${e.message}。请检查浏览器权限，并确认使用 https 或 localhost 访问。`);
      }
    })();
    return () => {
      cancelled = true;
      s?.getTracks().forEach((t) => t.stop());
    };
  }, [camOn, micId, camId]);

  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return setError('请填写你的姓名 —— 会议纪要里会用它来标注发言人');
    if (!roomId.trim()) return setError('请填写房间号');
    stream?.getTracks().forEach((t) => t.stop());
    onJoin({
      name: name.trim(),
      roomId: roomId.trim(),
      password,
      prefs: { camOn, micOn, micId, camId, denoise },
    });
  };

  const unsupported = !recordingSupported();

  return (
    <div className="lobby">
      <div className="lobby-card">
        <div className="lobby-preview">
          <video ref={videoRef} autoPlay muted playsInline className={camOn ? '' : 'off'} />
          {!camOn && <div className="preview-off">摄像头已关闭</div>}
          <div className="preview-controls">
            <button type="button" className={micOn ? 'chip on' : 'chip'} onClick={() => setMicOn(!micOn)}>
              {micOn ? '麦克风开' : '麦克风关'}
            </button>
            <button type="button" className={camOn ? 'chip on' : 'chip'} onClick={() => setCamOn(!camOn)}>
              {camOn ? '摄像头开' : '摄像头关'}
            </button>
          </div>
        </div>

        <form className="lobby-form" onSubmit={submit}>
          <h1>InsideMeeting</h1>
          <p className="sub">内部会议 · 不限时长 · 分轨录制 · 自动纪要</p>

          <label>
            你的姓名
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="会议纪要里的 @姓名" maxLength={24} />
          </label>

          <label>
            房间号
            <input
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              placeholder="例如 weekly 或 产品评审"
              maxLength={40}
            />
          </label>

          {(serverConfig.needPassword || roomInfo?.hasPassword) && (
            <label>
              {roomInfo?.hasPassword ? '房间密码' : '入会口令'}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={roomInfo?.hasPassword ? '这个房间设了密码' : ''}
              />
            </label>
          )}

          {roomInfo && (roomInfo.waitingRoom || roomInfo.locked || roomInfo.hostName) && (
            <div className="room-hint">
              {roomInfo.locked && <b>此会议已被锁定，暂时无法加入。</b>}
              {!roomInfo.locked && roomInfo.waitingRoom && <span>此房间启用了等候室，进入后需要主持人允许。</span>}
              {roomInfo.hostName && <span className="muted"> 主持人：{roomInfo.hostName}</span>}
            </div>
          )}

          <label className="inline-check">
            <input type="checkbox" checked={denoise} onChange={(e) => setDenoise(e.target.checked)} />
            <span>入会后开启增强降噪（压掉空调声和底噪，对会议纪要准确率有帮助）</span>
          </label>

          <details className="devices">
            <summary>设备选择</summary>
            <label>
              麦克风
              <select value={micId} onChange={(e) => setMicId(e.target.value)}>
                <option value="">默认</option>
                {devices.mics.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || '麦克风'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              摄像头
              <select value={camId} onChange={(e) => setCamId(e.target.value)}>
                <option value="">默认</option>
                {devices.cams.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || '摄像头'}
                  </option>
                ))}
              </select>
            </label>
          </details>

          {error && <div className="error">{error}</div>}
          {unsupported && (
            <div className="warn">
              当前浏览器不支持 MediaRecorder，无法参与录制。建议使用 Chrome 或 Edge（Windows / macOS 均可）。
            </div>
          )}

          <button className="primary" type="submit">
            加入会议
          </button>

          <div className="lobby-foot">
            <button type="button" className="link" onClick={onArchive}>
              查看历史会议与纪要
            </button>
            <span className="muted">
              {serverConfig.features?.asr ? '转写已就绪' : '未配置转写'} ·{' '}
              {serverConfig.features?.llm ? '纪要已就绪' : '未配置纪要'} · 每{' '}
              {serverConfig.settings?.segmentMinutes || 60} 分钟切分录制文件
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
