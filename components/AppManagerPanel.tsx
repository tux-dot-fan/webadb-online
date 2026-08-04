"use client";

import { useEffect, useState } from "react";
import { getAdbClient, type AdbSession, type PackageInfo } from "@/lib/adb-client";

interface Props {
  session: AdbSession;
}

export function AppManagerPanel({ session: _session }: Props) {
  const [apps, setApps] = useState<PackageInfo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const list = await getAdbClient().listInstalledPackages();
      setApps(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function uninstall(pkg: string) {
    if (!confirm(`Uninstall ${pkg}? This cannot be undone.`)) return;
    setPending(pkg);
    setError(null);
    try {
      const ok = await getAdbClient().uninstallPackage(pkg);
      if (!ok) throw new Error("pm uninstall returned without 'Success'");
      setStatus(`Uninstalled ${pkg}`);
      // Remove from list.
      setApps((prev) => prev?.filter((a) => a.packageName !== pkg) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  async function launch(pkg: string) {
    setPending(pkg);
    setError(null);
    try {
      const out = await getAdbClient().launchPackage(pkg);
      setStatus(`Launched ${pkg}: ${out.trim()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  }

  const filtered = apps?.filter(
    (a) =>
      a.packageName.toLowerCase().includes(filter.toLowerCase()) ||
      a.apkPath.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <section className="panel">
      <h2>Apps</h2>
      <p className="panel-desc">
        Third-party apps installed on the device (<code>pm list packages -3 -f</code>).
        Launch or uninstall them. System apps are hidden.
      </p>

      <div className="row" style={{ marginBottom: 10 }}>
        <input
          placeholder="Filter by name or path…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <span className="muted" style={{ fontSize: 13 }}>
          {apps ? `${filtered?.length ?? 0} / ${apps.length}` : "—"}
        </span>
        <button onClick={() => void refresh()} disabled={busy}>
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {status && (
        <div className="banner info" style={{ margin: "0 0 12px" }}>
          {status}
        </div>
      )}
      {error && (
        <div className="banner error" style={{ margin: "0 0 12px" }}>
          {error}
        </div>
      )}

      {apps === null && !error && (
        <div className="muted" style={{ padding: "12px 0" }}>
          Loading package list…
        </div>
      )}

      {filtered && filtered.length > 0 && (
        <div className="file-list">
          <div className="row header">
            <div>Package</div>
            <div>APK path</div>
            <div>Actions</div>
          </div>
          {filtered.map((a) => (
            <div key={a.packageName} className="row" style={{ gridTemplateColumns: "1fr 1fr 160px" }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={a.packageName}>
                {a.packageName}
              </div>
              <div
                className="muted"
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={a.apkPath}
              >
                {a.apkPath}
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  onClick={() => void launch(a.packageName)}
                  disabled={pending !== null}
                  title="Launch the app"
                  style={{ padding: "4px 10px", fontSize: 12 }}
                >
                  ▶
                </button>
                <button
                  onClick={() => void uninstall(a.packageName)}
                  disabled={pending !== null}
                  title="Uninstall the app"
                  style={{
                    padding: "4px 10px",
                    fontSize: 12,
                    borderColor: "rgba(255, 107, 107, 0.4)",
                    color: "var(--danger)",
                  }}
                >
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {apps !== null && filtered && filtered.length === 0 && (
        <div className="muted" style={{ padding: "12px 0" }}>
          No apps match your filter.
        </div>
      )}
    </section>
  );
}