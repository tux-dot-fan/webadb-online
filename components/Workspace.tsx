"use client";

import { useState } from "react";
import { DevicePanel } from "@/components/DevicePanel";
import { ShellPanel } from "@/components/ShellPanel";
import { ApkInstallPanel } from "@/components/ApkInstallPanel";
import { FileManagerPanel } from "@/components/FileManagerPanel";
import { ScreenshotPanel } from "@/components/ScreenshotPanel";
import { AppManagerPanel } from "@/components/AppManagerPanel";
import { LogcatPanel } from "@/components/LogcatPanel";
import { WiFiAdbPanel } from "@/components/WiFiAdbPanel";
import {
  useAdbSession,
  useAdbState,
  useAdbSupported,
} from "@/lib/use-adb";

type Tab = "shell" | "apps" | "logcat" | "files" | "screenshot" | "apk" | "wifi";

export function Workspace() {
  const state = useAdbState();
  const session = useAdbSession();
  const supported = useAdbSupported();
  const [tab, setTab] = useState<Tab>("shell");

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand">
          <span className="logo">W</span>
          WebADB
        </div>
        <div className="meta">
          {state.kind === "connected" ? state.banner : "browser · webusb · adb"}
        </div>
      </header>

      <main className="workspace">
        <DevicePanel state={state} session={session} supported={supported} />

        <div className="workspace-content">
          {!session ? (
            <NotConnected />
          ) : (
            <>
              <nav className="feature-tabs" role="tablist">
                <TabButton current={tab} value="shell" onClick={setTab}>
                  Shell
                </TabButton>
                <TabButton current={tab} value="apps" onClick={setTab}>
                  Apps
                </TabButton>
                <TabButton current={tab} value="logcat" onClick={setTab}>
                  Logcat
                </TabButton>
                <TabButton current={tab} value="files" onClick={setTab}>
                  Files
                </TabButton>
                <TabButton current={tab} value="screenshot" onClick={setTab}>
                  Screenshot
                </TabButton>
                <TabButton current={tab} value="apk" onClick={setTab}>
                  Install APK
                </TabButton>
                <TabButton current={tab} value="wifi" onClick={setTab}>
                  Wi-Fi ADB
                </TabButton>
              </nav>

              <div style={{ height: 24 }} />

              {tab === "shell" && <ShellPanel session={session} />}
              {tab === "apps" && <AppManagerPanel session={session} />}
              {tab === "logcat" && <LogcatPanel session={session} />}
              {tab === "files" && <FileManagerPanel session={session} />}
              {tab === "screenshot" && <ScreenshotPanel session={session} />}
              {tab === "apk" && <ApkInstallPanel session={session} />}
              {tab === "wifi" && <WiFiAdbPanel session={session} />}
            </>
          )}
        </div>
      </main>

      <footer className="site-footer">
        Built with{" "}
        <a href="https://github.com/yume-chan/ya-webadb" target="_blank" rel="noopener noreferrer">
          ya-webadb
        </a>{" "}
        · Source on{" "}
        <a href="https://github.com/tux-dot-fan/webadb-online" target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
      </footer>
    </div>
  );
}

function TabButton({
  current,
  value,
  onClick,
  children,
}: {
  current: Tab;
  value: Tab;
  onClick: (v: Tab) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={current === value}
      className={current === value ? "active" : ""}
      onClick={() => onClick(value)}
    >
      {children}
    </button>
  );
}

function NotConnected() {
  return (
    <div>
      <div className="hero">
        <h1>Run ADB fully in your browser</h1>
        <p>
          Connect your Android device over USB, then run shell commands, install APKs,
          browse files, and take screenshots — without installing anything on your
          computer.
        </p>
      </div>

      <div className="feature-grid">
        <div className="card">
          <h3>🔌 WebUSB</h3>
          <p>
            Direct USB connection from your browser. No drivers, no adb-server, no
            extensions. Just Chrome, Edge, or Opera.
          </p>
        </div>
        <div className="card">
          <h3>🐚 Shell</h3>
          <p>
            Run any command on the device. <code>getprop</code>, <code>pm list</code>,
            <code>dumpsys</code>, <code>ls</code> — everything you can do in a
            terminal.
          </p>
        </div>
        <div className="card">
          <h3>📦 APK install</h3>
          <p>
            Pick an APK from your computer. It streams over USB, installs via{" "}
            <code>pm install</code>, and the temp file is cleaned up automatically.
          </p>
        </div>
        <div className="card">
          <h3>📁 Files</h3>
          <p>
            Browse <code>/sdcard</code> and the rest of the device filesystem, and
            download any file back to your computer.
          </p>
        </div>
        <div className="card">
          <h3>📸 Screenshot</h3>
          <p>
            One-click <code>screencap</code> via the framebuffer protocol. No
            scrcpy server needed.
          </p>
        </div>
        <div className="card">
          <h3>🔒 Private</h3>
          <p>
            Everything runs in your browser. No files leave your computer, no data
            is sent to a server. <code>webadb.online</code> is a static site.
          </p>
        </div>
      </div>
    </div>
  );
}