// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Replay Theater PS: Anthropic's Replay Theater sample, extended to changes made
// through the PowerShell and Bash tools, and to Windows paths.
//
// Edit, Write and MultiEdit are recorded as before. For a shell command:
//   1. Files the command names after a writing verb (Set-Content, Out-File, >,
//      Move-Item, Remove-Item, sed -i, mv, cp ...) are copied before it runs and
//      read again after, so they get a full diff.
//   2. After it runs, one scan of the working folder finds any other file
//      written since the command started. If Claude had read or edited that file
//      earlier in the session, it is diffed against that copy; otherwise it is
//      listed with its new content and "before-copy not available".

const PANE_ID = "replay-theater";
const MAX_DIFF_LINES = 12;
const MAX_LCS_LINES = 400;
const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_CACHE_FILES = 300;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const PS = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
const SKIP_DIRS = [".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", ".next", ".cache", ".tox", ".claude", ".tmp.drivedownload", ".tmp.driveupload"];

// Module state. `pending` fills during a turn; `replay` is the last finished
// turn's steps, the ones the pane shows. `cache` holds the last text seen of
// each file, keyed by its lowercased absolute path.
const state = { pending: [], replay: [], index: 0, isOpen: false, inBand: false, turns: 0, full: false };
const cache = new Map();
let inflight = [];
let windows = null;

async function isWindows($) {
  if (windows === null) {
    windows = (await $.env.get("OS")) === "Windows_NT";
  }
  return windows;
}

