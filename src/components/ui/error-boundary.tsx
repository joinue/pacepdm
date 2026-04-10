"use client";

import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time errors in child components so a single bad fetch
 * or crashing render doesn't take down the whole page.
 *
 * Wrap around feature-level subtrees (e.g., file detail panel, approval list)
 * rather than the entire app.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        <div className="flex flex-col items-center justify-center text-center p-8 border border-destructive/30 bg-destructive/5 rounded-lg">
          <AlertTriangle className="w-8 h-8 text-destructive mb-3" />
          <h3 className="text-sm font-medium">Something went wrong</h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-md">
            {this.state.error.message || "An unexpected error occurred while rendering this section."}
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={this.reset}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
