"use client";

import { useState, useRef, useEffect, type FormEvent } from "react";
import type { AdbSession } from "@/lib/adb-client";
import { escapeArg } from "@yume-chan/adb";

interface Props {
  session: AdbSession;
}

/**
 * Run a one-shot command and collect its stdout. Prefers Shell V2 (separate
 * stderr + exit code), falls back to "none" protocol otherwise. Lifted out of
 * the component so the same helper can be reused elsewhere.
 */
async function runCommand(
  session: AdbSession,
  args: readonly string[],
): Promise<string> {
  const shell = session.adb.subprocess.shellProtocol;
  if (shell && shell.isSupported) {
    // `shell.spawn` is typed as `AdbShellProtocolSpawner`, which returns a
    // Promise that ALSO has a `.wait()` method (added dynamically by the
    // spawner implementation). If we `await` first we lose the typed
    // access to `.wait()`, so we call `.wait()` directly on the returned
    // spawner object.
    const wait = await shell.spawn(args).wait();
    const stdout = await wait.stdout.toString();
    if (wait.exitCode !== 0) {
      const stderr = await wait.stderr.toString();
      throw new Error(
        `Command exited with code ${wait.exitCode}\n` +
          (stderr.trim() || stdout.trim() || "(no output)"),
      );
    }
    return stdout;
  }
  // Fallback: none protocol — read mixed output until process exits.
  const proc = await session.adb.subprocess.noneProtocol.spawn(args);
  const decoder = new TextDecoder();
  let text = "";
  const reader = proc.output.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  await proc.exited;
  return text;
}

export function ShellPanel({ session }: Props) {
  const [history, setHistory] = useState<string[]>([
    "# Shell session — type a command and press Enter.",
    "# Examples: 'getprop ro.build.version.release', 'ls /sdcard', 'pm list packages'",
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const outRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [history]);

  async function run(cmd: string) {
    const trimmed = cmd.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setHistory((h) => [...h, `$ ${trimmed}`]);
    setInput("");
    try {
      const args = tokenize(trimmed);
      const out = await runCommand(session, args);
      const text = out.trimEnd();
      setHistory((h) => [...h, text.length ? text : "(no output)"]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setHistory((h) => [...h, `! error: ${msg}`]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void run(input);
  }

  return (
    <section className="panel">
      <h2>Shell</h2>
      <p className="panel-desc">
        Run commands on the device. Uses the &quot;none&quot; protocol — non-interactive,
        returns when the command finishes.
      </p>
      <div ref={outRef} className="shell-output">
        {history.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
        {busy && <div className="muted">…running…</div>}
      </div>
      <form className="shell-input-row" onSubmit={onSubmit}>
        <span className="mono muted" style={{ alignSelf: "center" }}>$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? "running…" : "getprop ro.product.model"}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          aria-label="shell command"
        />
        <button type="submit" className="primary" disabled={busy || !input.trim()}>
          Run
        </button>
      </form>
    </section>
  );
}

/**
 * Naive shell-style tokenizer — splits on whitespace but respects single/double
 * quotes. For the kind of commands users type into WebADB (ls -la /path, etc.)
 * this is enough. If we ever need a real lexer we can swap this out.
 */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) {
        q = null;
      } else {
        cur += c;
      }
    } else if (c === "'" || c === '"') {
      q = c;
    } else if (/\s/.test(c)) {
      if (cur.length) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += c;
    }
  }
  if (cur.length) out.push(cur);
  // Escape each argument so ADB receives it correctly when the daemon joins
  // the command back together server-side.
  return out.map(escapeArg);
}