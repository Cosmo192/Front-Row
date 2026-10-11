import { createClient } from '@supabase/supabase-js';
import type { AppConfig, Caption, CreateRoomInput, CatchUpSummary, Room, RoomEvent, RoomSession } from '../../shared/protocol';

export class RequestError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable: boolean, public readonly status = 0) {
    super(message); this.name = 'RequestError';
  }
}

async function request<T>(path: string, method = 'GET', body?: unknown, token?: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = data?.error;
      throw new RequestError(typeof error?.message === 'string' ? error.message : 'We could not reach the room. Please try again.',
        typeof error?.code === 'string' ? error.code : 'request_failed', error?.retryable === true || response.status >= 500 || response.status === 429, response.status);
    }
    if (data === null) throw new RequestError('The server returned an unreadable response. Please try again.', 'invalid_response', true);
    return data as T;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('The connection was interrupted. Check your internet connection and try again.', 'network_error', true);
  } finally { clearTimeout(timeout); }
}

const roomPath = (session: RoomSession, action: string) => `/api/rooms/${encodeURIComponent(session.room.code)}/${action}`;
export const getConfig = () => request<AppConfig>('/api/config');
export const createRoom = (input: CreateRoomInput) => request<RoomSession>('/api/rooms', 'POST', input);
export const joinRoom = (code: string) => request<RoomSession>(`/api/rooms/${encodeURIComponent(code.trim().toUpperCase())}/join`, 'POST', {});
export const getSnapshot = (session: RoomSession) => request<{ room: Room; captions: Caption[] }>(roomPath(session, 'snapshot'), 'GET', undefined, session.accessToken);
export const getSummary = (session: RoomSession) => request<CatchUpSummary>(roomPath(session, 'summary'), 'POST', {}, session.accessToken);
export const refreshSession = (session: RoomSession) => request<RoomSession>(roomPath(session, 'refresh'), 'POST', {}, session.accessToken);
export const getTranscriptionToken = (session: RoomSession) => request<{ token: string }>(roomPath(session, 'transcription-token'), 'POST', {}, session.accessToken);
export const heartbeat = (session: RoomSession) => request<{ room: Room }>(roomPath(session, 'heartbeat'), 'POST', {}, session.accessToken);
export const setRoomState = (session: RoomSession, status: 'listening' | 'reconnecting') => request<{ room: Room }>(roomPath(session, 'state'), 'POST', { status }, session.accessToken);
export const endRoom = (session: RoomSession) => request<{ room: Room }>(roomPath(session, 'end'), 'POST', {}, session.accessToken);
export const setSessionTitle = (session: RoomSession, title: string) => request<{ room: Room }>(roomPath(session, 'title'), 'POST', { title }, session.accessToken);
const postCaption = (session: RoomSession, caption: Caption) => request<{ ok: boolean }>(roomPath(session, 'captions'), 'POST', caption, session.accessToken);

/** A slow network never queues audio. Coalesce text drafts; retry immutable finals. */
export class CaptionPublisher {
  private queue: Caption[] = [];
  private running = false;
  private closed = false;
  private failure: Error | null = null;
  private latest = new Map<string, { revision: number; final: boolean }>();
  private draftFailures = 0;
  private waiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
  constructor(private session: RoomSession, private onError: (error: Error) => void,
    private send: (session: RoomSession, caption: Caption) => Promise<unknown> = postCaption) {}

  publish(caption: Caption): void {
    if (this.closed || this.failure) return;
    const previous = this.latest.get(caption.segmentId);
    if (previous && (previous.final || caption.revision <= previous.revision)) return;
    this.latest.set(caption.segmentId, { revision: caption.revision, final: caption.final });
    const index = this.queue.findIndex(item => item.segmentId === caption.segmentId);
    if (index >= 0) {
      const queued = this.queue[index];
      if (queued.final || caption.revision <= queued.revision) return;
      this.queue[index] = caption;
    } else {
      // Drafts for older segments are obsolete once a newer segment exists.
      this.queue = this.queue.filter(item => item.final || item.segmentId === caption.segmentId);
      this.queue.push(caption);
    }
    if (this.queue.length > 32) {
      this.fail(new RequestError('Captions could not be delivered. Please end this session and start again when your connection improves.', 'caption_backlog', false));
      return;
    }
    void this.drain();
  }

