/**
 * 设备获取与枚举。
 *
 * 这个文件是为了修两个一直在互相掩护的问题：
 *
 * 1. 麦克风和摄像头原来是一次 getUserMedia 同时要的。只要摄像头不可用
 *    —— 机器上没装、被别的软件占着、Windows 隐私设置只放开了麦克风、
 *    驱动睡过去了 —— 整次调用就抛错，麦克风被一起拖死。
 *    更坑的是报错文案写的是「无法获取麦克风」，把锅甩给了没坏的那个设备。
 *    所以这里拆成两次独立的调用：摄像头失败就当没有摄像头，会照开。
 *
 * 2. deviceId 原来一律用 { exact: id }。这个 id 是上次会话记下来的，
 *    换了耳机、拔了 USB 麦、甚至只是重启一次系统之后就可能失效，
 *    失效时抛 OverconstrainedError —— 又是整个流程被打断。
 *    这里改成 exact 失败后自动退回系统默认设备。
 */

/** 拿麦克风。指定的设备不存在时自动退回默认设备，不会整体失败。 */
export async function getMic(micId, extra = {}) {
  const base = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...extra,
  };
  if (micId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...base, deviceId: { exact: micId } },
      });
    } catch (e) {
      // 只有「这个设备没了」才降级；权限被拒之类的要如实往上抛
      if (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') throw e;
      console.warn('[devices] 记住的麦克风已不可用，改用系统默认：', micId);
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: base });
}

/** 拿摄像头。同样支持 exact 失败后降级。 */
export async function getCam(camId, extra = {}) {
  const base = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    facingMode: 'user',
    ...extra,
  };
  if (camId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { ...base, deviceId: { exact: camId } },
      });
    } catch (e) {
      if (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') throw e;
      console.warn('[devices] 记住的摄像头已不可用，改用系统默认：', camId);
    }
  }
  return navigator.mediaDevices.getUserMedia({ video: base });
}

/**
 * 列设备。
 *
 * 注意 enumerateDevices 的 label 只有在拿到对应类别的权限之后才有值。
 * 原来的写法把它放在 getUserMedia 的 try 里面，一旦取流失败就整个跳过，
 * 结果是「麦克风明明是好的，但下拉框里一个设备都没有」。
 * 这里做成独立函数，取流成功与否都调一次。
 */
export async function listDevices() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: list.filter((d) => d.kind === 'audioinput'),
      cams: list.filter((d) => d.kind === 'videoinput'),
    };
  } catch {
    return { mics: [], cams: [] };
  }
}

/** 插拔设备时回调。返回取消订阅的函数。 */
export function onDeviceChange(fn) {
  const md = navigator.mediaDevices;
  if (!md?.addEventListener) return () => {};
  md.addEventListener('devicechange', fn);
  return () => md.removeEventListener('devicechange', fn);
}

/** 把 getUserMedia 的错误翻译成人话，而不是把 NotReadableError 直接甩给用户 */
export function explainMediaError(e, what = '设备') {
  const map = {
    NotAllowedError: `${what}权限被拒绝。浏览器地址栏左侧可以重新授权；Windows 还要检查「设置 → 隐私和安全性 → 麦克风/相机」里是否允许桌面应用访问。`,
    NotFoundError: `没有找到可用的${what}。`,
    NotReadableError: `${what}被其他程序占用了（常见的是腾讯会议、飞书、Zoom、OBS 或另一个标签页），关掉它们再试。`,
    OverconstrainedError: `${what}不支持请求的参数，已尝试退回默认设置。`,
    SecurityError: `当前页面不是安全上下文，浏览器不允许访问${what}。请用 https 或 localhost 打开。`,
    AbortError: `${what}启动失败，通常是驱动异常，重插设备或重启后再试。`,
  };
  return map[e?.name] || `${what}打开失败：${e?.name || ''} ${e?.message || e}`;
}
