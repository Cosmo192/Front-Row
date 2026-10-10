import { createClient } from '@supabase/supabase-js';
import type { Caption, Room, RoomEvent } from '../shared/protocol.ts';
import type { Environment } from './auth.ts';
import { ApiFault } from './validation.ts';

export interface DatabaseResult {
  room?: Room; captions?: Caption[]; guestId?: string; accepted?: boolean;
  error?: string;
}

export interface DatabaseArguments {
  code: string; secretHash?: string; guestId?: string; claimRoom?: string;
  payload?: unknown; rateKey?: string;
}

export interface Database {
  manage(action: string, args: DatabaseArguments): Promise<DatabaseResult>;
  broadcast(roomId: string, event: RoomEvent): Promise<void>;
}

export function createDatabase(env: Environment, fetcher: typeof fetch = fetch): Database {
  const timedFetch: typeof fetch = (input, init) => fetcher(input, {
    ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
  });
  const client = createClient(env.SUPABASE_URL!, env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: timedFetch },
  });
  return {
    async manage(action, args) {
      const { data, error } = await client.rpc('front_row_manage', {
        p_action: action, p_code: args.code, p_secret_hash: args.secretHash ?? null,
        p_guest_id: args.guestId ?? null, p_claim_room: args.claimRoom ?? null,
        p_payload: args.payload ?? {}, p_rate_key: args.rateKey ?? null,
      });
      if (error || !data || typeof data !== 'object') {
        // Never expose database details: they can contain request values and transcripts.
        throw new ApiFault('SERVICE_UNAVAILABLE', 'Front Row could not connect. Please try again.', 503, true);
      }
      return data as DatabaseResult;
    },
    async broadcast(roomId, event) {
      const response = await timedFetch(`${env.SUPABASE_URL!.replace(/\/$/, '')}/realtime/v1/api/broadcast`, {
        method: 'POST', headers: { apikey: env.SUPABASE_SECRET_KEY!, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ topic: `room:${roomId}`, event: 'room', private: true, payload: event }] }),
      });
      if (!response.ok) throw new ApiFault('DELIVERY_DELAYED', 'Captions could not reach the room. Reconnecting…', 503, true);
    },
  };
}
