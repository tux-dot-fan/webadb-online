"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { getAdbClient, type ConnectionState } from "@/lib/adb-client";

/**
 * Subscribe a React component to the singleton AdbClient's connection state.
 *
 * useSyncExternalStore is the React 18+ primitive for this. The client is
 * browser-only, so we lazily instantiate on first call and SSR-safe (returns
 * "disconnected" on the server).
 */
export function useAdbState(): ConnectionState {
  const subscribe = (cb: () => void) => {
    if (typeof window === "undefined") return () => {};
    return getAdbClient().subscribe(() => cb());
  };
  const getSnapshot = () => {
    if (typeof window === "undefined") {
      return { kind: "disconnected" } as ConnectionState;
    }
    return getAdbClient().getState();
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useAdbSupported(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(getAdbClient().isSupported());
  }, []);
  return supported;
}

export function useAdbSession() {
  const [session, setSession] = useState(() =>
    typeof window === "undefined" ? null : getAdbClient().getSession(),
  );
  useEffect(() => {
    return getAdbClient().subscribe(() => {
      setSession(getAdbClient().getSession());
    });
  }, []);
  return session;
}