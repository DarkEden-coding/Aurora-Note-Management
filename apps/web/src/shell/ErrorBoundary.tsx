// This boundary keeps a crash inside one panel from taking down Aurora's shell, offering a reload instead of a blank screen.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  label: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `Aurora panel "${this.props.label}" crashed`,
      error,
      info.componentStack,
    );
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="canvas-empty">
          <div style={{ textAlign: "center" }}>
            <p>
              The {this.props.label} crashed: {this.state.error.message}
            </p>
            <button onClick={() => this.setState({ error: null })}>
              Reload panel
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
