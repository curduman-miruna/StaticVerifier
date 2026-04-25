import { createRoot } from 'react-dom/client';
import App from './app/App';
import './styles/interface.css';

const container = document.getElementById('root');
if (!container) {
	throw new Error('Missing #root container for StaticVerifier webview.');
}

createRoot(container).render(<App />);
