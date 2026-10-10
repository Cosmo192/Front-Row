import { randomUUID } from 'node:crypto';
import type { ApiError, Role, Room, RoomSession } from '../shared/protocol.ts';
import { appConfig, bearerToken, isSpeakerSecret, issueGuestToken, newRoomCode, rateKey, secretHash, speakerSecret, verifyGuestToken, type Environment } from './auth.ts';
import { createDatabase, type Database, type DatabaseArguments, type DatabaseResult } from './db.ts';
import { ApiFault, captionInput, createRoomInput, databaseFault, readJson, roomCode, roomEvent, stateInput, titleInput } from './validation.ts';
import { summarizeRecent } from './gemini.ts';

interface Dependencies { env?: Environment; database?: Database; fetcher?: typeof fetch }

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  } });
}

function requireRoom(result: DatabaseResult): Room {
  if (result.error) throw databaseFault(result.error);
  if (!result.room) throw new ApiFault('SERVICE_UNAVAILABLE', 'Front Row could not connect. Please try again.', 503, true);
  return result.room;
}

export function createRequestHandler(dependencies: Dependencies = {}) {
  return async function handle(request: Request): Promise<Response> {
    const env = dependencies.env ?? process.env;
    const fetcher = dependencies.fetcher ?? fetch;
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/api/config') return json(appConfig(env));
      const origin = request.headers.get('origin');
      const allowedOrigin = env.APP_ORIGIN ? new URL(env.APP_ORIGIN).origin : url.origin;
      if (origin && origin !== allowedOrigin) throw new ApiFault('ORIGIN_NOT_ALLOWED', 'Open Front Row directly to continue.', 403);
      if (!appConfig(env).ready) throw new ApiFault('NOT_CONFIGURED', 'Front Row is not ready yet. The organizer needs to finish setup.', 503);
      const db = dependencies.database ?? createDatabase(env, fetcher);

      async function session(result: DatabaseResult, role: Role, accessToken: string, subject: string): Promise<RoomSession> {
        const room = requireRoom(result);
        const realtime = await issueGuestToken(env, room, role, subject);
        return { room, role, accessToken: role === 'speaker' ? accessToken : realtime.token,
          realtime: { url: env.SUPABASE_URL!, publishableKey: env.SUPABASE_PUBLISHABLE_KEY!,
            ...realtime, topic: `room:${room.id}` }, captions: result.captions ?? [] };
      }

      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        const input = createRoomInput(await readJson(request));
        const accessToken = speakerSecret();
        for (let attempt = 0; attempt < 5; attempt++) {
          const result = await db.manage('create', { code: newRoomCode(), secretHash: secretHash(accessToken),
            payload: input, rateKey: rateKey(request, env) });
          if (result.error === 'CODE_COLLISION') continue;
          const room = requireRoom(result);
          return json(await session(result, 'speaker', accessToken, room.id), 201);
        }
        throw new ApiFault('SERVICE_UNAVAILABLE', 'We could not create a room. Please try again.', 503, true);
      }

      const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(join|snapshot|refresh|transcription-token|captions|heartbeat|state|end|summary|title)$/);
      if (!match) throw new ApiFault('NOT_FOUND', 'This page could not be found.', 404);
      const code = roomCode(decodeURIComponent(match[1]));
      const action = match[2];
      if (request.method !== (action === 'snapshot' ? 'GET' : 'POST')) throw new ApiFault('METHOD_NOT_ALLOWED', 'This action is not available.', 405);

      if (action === 'join') {
        const result = await db.manage('join', { code, guestId: randomUUID(), rateKey: rateKey(request, env) });
        requireRoom(result);
        if (!result.guestId) throw new ApiFault('SERVICE_UNAVAILABLE', 'Please try joining again.', 503, true);
        return json(await session(result, 'audience', '', result.guestId));
      }

      const token = bearerToken(request);
      const speaker = isSpeakerSecret(token);
      let auth: DatabaseArguments = { code };
      let subject = '';
      if (speaker) auth.secretHash = secretHash(token);
      else {
        const claims = await verifyGuestToken(env, token, code);
        auth = { ...auth, guestId: claims.subject, claimRoom: claims.roomId };
        subject = claims.subject;
      }
      if (!speaker && !['snapshot', 'refresh', 'summary'].includes(action)) throw new ApiFault('FORBIDDEN', 'Only the speaker can change this session.', 403);

      if (action === 'title') {
        const result = await db.manage('title', { ...auth, payload: titleInput(await readJson(request)) });
        return json({ room: requireRoom(result) });
      }

      if (action === 'summary') {
        const result = await db.manage('snapshot', auth);
        requireRoom(result);
        try { return json(await summarizeRecent(result.captions ?? [], env, fetcher)); }
        catch (error) { throw new ApiFault('SUMMARY_UNAVAILABLE', error instanceof Error ? error.message : 'A catch-up summary is not available right now.', 503, true); }
      }

      if (action === 'snapshot' || action === 'refresh') {
        const result = await db.manage(action, auth);
        const room = requireRoom(result);
        if (action === 'snapshot') return json({ room, captions: result.captions ?? [] });
        return json(await session(result, speaker ? 'speaker' : 'audience', token, speaker ? room.id : subject));
      }

      if (action === 'transcription-token') {
        // The DB checks ownership, expiry, and the issuance rate before any paid provider call.
        requireRoom(await db.manage('transcription-token', auth));
        const response = await fetcher('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
          method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY!, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) throw new ApiFault('TRANSCRIPTION_UNAVAILABLE', 'Speech recognition could not connect. Please try again.', 503, true);
        const data = await response.json() as { token?: unknown };
        if (typeof data.token !== 'string' || !data.token) throw new ApiFault('TRANSCRIPTION_UNAVAILABLE', 'Speech recognition could not connect. Please try again.', 503, true);
        // End/expiry may race the provider request; never hand a token to a closed room.
        requireRoom(await db.manage('authorize', auth));
        return json({ token: data.token });
      }

      if (action === 'captions') {
        const caption = captionInput(await readJson(request));
        const result = await db.manage('caption', { ...auth, payload: caption });
        const room = requireRoom(result);
        if (result.accepted !== false) await db.broadcast(room.id, caption);
        return json({ ok: true });
      }

      const result = await db.manage(action, { ...auth, ...(action === 'state' ? { payload: stateInput(await readJson(request)) } : {}) });
      const room = requireRoom(result);
      if (action === 'state' || action === 'end') {
        // State is already committed. A broadcast failure cannot undo End; polling repairs missed delivery.
        try { await db.broadcast(room.id, roomEvent(room)); } catch { /* never log private payloads */ }
      }
      return json({ room });
    } catch (error) {
      const fault = error instanceof ApiFault ? error : new ApiFault('SERVICE_UNAVAILABLE', 'Front Row could not connect. Please try again.', 503, true);
      const body: ApiError = { error: { code: fault.code, message: fault.message, retryable: fault.retryable } };
      return json(body, fault.status);
    }
  };
}

export const handleRequest = createRequestHandler();
