import { defaultSessionTitle } from '../shared/session-title.ts';
import { LANGUAGES, ROOM_CODE_PATTERN, type Caption, type CreateRoomInput, type Room } from '../shared/protocol.ts';

export class ApiFault extends Error {
  constructor(public code: string, message: string, public status = 400, public retryable = false) {
    super(message);
  }
}

export function roomCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!ROOM_CODE_PATTERN.test(normalized)) throw new ApiFault('INVALID_CODE', 'Enter the six-character room code.');
  return normalized;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiFault('INVALID_REQUEST', 'Please try that again.');
  return value as Record<string, unknown>;
}

export function createRoomInput(value: unknown): CreateRoomInput {
  const input = object(value);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length > 120 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(title)) {
    throw new ApiFault('INVALID_TITLE', 'Keep the talk title to 120 characters.');
  }
  if (!LANGUAGES.some(([code]) => code === input.language)) throw new ApiFault('INVALID_LANGUAGE', 'Choose a spoken language from the list.');
  return { title: title || defaultSessionTitle(new Date(), 'UTC'), language: input.language as string };
}

export function titleInput(value: unknown): { title: string } {
  const input = object(value);
  if (typeof input.title !== 'string') throw new ApiFault('INVALID_TITLE', 'Enter a session title.');
  const title = input.title.trim();
  if (title.length > 120 || /[\u0000-\u001f\u007f]/.test(title)) throw new ApiFault('INVALID_TITLE', 'Keep the session title to 120 characters on one line.');
  return { title };
}

export function captionInput(value: unknown): Caption {
  const input = object(value);
  if (input.v !== 1 || input.type !== 'caption' || typeof input.roomId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.roomId)
    || typeof input.segmentId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.segmentId)
    || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || Number(input.revision) > 1_000_000_000
    || typeof input.final !== 'boolean' || typeof input.text !== 'string' || input.text.length > 8000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text)
    || !Number.isSafeInteger(input.startMs) || !Number.isSafeInteger(input.endMs)
    || Number(input.startMs) < 0 || Number(input.endMs) < Number(input.startMs) || Number(input.endMs) > 21_600_000) {
    throw new ApiFault('INVALID_CAPTION', 'The caption could not be sent. Please try again.');
  }
  // Copy only the protocol fields, never forward arbitrary client properties.
  return { v: 1, type: 'caption', roomId: input.roomId, segmentId: input.segmentId,
    revision: input.revision as number, final: input.final, text: input.text,
    startMs: input.startMs as number, endMs: input.endMs as number };
}

export function stateInput(value: unknown): { status: 'listening' | 'reconnecting'; expectedVersion?: number } {
  const input = object(value);
  if (input.status !== 'listening' && input.status !== 'reconnecting') throw new ApiFault('INVALID_STATE', 'This session state is not available.');
  if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1)) {
    throw new ApiFault('INVALID_STATE', 'Please try that again.');
  }
  return { status: input.status, ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion as number }) };
}

export async function readJson(request: Request): Promise<unknown> {
  if (!request.body) return {};
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiFault('INVALID_REQUEST', 'Send a JSON request.', 415);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 64 * 1024) {
      await reader.cancel();
      throw new ApiFault('REQUEST_TOO_LARGE', 'The request is too large.', 413);
    }
    chunks.push(value);
  }
  if (!length) return {};
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiFault('INVALID_REQUEST', 'The request could not be read.'); }
}

export function databaseFault(code: string): ApiFault {
  const failures: Record<string, [string, number, boolean?]> = {
    ROOM_UNAVAILABLE: ['This room has ended or the code is incorrect.', 404],
    ROOM_ENDED: ['This session has ended. Start a new session to continue.', 410],
    UNAUTHORIZED: ['This session link is no longer valid. Please join again.', 401],
    ROOM_FULL: ['This room is full. Please try again shortly.', 409],
    ROOM_LIMIT: ['All available rooms are in use. Please try again shortly.', 429, true],
    RATE_LIMIT: ['Please wait a moment before trying again.', 429, true],
    CAPTION_CONFLICT: ['This caption was already finalized.', 409],
    STALE_STATE: ['The session state has changed. Please try again.', 409, true],
    INVALID_REQUEST: ['Please try that again.', 400],
  };
  const failure = failures[code];
  return failure ? new ApiFault(code, ...failure) : new ApiFault('SERVICE_UNAVAILABLE', 'Front Row could not connect. Please try again.', 503, true);
}

export function roomEvent(room: Room) {
  return { v: 1 as const, type: 'room.state' as const, room };
}
