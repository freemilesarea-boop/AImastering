// ProductPageErrorBoundary — render-crash safety net for the product
// layout (M3-P-NEXT-6).
//
// If ProductPage throws during render, the whole renderer would
// otherwise white-screen.  This boundary catches the error, logs it,
// and renders a `fallback` (the classic ResultPage) so the user can
// still see + export their master.  A "classic layout" button lets the
// user opt out of the product layout for the session.

import React from 'react';

export interface ProductPageErrorBoundaryProps {
  /** Rendered when ProductPage crashes (the classic ResultPage). */
  fallback: React.ReactNode;
  /** Called once when a crash is caught — used to flip the runtime flag. */
  onError?: (error: Error, info: { componentStack: string }) => void;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

export class ProductPageErrorBoundary extends React.Component<ProductPageErrorBoundaryProps, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ProductPage] render crash — falling back to classic layout:', error, info);
    // Record to the support-bundle ring (best-effort; never throws).
    try {
      (globalThis as { electronAPI?: { invoke: (c: string, ...a: unknown[]) => unknown } })
        .electronAPI?.invoke('support:record-failure', {
          category: 'preview',
          message: `ProductPage render crash: ${error.message}`,
          data: { componentStack: info.componentStack?.slice(0, 2000) ?? '' },
        });
    } catch { /* ignore */ }
    this.props.onError?.(error, { componentStack: info.componentStack ?? '' });
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      // The fallback (classic ResultPage) renders in place of ProductPage.
      // The crash banner sits above it so the user knows what happened.
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <div style={{
            flexShrink: 0,
            padding: '8px 16px',
            background: 'rgba(239,68,68,0.12)',
            borderBottom: '1px solid rgba(239,68,68,0.4)',
            color: '#fca5a5',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            fontSize: 12,
            lineHeight: 1.4,
          }}>
            새 제품 화면에서 오류가 발생해 기존 결과 화면으로 전환했습니다.
            저장·내보내기는 정상 동작합니다.
            <span style={{ opacity: 0.7 }}> (Loui product layout error — using classic result view)</span>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {this.props.fallback}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
