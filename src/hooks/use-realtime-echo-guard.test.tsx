import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRealtimeEchoGuard } from "./use-realtime-echo-guard";

describe("useRealtimeEchoGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports no echo before any local write", () => {
    const { result } = renderHook(() => useRealtimeEchoGuard());
    expect(result.current.isEcho()).toBe(false);
  });

  it("suppresses events for the window after a local write", () => {
    const { result } = renderHook(() => useRealtimeEchoGuard(1500));

    act(() => result.current.markLocalWrite());
    expect(result.current.isEcho()).toBe(true);

    // Still inside the window — this is the tab's own write coming back.
    vi.advanceTimersByTime(1400);
    expect(result.current.isEcho()).toBe(true);
  });

  it("stops suppressing once the window elapses", () => {
    const { result } = renderHook(() => useRealtimeEchoGuard(1500));

    act(() => result.current.markLocalWrite());
    vi.advanceTimersByTime(1501);

    expect(result.current.isEcho()).toBe(false);
  });

  it("extends the window when a second write lands inside it", () => {
    const { result } = renderHook(() => useRealtimeEchoGuard(1000));

    act(() => result.current.markLocalWrite());
    vi.advanceTimersByTime(800);
    act(() => result.current.markLocalWrite());

    // Past the first window, but the second write reset the clock.
    vi.advanceTimersByTime(400);
    expect(result.current.isEcho()).toBe(true);

    vi.advanceTimersByTime(700);
    expect(result.current.isEcho()).toBe(false);
  });

  it("honours a custom window", () => {
    const { result } = renderHook(() => useRealtimeEchoGuard(200));

    act(() => result.current.markLocalWrite());
    vi.advanceTimersByTime(250);

    expect(result.current.isEcho()).toBe(false);
  });
});
