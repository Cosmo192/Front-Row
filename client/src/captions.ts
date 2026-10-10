import type { Caption } from '../../shared/protocol';

/** Finals are immutable. Duplicated broadcasts and delayed interim results are harmless. */
export function mergeCaption(current: Caption[], incoming: Caption): Caption[] {
  const index = current.findIndex(item => item.segmentId === incoming.segmentId && item.roomId === incoming.roomId);
  const previous = current[index];
  if (previous && (previous.final || incoming.revision <= previous.revision)) return current;
  const next = [...current];
  if (index < 0) next.push(incoming);
  else next[index] = incoming;
  return next.sort((a, b) => a.startMs - b.startMs || a.segmentId.localeCompare(b.segmentId));
}

export function mergeCaptions(current: Caption[], incoming: Caption[]): Caption[] {
  return incoming.reduce(mergeCaption, current);
}

/** One id per provider segment, shared by all its interim revisions and its commit. */
export class CaptionAssembler {
  private segment = 0;
  private revision = 0;
  private startMs = 0;
  private previousText = '';
  constructor(private readonly roomId: string, private readonly streamId: string = crypto.randomUUID()) {}

  accept(text: string, final: boolean, elapsedMs: number): Caption | null {
    text = text.slice(0, 8000).trim();
    if (!text || (!final && text === this.previousText)) return null;
    const endMs = Math.max(this.startMs, Math.min(21_600_000, Math.round(elapsedMs)));
    const caption: Caption = {
      v: 1, type: 'caption', roomId: this.roomId,
      segmentId: `${this.streamId}_${String(this.segment).padStart(6, '0')}`,
      revision: ++this.revision, final, text, startMs: this.startMs, endMs,
    };
    this.previousText = text;
    if (final) {
      this.segment++;
      this.revision = 0;
      this.startMs = endMs;
      this.previousText = '';
    }
    return caption;
  }
}