  flush(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  close(): void { this.closed = true; this.queue = []; this.settle(); }
  private fail(error: Error): void { this.failure = error; this.queue = []; this.onError(error); this.settle(); }
  private settle(): void {
    for (const waiter of this.waiters.splice(0)) this.failure ? waiter.reject(this.failure) : waiter.resolve();
  }
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.closed && !this.failure) {
        const caption = this.queue.shift()!;
        for (let attempt = 0; ; attempt++) {
          if (this.closed) break;
          try { await this.send(this.session, caption); this.draftFailures = 0; break; }
          catch (error) {
            if (this.closed) break;
            const failure = error instanceof Error ? error : new Error('Captions could not be delivered.');
            const retryable = !(error instanceof RequestError) || error.retryable;
            if (caption.final && retryable && attempt < 2 && !this.closed) {
              await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
              continue;
            }
            // A failed draft may be superseded; a missing final is a visible failure.
            if (caption.final || !retryable || ++this.draftFailures >= 3) this.fail(failure);
            break;
          }
        }
      }
    } finally { this.running = false; this.settle(); }
  }
}

export interface RoomSubscriptionCallbacks {
  onEvent(event: RoomEvent): void;
  onStatus?(status: 'connected' | 'reconnecting' | 'closed'): void;
  onAudienceCount?(count: number): void;
  onError?(error: Error): void;
}
export interface RoomSubscription { session: RoomSession; close(): Promise<void>; }

export async function subscribeRoom(session: RoomSession, callbacks: RoomSubscriptionCallbacks): Promise<RoomSubscription> {
  let closed = false;
  let ended = session.room.status === 'ended';
  let version = session.room.version;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const client = createClient(session.realtime.url, session.realtime.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    accessToken: async () => session.realtime.token,
  });
  await client.realtime.setAuth(session.realtime.token);
  const channel = client.channel(session.realtime.topic, { config: { private: true, presence: { key: crypto.randomUUID() } } });
  function receive(event: RoomEvent): void {
    if (closed || !event || event.v !== 1) return;
    if (event.type === 'caption') {
      if (ended || event.roomId !== session.room.id) return;
    } else if (event.type === 'room.state') {
      if (event.room.id !== session.room.id || event.room.version < version || (ended && event.room.status !== 'ended')) return;
      version = event.room.version;
      session.room = event.room;
      ended = event.room.status === 'ended';
    } else if (event.type === 'room.ended') {
      if (event.roomId !== session.room.id) return;
      ended = true;
    } else return;
    callbacks.onEvent(event);
  }
  channel.on('broadcast', { event: 'room' }, ({ payload }) => receive(payload as RoomEvent));
  channel.on('presence', { event: 'sync' }, () => {
    const count = Object.values(channel.presenceState<{ role: string }>()).filter(entries => entries.some(entry => entry.role === 'audience')).length;
    callbacks.onAudienceCount?.(count);
  });
  const subscription: RoomSubscription = {
    session,
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(refreshTimer);
      await client.removeChannel(channel);
      client.realtime.disconnect();
      callbacks.onStatus?.('closed');
    },
  };
  const refresh = async () => {
    if (closed || ended) return;
    try {
      const updated = await refreshSession(session);
      if (closed) return;
      const room = session.room;
      Object.assign(session, updated);
      if (updated.room.version < room.version) session.room = room;
      await client.realtime.setAuth(session.realtime.token);
      scheduleRefresh();
    } catch (error) {
      if (closed) return;
      callbacks.onStatus?.('reconnecting');
      callbacks.onError?.(error instanceof Error ? error : new Error('The room connection expired. Please rejoin.'));
    }
  };
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), Math.max(5000, session.realtime.expiresAt * 1000 - Date.now() - 60_000));
  };
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => { settled = true; reject(new Error('The live connection could not start. Check your internet connection and try again.')); }, 12_000);
    channel.subscribe((status, error) => {
      if (closed) return;
      if (status === 'SUBSCRIBED') {
        callbacks.onStatus?.('connected');
        void channel.track({ role: session.role }).then(result => {
          if (result !== 'ok' && !closed) callbacks.onError?.(new Error('The audience count is temporarily unavailable.'));
        });
        if (!settled) { settled = true; clearTimeout(timeout); resolve(); }
        // Fill any final-caption gap during subscription/rejoin without racing broadcasts.
        void getSnapshot(session).then(snapshot => {
          // Deliver stored finals before an ended state seals the room locally.
          for (const caption of snapshot.captions) receive(caption);
          receive({ v: 1, type: 'room.state', room: snapshot.room });
        }).catch(error => { if (!closed) callbacks.onError?.(error); });
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        callbacks.onStatus?.('reconnecting');
        if (!settled) { settled = true; clearTimeout(timeout); reject(error ?? new Error('The room connection could not start. Please try again.')); }
      }
    });
  }).catch(async error => { await subscription.close(); throw error; });
  scheduleRefresh();
  return subscription;
}
