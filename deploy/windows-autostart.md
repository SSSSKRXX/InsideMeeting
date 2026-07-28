# Windows 开机自启

macOS 用 launchd（`com.inside.meeting.plist`），Windows 这边有两种做法。

## 方案一：任务计划程序（不用装东西，推荐先试这个）

1. Win + R 输入 `taskschd.msc` 打开任务计划程序
2. 右侧「创建任务」（**不是**「创建基本任务」）
3. **常规**页：
   - 名称填 `InsideMeeting`
   - 勾选「不管用户是否登录都要运行」
   - 勾选「使用最高权限运行」
   - 配置为选「Windows 10」或更高
4. **触发器**页 → 新建 → 开始任务选「计算机启动时」
5. **操作**页 → 新建：
   - 程序或脚本：`C:\Program Files\nodejs\node.exe`
   - 添加参数：`server\src\index.js`
   - 起始于：`C:\InsideMeeting`（换成你的实际路径，**这一项不能留空**）
6. **条件**页：取消勾选「只有在计算机使用交流电源时才启动」
7. **设置**页：勾选「如果任务失败，按以下频率重新启动」，间隔 1 分钟，尝试 3 次

日志需要自己重定向，可以改成执行一个 `run.bat`：

```bat
@echo off
cd /d C:\InsideMeeting
"C:\Program Files\nodejs\node.exe" server\src\index.js >> data\server.log 2>&1
```

然后任务计划里指向这个 bat。

## 方案二：注册成真正的 Windows 服务（更稳，能自动拉起）

用 [NSSM](https://nssm.cc/)：

```powershell
winget install NSSM.NSSM
# 或从 nssm.cc 下载解压

nssm install InsideMeeting "C:\Program Files\nodejs\node.exe" "server\src\index.js"
nssm set InsideMeeting AppDirectory "C:\InsideMeeting"
nssm set InsideMeeting AppStdout "C:\InsideMeeting\data\server.log"
nssm set InsideMeeting AppStderr "C:\InsideMeeting\data\server.err.log"
nssm set InsideMeeting Start SERVICE_AUTO_START
nssm start InsideMeeting
```

停止 / 卸载：

```powershell
nssm stop InsideMeeting
nssm remove InsideMeeting confirm
```

## 防火墙

首次启动 Windows 会弹「是否允许 node.exe 通信」，**必须勾选「专用网络」**，否则别人连不进来。

如果当时点错了，手动放行：

```powershell
New-NetFirewallRule -DisplayName "InsideMeeting" -Direction Inbound `
  -Protocol TCP -LocalPort 8443 -Action Allow -Profile Private,Domain
```

注册成服务时防火墙不会弹窗，需要直接执行上面这条命令。

## 别让电脑睡过去

会议进行中主机休眠会直接断会：

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 15
```

（只关睡眠，屏幕该关还是关，省电。）

## 证书自动续期

用了 Tailscale 正式证书的话，证书 90 天过期。再建一个任务计划：

- 触发器：每月一次
- 操作：`powershell.exe`，参数 `-ExecutionPolicy Bypass -File C:\InsideMeeting\scripts\gen-cert.ps1`
- 后面再加一步重启服务：`nssm restart InsideMeeting`
