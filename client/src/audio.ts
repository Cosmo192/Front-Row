import { AudioFormat, CommitStrategy, RealtimeEvents, Scribe, type RealtimeConnection } from '@elevenlabs/client';
import type { Caption } from '../../shared/protocol';
import { CaptionAssembler } from './captions';

export interface AudioCallbacks {
  onLevel?(level: number): void;
  onWarning?(message: string): void;
  onError?(error: Error): void;
}
export interface AudioStartOptions {
  token: string; roomId: string; language: string;
  onCaption(caption: Caption): void;
  onStatus?(status: 'connecting' | 'listening' | 'stopped'): void;
}
export interface PreparedAudio { start(options: AudioStartOptions): Promise<void>; stop(): Promise<void>; }

// A single mic stream supplies both the local level meter and the provider.
// Worklet samples use the AudioContext's actual rate; no browser resampling promise is assumed.
const workletSource = `
class FrontRowPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(Math.round(sampleRate / 5));
    this.offset = 0;
    this.energy = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const raw of channel) {
      const sample = Math.max(-1, Math.min(1, raw));
      this.energy += sample * sample;
      this.buffer[this.offset++] = Math.round(sample < 0 ? sample * 32768 : sample * 32767);
      if (this.offset === this.buffer.length) {
        this.port.postMessage({ pcm: this.buffer, level: Math.sqrt(this.energy / this.offset) }, [this.buffer.buffer]);
        this.buffer = new Int16Array(Math.round(sampleRate / 5));
        this.offset = 0;
        this.energy = 0;
      }
    }
    return true;
  }
}
registerProcessor('front-row-pcm', FrontRowPCM);
`;

function audioError(error: unknown): Error {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return new Error('Microphone access is blocked. Allow the microphone in your browser’s site settings, then try again.');
  if (name === 'NotFoundError') return new Error('No microphone was found. Connect a microphone and try again.');
  if (name === 'NotReadableError') return new Error('Your microphone is busy. Close other apps using it, then try again.');
  return error instanceof Error ? error : new Error('Your microphone could not start. Please try again.');
}

function providerError(error: unknown): Error {
  const code = typeof error === 'object' && error !== null && 'message_type' in error ? String(error.message_type) : '';
  if (code === 'quota_exceeded' || code === 'rate_limited') return new Error('The caption service has reached its usage limit. Please try again later.');
  if (code === 'auth_error' || code === 'unaccepted_terms') return new Error('The caption service could not authorize this session. Check the service setup and try again.');
  return new Error('Live captions stopped because the caption service connection was interrupted. Please end the session and start again.');
}

