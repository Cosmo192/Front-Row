/** Closing the room must remain possible even after caption delivery fails. */
export async function stopAndEnd<T>(stopAudio: () => Promise<void>, flushCaptions: () => Promise<void>, closeRoom: () => Promise<T>): Promise<T> {
  await stopAudio();
  // A publisher failure has already surfaced to the speaker. It must not trap
  // everyone in an open room after microphone capture has stopped.
  await flushCaptions().catch(() => {});
  return closeRoom();
}
