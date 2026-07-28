import { useCallback, useEffect, useState } from 'react';

const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b > 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
  if (b > 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  return `${Math.round(b / 1024)} KB`;
};

const fmtUptime = (s) => {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
};

const clock = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });

export default function Admin({ onBack }) {
  const [token, setToken] = useState(() => sessionStorage.getItem('im.admin') || '');
  const [authed, setAuthed] = useState(false);
  const [authErr, setAuthErr] = useState('');
  const [tab, setTab] = useState('status');

  const [status, setStatus] = useState(null);
  const [storage, setStorage] = useState(null);
  const [logs, setLogs] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const api = useCallback(
    async (path, opts = {}) => {
      const r = await fetch(`/api/admin/${path}`, {
        ...opts,
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token, ...(opts.headers || {}) },
      });
      if (r.status === 401) throw new Error('管理口令不正确');
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `请求失败 ${r.status}`);
      return r.json();
    },
    [token]
  );

  const login = async (t = token) => {
    setAuthErr('');
    try {
      const r = await fetch('/api/admin/ping', { headers: { 'x-admin-token': t } });
      if (!r.ok) throw new Error('管理口令不正确');
      sessionStorage.setItem('im.admin', t);
      setToken(t);
      setAuthed(true);
    } catch (e) {
      setAuthed(false);
      setAuthErr(e.message);
    }
  };

  // 存过口令就自动登录；服务端没设 ADMIN_TOKEN 时空口令也能过
  useEffect(() => {
    login(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api('status'));
    } catch (e) {
      setMsg(e.message);
    }
  }, [api]);

  useEffect(() => {
    if (!authed) return;
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [authed, refresh]);

  useEffect(() => {
    if (!authed) return;
    if (tab === 'storage' && !storage) api('storage').then(setStorage).catch((e) => setMsg(e.message));
    if (tab === 'logs') api('logs?lines=300').then((d) => setLogs(d.lines || d.error || '')).catch((e) => setMsg(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, authed]);

  const flash = (t) => {
    setMsg(t);
    setTimeout(() => setMsg(''), 5000);
  };

  const doCleanup = async (days, dryRun) => {
    setBusy('cleanup');
    try {
      const r = await api('cleanup', { method: 'POST', body: JSON.stringify({ days, dryRun, keepArtifacts: true }) });
      if (dryRun) {
        flash(
          r.meetings.length
            ? `预演：会删除 ${r.meetings.length} 场会议的录音文件，释放 ${fmtBytes(r.freedBytes)}。纪要和逐字稿会保留。`
            : `预演：没有超过 ${days} 天的录制文件。`
        );
      } else {
        flash(`已清理 ${r.meetings.length} 场会议，释放 ${fmtBytes(r.freedBytes)}`);
        setStorage(await api('storage'));
        refresh();
      }
    } catch (e) {
      flash(e.message);
    } finally {
      setBusy('');
    }
  };

  const roomOp = async (roomId, body) => {
    try {
      await api(`rooms/${encodeURIComponent(roomId)}`, { method: 'POST', body: JSON.stringify(body) });
      flash('已更新');
      refresh();
    } catch (e) {
      flash(e.message);
    }
  };

  if (!authed) {
    return (
      <div className="boot gate">
        <h3>管理后台</h3>
        <p className="muted">需要管理口令（.env 里的 ADMIN_TOKEN）</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            login();
          }}
          style={{ display: 'flex', gap: 8 }}
        >
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ADMIN_TOKEN"
            style={{ background: 'var(--panel-2)', border: '1px solid var(--line)', color: 'var(--text)', padding: '9px 12px', borderRadius: 8 }}
          />
          <button className="primary" type="submit">
            进入
          </button>
        </form>
        {authErr && <div className="error">{authErr}</div>}
        <p className="hint">服务端没有设置 ADMIN_TOKEN 时，留空直接点「进入」即可。</p>
        <button className="ghost" onClick={onBack}>
          返回
        </button>
      </div>
    );
  }

  const s = status;

  return (
    <div className="archive">
      <header className="arch-head">
        <button className="ghost" onClick={onBack}>
          ← 返回
        </button>
        <h2>管理后台</h2>
        <span className="muted">每 10 秒自动刷新</span>
      </header>

      <nav className="tabs" style={{ flex: 'none' }}>
        {[
          ['status', '服务状态'],
          ['rooms', '房间管理'],
          ['storage', '磁盘与清理'],
          ['config', '配置总览'],
          ['logs', '日志'],
        ].map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>

      <div className="arch-detail" style={{ flex: 1 }}>
        {msg && <div className="warn" style={{ marginBottom: 12 }}>{msg}</div>}
        {!s && <p className="hint">加载中…</p>}

        {s && tab === 'status' && (
          <>
            <div className="stat-grid">
              <div className="stat">
                <span>运行时长</span>
                <b>{fmtUptime(s.service.uptimeSec)}</b>
              </div>
              <div className="stat">
                <span>进行中的会议</span>
                <b>{s.live.rooms}</b>
              </div>
              <div className="stat">
                <span>在会人数</span>
                <b>{s.live.peers}</b>
              </div>
              <div className="stat">
                <span>等候中</span>
                <b>{s.live.waiting}</b>
              </div>
              <div className="stat">
                <span>内存占用</span>
                <b>{s.service.memoryMB} MB</b>
              </div>
              <div className="stat">
                <span>磁盘可用</span>
                <b>{fmtBytes(s.storage.freeBytes)}</b>
              </div>
            </div>

            <h3>进行中的会议</h3>
            {s.live.detail.length === 0 ? (
              <p className="hint">当前没有人在开会。</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>房间</th>
                    <th>开始时间</th>
                    <th>参会人</th>
                    <th>等候</th>
                  </tr>
                </thead>
                <tbody>
                  {s.live.detail.map((r) => (
                    <tr key={r.meetingId}>
                      <td>{r.roomId}</td>
                      <td>{clock(r.startedAt)}</td>
                      <td>{r.peers.join('、') || '—'}</td>
                      <td>{r.waitingCount || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3>运行环境</h3>
            <table>
              <tbody>
                <tr><td className="k">主机</td><td>{s.service.hostname}</td></tr>
                <tr><td className="k">平台</td><td>{s.service.platform} · Node {s.service.node}</td></tr>
                <tr><td className="k">负载</td><td>{s.service.loadavg.join(' / ')}</td></tr>
                <tr><td className="k">ffmpeg</td><td>{s.service.ffmpeg ? '可用' : '未安装（无法生成纪要）'}</td></tr>
                <tr><td className="k">数据目录</td><td><code>{s.storage.dataDir}</code></td></tr>
              </tbody>
            </table>
          </>
        )}

        {s && tab === 'rooms' && (
          <>
            <p className="hint">
              房间配置是长期的：密码、等候室设置重开会议依然有效。主持人也能在会中自己改，这里是兜底入口
              （比如主持人离职了、或者密码没人记得了）。
            </p>
            <table>
              <thead>
                <tr>
                  <th>房间号</th>
                  <th>密码</th>
                  <th>等候室</th>
                  <th>锁定</th>
                  <th>主持人</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {s.rooms.map((r) => (
                  <tr key={r.roomId}>
                    <td><b>{r.roomId}</b></td>
                    <td>{r.hasPassword ? '已设置' : '—'}</td>
                    <td>{r.waitingRoom ? '开' : '关'}</td>
                    <td>{r.locked ? '已锁定' : '—'}</td>
                    <td>{r.hostName || '—'}</td>
                    <td style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="link" onClick={() => {
                        const pw = prompt(`设置「${r.roomId}」的密码（留空则取消密码）`, '');
                        if (pw !== null) roomOp(r.roomId, { password: pw });
                      }}>
                        改密码
                      </button>
                      <button className="link" onClick={() => roomOp(r.roomId, { waitingRoom: !r.waitingRoom })}>
                        {r.waitingRoom ? '关等候室' : '开等候室'}
                      </button>
                      <button className="link" onClick={() => roomOp(r.roomId, { locked: !r.locked })}>
                        {r.locked ? '解锁' : '锁定'}
                      </button>
                      <button className="link danger" onClick={() => {
                        if (confirm(`吊销「${r.roomId}」的所有主持人令牌？\n\n下一个进入房间的人将成为新主持人。`))
                          roomOp(r.roomId, { revokeHost: true });
                      }}>
                        吊销主持人
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {tab === 'storage' && (
          <>
            <div className="stat-grid">
              <div className="stat">
                <span>录制总占用</span>
                <b>{fmtBytes(storage?.total ?? s?.storage.recordingsBytes)}</b>
              </div>
              <div className="stat">
                <span>会议场次</span>
                <b>{storage?.meetings.length ?? s?.storage.meetings}</b>
              </div>
              <div className="stat">
                <span>磁盘可用</span>
                <b>{fmtBytes(s?.storage.freeBytes)}</b>
              </div>
            </div>

            <h3>清理旧录制</h3>
            <p className="hint">
              只删音视频文件，<b>纪要和逐字稿会保留</b>——它们是纯文本几乎不占空间，删了却再也拿不回来。
              建议先预演看看会删掉什么。
            </p>
            <div className="arch-actions">
              {[30, 90, 180].map((d) => (
                <button key={d} className="ghost" disabled={busy === 'cleanup'} onClick={() => doCleanup(d, true)}>
                  预演：清理 {d} 天前
                </button>
              ))}
              <button
                className="ghost danger-btn"
                disabled={busy === 'cleanup'}
                onClick={() => {
                  const d = Number(prompt('删除多少天以前的录音文件？（纪要保留）', '90'));
                  if (d > 0 && confirm(`确定删除 ${d} 天前的所有录音文件？此操作不可撤销。`)) doCleanup(d, false);
                }}
              >
                执行清理
              </button>
            </div>

            <h3>各会议占用</h3>
            {!storage ? (
              <p className="hint">统计中…</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>会议</th>
                    <th>时间</th>
                    <th>文件</th>
                    <th>占用</th>
                    <th>纪要</th>
                  </tr>
                </thead>
                <tbody>
                  {storage.meetings.slice(0, 50).map((m) => (
                    <tr key={m.meetingId}>
                      <td>{m.title || m.roomId}</td>
                      <td>{clock(m.startedAt)}</td>
                      <td>{m.files}</td>
                      <td>{fmtBytes(m.bytes)}</td>
                      <td>{m.hasSummary ? '有' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {s && tab === 'config' && (
          <>
            <p className="hint">
              这里只读。改配置要编辑服务器上的 <code>.env</code> 然后重启服务。密钥已脱敏。
            </p>
            <table>
              <tbody>
                <tr><td className="k">端口 / HTTPS</td><td>{s.config.port} · {s.config.tls ? '已启用' : '未启用'}</td></tr>
                <tr><td className="k">组网模式</td><td>{s.config.networkMode}</td></tr>
                <tr><td className="k">录制切分</td><td>每 {s.config.segmentMinutes} 分钟</td></tr>
                <tr><td className="k">全局入会口令</td><td>{s.config.joinPassword ? '已设置' : <b style={{ color: '#fcd34d' }}>未设置</b>}</td></tr>
                <tr><td className="k">管理口令</td><td>{s.config.adminToken ? '已设置' : <b style={{ color: '#fcd34d' }}>未设置</b>}</td></tr>
                <tr><td className="k">实时纪要</td><td>{s.config.live.enabled ? `开启，每 ${s.config.live.chunkSeconds} 秒转写 / 每 ${s.config.live.summarySeconds} 秒刷新摘要` : '关闭'}</td></tr>
                <tr><td className="k">转写服务</td><td>{s.config.asr.model} @ {s.config.asr.baseUrl}<br /><span className="muted">密钥 {s.config.asr.key || '未配置'} · 语言 {s.config.asr.language}</span></td></tr>
                <tr><td className="k">纪要模型</td><td>{s.config.llm.model} @ {s.config.llm.baseUrl}<br /><span className="muted">密钥 {s.config.llm.key || '未配置'}</span></td></tr>
                <tr><td className="k">纪要推送</td><td>
                  {['wecom', 'feishu', 'email'].filter((k) => s.config.notify[k]).map((k) => ({ wecom: '企业微信', feishu: '飞书', email: '邮件' })[k]).join('、') || '未配置'}
                </td></tr>
                <tr><td className="k">对外地址</td><td>{s.config.publicBaseUrl || <span className="muted">未配置（推送消息里不会有跳转按钮）</span>}</td></tr>
              </tbody>
            </table>
          </>
        )}

        {tab === 'logs' && (
          <>
            <div className="arch-actions">
              <button className="ghost" onClick={() => api('logs?lines=300').then((d) => setLogs(d.lines || d.error || ''))}>
                刷新
              </button>
            </div>
            <pre className="logbox">{logs || '（空）'}</pre>
          </>
        )}
      </div>
    </div>
  );
}
