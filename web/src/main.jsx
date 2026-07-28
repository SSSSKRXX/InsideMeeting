import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// 注意：这里刻意不用 React.StrictMode。
// StrictMode 在开发模式下会重复挂载 effect，会导致 WebRTC 连接和录制器被建立两次。
createRoot(document.getElementById('root')).render(<App />);
