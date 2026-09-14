import { RealtimeSttSession, type RealtimeToken, type SttSessionConfig } from "@soniox/client";

/**
 * Thin wrapper around one Soniox `RealtimeSttSession` (SDK decision locked in P01 —
 * DIY WS protocol was wrong 3 times in the POC, see `docs/soniox-integration-notes.md`).
 *
 * The real SDK class is hidden behind `SonioxSessionLike` + an injectable
 * `SonioxSessionFactory` so tests never touch a real WebSocket/network — pass a fake
 * factory that returns an object implementing the same minimal surface.
 */

const SONIOX_WS_URL_PRODUCTION = "wss://stt-rt.soniox.com/transcribe-websocket";

/**
 * Endpoint WS Soniox.
 *
 * Override `NEXT_PUBLIC_SONIOX_WS_URL` CHỈ có hiệu lực ngoài production — nó tồn tại
 * để E2E trỏ sang mock server local, không phải để cấu hình vận hành.
 *
 * VÌ SAO PHẢI GUARD (code review P07, H1): thiếu guard thì chỉ cần set 1 biến env trên
 * Vercel là bẻ HƯỚNG toàn bộ audio live + temp key Soniox sang host bất kỳ, KHÔNG cần
 * deploy lại code — biến tiện ích cho test thành đường exfil. Production luôn dùng
 * endpoint thật, không có cách nào override.
 */
export const SONIOX_WS_URL =
  process.env.NODE_ENV === "production"
    ? SONIOX_WS_URL_PRODUCTION
    : process.env.NEXT_PUBLIC_SONIOX_WS_URL || SONIOX_WS_URL_PRODUCTION;

export interface SonioxSessionHandlers {
  onToken?: (token: RealtimeToken) => void;
  onEndpoint?: () => void;
  onFinished?: () => void;
  onError?: (error: Error) => void;
  onDisconnected?: (reason?: string) => void;
  onConnected?: () => void;
}

/** Minimal surface connection.ts needs from a session — matches RealtimeSttSession's
 *  public API (connect/sendAudio/finish/close/on) but as a small interface so a fake can
 *  implement it without pulling in the real SDK/network. */
export interface SonioxSessionLike {
  connect(): Promise<void>;
  sendAudio(data: Uint8Array | ArrayBuffer): void;
  finish(): Promise<void>;
  close(): void;
  on(event: string, handler: (...args: never[]) => void): unknown;
}

export type SonioxSessionFactory = (config: SttSessionConfig, apiKey: string) => SonioxSessionLike;

/** Default factory — real SDK session bound to the production WS endpoint. */
export const createSdkSession: SonioxSessionFactory = (config, apiKey) =>
  new RealtimeSttSession(apiKey, SONIOX_WS_URL, config) as unknown as SonioxSessionLike;

export interface SonioxConnectionOptions {
  config: SttSessionConfig;
  /** Log/debug label, e.g. "mic-canonical". Never used for anything semantic. */
  label: string;
  sessionFactory?: SonioxSessionFactory;
  /** Injectable clock for epoch_conn — defaults to Date.now. */
  now?: () => number;
}

export class SonioxConnection {
  readonly label: string;
  private readonly config: SttSessionConfig;
  private readonly sessionFactory: SonioxSessionFactory;
  private readonly now: () => number;
  private session: SonioxSessionLike | null = null;
  private epochConnMs: number | null = null;
  private handlers: SonioxSessionHandlers = {};

  constructor(opts: SonioxConnectionOptions) {
    this.config = opts.config;
    this.label = opts.label;
    this.sessionFactory = opts.sessionFactory ?? createSdkSession;
    this.now = opts.now ?? Date.now;
  }

  setHandlers(handlers: SonioxSessionHandlers): void {
    this.handlers = handlers;
  }

  /** Opens the WS session and resolves once connected — caller (fanout.ts) awaits ALL
   *  connections being ready before feeding any audio (§Architecture). */
  async open(apiKey: string): Promise<void> {
    const session = this.sessionFactory(this.config, apiKey);
    session.on("token", (token: RealtimeToken) => this.handlers.onToken?.(token));
    session.on("endpoint", () => this.handlers.onEndpoint?.());
    session.on("finished", () => this.handlers.onFinished?.());
    session.on("error", (err: Error) => this.handlers.onError?.(err));
    session.on("disconnected", (reason?: string) => this.handlers.onDisconnected?.(reason));
    session.on("connected", () => this.handlers.onConnected?.());
    this.session = session;
    await session.connect();
  }

  /** Feeds one PCM16 chunk. Records epoch_conn (client clock at FIRST feed) per
   *  §Architecture — normal (non-replay) case. */
  feed(chunk: Uint8Array): void {
    if (!this.session) throw new Error(`[${this.label}] feed() called before open()`);
    if (this.epochConnMs === null) this.epochConnMs = this.now();
    this.session.sendAudio(chunk);
  }

  /** Overrides epoch_conn explicitly — reconnect-replay case (fix B13): epoch_conn =
   *  capture_ts of the first replayed chunk, not the replay wall-clock time. Call BEFORE
   *  replaying the RAM buffer via feed(). */
  setEpochConnMs(ms: number): void {
    this.epochConnMs = ms;
  }

  getEpochConnMs(): number | null {
    return this.epochConnMs;
  }

  /** Gracefully ends the stream (empty text-frame per SDK, awaits `finished`). */
  async finish(): Promise<void> {
    await this.session?.finish();
  }

  /** Closes immediately without waiting — used to drop the OLD connection ~1s after a
   *  renew/reconnect swap (overlap window per §Architecture "Temp key TTL"). */
  close(): void {
    this.session?.close();
  }
}
