import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * 设置面板。
 *
 * 三个刻意的设计：
 * 1. 密钥字段永远只显示掩码，留空表示「不改」而不是「清空」。
 *    否则用户改个别的字段一保存，所有密钥就都没了。
 * 2. 每个 AI 服务和推送渠道旁边都有「测试」按钮，真发一次请求。
 *    配错 key 这种事，不测是发现不了的——等到会后生成纪要才报错就太晚了。
 * 3. 每项都标注它对应的环境变量名，方便以后想改回用 .env 管理。
 */

function Field({ f, value, onChange, dirty }) {
  const id = `set-${f.key}`;

  const input = () => {
    switch (f.type) {
      case 'bool':
        return (
          <label className="switch-row" style={{ margin: 0 }}>
            <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
            <span>
              {f.label}
              {f.help && <i>{f.help}</i>}
            </span>
          </label>
        );
      case 'select':
        return (
          <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
            {f.options.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        );
      case 'number':
        return (
          <input
            id={id}
            type="number"
            min={f.min}
            max={f.max}
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case 'password':
        return (
          <input
            id={id}
            type="password"
            value={value ?? ''}
            placeholder={f.hasValue ? `已设置（${f.masked}），留空表示不修改` : '未设置'}
            onChange={(e) => onChange(e.target.value)}
            autoComplete="new-password"
          />
        );
      default:
        return (
          <input id={id} type="text" value={value ?? ''} placeholder={f.placeholder || ''} onChange={(e) => onChange(e.target.value)} />
        );
    }
  };

  if (f.type === 'bool') {
    return (
      <div className={`set-field ${dirty ? 'dirty' : ''}`}>
        {input()}
        <span className="set-env">{f.env}</span>
      </div>
    );
  }

  return (
    <div className={`set-field ${dirty ? 'dirty' : ''}`}>
      <label htmlFor={id} className="set-label">
        {f.label}
        <span className="set-env">{f.env}</span>
      </label>
      {input()}
      {f.help && <p className="set-help">{f.help}</p>}
      {f.type === 'password' && f.hasValue && (
        <button className="link" onClick={() => onChange('__CLEAR__')}>
          清空这一项
        </button>
      )}
    </div>
  );
}

export default function SettingsPanel({ api, flash }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState({});
  const [testing, setTesting] = useState('');

  // 同上：flash 不能进依赖数组。
  // 另外加一道硬保险 —— 只要有没保存的修改，就绝不重新拉取覆盖。
  const flashRef = useRef(flash);
  flashRef.current = flash;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const load = useCallback(async () => {
    if (Object.keys(draftRef.current).length) return;
    try {
      const d = await api('settings');
      setData(d);
      setDraft({});
    } catch (e) {
      flashRef.current(e.message);
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const byGroup = useMemo(() => {
    if (!data) return {};
    const out = {};
    for (const f of data.fields) (out[f.group] ||= []).push(f);
    return out;
  }, [data]);

  const set = (key, v) => setDraft((d) => ({ ...d, [key]: v }));
  const dirtyCount = Object.keys(draft).length;

  const save = async () => {
    setSaving(true);
    try {
      const r = await api('settings', { method: 'POST', body: JSON.stringify(draft) });
      if (r.ok === false) return flash(r.error);
      setData(r.settings);
      setDraft({});
      flash(`已保存 ${r.changed.length} 项，立即生效`);
    } catch (e) {
      flash(e.message);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (what) => {
    if (dirtyCount) return flash('先保存修改再测试，否则测的还是旧配置');
    setTesting(what);
    try {
      const r = await api('settings/test', { method: 'POST', body: JSON.stringify({ what }) });
      setTests((t) => ({ ...t, [what]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [what]: { ok: false, error: e.message } }));
    } finally {
      setTesting('');
    }
  };

  if (!data) return <p className="hint">读取设置中…</p>;

  const TestButton = ({ what, label }) => (
    <span className="test-row">
      <button className="ghost" disabled={testing === what} onClick={() => runTest(what)}>
        {testing === what ? '测试中…' : label}
      </button>
      {tests[what] && (
        <span className={tests[what].ok ? 'hint ok' : 'hint bad'}>
          {tests[what].ok ? tests[what].message || '正常' : tests[what].error}
        </span>
      )}
    </span>
  );

  return (
    <div className="settings">
      <p className="hint">
        这里改的设置会覆盖服务器上的 <code>.env</code>，保存后立即生效，不用重启。
        每项右上角标的是它对应的环境变量名。
      </p>

      {data.groups.map((g) => (
        <section key={g.id} className="set-group">
          <h3>{g.label}</h3>
          {g.desc && <p className="hint">{g.desc}</p>}

          <div className="set-grid">
            {(byGroup[g.id] || []).map((f) => (
              <Field key={f.key} f={f} value={draft[f.key] ?? (f.type === 'password' ? '' : f.value)} onChange={(v) => set(f.key, v)} dirty={f.key in draft} />
            ))}
          </div>

          {g.id === 'ai' && (
            <div className="test-bar">
              <TestButton what="asr" label="测试转写服务" />
              <TestButton what="llm" label="测试纪要模型" />
            </div>
          )}
          {g.id === 'notify' && (
            <div className="test-bar">
              <TestButton what="wecom" label="给企业微信发测试" />
              <TestButton what="feishu" label="给飞书发测试" />
              <TestButton what="email" label="发测试邮件" />
              <span className="hint">测试会用最近一场已生成纪要的会议真发一条消息。</span>
            </div>
          )}
        </section>
      ))}

      <div className={`save-bar ${dirtyCount ? 'on' : ''}`}>
        <span>{dirtyCount ? `有 ${dirtyCount} 项未保存` : '没有未保存的修改'}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {dirtyCount > 0 && (
            <button className="ghost" onClick={() => setDraft({})}>
              撤销
            </button>
          )}
          <button className="primary" disabled={!dirtyCount || saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
