import type { Caption, CatchUpSummary } from '../shared/protocol.ts';
import type { Environment } from './auth.ts';

export async function summarizeRecent(captions: Caption[], env: Environment, fetcher: typeof fetch): Promise<CatchUpSummary> {
  const finals = captions.filter(c => c.final && c.text.trim()).slice(-80);
  const windowStart = finals[0]?.startMs ?? 0;
  const windowEnd = finals.at(-1)?.endMs ?? windowStart;
  if (!finals.length) return { bullets: [], windowStart, windowEnd, insufficientContext: true };
  if (!env.GEMINI_API_KEY) throw new Error('Gemini summaries are not configured yet.');
  const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
  const prompt = `Summarize this live-caption window in at most three short bullets. Use only the supplied words. Each bullet must cite one or more exact sourceSegmentIds. If there is not enough context, set insufficientContext true and return no bullets. JSON only.\n${JSON.stringify(finals.map(c => ({ sourceSegmentId: c.segmentId, text: c.text })))} `;
  const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: {
        bullets: { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, sourceSegmentIds: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['text', 'sourceSegmentIds'] } },
        insufficientContext: { type: 'BOOLEAN' },
      }, required: ['bullets', 'insufficientContext'] }, thinkingConfig: { thinkingLevel: 'minimal' } },
    }), signal: AbortSignal.timeout(18_000),
  });
  if (!response.ok) throw new Error('Gemini could not prepare a catch-up summary.');
  const body = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned an empty summary.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Gemini returned an unreadable summary.'); }
  const value = parsed as { bullets?: unknown; insufficientContext?: unknown };
  const ids = new Set(finals.map(c => c.segmentId));
  const bullets = Array.isArray(value.bullets) ? value.bullets.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const entry = item as { text?: unknown; sourceSegmentIds?: unknown };
    const sourceSegmentIds = Array.isArray(entry.sourceSegmentIds) ? entry.sourceSegmentIds.filter((id): id is string => typeof id === 'string' && ids.has(id)).slice(0, 12) : [];
    return typeof entry.text === 'string' && entry.text.trim() && sourceSegmentIds.length ? [{ text: entry.text.trim().slice(0, 500), sourceSegmentIds }] : [];
  }).slice(0, 3) : [];
  return { bullets, windowStart, windowEnd, insufficientContext: value.insufficientContext === true || bullets.length === 0 };
}
