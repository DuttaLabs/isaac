import { Component, type ErrorInfo, type ReactNode } from 'react';
import { describeError } from '../lib/result.ts';

/**
 * The engine throws by design, and a throw during render would otherwise blank
 * the whole app. Each panel is wrapped so a failure stays inside that panel.
 */
export class ErrorBoundary extends Component<
  { label: string; children: ReactNode },
  { error?: string }
> {
  public override state: { error?: string } = {};

  public static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: describeError(error) };
  }

  public override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Panel failed:', this.props.label, error, info.componentStack);
  }

  public override componentDidUpdate(previous: { label: string; children: ReactNode }): void {
    // A new design is a new chance to render; clear the previous failure.
    if (this.state.error && previous.children !== this.props.children) {
      this.setState({ error: undefined });
    }
  }

  public override render(): ReactNode {
    if (this.state.error) {
      return (
        <section className="panel">
          <div className="panel-body">
            <p className="error">
              {this.props.label} could not be drawn: {this.state.error}
            </p>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
