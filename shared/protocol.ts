export type RoomStatus = 'starting' | 'listening' | 'paused' | 'reconnecting' | 'ended';
export type Role = 'speaker' | 'audience';
export interface Room {
  id: string; code: string; title: string; language: string; status: RoomStatus;
  createdAt: string; expiresAt: string; version: number;
}
export interface Caption {
  v: 1; type: 'caption'; roomId: string; segmentId: string; revision: number;
  final: boolean; text: string; startMs: number; endMs: number;
}
export type RoomEvent = Caption | { v: 1; type: 'room.state'; room: Room }
  | { v: 1; type: 'room.ended'; roomId: string; reason: string };
export interface RoomSession {
  room: Room; role: Role; accessToken: string;
  realtime: { url: string; publishableKey: string; token: string; expiresAt: number; topic: string };
  captions: Caption[];
}

export interface CatchUpSummary {
  bullets: Array<{ text: string; sourceSegmentIds: string[] }>;
  windowStart: number;
  windowEnd: number;
  insufficientContext: boolean;
}
export interface CreateRoomInput { title: string; language: string; }
export interface ApiError { error: { code: string; message: string; retryable: boolean } }
export interface AppConfig { ready: boolean; missing: string[]; tier: 1 | 2; }
export const LANGUAGES = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['hi', 'Hindi'], ['pt', 'Portuguese'],
] as const;
export const ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
