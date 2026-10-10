/** Browsers use the speaker's local date; API-only callers use a UTC fallback. */
export function defaultSessionTitle(date = new Date(), timeZone?: string): string {
  const label = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', ...(timeZone ? { timeZone } : {}),
  }).format(date);
  return `Session — ${label}`;
}
