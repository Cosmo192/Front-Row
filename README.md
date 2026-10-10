# Front Row

Front Row puts one speaker's live captions on every phone in the room. A speaker opens the web app, starts a session, and shares a QR code. The audience scans it in the phone's camera and reads the captions in Safari or Chrome. There is no app install and no audience account.

This project is prepared for Hacklanta's Social Good track. Its strongest integrations are ElevenLabs Scribe v2 Realtime for the live speech-to-text path and Gemini for optional “catch me up” summaries. The live caption path remains useful if the summary feature is unavailable.

## What is included

- Mobile-first Vite + TypeScript client for `/`, `/speaker`, `/join`, and `/join/:code`.
- Vercel-compatible serverless API adapter under `api/handler.ts`.
- Supabase Postgres migration with private Realtime Broadcast, scoped JWTs, rate limits, room expiry, immutable final captions, and a 24-hour post-session retention window.
- Direct browser-to-ElevenLabs Scribe streaming using a server-issued single-use token. The permanent ElevenLabs key stays server-side.
- QR join links, readable interim captions, automatic screen wake lock, audience count, end-session invalidation, transcript recovery, text-size controls, and screen-reader announcement opt-in.
- Unit and migration tests that run without your cloud credentials.

## Stack and data flow

The browser asks the Vercel function to create or join a room. The speaker requests a single-use ElevenLabs Scribe token, then sends PCM microphone frames directly to ElevenLabs. Final captions are sent to the Vercel API, written to Supabase, and broadcast through a private Supabase Realtime topic. Draft captions are broadcast live but are not stored. Audience browsers merge the initial snapshot with Realtime events and ignore stale or post-end events.

Supabase stores room metadata, finalized captions, short-lived audience leases, and rate-limit counters. Rooms expire after six hours or after a two-minute speaker heartbeat gap. Ending a room immediately rejects new joins and schedules its rows for deletion 24 hours later. Front Row does not store raw audio. ElevenLabs processes the audio under the provider settings and policy selected by the organizer; this app does not promise provider-side zero retention.

## Local setup

Requirements: Node.js 24, a Supabase project, an ElevenLabs API key, and (for the optional Gemini feature) a Gemini API key.

```sh
npm ci
cp .env.example .env.local
npm run setup:key
```

Import `.keys/private-jwk.json` into the Supabase project's JWT signing-key configuration and activate it. Put the same compact JSON object in `SUPABASE_JWT_PRIVATE_KEY` in `.env.local`. Keep `.keys/` and `.env.local` private. The legacy `SUPABASE_JWT_SECRET` can be used instead, but do not configure both signing methods.

Apply both files in `supabase/migrations/` in timestamp order to a dedicated Supabase project. The second migration supports owner-only title updates after recording. New sessions are saved with a default title using the speaker’s local date (for example, `Session — Oct 10, 2026`); the organizer can edit that name after recording stops, then save and return home. API-only callers without a title receive a UTC date fallback. Enable `pg_cron`, then schedule `select public.front_row_cleanup();` every 15 minutes. The migration deliberately does not alter tables in the hosted `realtime` schema; its policies are the only Realtime changes.

Run the app:

```sh
npm run dev
```

Open `http://localhost:5173`. Microphone capture requires HTTPS in production; localhost is treated as secure by modern browsers. The app's `/api/config` response will explain when required server configuration is missing.

## Vercel deployment

Import this folder as a Vercel project. Vercel will run `npm run build` and serve `dist`; `vercel.json` routes `/api/*` to the function and all client routes to the Vite shell. Add the variables in `.env.example` as Vercel **server** environment variables for Preview and Production. Do not prefix secrets with `VITE_` or `NEXT_PUBLIC_`.

Set `APP_ORIGIN` to the final HTTPS origin when known. After deployment, open `/api/config`, then run the phone acceptance test below. Vercel functions are request/response only; no microphone or WebSocket is held by a Vercel function. Supabase Realtime carries the live room fan-out.

## Verification

```sh
npm run typecheck
node --import tsx --test tests/*.test.ts
npm run build
```

The automated tests cover room expiry, authorization, cross-room isolation, rate limits, caption idempotency, snapshot/Realtime overlap, draft replacement, final delivery retries, and the client caption reducer. Live ElevenLabs, Gemini, Supabase Realtime, and real iPhone/Android microphone behavior require the credentials and devices you said you will configure and test.

## Demo script

1. Open the HTTPS deployment on the speaker's phone and choose **Speaker**.
2. Choose a language, tap **Start session**, allow the microphone, and show the QR code.
3. Scan from two or three other phones. Speak near the speaker phone and confirm captions arrive on each audience screen.
4. On an audience phone, adjust the caption size and enable screen-reader announcements if needed.
5. On one audience phone, choose **Leave session**. Confirm it returns home and the organizer’s session continues.
6. Choose **End session** in the organizer’s top-right controls, then confirm. Connected audience members should return home automatically. The organizer should see a title prompt with the date-based name prefilled; save a title and confirm it returns home. The room code should no longer join.

## Positioning and limitations

Built-in tools such as Apple's Live Captions primarily help one person caption audio picked up by that person's device. Front Row uses one speaker's microphone and delivers the resulting text to the whole room on any modern phone browser. It only works when a speaker or organizer chooses to run a session. Automatic transcription can be wrong around names, noise, accents, and overlapping voices. Keep the speaker phone near the sound source.

## Privacy

There are no accounts, advertising trackers, or analytics in this app. The audience is represented by short-lived anonymous room leases and an in-memory Realtime presence count. Front Row does not record or store raw audio. Finalized captions and room details are stored in Supabase for the active session and for up to 24 hours after it ends, then the cleanup job deletes them. A person with the room code can read that room's captions while it is active.

The speaker's browser sends microphone audio to ElevenLabs for transcription. Review the provider's privacy and retention settings before using Front Row for sensitive events. Gemini, when enabled for a summary request, receives only the selected finalized caption window and the source segment IDs needed to cite it; a summary failure never interrupts live captions. Do not put secrets in client-exposed environment variables.

## Local screen preview

With `npm run dev` running, open `/preview` to see the speaking and reading flows. The screen selector includes home, setup, the organizer’s QR screen, full-screen QR sharing, end confirmation, the title prompt, joining, and audience captions. Organizers save the title before returning home. These previews reuse the actual UI with explicitly marked sample captions, do not request a microphone, and do not contact providers or save data. Preview routes are enabled only by Vite’s development flag and are unavailable in the production build.

Normal pages fit within the viewport, with long transcripts scrolling within their caption panel. Short screens and enlarged text retain scrolling so controls remain accessible.

Organizers name the session after recording stops. The date-based name is prefilled; Save and finish saves it and returns home. Audience members return home when the session ends. Preview the title screen at `/preview/title`.
