import { useEffect, useState } from 'react';
import Lobby from './views/Lobby.jsx';
import Room from './views/Room.jsx';
import Archive from './views/Archive.jsx';
import Admin from './views/Admin.jsx';

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (h.startsWith('room/')) return { view: 'room', roomId: decodeURIComponent(h.slice(5)) };
  if (h.startsWith('archive')) return { view: 'archive', meetingId: decodeURIComponent(h.split('/')[1] || '') };
  if (h.startsWith('admin')) return { view: 'admin' };
  return { view: 'lobby' };
}

export default function App() {
  const [route, setRoute] = useState(parseHash);
  const [serverConfig, setServerConfig] = useState(null);
  const [joinInfo, setJoinInfo] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('im.join') || '{}');
    } catch {
      return {};
    }
  });

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then(setServerConfig)
      .catch(() => setServerConfig({ iceServers: [], needPassword: false, settings: {}, features: {} }));
  }, []);

  const navigate = (hash) => {
    window.location.hash = hash;
    setRoute(parseHash());
  };

  const enterRoom = (info) => {
    setJoinInfo(info);
    localStorage.setItem('im.join', JSON.stringify({ name: info.name, roomId: info.roomId }));
    navigate(`/room/${encodeURIComponent(info.roomId)}`);
  };

  if (!serverConfig) {
    return <div className="boot">正在连接服务器…</div>;
  }

  if (route.view === 'room' && joinInfo?.name) {
    return (
      <Room
        roomId={route.roomId}
        name={joinInfo.name}
        password={joinInfo.password}
        prefs={joinInfo.prefs || {}}
        serverConfig={serverConfig}
        onLeave={() => navigate('/')}
        onArchive={(id) => navigate(`/archive/${id}`)}
      />
    );
  }

  if (route.view === 'archive') {
    return <Archive meetingId={route.meetingId} onBack={() => navigate('/')} />;
  }

  if (route.view === 'admin') {
    return <Admin onBack={() => navigate('/')} />;
  }

  return (
    <Lobby
      serverConfig={serverConfig}
      defaults={joinInfo}
      presetRoom={route.view === 'room' ? route.roomId : ''}
      onJoin={enterRoom}
      onArchive={() => navigate('/archive')}
    />
  );
}
