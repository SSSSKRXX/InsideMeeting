const { contextBridge, ipcRenderer } = require('electron');

/**
 * 桥接给网页用的能力。
 * 网页可以通过 window.insideMeeting 判断自己跑在桌面壳里，
 * 从而启用系统音频共享这类只有桌面版才有的选项。
 */
contextBridge.exposeInMainWorld('insideMeeting', {
  isDesktop: true,
  getConfig: () => ipcRenderer.invoke('get-config'),
  chooseRole: (o) => ipcRenderer.invoke('choose-role', o),
  serverAction: (o) => ipcRenderer.invoke('server-action', o),
  switchRole: () => ipcRenderer.invoke('switch-role'),
  onServerState: (fn) => {
    const h = (_e, s) => fn(s);
    ipcRenderer.on('server-state', h);
    return () => ipcRenderer.removeListener('server-state', h);
  },
});

/**
 * 屏幕共享的选源界面。
 *
 * Electron 里 getDisplayMedia 不会自己弹系统选择框，得我们自己画一个。
 * 主进程通过 IPC 把候选源发过来，选完再把结果发回去。
 *
 * 为什么不让主进程用 executeJavaScript 直接调这里的函数：
 * 开了 contextIsolation 之后 preload 的 window 是隔离世界，
 * executeJavaScript 跑在主世界，两边看不见对方。DOM 倒是共享的，
 * 所以这个函数在隔离世界里跑、往共享 DOM 上画界面，完全没问题。
 */

/** DOM 还没准备好就等一下。页面正在导航时 document.body 可能是 null。 */
function waitForBody() {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    if (document.readyState !== 'loading') return resolve();
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

const pickShareSource = (sources) =>
  new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = `
      position:fixed;inset:0;z-index:2147483647;background:#0e1116ee;
      display:flex;flex-direction:column;padding:24px;box-sizing:border-box;
      font:14px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#e6edf3;`;

    const screens = sources.filter((s) => s.isScreen);
    const windows = sources.filter((s) => !s.isScreen);
    let selected = null;
    let withAudio = false;

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px';
    head.innerHTML = '<b style="font-size:16px">选择要共享的内容</b>';
    wrap.appendChild(head);

    const grid = document.createElement('div');
    grid.style.cssText = 'flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;align-content:start';
    wrap.appendChild(grid);

    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;align-items:center;gap:12px;margin-top:16px';

    const audioLabel = document.createElement('label');
    audioLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer';
    const audioBox = document.createElement('input');
    audioBox.type = 'checkbox';
    audioBox.onchange = () => (withAudio = audioBox.checked);
    audioLabel.append(audioBox, document.createTextNode('同时共享系统声音'));

    const spacer = document.createElement('div');
    spacer.style.flex = '1';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = 'background:transparent;border:1px solid #2a3341;color:#e6edf3;padding:8px 18px;border-radius:8px;cursor:pointer';

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = '开始共享';
    confirmBtn.disabled = true;
    confirmBtn.style.cssText = 'background:#3b82f6;border:0;color:#fff;padding:8px 20px;border-radius:8px;cursor:pointer';

    foot.append(audioLabel, spacer, cancelBtn, confirmBtn);
    wrap.appendChild(foot);

    const close = (val) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      }
    };
    // 用捕获阶段监听：会议页面自己也在监听键盘，别被它先吃掉
    document.addEventListener('keydown', onKey, true);

    const section = (title, list) => {
      if (!list.length) return;
      const h = document.createElement('div');
      h.textContent = title;
      h.style.cssText = 'grid-column:1/-1;color:#8b97a6;font-size:12px;margin-top:4px';
      grid.appendChild(h);
      for (const s of list) {
        const card = document.createElement('button');
        card.type = 'button';
        card.style.cssText = `
          background:#161b22;border:2px solid #2a3341;border-radius:10px;padding:8px;
          color:#e6edf3;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:6px;`;
        const img = document.createElement('img');
        img.src = s.thumbnail;
        img.style.cssText = 'width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:6px;background:#000';
        const label = document.createElement('span');
        label.textContent = s.name;
        label.title = s.name;
        label.style.cssText = 'font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        card.append(img, label);
        card.onclick = () => {
          selected = s;
          [...grid.querySelectorAll('button')].forEach((b) => (b.style.borderColor = '#2a3341'));
          card.style.borderColor = '#3b82f6';
          confirmBtn.disabled = false;
        };
        // 双击直接开始，少点一次
        card.ondblclick = () => close({ id: s.id, withAudio });
        grid.appendChild(card);
      }
    };
    section('整个屏幕', screens);
    section('应用窗口', windows);

    cancelBtn.onclick = () => close(null);
    confirmBtn.onclick = () => selected && close({ id: selected.id, withAudio });

    document.body.appendChild(wrap);
    confirmBtn.focus();

    // 系统音频只有 Windows 抓得到，其它平台把选项禁掉并说明原因
    ipcRenderer.invoke('get-config').then((cfg) => {
      if (!cfg.systemAudioSupported) {
        audioBox.disabled = true;
        audioLabel.style.opacity = '0.5';
        audioLabel.title = 'macOS 需要安装 BlackHole 之类的虚拟声卡才能捕获系统声音';
        audioLabel.lastChild.textContent = '同时共享系统声音（本平台不支持）';
      }
    }).catch(() => {});
  });

/**
 * 无论如何都要给主进程回一个值。
 *
 * 原来这里没有 try/finally：选源界面渲染时抛任何异常（最典型的是页面
 * 正在导航、document.body 还是 null），主进程那边就只能干等 120 秒的超时，
 * 而前端的 getDisplayMedia 全程没有任何反馈 —— 表现就是「点了共享屏幕没反应」。
 */
ipcRenderer.on('pick-share-source', async (_e, { replyChannel, sources }) => {
  let picked = null;
  try {
    await waitForBody();
    picked = await pickShareSource(sources);
  } catch (err) {
    console.error('[InsideMeeting] 选源界面出错：', err);
    picked = null;
  } finally {
    ipcRenderer.send(replyChannel, picked);
  }
});
