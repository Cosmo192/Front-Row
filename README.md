# Front Row

Front Row puts one speaker's live captions on every phone in the room. A speaker opens the web app, starts a session, and shares a QR code. The audience scans it in the phone's camera and reads the captions in Safari or Chrome. There is no app install and no audience account.

This project is prepared for Hacklanta's Social Good track. Its strongest integrations are ElevenLabs Scribe v2 Realtime for the live speech-to-text path and Gemini for optional “catch me up” summaries. The live caption path remains useful if the summary feature is unavailable.

## Stack and data flow

The browser asks the Vercel function to create or join a room. The speaker requests a single-use ElevenLabs Scribe token, then sends PCM microphone frames directly to ElevenLabs. Final captions are sent to the Vercel API, written to Supabase, and broadcast through a private Supabase Realtime topic. Draft captions are broadcast live but are not stored. Audience browsers merge the initial snapshot with Realtime events and ignore stale or post-end events.

Supabase stores room metadata, finalized captions, short-lived audience leases, and rate-limit counters. Rooms expire after six hours or after a two-minute speaker heartbeat gap. Ending a room immediately rejects new joins and schedules its rows for deletion 24 hours later. Front Row does not store raw audio. ElevenLabs processes the audio under the provider settings and policy selected by the organizer; this app does not promise provider-side zero retention.

## Demo 

1. Open the HTTPS deployment on the speaker's phone and choose **Speaker**.
2. Choose a language, tap **Start session**, allow the microphone, and show the QR code.
3. Scan from two or three other phones. Speak near the speaker phone and confirm captions arrive on each audience screen.
4. On an audience phone, adjust the caption size and enable screen-reader announcements if needed.
5. End the session. Audience phones should show the ended state and the room code should no longer join.

## Positioning and limitations

Built-in tools such as Apple's Live Captions primarily help one person caption audio picked up by that person's device. Front Row uses one speaker's microphone and delivers the resulting text to the whole room on any modern phone browser. It only works when a speaker or organizer chooses to run a session. Automatic transcription can be wrong around names, noise, accents, and overlapping voices. Keep the speaker phone near the sound source.

## Privacy

There are no accounts, advertising trackers, or analytics in this app. The audience is represented by short-lived anonymous room leases and an in-memory Realtime presence count. Front Row does not record or store raw audio. Finalized captions and room details are stored in Supabase for the active session and for up to 24 hours after it ends, then the cleanup job deletes them. A person with the room code can read that room's captions while it is active.

The speaker's browser sends microphone audio to ElevenLabs for transcription. Review the provider's privacy and retention settings before using Front Row for sensitive events. Gemini, when enabled for a summary request, receives only the selected finalized caption window and the source segment IDs needed to cite it; a summary failure never interrupts live captions. Do not put secrets in client-exposed environment variables.
