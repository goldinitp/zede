import { createRoot } from 'react-dom/client'
import App from './App'
import './app.css'

const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
if (platform.includes('mac')) {
  document.documentElement.classList.add('platform-mac')
}

// NB: no React.StrictMode — its double-invoked effects would spawn/kill the PTY
// twice on mount. Revisit with a mount guard when the tab model lands (M2).
createRoot(document.getElementById('root') as HTMLElement).render(<App />)
