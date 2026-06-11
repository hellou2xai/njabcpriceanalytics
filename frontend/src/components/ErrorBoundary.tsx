import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

// Catches render errors so a bug on one screen shows a recoverable panel
// instead of a blank white page.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary" role="alert">
          <h2>Something went wrong</h2>
          <p>This screen hit an unexpected error. Your data is safe. You can retry, or reload the app.</p>
          <pre className="error-boundary-detail">{this.state.error.message}</pre>
          <div className="error-boundary-actions">
            <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
            <button className="btn" onClick={() => window.location.reload()}>Reload page</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
