/**
 * 桌面音频与音乐陪听 MSP World（缝合 cortico-world-music 与 better-cortico-world-netease-companion）：
 * - 跨平台媒体会话读取（Windows SMTC / macOS AppleScript / Linux MPRIS playerctl）
 * - LRCLIB 同步歌词获取与当前句定位
 * - 播放控制（需显式调用）
 * - 工具：music_now_playing, music_recent_tracks, music_lyrics, music_control, music_watch, music_mode
 * - 信号：music.started, music.switch, music.paused
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MSPNode } from "../shared/msp.ts";

const execFileAsync = promisify(execFile);

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface TrackInfo {
  title: string;
  artist: string;
  album?: string;
  player?: string;
  status: "playing" | "paused" | "stopped";
  positionSec?: number;
  durationSec?: number;
  observedAt: string;
}

export interface LrcLine {
  timeSec: number;
  text: string;
}

export interface MusicWorldOptions {
  pollIntervalMs?: number;
  allowControl?: boolean;
  readSystemMedia?: () => Promise<TrackInfo | null>;
  controlSystemMedia?: (action: "play" | "pause" | "next" | "previous") => Promise<void>;
  fetchImpl?: FetchImpl;
}

export function parseLrc(lrc: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const m = /^\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.*)$/.exec(raw.trim());
    if (!m) continue;
    const min = Number(m[1]);
    const sec = Number(m[2]);
    const ms = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
    const text = m[4].trim();
    if (text) lines.push({ timeSec: min * 60 + sec + ms / 1000, text });
  }
  return lines.sort((a, b) => a.timeSec - b.timeSec);
}

const WIN_SMTC_READ_PS = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sess = $mgr.GetCurrentSession()
if ($null -eq $sess) { exit 0 }
$props = Await ($sess.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$info = $sess.GetPlaybackInfo()
$tl = $sess.GetTimelineProperties()
[PSCustomObject]@{
  title = $props.Title
  artist = $props.Artist
  album = $props.AlbumTitle
  player = $sess.SourceAppUserModelId
  status = [int]$info.PlaybackStatus
  positionSec = [math]::Round($tl.Position.TotalSeconds, 2)
  durationSec = [math]::Round($tl.EndTime.TotalSeconds, 2)
} | ConvertTo-Json -Compress
`.trim();

function buildWinSmtcControlPs(action: "play" | "pause" | "next" | "previous"): string {
  const method =
    action === "play"
      ? "TryPlayAsync"
      : action === "pause"
        ? "TryPauseAsync"
        : action === "next"
          ? "TrySkipNextAsync"
          : "TrySkipPreviousAsync";
  return `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sess = $mgr.GetCurrentSession()
if ($null -eq $sess) { throw "No active SMTC media session" }
Await ($sess.${method}()) ([bool]) | Out-Null
`.trim();
}

const MAC_MEDIA_READ_AS = `
if application "Spotify" is running then
  tell application "Spotify"
    set st to player state as string
    if st is "stopped" then return ""
    set t to name of current track
    set a to artist of current track
    set al to album of current track
    set p to player position
    set d to (duration of current track) / 1000
    return "Spotify" & tab & st & tab & t & tab & a & tab & al & tab & p & tab & d
  end tell
else if application "Music" is running then
  tell application "Music"
    set st to player state as string
    if st is "stopped" then return ""
    set t to name of current track
    set a to artist of current track
    set al to album of current track
    set p to player position
    set d to duration of current track
    return "Music" & tab & st & tab & t & tab & a & tab & al & tab & p & tab & d
  end tell
end if
return ""
`.trim();

function buildMacMediaControlAs(action: "play" | "pause" | "next" | "previous"): string {
  const cmd =
    action === "play"
      ? "play"
      : action === "pause"
        ? "pause"
        : action === "next"
          ? "next track"
          : "previous track";
  return `
if application "Spotify" is running then
  tell application "Spotify" to ${cmd}
else if application "Music" is running then
  tell application "Music" to ${cmd}
else
  error "No supported macOS media player (Spotify / Music) is running"
end if
`.trim();
}

async function defaultReadSystemMedia(): Promise<TrackInfo | null> {
  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync("playerctl", [
        "metadata",
        "--format",
        "{{status}}\t{{playerName}}\t{{title}}\t{{artist}}\t{{album}}\t{{position}}\t{{mpris:length}}",
      ]);
      const [statusRaw, player, title, artist, album, posUs, lenUs] = stdout.trim().split("\t");
      if (!title) return null;
      const status = statusRaw?.toLowerCase() === "playing" ? "playing" : statusRaw?.toLowerCase() === "paused" ? "paused" : "stopped";
      return {
        title,
        artist: artist || "Unknown",
        album: album || undefined,
        player: player || "mpris",
        status,
        positionSec: posUs ? Number(posUs) / 1e6 : undefined,
        durationSec: lenUs ? Number(lenUs) / 1e6 : undefined,
        observedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WIN_SMTC_READ_PS,
      ]);
      const trimmed = stdout.trim();
      if (!trimmed) return null;
      const data = JSON.parse(trimmed) as {
        title?: string;
        artist?: string;
        album?: string;
        player?: string;
        status?: number;
        positionSec?: number;
        durationSec?: number;
      };
      if (!data.title) return null;
      const status = data.status === 4 ? "playing" : data.status === 5 ? "paused" : "stopped";
      return {
        title: data.title,
        artist: data.artist || "Unknown",
        album: data.album || undefined,
        player: data.player || "smtc",
        status,
        positionSec: typeof data.positionSec === "number" ? data.positionSec : undefined,
        durationSec: typeof data.durationSec === "number" && data.durationSec > 0 ? data.durationSec : undefined,
        observedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", MAC_MEDIA_READ_AS]);
      const trimmed = stdout.trim();
      if (!trimmed) return null;
      const [player, statusRaw, title, artist, album, posStr, durStr] = trimmed.split("\t");
      if (!title) return null;
      const status = statusRaw?.toLowerCase() === "playing" ? "playing" : statusRaw?.toLowerCase() === "paused" ? "paused" : "stopped";
      const pos = posStr ? Number(posStr) : undefined;
      const dur = durStr ? Number(durStr) : undefined;
      return {
        title,
        artist: artist || "Unknown",
        album: album || undefined,
        player: player || "macos",
        status,
        positionSec: pos !== undefined && Number.isFinite(pos) ? pos : undefined,
        durationSec: dur !== undefined && Number.isFinite(dur) && dur > 0 ? dur : undefined,
        observedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  return null;
}

async function defaultControlSystemMedia(action: "play" | "pause" | "next" | "previous"): Promise<void> {
  if (process.platform === "linux") {
    await execFileAsync("playerctl", [action]);
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", buildWinSmtcControlPs(action)]);
    return;
  }
  if (process.platform === "darwin") {
    await execFileAsync("osascript", ["-e", buildMacMediaControlAs(action)]);
    return;
  }
  throw new Error(`当前平台 (${process.platform}) 暂未配置系统媒体控制适配器`);
}

export class MusicWorld {
  private readonly opts: Required<
    Pick<MusicWorldOptions, "pollIntervalMs" | "allowControl" | "readSystemMedia" | "controlSystemMedia" | "fetchImpl">
  >;
  private node: MSPNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: TrackInfo | null = null;
  private recent: TrackInfo[] = [];
  private watching = false;
  private mode: "end" | "live" | "both" = "both";
  private lyricsCache = new Map<string, LrcLine[]>();

  constructor(options: MusicWorldOptions = {}) {
    this.opts = {
      pollIntervalMs: options.pollIntervalMs ?? 3000,
      allowControl: options.allowControl ?? true,
      readSystemMedia: options.readSystemMedia ?? defaultReadSystemMedia,
      controlSystemMedia: options.controlSystemMedia ?? defaultControlSystemMedia,
      fetchImpl: options.fetchImpl ?? ((u, i) => fetch(u, i)),
    };
  }

  attach(node: MSPNode): void {
    this.node = node;
    node.declareSignal("music.started", "开始播放或进入听歌模式");
    node.declareSignal("music.switch", "曲目切换");
    node.declareSignal("music.paused", "播放暂停或停止");

    node.tool(
      "music_now_playing",
      "读取当前本机正在播放的曲目、歌手、播放器与进度",
      async () => {
        await this.pollOnce();
        return { watching: this.watching, mode: this.mode, current: this.current };
      },
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "music_recent_tracks",
      "列出本次运行观察到的最近 20 首曲目",
      () => ({ count: this.recent.length, tracks: [...this.recent].reverse() }),
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "music_lyrics",
      "获取当前曲目的同步 LRC 歌词（LRCLIB）并定位当前播放句",
      async () => this.getLyrics(),
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.tool(
      "music_control",
      "控制本机播放器（play/pause/next/previous），仅在用户明确要求时调用",
      async (args) => {
        if (!this.opts.allowControl) throw new Error("音乐播放控制已在配置中禁用");
        const action = String(args.action ?? "") as "play" | "pause" | "next" | "previous";
        if (!["play", "pause", "next", "previous"].includes(action)) throw new Error("非法控制动作");
        await this.opts.controlSystemMedia(action);
        return { ok: true, action };
      },
      {
        type: "object",
        required: ["action"],
        properties: { action: { type: "string", enum: ["play", "pause", "next", "previous"] } },
      },
    );

    node.tool(
      "music_watch",
      "开启、停止或查询桌面音频陪听监听状态",
      async (args) => {
        const action = String(args.action ?? "status");
        if (action === "start") {
          this.watching = true;
          await this.pollOnce();
        } else if (action === "stop") {
          this.watching = false;
        }
        return { watching: this.watching, mode: this.mode, current: this.current };
      },
      {
        type: "object",
        required: ["action"],
        properties: { action: { type: "string", enum: ["start", "stop", "status"] } },
      },
    );

    node.tool(
      "music_mode",
      "设置听歌感受投递模式（end / live / both）",
      (args) => {
        const m = String(args.mode ?? "");
        if (m !== "end" && m !== "live" && m !== "both") throw new Error("mode 仅支持 end / live / both");
        this.mode = m;
        return { mode: this.mode };
      },
      {
        type: "object",
        required: ["mode"],
        properties: { mode: { type: "string", enum: ["end", "live", "both"] } },
      },
    );
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    if (this.opts.pollIntervalMs > 0) {
      this.timer = setInterval(() => void this.pollOnce(), this.opts.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<void> {
    const next = await this.opts.readSystemMedia().catch(() => null);
    if (!next) {
      if (this.current && this.current.status === "playing") {
        this.current = { ...this.current, status: "stopped" };
        this.node?.publish("music.paused", { track: this.current });
      }
      return;
    }

    const prev = this.current;
    this.current = next;

    const sameTrack = prev && prev.title === next.title && prev.artist === next.artist;
    if (!prev && next.status === "playing") {
      this.pushRecent(next);
      this.node?.publish("music.started", { track: next });
    } else if (prev && !sameTrack && next.status === "playing") {
      this.pushRecent(next);
      this.node?.publish("music.switch", { from: prev, to: next });
    } else if (prev && prev.status === "playing" && next.status !== "playing") {
      this.node?.publish("music.paused", { track: next });
    }
  }

  private pushRecent(t: TrackInfo): void {
    this.recent.push(t);
    if (this.recent.length > 20) this.recent.shift();
  }

  private async getLyrics(): Promise<Record<string, unknown>> {
    if (!this.current) return { available: false, reason: "当前没有检测到曲目" };
    const key = `${this.current.artist}::${this.current.title}`;
    let lines = this.lyricsCache.get(key);
    if (!lines) {
      const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(this.current.title)}&artist_name=${encodeURIComponent(this.current.artist)}`;
      const res = await this.opts.fetchImpl(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (!res || !res.ok) return { available: false, track: this.current };
      const json = (await res.json()) as { syncedLyrics?: string; plainLyrics?: string };
      if (json.syncedLyrics) {
        lines = parseLrc(json.syncedLyrics);
        this.lyricsCache.set(key, lines);
      } else {
        return { available: Boolean(json.plainLyrics), plainLyrics: json.plainLyrics ?? null, track: this.current };
      }
    }

    const pos = this.current.positionSec ?? 0;
    let currentLine: LrcLine | null = null;
    for (const l of lines) {
      if (l.timeSec <= pos) currentLine = l;
      else break;
    }
    return {
      available: lines.length > 0,
      track: this.current,
      currentLine,
      linesCount: lines.length,
    };
  }
}