/** Call immediately from the Start tap, before awaiting any network request. */
export async function prepareAudio(callbacks: AudioCallbacks = {}): Promise<PreparedAudio> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires a secure HTTPS page. Open the public Front Row link in Safari or Chrome.');
  if (!window.AudioContext || !window.AudioWorkletNode) throw new Error('This browser cannot stream the microphone. Open Front Row in an up-to-date Safari or Chrome browser.');
  const context = new AudioContext({ latencyHint: 'interactive' });
  const resume = context.resume();
  const microphone = navigator.mediaDevices.getUserMedia({ audio: {
    channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  } });
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  let mutedOutput: GainNode | undefined;
  let connection: RealtimeConnection | undefined;
  let options: AudioStartOptions | undefined;
  let stopped = false;
  let ready = false;
  let failed = false;
  let sentSamples = 0;
  let finishCommit: (() => void) | undefined;
  let rejectStart: ((error: Error) => void) | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;

  const visibility = () => {
    if (document.visibilityState === 'hidden' && !stopped) callbacks.onWarning?.('Keep Front Row open and your screen unlocked. Your phone may stop the microphone in the background.');
  };
  const teardownCapture = () => {
    document.removeEventListener('visibilitychange', visibility);
    context.onstatechange = null;
    if (processor) { processor.port.onmessage = null; processor.disconnect(); processor.port.close(); }
    source?.disconnect();
    mutedOutput?.disconnect();
    stream?.getTracks().forEach(track => { track.onended = null; track.onmute = null; track.stop(); });
    callbacks.onLevel?.(0);
  };
  const stop = async (flush = true) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(startTimer);
    rejectStart?.(new Error('Microphone startup was cancelled.'));
    rejectStart = undefined;
    teardownCapture();
    const closingContext = context.state === 'closed' ? Promise.resolve() : context.close().catch(() => {});
    if (flush && ready && connection) {
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 1200);
        finishCommit = () => { clearTimeout(timeout); resolve(); };
        try { connection!.commit(); } catch { clearTimeout(timeout); resolve(); }
      });
    }
    ready = false;
    connection?.close();
    connection = undefined;
    finishCommit = undefined;
    options?.onStatus?.('stopped');
    await closingContext;
  };
  const fail = (error: Error) => {
    if (stopped || failed) return;
    failed = true;
    rejectStart?.(error);
    rejectStart = undefined;
    callbacks.onError?.(error);
    void stop(false);
  };

  try {
    // Both operations begin in the user gesture; Promise.all observes both failures.
    [stream] = await Promise.all([microphone, resume]);
    const supportedRates = [8000, 16000, 22050, 24000, 44100, 48000];
    if (!supportedRates.includes(context.sampleRate)) throw new Error('This microphone’s audio format is not supported. Try another microphone or browser.');
    const workletUrl = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
    try { await context.audioWorklet.addModule(workletUrl); }
    finally { URL.revokeObjectURL(workletUrl); }
    processor = new AudioWorkletNode(context, 'front-row-pcm', { channelCount: 1, channelCountMode: 'explicit' });
    source = context.createMediaStreamSource(stream);
    mutedOutput = context.createGain();
    mutedOutput.gain.value = 0;
    source.connect(processor);
    processor.connect(mutedOutput);
    mutedOutput.connect(context.destination);
    processor.port.onmessage = ({ data }: MessageEvent<{ pcm: Int16Array; level: number }>) => {
      if (stopped) return;
      callbacks.onLevel?.(Math.min(1, data.level * 4));
      if (!ready || !connection) return; // Never buffer or replay pre-session/stale audio.
      if (context.state !== 'running') { fail(new Error('Your phone stopped the microphone. Keep the screen unlocked, then start a new session.')); return; }
      const pcm = data.pcm;
      // Write little-endian explicitly instead of assuming the platform's byte order.
      const bytes = new Uint8Array(pcm.length * 2);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      try {
        connection.send({ audioBase64: btoa(binary), sampleRate: context.sampleRate });
        sentSamples += pcm.length;
      } catch { fail(new Error('The microphone connection was interrupted. Please end the session and start again.')); }
    };
    stream.getAudioTracks().forEach(track => {
      track.onended = () => fail(new Error('Your microphone stopped. Check your microphone permission and start a new session.'));
      track.onmute = () => { if (ready) fail(new Error('Your phone interrupted the microphone. Keep the screen unlocked, then start a new session.')); };
    });
    context.onstatechange = () => {
      if (ready && context.state !== 'running' && !stopped) fail(new Error('Your phone paused the microphone. Keep Front Row open, then start a new session.'));
    };
    document.addEventListener('visibilitychange', visibility);
  } catch (error) {
    stopped = true;
    teardownCapture();
    // getUserMedia can resolve after resume/addModule fails. Release that stream too.
    void microphone.then(media => media.getTracks().forEach(track => track.stop()), () => {});
    await context.close().catch(() => {});
    throw audioError(error);
  }

  return {
    async start(startOptions) {
      if (stopped || connection) throw new Error('This microphone session has already finished. Start a new session.');
      options = startOptions;
      options.onStatus?.('connecting');
      const assembler = new CaptionAssembler(options.roomId);
      try {
        connection = Scribe.connect({
          token: options.token, modelId: 'scribe_v2_realtime', languageCode: options.language,
          audioFormat: `pcm_${context.sampleRate}` as AudioFormat, sampleRate: context.sampleRate,
          commitStrategy: CommitStrategy.VAD, vadSilenceThresholdSecs: 0.7,
        });
      } catch (error) { await stop(false); throw audioError(error); }
      const publish = (text: string, final: boolean) => {
        const caption = assembler.accept(text, final, sentSamples / context.sampleRate * 1000);
        if (caption) options!.onCaption(caption);
      };
      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, data => { if (!stopped) publish(data.text, false); });
      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, data => { publish(data.text, true); finishCommit?.(); });
      connection.on(RealtimeEvents.ERROR, error => fail(providerError(error)));
      connection.on(RealtimeEvents.CLOSE, () => {
        finishCommit?.();
        if (!stopped) fail(new Error('The caption service disconnected. Please end this session and start again.'));
      });
      await new Promise<void>((resolve, reject) => {
        rejectStart = reject;
        startTimer = setTimeout(() => fail(new Error('The caption service took too long to connect. Please try again.')), 12_000);
        connection!.on(RealtimeEvents.SESSION_STARTED, () => {
          if (stopped) return;
          clearTimeout(startTimer);
          rejectStart = undefined;
          ready = true;
          options!.onStatus?.('listening');
          resolve();
        });
      });
    },
    stop: () => stop(),
  };
}
