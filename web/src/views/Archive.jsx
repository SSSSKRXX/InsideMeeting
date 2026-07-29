import { useEffect, useState, useCallback } from 'react';
import { renderMarkdown } from '../lib/md.js';

const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const fmtMin = (ms) => `${Math.max(1, Math.round(ms / 60000))} 分钟`;
const KIND = { mic: '麦克风', screen: '屏幕共享', cam: '摄像头', screenaudio: '共享音频' };

export default function Archive({ meetingId, onBack }) {
  const [list, setList] = useState([]);
  const [current, setCurrent] = useState(meetingId || '');
  const [detail, setDetail] = useState(null);
  const [job, setJob] = useState(null);
  const [tab, setTab] = useState('summary');
  const [err, setErr] = useState('');

  // 会议记录可能需要口令。存在 sessionStorage 里，关掉浏览器就要重新输。
  const [token, setToken] = useState(() => sessionStorage.getItem('im.archive') || '');
  const [locked, setLocked] = useState(false);
  const [pwInput, setPwInput] = useState('');
  const [pwErr, setPwErr] = useState('');

  /** 所有会议记录相关请求都要带口令 */
  const afetch = useCallback(
    (url, opts = {}) =>
      fetch(url, { ...opts, headers: { ...(opts.headers || {}), 'x-archive-token': token } }).then((r) => {
        if (r.status === 401) {
          setLocked(true);
          throw new Error('需要口令');
        }
        return r;
      }),
    [token]
  );

  const loadList = useCallback(() => {
    afetch('/api/meetings')
      .then((r) => r.json())
      .then((d) => {
        setList(d);
        setLocked(false);
      })
      .catch(() => {});
  }, [afetch]);

  const loadDetail = useCallback(
    (id) => {
      if (!id) return;
      afetch(`/api/meetings/${id}`)
        .then((r) => r.json())
        .then((d) => {
          setDetail(d);
          setJob(d.job);
          setTab(d.summary ? 'summary' : d.transcript ? 'transcript' : 'files');
        })
        .catch(() => {});
    },
    [afetch]
  );

  useEffect(loadList, [loadList]);
  useEffect(() => loadDetail(current), [current, loadDetail]);

  // 处理中轮询进度
  useEffect(() => {
    if (!current || job?.state !== 'running') return;
    const t = setInterval(async () => {
      const j = await afetch(`/api/meetings/${current}/job`).then((r) => r.json());
      setJob(j);
      if (j.state === 'done' || j.state === 'error') {
        clearInterval(t);
        loadDetail(current);
        loadList();
      }
    }, 1500);
    return () => clearInterval(t);
  }, [current, job?.state, loadDetail, loadList, afetch]);

  const process = async (body = {}) => {
    setErr('');
    await afetch(`/api/meetings/${current}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setJob({ state: 'running', progress: 0, message: '排队中' });
  };

  const renameSpeaker = async (peerId, name) => {
    await afetch(`/api/meetings/${current}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantNames: { [peerId]: name } }),
    });
    loadDetail(current);
  };

  const download = (name, text) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (locked) {
    return (
      <div className="boot gate">
        <h3>会议记录需要口令</h3>
        <p className="muted">历史录音和纪要涉及会议内容，管理员为它设置了访问口令。</p>
        <form
          style={{ display: 'flex', gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            setPwErr('');
            fetch('/api/meetings', { headers: { 'x-archive-token': pwInput } }).then((r) => {
              if (!r.ok) return setPwErr('口令不正确');
              sessionStorage.setItem('im.archive', pwInput);
              setToken(pwInput);
              setLocked(false);
            });
          }}
        >
          <input
            type="password"
            value={pwInput}
            onChange={(e) => setPwInput(e.target.value)}
            placeholder="查看口令"
            autoFocus
            style={{
              background: 'var(--panel-2)', border: '1px solid var(--line)', color: 'var(--text)',
              padding: '9px 12px', borderRadius: 8,
            }}
          />
          <button className="primary" type="submit">
            查看
          </button>
        </form>
        {pwErr && <div className="error">{pwErr}</div>}
        <button className="ghost" onClick={onBack}>
          返回
        </button>
      </div>
    );
  }

  return (
    <div className="archive">
      <header className="arch-head">
        <button className="ghost" onClick={onBack}>
          ← 返回
        </button>
        <h2>历史会议</h2>
      </header>

      <div className="arch-body">
        <aside className="arch-list">
          {list.length === 0 && <p className="hint">还没有录制过的会议。</p>}
          {list.map((m) => (
            <button
              key={m.meetingId}
              className={m.meetingId === current ? 'arch-item on' : 'arch-item'}
              onClick={() => setCurrent(m.meetingId)}
            >
              <strong>{m.title || m.roomId}</strong>
              <span className="muted">{new Date(m.startedAt).toLocaleString('zh-CN', { hour12: false })}</span>
              <span className="muted">
                {fmtMin(m.durationMs)} · {m.participants.length} 人 · {m.hasSummary ? '已出纪要' : '未处理'}
              </span>
            </button>
          ))}
        </aside>

        <main className="arch-detail">
          {!detail && <p className="hint">选择左侧一场会议查看录制文件与纪要。</p>}

          {detail && (
            <>
              <div className="arch-title">
                <h3>{detail.title || detail.roomId}</h3>
                <span className="muted">
                  {new Date(detail.startedAt).toLocaleString('zh-CN', { hour12: false })} ·{' '}
                  {fmtMin((detail.endedAt || Date.now()) - detail.startedAt)} · 参会：
                  {Object.values(detail.participants || {}).map((p) => p.name).join('、')}
                </span>
              </div>

              <div className="arch-actions">
                <button className="primary" onClick={() => process({ force: true })} disabled={job?.state === 'running'}>
                  {detail.summary ? '重新生成逐字稿与纪要' : '生成逐字稿与会议纪要'}
                </button>
                {detail.transcript && (
                  <button
                    className="ghost"
                    disabled={job?.state === 'running'}
                    onClick={async () => {
                      await afetch(`/api/meetings/${current}/resummarize`, { method: 'POST' });
                      setJob({ state: 'running', progress: 50, message: '重新生成纪要' });
                    }}
                  >
                    仅重写纪要（不重新转写）
                  </button>
                )}
                <button className="ghost" onClick={() => process({ skipSummary: true, force: true })} disabled={job?.state === 'running'}>
                  只出逐字稿
                </button>
                {detail.summary && (
                  <button
                    className="ghost"
                    onClick={async () => {
                      setErr('');
                      const r = await afetch(`/api/meetings/${current}/notify`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: '{}',
                      }).then((x) => x.json());
                      if (r.skipped) setErr(r.skipped);
                      else if (r.failed?.length) setErr(`部分渠道失败：${r.failed.map((f) => `${f.channel}(${f.error})`).join('；')}`);
                      else setErr(`已推送到：${(r.sent || []).join('、') || '（没有已配置的渠道）'}`);
                      loadDetail(current);
                    }}
                  >
                    推送纪要
                  </button>
                )}
              </div>

              {detail.notified && (
                <p className="hint">
                  上次推送：{new Date(detail.notified.at).toLocaleString('zh-CN', { hour12: false })}
                  {detail.notified.sent?.length ? ` · 成功 ${detail.notified.sent.join('、')}` : ''}
                  {detail.notified.failed?.length ? ` · 失败 ${detail.notified.failed.join('、')}` : ''}
                </p>
              )}

              {job && job.state !== 'idle' && (
                <div className={`job ${job.state}`}>
                  <div className="bar">
                    <i style={{ width: `${job.progress || 0}%` }} />
                  </div>
                  <span>
                    {job.state === 'error' ? `失败：${job.error}` : `${job.progress || 0}% ${job.message || ''}`}
                  </span>
                </div>
              )}
              {err && <div className="error">{err}</div>}

              <nav className="tabs">
                <button className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')}>
                  会议纪要
                </button>
                <button className={tab === 'transcript' ? 'on' : ''} onClick={() => setTab('transcript')}>
                  逐字稿
                </button>
                <button className={tab === 'actions' ? 'on' : ''} onClick={() => setTab('actions')}>
                  待办
                </button>
                <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
                  录制文件
                </button>
                <button className={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}>
                  发言统计
                </button>
              </nav>

              {tab === 'summary' && (
                <div className="doc">
                  {detail.summary ? (
                    <>
                      <div className="doc-tools">
                        <button className="ghost" onClick={() => download(`${detail.meetingId}-纪要.md`, detail.summary)}>
                          下载 Markdown
                        </button>
                        <button className="ghost" onClick={() => navigator.clipboard?.writeText(detail.summary)}>
                          复制全文
                        </button>
                      </div>
                      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.summary) }} />
                    </>
                  ) : (
                    <p className="hint">还没有纪要，点击上方按钮生成。</p>
                  )}
                </div>
              )}

              {tab === 'transcript' && (
                <div className="doc">
                  {detail.transcript ? (
                    <>
                      <div className="doc-tools">
                        <button className="ghost" onClick={() => download(`${detail.meetingId}-逐字稿.md`, detail.transcript)}>
                          下载 Markdown
                        </button>
                      </div>
                      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.transcript) }} />
                    </>
                  ) : (
                    <p className="hint">还没有逐字稿。</p>
                  )}
                </div>
              )}

              {tab === 'actions' && (
                <div className="doc">
                  {detail.actions?.length ? (
                    <table>
                      <thead>
                        <tr>
                          <th>事项</th>
                          <th>负责人</th>
                          <th>截止</th>
                          <th>出处</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.actions.map((a, i) => (
                          <tr key={i}>
                            <td>{a.task}</td>
                            <td>{a.owner ? <span className="mention">@{a.owner}</span> : '未明确'}</td>
                            <td>{a.due || '未明确'}</td>
                            <td className="ts">{a.timestamp}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="hint">暂无抽取到的待办。</p>
                  )}
                </div>
              )}

              {tab === 'files' && (
                <div className="files">
                  <p className="hint">
                    录制按发言人分轨保存，每 60 分钟自动切一个文件。mic 是各人麦克风原始音轨，screen 是屏幕共享画面。
                  </p>
                  {detail.files?.map((f) => (
                    <div className="file" key={f.file}>
                      <span className="fname">
                        {f.name} · {KIND[f.kind] || f.kind} · 第 {f.seg + 1} 段
                      </span>
                      <span className="muted">
                        {new Date(f.startedAt).toLocaleTimeString('zh-CN', { hour12: false })} · {fmtSize(f.bytes)}
                      </span>
                      <a className="ghost" href={`${f.url}${token ? `?token=${encodeURIComponent(token)}` : ''}`} target="_blank" rel="noreferrer">
                        播放
                      </a>
                      <a className="ghost" href={`${f.url}?download=1${token ? `&token=${encodeURIComponent(token)}` : ''}`}>
                        下载
                      </a>
                      <button className="link" onClick={() => {
                        const n = prompt('修正这条音轨的发言人姓名（会影响纪要里的 @姓名）', f.name);
                        if (n) renameSpeaker(f.peerId, n);
                      }}>
                        改名
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {tab === 'stats' && (
                <div className="doc">
                  {detail.stats?.length ? (
                    <table>
                      <thead>
                        <tr>
                          <th>发言人</th>
                          <th>说话时长</th>
                          <th>发言轮次</th>
                          <th>字数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.stats.map((s) => (
                          <tr key={s.speaker}>
                            <td className="mention">@{s.speaker}</td>
                            <td>{Math.round(s.talkMs / 1000)} 秒</td>
                            <td>{s.turns}</td>
                            <td>{s.chars}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="hint">生成逐字稿后这里会显示发言占比。</p>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