function isAbsolute(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

/** An absolute path for `p`, Git Bash's /c/... turned into C:\... on Windows. */
function absPath(cwd, p, win) {
  let path = String(p).trim();
  if (win) {
    const m = path.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (m) {
      path = `${m[1].toUpperCase()}:${(m[2] ?? "/").replace(/\//g, "\\")}`;
    }
  }
  if (isAbsolute(path)) {
    return path;
  }
  const sep = win ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${sep}${path.replace(/^\.[\\/]/, "")}`;
}

function key(path) {
  return path.replace(/\//g, "\\").toLowerCase();
}

function relPath(cwd, path) {
  if (!path) return "(unknown file)";
  if (!cwd) return path;
  const base = cwd.replace(/[\\/]+$/, "");
  if (path.length > base.length + 1 && path.slice(0, base.length).toLowerCase() === base.toLowerCase() && /[\\/]/.test(path[base.length])) {
    return path.slice(base.length + 1);
  }
  return path;
}

function remember(path, text) {
  if (typeof text !== "string" || text.length > MAX_CACHE_BYTES || text.includes("\u0000")) {
    cache.delete(key(path));
    return;
  }
  cache.delete(key(path));
  cache.set(key(path), text);
  if (cache.size > MAX_CACHE_FILES) {
    cache.delete(cache.keys().next().value);
  }
}

/** The file's text, or null when it is missing, too big or binary. */
async function readText($, path) {
  try {
    const st = await $.fs.stat(path);
    if (st.kind !== "file" || st.size > MAX_CACHE_BYTES) return null;
    const text = await $.fs.read(path);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

function splitLines(text) {
  if (text === undefined || text === null || text === "") return [];
  const lines = String(text).split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// A line diff. Small inputs get an LCS diff, so unchanged lines show as
// context; large ones fall back to all-removed then all-added.
function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [...a.map((t) => ({ op: "-", t })), ...b.map((t) => ({ op: "+", t }))];
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: " ", t: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", t: a[i++] });
    else out.push({ op: "+", t: b[j++] });
  }
  while (i < n) out.push({ op: "-", t: a[i++] });
  while (j < m) out.push({ op: "+", t: b[j++] });
  return trimContext(out);
}

function trimContext(lines) {
  if (!lines.some((l) => l.op !== " ")) return lines.slice(0, MAX_DIFF_LINES);
  const keep = lines.map((l, k) =>
    l.op !== " " || lines[k - 1]?.op && lines[k - 1].op !== " " || lines[k + 1]?.op && lines[k + 1].op !== " ");
  const out = [];
  let skipped = false;
  lines.forEach((l, k) => {
    if (keep[k]) { if (skipped && out.length) out.push({ op: "~", t: "⋯" }); out.push(l); skipped = false; }
    else skipped = true;
  });
  return out;
}

function countChanges(diff) {
  let add = 0, del = 0;
  for (const l of diff) { if (l.op === "+") add++; else if (l.op === "-") del++; }
  return { add, del };
}

// ---- Edit tools -------------------------------------------------------------

async function stepsFor($, e, cwd) {
  const file = relPath(cwd, e.file_path);
  if (e.tool === "Edit") {
    return [{ tool: "Edit", file, diff: diffLines(e.old_string, e.new_string), note: e.replace_all ? "replace all" : "" }];
  }
  if (e.tool === "MultiEdit" && Array.isArray(e.edits)) {
    return e.edits.map((ed, k) => ({
      tool: "MultiEdit", file, diff: diffLines(ed.old_string, ed.new_string), note: `edit ${k + 1} of ${e.edits.length}`,
    }));
  }
  if (e.tool === "Write") {
    const before = e.file_path ? await readText($, e.file_path) : null;
    return [{ tool: "Write", file, diff: diffLines(before ?? "", e.content), note: before === null ? "new file" : "rewrite" }];
  }
  return [];
}

// ---- Shell commands -----------------------------------------------------------

const PS_WRITERS = new Set([
  "set-content", "sc", "add-content", "ac", "out-file", "clear-content", "clc", "new-item", "ni",
  "copy-item", "cp", "copy", "cpi", "move-item", "mv", "move", "mi", "rename-item", "ren", "rni",
  "remove-item", "ri", "rm", "del", "erase", "rd", "rmdir", "tee-object", "tee",
]);
const BASH_WRITERS = new Set(["mv", "cp", "rm", "touch", "tee", "truncate", "sed", "perl", "dos2unix", "unix2dos"]);
// Parameters whose value is text, not a path.
const VALUE_PARAMS = /^-(value|encoding|itemtype|type|newname|stream|filter|include|exclude|credential|inputobject|width|delimiter)$/i;

function words(text) {
  const out = [];
  const re = /"((?:[^"\\`]|[\\`].)*)"|'((?:[^']|'')*)'|([^\s;|&(){}]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1] ?? (m[2] !== undefined ? m[2].replace(/''/g, "'") : m[3]));
  }
  return out;
}

/** Paths a shell command names as things it writes, moves or deletes (best effort). */
function writeTargets(command, isPs) {
  const found = new Set();
  for (const m of command.matchAll(/\d?>>?\s*("([^"]+)"|'([^']+)'|([^\s;|&)]+))/g)) {
    const p = m[2] ?? m[3] ?? m[4];
    if (p && !/^(&\d|\$null|nul|\/dev\/null)$/i.test(p)) found.add(p);
  }
  for (const m of command.matchAll(/\[(?:System\.)?IO\.File\]::\w+\(\s*["']([^"']+)["']/gi)) {
    found.add(m[1]);
  }
  for (const segment of command.split(/&&|\|\||;|\||\r?\n/)) {
    const w = words(segment.trim());
    if (w.length === 0) continue;
    const verb = w[0].toLowerCase().replace(/\.exe$/, "");
    const writers = isPs ? PS_WRITERS : BASH_WRITERS;
    if (!writers.has(verb) && !(isPs && BASH_WRITERS.has(verb))) continue;
    for (let i = 1; i < w.length; i += 1) {
      const a = w[i];
      if (VALUE_PARAMS.test(a)) { i += 1; continue; }
      if (a.startsWith("-") || /^\d?>>?$/.test(a)) continue;
      if (/^\$/.test(a) || /^s[/|#]/.test(a)) continue; // variables and sed scripts
      found.add(a);
    }
  }
  return [...found].slice(0, 20);
}

const PS_SCAN = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
$since = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$in.since).UtcDateTime
$skip = @{}; foreach ($s in $in.skip) { $skip[$s.ToLower()] = $true }
$deadline = (Get-Date).AddSeconds(8); $seen = 0; $partial = $false
$changed = New-Object System.Collections.ArrayList
$stack = New-Object System.Collections.Stack
$stack.Push($in.root)
while ($stack.Count -gt 0 -and -not $partial) {
  $d = New-Object System.IO.DirectoryInfo ($stack.Pop())
  try {
    foreach ($f in $d.EnumerateFiles()) {
      $seen++
      if ($f.LastWriteTimeUtc -ge $since -and $changed.Count -lt 40) { [void]$changed.Add($f.FullName) }
      if ($seen -gt 30000 -or (Get-Date) -gt $deadline) { $partial = $true; break }
    }
    foreach ($s in $d.EnumerateDirectories()) {
      if ($skip.ContainsKey($s.Name.ToLower())) { continue }
      if ($s.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
      $stack.Push($s.FullName)
    }
  } catch {}
}
@{ changed = @($changed); partial = $partial } | ConvertTo-Json -Compress
`;

/** Files under `root` written at or after `since` (ms), skipping tool folders. */
async function scanChanged($, root, since) {
  if (await isWindows($)) {
    const run = await $.process.run([...PS, PS_SCAN], { cwd: root, stdin: JSON.stringify({ root, since, skip: SKIP_DIRS }), timeoutMs: 20000 });
    try {
      return JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}").changed ?? [];
    } catch {
      return [];
    }
  }
  const prune = SKIP_DIRS.flatMap((d, i) => (i === 0 ? ["-name", d] : ["-o", "-name", d]));
  const run = await $.process.run(
    ["find", root, "-type", "d", "(", ...prune, ")", "-prune", "-o", "-type", "f", "-newermt", `@${Math.floor(since / 1000)}`, "-print"],
    { timeoutMs: 20000 },
  );
  return run.stdout.split("\n").filter(Boolean).slice(0, 40);
}

/** Runs one shell call, then records what it changed. */
async function recordShell($, e, next) {
  const win = await isWindows($);
  let cwd = "";
  try { cwd = await $.session.cwd(); } catch { return next(e); }
  const isPs = e.tool === "PowerShell";
  const label = isPs ? "PowerShell" : "Bash";
  const command = String(e.command ?? "");
  const named = writeTargets(command, isPs).map((p) => absPath(cwd, p, win));
  const before = new Map();
  for (const path of named) {
    before.set(key(path), { path, text: await readText($, path), existed: await $.fs.exists(path).catch(() => false) });
  }
  const since = (await $.clock.now()) - 1500;
  const result = await next(e);
  if (e.run_in_background) return result;

  const work = (async () => {
    const steps = [];
    const done = new Set();
    for (const b of before.values()) {
      const nowText = await readText($, b.path);
      const exists = await $.fs.exists(b.path).catch(() => false);
      done.add(key(b.path));
      if (!b.existed && !exists) continue;
      if (b.existed && !exists) {
        steps.push({ tool: label, file: relPath(cwd, b.path), diff: diffLines(b.text ?? "", ""), note: b.text === null ? "deleted (content not readable)" : "deleted" });
        cache.delete(key(b.path));
        continue;
      }
      if (nowText === null) continue;
      if (b.text === nowText) continue;
      steps.push({ tool: label, file: relPath(cwd, b.path), diff: diffLines(b.text ?? "", nowText), note: b.existed ? "full diff" : "new file" });
      remember(b.path, nowText);
    }
    let others = [];
    try { others = await scanChanged($, cwd, since); } catch { others = []; }
    for (const path of others) {
      if (done.has(key(path))) continue;
      const nowText = await readText($, path);
      if (nowText === null) {
        steps.push({ tool: label, file: relPath(cwd, path), diff: [], note: "changed (binary or too big to show)" });
        continue;
      }
      const old = cache.get(key(path));
      if (old === nowText) continue;
      steps.push({
        tool: label,
        file: relPath(cwd, path),
        diff: diffLines(old ?? "", nowText),
        note: old === undefined ? "changed by shell, before-copy not available" : "full diff (against the copy Claude last saw)",
      });
      remember(path, nowText);
    }
    state.pending.push(...steps);
  })().catch(() => { /* recording must never break the session */ });
  inflight.push(work);
  return result;
}

// ---- The view --------------------------------------------------------------

function hintText() {
  const n = state.replay.length;
  return `▶ Replay: ${n} change${n === 1 ? "" : "s"} (press r)`;
}

async function openReplay($) {
  if (!state.replay.length) return false;
  state.index = 0;
  state.isOpen = true;
  $.ui.invalidate("ui.render");
  await $.clock.sleep(200);
  const rows = Math.min(MAX_DIFF_LINES + 8, 22);
  const placed = await $.ui.open({ id: PANE_ID, title: "Replay Theater", focus: true, closeOnEscape: true, rows, columns: 64 });
  state.inBand = placed?.isPlaced === false;
  $.ui.invalidate("ui.render");
  return true;
}

const FULL_MAX_LINES = 400;

// Sized from the pane's own width (e.props.bodyColumns), so a narrow side pane
// wraps the controls instead of pushing them out. "▾ N more lines" expands the
// diff in place; the pane scrolls when it is taller than its room.
function replayView($, e, inBand) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const total = state.replay.length;
  if (!total) return Text({ dimColor: true, children: "No changes to replay." });
  const k = Math.max(0, Math.min(state.index, total - 1));
  const step = state.replay[k];
  const cols = e.props.bodyColumns ?? 100;
  const width = Math.max(20, cols - 4);
  const narrow = cols < 50;
  const short = inBand ? Math.max(3, Math.min(MAX_DIFF_LINES, (e.props.maxRows || 20) - 8)) : MAX_DIFF_LINES;
  const maxDiff = state.full ? FULL_MAX_LINES : short;
  const { add, del } = countChanges(step.diff);
  const shown = step.diff.slice(0, maxDiff);
  const viaShell = SHELL_TOOLS.has(step.tool);
  const redraw = () => $.ui.invalidate("ui.render");

  const diffRows = shown.map((l, n) => {
    const color = l.op === "+" ? "green" : l.op === "-" ? "red" : undefined;
    const line = `${l.op === "~" ? " " : l.op} ${l.t}`.slice(0, Math.max(width, 200));
    return Text({ key: `d${n}`, color, dimColor: l.op === " " || l.op === "~", wrap: "truncate-end", children: line });
  });
  if (step.diff.length > maxDiff) {
    diffRows.push(Button({ key: "more", label: `▾ ${step.diff.length - maxDiff} more lines`, plain: true, dimColor: true, onPress: () => { state.full = true; redraw(); } }));
  } else if (state.full && step.diff.length > short) {
    diffRows.push(Button({ key: "less", label: "▴ show less", plain: true, dimColor: true, onPress: () => { state.full = false; redraw(); } }));
  }
  if (!shown.length) diffRows.push(Text({ key: "empty", dimColor: true, children: "  (no line changes to show)" }));

  const strip = state.replay.map((s, n) =>
    Text({ key: `s${n}`, inverse: n === k, color: n === k ? "cyan" : SHELL_TOOLS.has(s.tool) ? "yellow" : undefined, dimColor: n !== k, children: ` ${n + 1} ` }));

  const go = (to) => { state.index = Math.max(0, Math.min(to, total - 1)); state.full = false; redraw(); };
  const close = () => {
    state.isOpen = false;
    state.full = false;
    if (!state.inBand) $.ui.close({ id: PANE_ID });
    state.inBand = false;
    redraw();
  };

  return Box({
    flexDirection: "column", borderStyle: "round", borderColor: "magenta", paddingX: 1,
    children: [
      Box({ key: "head", flexDirection: narrow ? "column" : "row", justifyContent: "space-between", children: [
        Text({ key: "t", bold: true, color: "magenta", children: "▶ Replay Theater" }),
        Text({ key: "k", bold: true, children: `step ${k + 1} of ${total}` }),
      ] }),
      Box({ key: "strip", flexDirection: "row", flexWrap: "wrap", children: strip }),
      Text({ key: "file", bold: true, color: "cyan", wrap: "truncate-start", children: step.file }),
      Box({ key: "meta", flexDirection: "row", flexWrap: "wrap", columnGap: 2, children: [
        Text({ key: "via", color: viaShell ? "yellow" : undefined, dimColor: !viaShell, wrap: "truncate-end", children: `${viaShell ? "via " : ""}${step.tool}${step.note ? " · " + step.note : ""}` }),
        Text({ key: "add", color: "green", children: `+${add}` }),
        Text({ key: "del", color: "red", children: `-${del}` }),
      ] }),
      Box({ key: "diff", flexDirection: "column", marginTop: 1, children: diffRows }),
      Box({ key: "nav", flexDirection: "row", flexWrap: "wrap", gap: narrow ? 1 : 2, marginTop: 1, children: [
        Button({ key: "prev", label: narrow ? "◀" : "◀ Prev", hotkey: "p", onPress: () => go(k - 1) }),
        Button({ key: "next", label: narrow ? "▶" : "Next ▶", hotkey: "n", autoFocus: true, onPress: () => go(k + 1) }),
        Button({ key: "close", label: narrow ? "✕" : "Close", hotkey: "c", onPress: close }),
      ] }),
    ],
  });
}

