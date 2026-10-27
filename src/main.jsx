import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './ConnectedApp.jsx';
import './styles.css';
import './extras.css';

class AppErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <main className="connection-screen"><div className="connection-card connection-error">
        <strong>The farm dashboard hit an error</strong>
        <p>{this.state.error.message || 'An unexpected display error occurred.'}</p>
        <p>Reload the app. If it happens again, share this message so we can trace the failing component.</p>
        <button className="outline-button" onClick={() => window.location.reload()}>Reload app</button>
      </div></main>;
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(<React.StrictMode><AppErrorBoundary><App /></AppErrorBoundary></React.StrictMode>);
