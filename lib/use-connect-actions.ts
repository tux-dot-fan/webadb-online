"use client";

/**
 * Hook for the Connect / Disconnect / Switch-device buttons. Centralised
 * so the hero page (big "Connect device" CTA) and the topbar menu (small
 * Connect / Switch / Disconnect items) share the same `busy` / `error`
 * state — they are mutually exclusive, so making them independent
 * copies would let the user start two WebUSB prompts at once.
 *
 * The hook returns `busy` so the caller can disable its own UI; the
 * hook itself fires one action at a time and ignores subsequent calls
 * while a request is in flight.
 *
 * Implementation note: the action callbacks are kept stable across
 * renders (no `busy` in the dep list) so consumers can pass them as
 * props without re-rendering downstream. The `busy` guard is enforced
 * via a ref so the callbacks see the latest value without making
 * themselves identity-unstable.
 */

import { useCallback, useRef, useState } from "react";
import { getAdbClient } from "@/lib/adb-client";

export interface ConnectActions {
  busy: boolean;
  error: string | null;
  clearError(): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  switchDevice(): Promise<void>;
}

export function useConnectActions(): ConnectActions {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const setBusyBoth = (v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  };

  const connect = useCallback(async () => {
    if (busyRef.current) return;
    setError(null);
    setBusyBoth(true);
    try {
      await getAdbClient().connect();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyBoth(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (busyRef.current) return;
    setBusyBoth(true);
    try {
      await getAdbClient().disconnect();
    } catch {
      // Disconnect errors are not interesting to surface — the state will
      // update via the event subscription regardless.
    } finally {
      setBusyBoth(false);
    }
  }, []);

  const switchDevice = useCallback(async () => {
    if (busyRef.current) return;
    setError(null);
    setBusyBoth(true);
    try {
      await getAdbClient().switchDevice();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyBoth(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { busy, error, clearError, connect, disconnect, switchDevice };
}