export function register(on, options) {
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    await $.command.register({ name: "replay", description: "Replay Theater: step through the last turn's file changes (edits and shell)" });
    return r;
  });

  on("command.run", { command: "replay" }, async ($, e) => {
    const opened = await openReplay($);
    return { text: opened ? `Replay Theater: ${state.replay.length} changes` : "Replay Theater: no changes in the last turn." };
  });

  // Record each change, then let it run. Never blocks the call.
  on("tool.call", async ($, e, next) => {
    if (SHELL_TOOLS.has(e.tool)) {
      return recordShell($, e, next);
    }
    if (EDIT_TOOLS.has(e.tool)) {
      let cwd = "";
      try { cwd = await $.session.cwd(); } catch { /* keep full paths */ }
      try {
        state.pending.push(...(await stepsFor($, e, cwd)));
      } catch { /* recording must never stop the edit */ }
      const r = await next(e);
      if (e.file_path) remember(e.file_path, await readText($, e.file_path));
      return r;
    }
    if (e.tool === "Read" && e.file_path) {
      const r = await next(e);
      if (!cache.has(key(e.file_path))) remember(e.file_path, await readText($, e.file_path));
      return r;
    }
    return next(e);
  }).catch(($, e, next) => next(e));

  on("turn.start", ($, e, next) => {
    if (!e.agentId) {
      state.pending = [];
      inflight = [];
    }
    return next(e);
  });

  // At the end of a main-loop turn, the pending changes become the replay.
  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (e.agentId) return r;
    if (inflight.length) {
      await Promise.all(inflight);
      inflight = [];
    }
    if (!state.pending.length) return r;
    state.replay = state.pending;
    state.pending = [];
    state.index = 0;
    state.turns++;
    // Shared so the mod bar's toolbar button can show the count and its own view.
    const shared = state.replay.slice(0, 60).map((st) => ({ tool: st.tool, file: st.file, note: st.note ?? "", diff: st.diff.slice(0, FULL_MAX_LINES) }));
    await $.state.set({ plugin: "replay-theater-ps", key: "steps" }, shared).catch(() => undefined);
    $.ui.invalidate("ui.render");
    return r;
  });

  // No hint line of its own any more: the toolbar's "▶ Replay · N" button shows
  // the count. Only the band fallback of the open replay (no room for a pane) is drawn here.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (state.isOpen && state.inBand) return replayView($, e, true);
    return next(e);
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);
    return replayView($, e, false);
  });

  on("ui.close", ($, e, next) => {
    if (e.id === PANE_ID || e.requestId === PANE_ID) state.isOpen = false;
    $.ui.invalidate("ui.render");
    return next(e);
  });
}
