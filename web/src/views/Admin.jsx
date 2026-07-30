import { useCallback, useEffect, useState } from 'react';
import SettingsPanel from './SettingsPanel.jsx';

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

/**
 * 存储位置设置。
 *
 * 浏览器没法弹出服务器的文件选择框，所以做法是：
 * 服务端把常用位置和外接磁盘列出来，这里做成可点的候选；
 * 也允许手敲绝对路径，敲完先校验可写再保存。
 * 真正的原生选择框在菜单栏程序里（它跑在服务器那台机器上）。
 */
function PathSettings({ api, onSaved, flash }) {
  const [data, setData] = useState(null);
  const [rec, setRec] = useState('');
  const [min, setMin] = useState('');
  const [separate, setSeparate] = useState(false);
  const [migrate, setMigrate] = useState(true);
  const [checking, setChecking] = useState('');
  const [check, setCheck] = useState({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api('paths');
      setData(d);
      setRec(d.recordings);
      setMin(d.minutes || '');
      setSeparate(d.separate);
    } catch (e) {
      flash(e.message);
    }
  }, [api, flash]);

  useEffect(() => {
    load();
  }, [load]);

  const validate = async (which, dir) => {
    if (!dir) return;
    setChecking(which);
    try {
      const r = await api('paths/validate', { method: 'POST', body: JSON.stringify({ dir }) });
      setCheck((c) => ({ ...c, [which]: r }));
    } catch (e) {
      setCheck((c) => ({ ...c, [which]: { ok: false, error: e.message } }));
    } finally {
      setChecking('');
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = { recordings: rec, minutes: separate ? min : '', migrate };
      const r = await api('paths', { method: 'POST', body: JSON.stringify(body) });
      if (r.ok === false) return flash(r.error);
      const parts = [];
      if (r.migrated?.recordings) parts.push(`搬移了 ${r.migrated.recordings.moved} 场会议的录制文件`);
      if (r.migrated?.minutes) parts.push(`搬移了 ${r.migrated.minutes.moved} 份纪要`);
      flash(`存储位置已更新${parts.length ? '，' + parts.join('，') : ''}${r.warnings?.length ? '。' + r.warnings.join(' ') : ''}`);
      await load();
      onSaved?.();
    } catch (e) {
      flash(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (!data) return <p className="hint">读取存储配置中…</p>;

  const dirty = rec !== data.recordings || (separate ? min : '') !== (data.minutes || '');

  return (
    <div className="pathbox">
      <h3 style={{ marginTop: 0 }}>存储位置</h3>
      <p className="hint">
        录制文件会持续变大（一场 2 小时 6 人的会几百 MB），纪要只有几十 KB。
        把录制放外置盘、纪要留在系统盘跟着备份，是比较常见的分法。
      </p>

      <label className="path-label">录制文件保存到</label>
      <div className="path-row">
        <input value={rec} onChange={(e) => setRec(e.target.value)} placeholder="/Volumes/移动硬盘/InsideMeeting" />
        <button className="ghost" disabled={checking === 'rec'} onClick={() => validate('rec', rec)}>
          {checking === 'rec' ? '检查中' : '检查可写'}
        </button>
      </div>
      {check.rec && (
        <p className={check.rec.ok ? 'hint ok' : 'hint bad'}>
          {check.rec.ok ? `可写${check.rec.freeBytes != null ? `，剩余 ${fmtBytes(check.rec.freeBytes)}` : ''}` : check.rec.error}
        </p>
      )}
      <div className="path-sugs">
        {data.suggestions.map((s) => (
          <button key={s.dir} className="sug" onClick={() => setRec(s.dir)} title={s.dir}>
            {s.label}
            {s.freeBytes != null && <i>剩 {fmtBytes(s.freeBytes)}</i>}
          </button>
        ))}
      </div>

      <label className="switch-row" style={{ marginTop: 14 }}>
        <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} />
        <span>纪要单独存放<i>不勾选就跟录制文件放在一起</i></span>
      </label>

      {separate && (
        <>
          <label className="path-label">会议纪要保存到</label>
          <div className="path-row">
            <input value={min} onChange={(e) => setMin(e.target.value)} placeholder="/Users/你/Documents/会议纪要" />
            <button className="ghost" disabled={checking === 'min'} onClick={() => validate('min', min)}>
              {checking === 'min' ? '检查中' : '检查可写'}
            </button>
          </div>
          {check.min && (
            <p className={check.min.ok ? 'hint ok' : 'hint bad'}>
              {check.min.ok ? `可写${check.min.freeBytes != null ? `，剩余 ${fmtBytes(check.min.freeBytes)}` : ''}` : check.min.error}
            </p>
          )}
          <div className="path-sugs">
            {data.suggestions.map((s) => (
              <button key={s.dir} className="sug" onClick={() => setMin(s.dir)} title={s.dir}>
                {s.label}
              </button>
            ))}
          </div>
        </>
      )}

      <label className="switch-row" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={migrate} onChange={(e) => setMigrate(e.target.checked)} />
        <span>同时搬移已有文件<i>不搬的话，历史会议在界面上会看不到</i></span>
      </label>

      <div className="arch-actions" style={{ marginTop: 12 }}>
        <button className="primary" disabled={!dirty || saving} onClick={save}>
          {saving ? '保存中…' : '保存并生效'}
        </button>
        {dirty && (
          <button className="ghost" onClick={() => { setRec(data.recordings); setMin(data.minutes || ''); setSeparate(data.separate); setCheck({}); }}>
            撤销修改
          </button>
        )}
      </div>

      <p className="hint">
        改动立即生效，不用重启服务。当前实际使用：录制 <code>{data.recordings}</code>
        ，纪要 <code>{data.minutesEffective}</code>
      </p>
    </div>
  );
}

/**
 * 虚拟背景模型的下载。
 *
 * 之前只让浏览器去拉模型，失败就提示用户跑命令行脚本 —— 对
 * 「装个 App 就想用」的人等于没有。改成服务端下一次、所有参会者
 * 从局域网取：又快，又不依赖每个人的网络。
 */
function ModelPanel({ api, flash }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await api('models'));
    } catch { /* 没配管理口令时也可能读不到，静默 */ }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  // 下载中每 2 秒刷一次进度
  useEffect(() => {
    if (st?.job?.state !== 'running') return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [st?.job?.state, load]);

  const download = async () => {
    setBusy(true);
    try {
      await api('models/download', { method: 'POST', body: '{}' });
      flash('开始下载模型，会依次尝试多个镜像');
      setTimeout(load, 800);
    } catch (e) {
      flash(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!st) return null;
  const job = st.job;

  return (
    <section className="set-group">
      <h3>虚拟背景模型</h3>
      <p className="hint">
        背景模糊和换背景需要一个约 250KB 的人像分割模型。
        <b>服务器下载一次，所有参会者从局域网取</b>，不用每个人各自去外网拉。
      </p>

      <div className="switch-row" style={{ marginTop: 10 }}>
        <span>
          当前状态
          <i>
            {st.ready ? '已就绪，虚拟背景可用' : '未下载，虚拟背景会提示加载失败'}
            {' · '}存放在 {st.dir}
          </i>
        </span>
        <button className={st.ready ? 'ghost' : 'primary'} disabled={busy || job?.state === 'running'} onClick={download}>
          {job?.state === 'running' ? '下载中…' : st.ready ? '重新下载' : '下载模型'}
        </button>
      </div>

      {job && job.state !== 'idle' && (
        <>
          {job.state === 'error' && (
            <div className="error" style={{ marginTop: 10 }}>
              {job.error}
              <div style={{ marginTop: 6, fontWeight: 'normal' }}>
                服务器连不上外网的话，可以在能上网的机器下载后手动放进去：
                把 <code>selfie_segmenter.tflite</code> 放到 <code>{st.dir}</code>。
              </div>
            </div>
          )}
          {job.log?.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="hint" style={{ cursor: 'pointer' }}>
                下载日志（{job.done}/{job.total}）
              </summary>
              <pre className="logbox" style={{ maxHeight: 200, marginTop: 6 }}>
                {job.log.join('\n')}
              </pre>
            </details>
          )}
        </>
      )}
    </section>
  );
}

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
          ['settings', '设置'],
          ['rooms', '房间管理'],
          ['storage', '存储与清理'],
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

        {tab === 'settings' && (
          <>
            <ModelPanel api={api} flash={flash} />
            <SettingsPanel api={api} flash={flash} />
          </>
        )}

        {s && tab === 'status' && (
          <>
            {(!s.config.asr.key || !s.config.llm.key) && (
              <div className="setup-banner">
                <b>还没配置完</b>
                <p>
                  {!s.config.asr.key && !s.config.llm.key
                    ? '转写服务和纪要模型都还没填，现在开会不会生成任何纪要。'
                    : !s.config.asr.key
                      ? '转写服务还没填，无法把录音转成文字。'
                      : '纪要模型还没填，能出逐字稿但不会有纪要。'}
                </p>
                <button className="primary" onClick={() => setTab('settings')}>
                  去填写
                </button>
              </div>
            )}
            {!s.config.adminToken && (
              <div className="setup-banner warn-banner">
                <b>管理口令未设置</b>
                <p>现在任何能打开会议地址的人都能进入这个管理后台，改配置、删录制。</p>
                <button className="primary" onClick={() => setTab('settings')}>
                  去设置
                </button>
              </div>
            )}

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
                <tr><td className="k">端口 / HTTPS</td><td>{s.config.port} · {s.config.tls ? '已启用' : '未启用'}</td></tr>
                <tr><td className="k">组网模式</td><td>{s.config.networkMode}</td></tr>
                <tr><td className="k">录制位置</td><td><code>{s.storage.recordings}</code></td></tr>
                <tr><td className="k">纪要位置</td><td><code>{s.storage.minutesEffective}</code></td></tr>
                <tr><td className="k">会议记录访问</td><td>{s.config.archivePassword ? '需要口令' : <b style={{ color: '#fcd34d' }}>无口令，任何人都能查看全部历史</b>}</td></tr>
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
            <PathSettings api={api} onSaved={() => { refresh(); api('storage').then(setStorage).catch(() => {}); }} flash={flash} />

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
