import './styles.css';
import QRCode from 'qrcode';
import { LANGUAGES, ROOM_CODE_PATTERN, type AppConfig, type Caption, type RoomSession, type RoomStatus } from '../../shared/protocol';
import { prepareAudio, type PreparedAudio } from './audio';
import { getConfig, createRoom, joinRoom, getSnapshot, getSummary, getTranscriptionToken, setRoomState, heartbeat, endRoom, subscribeRoom, CaptionPublisher, type RoomSubscription } from './connection';
import { mergeCaption, mergeCaptions } from './captions';
import { icon, escapeHtml as esc } from './ui/icons';

const app = document.querySelector<HTMLDivElement>('#app')!;
const announcer = document.querySelector<HTMLDivElement>('#announcer')!;
const sizes = [20, 24, 30, 38, 48];
let sizeIndex = 1;
let announceCaptions = false;
let config: AppConfig | undefined;
let configError = '';
let viewVersion = 0;
let session: RoomSession | undefined;
let audio: PreparedAudio | undefined;
let subscription: RoomSubscription | undefined;
let publisher: CaptionPublisher | undefined;
let captions: Caption[] = [];
let ended = false;
let ending = false;
let roomStatus: RoomStatus = 'starting';
let connectionStatus = 'connecting';
let audienceCount = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let wakeLock: WakeLockSentinel | undefined;
let endDestination: string | undefined;
let qrUrl = '';
let lastAnnouncedSegment = '';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const wordmark = () => '<a class="wordmark" href="/" aria-label="Front Row home">Front Row<span aria-hidden="true">.</span></a>';
const header = () => `<header class="site-header">${wordmark()}<a class="header-link" href="/privacy">Privacy</a></header>`;
const footer = () => '<footer class="site-footer"><span>Live captions. No account needed.</span></footer>';
const shell = (content: string, cls = 'page') => `${header()}<main id="main" class="${cls}" tabindex="-1">${content}</main>${footer()}`;
const back = (label = 'Back to home') => `<a class="back-link" href="/">${icon('back')}${label}</a>`;
const notice = (id: string) => `<div id="${id}" class="notice error" role="alert" hidden></div>`;
const emptyCaptions = (speaker: boolean) => `<div class="empty-captions">${icon('captions')}<strong>${speaker ? 'Ready when you are' : 'Waiting for the speaker'}</strong><span>${speaker ? 'Keep your phone close to your voice and start speaking.' : 'You’re connected. Captions appear here when the speaker starts talking.'}</span></div>`;

function showNotice(id: string, title: string, detail = '', kind = 'error') {
  const element = $(`#${id}`);
  if (!element) return;
  element.className = `notice ${kind}`;
  element.innerHTML = `${icon(kind === 'error' || kind === 'warning' ? 'alert' : 'shield')}<div><strong>${esc(title)}</strong>${esc(detail)}</div>`;
  element.hidden = false;
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
function announce(text: string) { announcer.textContent = text; }

function homePage() {
  document.title = 'Front Row — Live captions for everyone';
  app.innerHTML = shell(`<section class="hero"><div class="eyebrow">Live captions, together</div><h1>Every word.<br>For everyone.</h1><p class="hero-description">One speaker. Captions on every phone.<br>Choose how you’re joining today.</p><div class="choose-role"><a class="role-card" href="/speaker">${icon('mic')}<span><strong>Start a session</strong><small>I’m speaking or hosting</small></span>${icon('arrow', 'role-arrow')}</a><a class="role-card secondary" href="/join">${icon('captions')}<span><strong>Join a session</strong><small>I’m here to read captions</small></span>${icon('arrow', 'role-arrow')}</a></div><p class="hero-footnote">No download. Just your browser.</p></section>`, 'home-main');
}

async function speakerSetup() {
  document.title = 'Start a session — Front Row';
  const version = viewVersion;
  app.innerHTML = shell(`${back()}<section class="setup-layout"><div class="eyebrow">Speaker · Set up</div><h1>Start a session</h1><p class="lead">Your phone picks up your voice. Your audience reads along on theirs.</p><form id="speaker-form" class="setup-form"><div class="field"><label for="spoken-language">What language will you speak?</label><select id="spoken-language" name="language">${LANGUAGES.map(([code, name]) => `<option value="${code}">${name}</option>`).join('')}</select></div><details class="optional-details"><summary>Add a session title <span>Optional</span></summary><div class="field"><label for="talk-title">Session title</label><input id="talk-title" name="title" type="text" maxlength="120" placeholder="e.g. Community meeting" autocomplete="off"></div></details><p class="setup-expectation">${icon('mic')}<span>Next, allow your microphone. You’ll get a QR code to share with your audience.</span></p>${notice('setup-error')}<button id="start-button" class="button block" type="submit" disabled><span>Checking availability…</span></button><p class="disclosure">Audio is sent to ElevenLabs for transcription. Final captions are kept for 24 hours after the session ends. <a href="/privacy">Privacy details</a></p></form></section>`);
  $('#speaker-form')!.addEventListener('submit', event => { event.preventDefault(); void startSpeaker(); });
  try { config = await getConfig(); configError = ''; }
  catch (error) { config = undefined; configError = message(error); }
  if (version !== viewVersion) return;
  const button = $<HTMLButtonElement>('#start-button');
  if (button) {
    button.disabled = !config?.ready;
    button.innerHTML = '<span>Start session</span>';
    if (!config?.ready) showNotice('setup-error', 'Sessions aren’t available yet', configError
      ? 'We couldn’t check the caption service. Reload the page to try again.'
      : 'The host needs to connect the caption service before you can start.', 'warning');
  }
}

async function startSpeaker() {
  const button = $<HTMLButtonElement>('#start-button')!;
  if (button.disabled) return;
  if (!config?.ready) {
    showNotice('setup-error', 'Session setup isn’t finished', configError ? 'We couldn’t check the caption service. Please reload this page and try again.' : 'The organizer needs to finish connecting the caption service before sessions can start. Please try again once setup is complete.');
    return;
  }
  const title = $<HTMLInputElement>('#talk-title')!.value.trim();
  const language = $<HTMLSelectElement>('#spoken-language')!.value;
  button.disabled = true;
  button.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Starting your session…</span>';
  $('#setup-error')!.hidden = true;
  let pendingSession: RoomSession | undefined;
  let pendingAudio: PreparedAudio | undefined;
  const version = viewVersion;
  try {
    // This starts microphone permission/audio activation in the original tap gesture.
    pendingAudio = await prepareAudio({ onLevel: updateLevel, onWarning: text => showNotice('live-warning', 'Keep your microphone ready', text, 'warning'), onError: error => onAudioError(error) });
    if (version !== viewVersion) { await pendingAudio.stop(); return; }
    pendingSession = await createRoom({ title, language });
    if (version !== viewVersion) { await pendingAudio.stop(); await endRoom(pendingSession); return; }
    session = pendingSession;
    audio = pendingAudio;
    captions = [...session.captions]; ended = false; ending = false; roomStatus = 'starting'; connectionStatus = 'connecting'; audienceCount = 0;
    const token = await getTranscriptionToken(session);
    if (version !== viewVersion) { await pendingAudio.stop(); await endRoom(pendingSession); return; }
    speakerLive();
    await connectToRoom();
    publisher = new CaptionPublisher(session, error => showNotice('live-error', 'Captions could not be shared', message(error)));
    await audio.start({ token: token.token, roomId: session.room.id, language, onCaption: caption => { acceptCaption(caption); publisher?.publish(caption); }, onStatus: status => { if (status === 'listening') updateStatus('listening'); else if (status === 'connecting') updateStatus('starting'); } });
    if (ended || !session) return;
    const result = await setRoomState(session, 'listening');
    session.room = result.room;
    updateStatus('listening');
    startHeartbeat();
    void acquireWakeLock();
    announce('Your session has started. Share the QR code with your audience.');
  } catch (error) {
    await pendingAudio?.stop().catch(() => {});
    if (pendingSession) await endRoom(pendingSession).catch(() => {});
    await disposeSession();
    if (version !== viewVersion) return;
    await speakerSetup();
    const text = message(error);
    showNotice('setup-error', /denied|permission|NotAllowed/i.test(text) ? 'Microphone access is needed' : 'Your session couldn’t start', /denied|permission|NotAllowed/i.test(text) ? 'Allow microphone access in your browser’s site settings, then try again. On iPhone, look for Website Settings in Safari’s page menu.' : text);
  }
}

function speakerLive() {
  if (!session) return;
  document.title = 'Speaking live — Front Row';
  const room = session.room;
  const languageName = LANGUAGES.find(([code]) => code === room.language)?.[1] ?? room.language;
  app.innerHTML = shell(`<div class="live-top"><div><div class="eyebrow">Speaker · Live session</div><h1>${esc(room.title || 'Live captions')}</h1><p>${esc(languageName)} captions · Speaker view</p></div>${statusMarkup()}</div>${notice('live-error')}${notice('live-warning')}<div class="speaker-grid"><section class="panel speaker-caption-panel" aria-labelledby="preview-title"><div class="mic-strip">${icon('mic')}<span class="mic-text">Microphone level</span><div id="mic-meter" class="mic-meter" role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="mic-fill" class="mic-fill"></div></div></div><div class="panel-header"><h2 id="preview-title" class="panel-title">Caption preview</h2></div><div id="transcript" class="transcript speaker-transcript" aria-live="off" tabindex="0" aria-label="Caption preview">${emptyCaptions(true)}</div></section><aside class="panel share-panel" aria-labelledby="share-title"><h2 id="share-title">Invite your audience</h2><p>Ask them to scan this QR code.</p><img id="room-qr" class="qr-image" alt="QR code to join this caption session" hidden><div class="code-wrap"><span class="code-label">Or enter room code</span><strong class="room-code">${esc(room.code)}</strong></div><div class="share-actions"><button id="expand-qr" class="button secondary" type="button">${icon('expand')}Enlarge QR code</button><button id="copy-link" class="button quiet" type="button">${icon('copy')}Copy join link</button></div><div class="audience-count">${icon('users')}<strong id="audience-count">0</strong><span>in the audience</span></div></aside></div><div class="speaker-bottom"><p id="wake-status" class="wake-status">${icon('sun')}<span>Keep this page visible and your phone unlocked.</span></p></div><button id="end-button" class="button danger speaker-end" type="button">End session</button><dialog id="end-dialog" aria-labelledby="end-dialog-title" aria-describedby="end-dialog-description"><h2 id="end-dialog-title">End this session?</h2><p id="end-dialog-description">Captions will stop for everyone, and the room code will no longer work.</p><div class="dialog-actions"><button id="cancel-end" class="button secondary" type="button" autofocus>Keep speaking</button><button id="confirm-end" class="button danger solid" type="button">End session</button></div></dialog><dialog id="qr-dialog" class="qr-full" aria-labelledby="qr-dialog-title"><button id="close-qr" class="close-button" type="button" aria-label="Close full-screen QR">${icon('close')}</button><div class="qr-full-inner">${wordmark()}<h2 id="qr-dialog-title">Scan to read captions</h2><p>Open your camera and scan to join the captions.</p><img id="fullscreen-qr" class="qr-image" alt="QR code to join this caption session"><span class="code-label">Or enter room code</span><strong class="room-code">${esc(room.code)}</strong><p id="qr-address" class="qr-url"></p></div></dialog>`);
  $('#end-button')!.addEventListener('click', () => openEndDialog());
  $('#cancel-end')!.addEventListener('click', () => { $<HTMLDialogElement>('#end-dialog')!.close(); endDestination = undefined; });
  $('#confirm-end')!.addEventListener('click', () => void finishSession());
  $('#end-dialog')!.addEventListener('cancel', () => { endDestination = undefined; });
  $('#expand-qr')!.addEventListener('click', () => $<HTMLDialogElement>('#qr-dialog')!.showModal());
  $('#close-qr')!.addEventListener('click', () => $<HTMLDialogElement>('#qr-dialog')!.close());
  $('#copy-link')!.addEventListener('click', () => void copyJoinLink());
  const joinUrl = `${location.origin}/join/${room.code}`;
  $('#qr-address')!.textContent = `${location.host}/join`;
  void QRCode.toDataURL(joinUrl, { width: 720, margin: 2, color: { dark: '#215B4C', light: '#FFFFFF' }, errorCorrectionLevel: 'M' }).then(url => {
    qrUrl = url;
    for (const id of ['room-qr', 'fullscreen-qr']) { const img = $<HTMLImageElement>(`#${id}`); if (img) { img.src = url; img.hidden = false; } }
  }).catch(() => showNotice('live-warning', 'The QR code couldn’t load', 'Your audience can still join by entering the room code.', 'warning'));
  renderCaptions();
  updateStatus(roomStatus);
}

function statusMarkup() { return '<span id="status-badge" class="status-badge" data-state="starting" role="status"><span class="status-dot" aria-hidden="true"></span><span id="status-text">Connecting…</span></span>'; }
function updateStatus(status: RoomStatus) {
  roomStatus = status;
  const badge = $('#status-badge');
  if (!badge) return;
  const finalStatus = ended ? 'ended' : connectionStatus === 'reconnecting' ? 'reconnecting' : status;
  badge.dataset.state = finalStatus;
  const labels: Record<RoomStatus, string> = { starting: 'Connecting…', listening: session?.role === 'speaker' ? 'Listening' : 'Connected', paused: 'Paused', reconnecting: 'Reconnecting…', ended: 'Session ended' };
  $('#status-text')!.textContent = labels[finalStatus];
}
function updateLevel(level: number) {
  const normalized = Math.max(0, Math.min(100, Math.round(level * 100)));
  const fill = $('#mic-fill');
  if (fill) fill.style.width = `${normalized}%`;
  const meter = $('#mic-meter');
  if (meter) meter.setAttribute('aria-valuenow', String(normalized));
}
function acceptCaption(caption: Caption) {
  if (!session || caption.roomId !== session.room.id) return;
  captions = mergeCaption(captions, caption);
  renderCaptions();
  if (announceCaptions && caption.final && caption.segmentId !== lastAnnouncedSegment) { lastAnnouncedSegment = caption.segmentId; announce(caption.text); }
}
function renderCaptions() {
  const transcript = $('#transcript');
  if (!transcript) return;
  if (!captions.length) { transcript.innerHTML = ended ? `<div class="empty-captions">${icon('captions')}<strong>This session has ended.</strong><span>No captions were received on this device.</span></div>` : emptyCaptions(session?.role === 'speaker'); return; }
  const atBottom = session?.role === 'speaker' && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 70;
  const fragment = document.createDocumentFragment();
  for (const caption of captions) {
    if (!caption.text.trim()) continue;
    const p = document.createElement('p');
    p.textContent = caption.text;
    p.dataset.segment = caption.segmentId;
    if (!caption.final) { p.className = 'caption-interim'; const label = document.createElement('span'); label.className = 'sr-only'; label.textContent = 'Draft: '; p.prepend(label); }
    fragment.append(p);
  }
  transcript.replaceChildren(fragment);
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
}
async function connectToRoom() {
  if (!session) return;
  const currentSession = session;
  subscription = await subscribeRoom(currentSession, {
    onEvent: event => {
      if (session?.room.id !== currentSession.room.id) return;
      if (event.type === 'caption') acceptCaption(event);
      if (event.type === 'room.state') { session.room = event.room; updateStatus(event.room.status); if (event.room.status === 'ended') onRoomEnded(); }
      if (event.type === 'room.ended') onRoomEnded();
    },
    onStatus: status => { connectionStatus = status; updateStatus(roomStatus); if (status === 'connected' && $('#live-error')) $('#live-error')!.hidden = true; },
    onAudienceCount: count => { audienceCount = count; const element = $('#audience-count'); if (element) element.textContent = String(count); },
    onError: error => showNotice('live-error', 'The room connection was interrupted', message(error)),
  });
}
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => { if (session && !ended && session.role === 'speaker') void heartbeat(session).then(result => { if (session) session.room = result.room; }).catch(error => showNotice('live-warning', 'The room connection was interrupted', message(error), 'warning')); }, 15_000);
}
async function acquireWakeLock() {
  if (!session || session.role !== 'speaker' || ended || document.visibilityState !== 'visible') return;
  const element = $('#wake-status');
  if (!('wakeLock' in navigator)) { if (element) element.innerHTML = `${icon('sun')}<span>Keep your phone unlocked. This browser can’t keep the screen awake for you.</span>`; return; }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    if (element) element.innerHTML = `${icon('sun')}<span>Screen kept awake. Keep this page open while you speak.</span>`;
    wakeLock.addEventListener('release', () => { const status = $('#wake-status'); if (status) status.innerHTML = `${icon('sun')}<span>Keep your phone unlocked and this page visible.</span>`; });
  } catch { if (element) element.innerHTML = `${icon('sun')}<span>Keep your phone unlocked. Screen wake lock isn’t available right now.</span>`; }
}
function onAudioError(error: Error) {
  if (!session || ended) return;
  updateStatus('reconnecting');
  showNotice('live-error', 'The microphone was interrupted', `${message(error)} End this session and start a new one to resume captions.`);
  void setRoomState(session, 'reconnecting').catch(() => {});
}
function openEndDialog(destination?: string) {
  endDestination = destination;
  const dialog = $<HTMLDialogElement>('#end-dialog');
  if (dialog && !dialog.open) dialog.showModal();
}
async function finishSession() {
  if (!session || ending) return;
  ending = true;
  const button = $<HTMLButtonElement>('#confirm-end');
  if (button) { button.disabled = true; button.textContent = 'Ending…'; }
  const currentSession = session;
  try {
    await audio?.stop();
    await publisher?.flush();
    const result = await endRoom(currentSession);
    session.room = result.room;
    $<HTMLDialogElement>('#end-dialog')?.close();
    onRoomEnded();
    if (endDestination) { const destination = endDestination; endDestination = undefined; await navigate(destination); }
  } catch (error) {
    $<HTMLDialogElement>('#end-dialog')?.close();
    showNotice('live-error', 'Your microphone is stopped', `We couldn’t confirm that the room closed. ${message(error)} Try ending the session again.`);
  } finally { ending = false; if (button) { button.disabled = false; button.textContent = 'End session'; } }
}
function onRoomEnded() {
  if (ended) return;
  ended = true;
  updateStatus('ended');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  void audio?.stop().catch(() => {});
  void wakeLock?.release().catch(() => {});
  publisher?.close();
  void subscription?.close().catch(() => {});
  showCompletion(true);
  announceCaptions = false;
  announce('The session has ended.');
  renderCaptions();
}
function showCompletion(roomClosed: boolean) {
  const transcript = $('#transcript');
  const main = $('#main');
  if (!main) return;
  document.title = 'Session complete — Front Row';
  main.className = 'page completion-page';
  main.innerHTML = `<section class="completion"><div class="completion-mark">${icon('check')}</div><h1>${roomClosed ? 'Session complete' : 'You’re all done'}</h1><p class="lead">${roomClosed ? 'Live captions have stopped. This room is now closed.' : 'You’ve left the captions. The speaker’s session can continue.'}</p><a class="button block" href="/">Finish</a></section>`;
  if (transcript && captions.some(caption => caption.text.trim())) {
    const review = document.createElement('details');
    review.className = 'transcript-review';
    const summary = document.createElement('summary');
    summary.textContent = 'Review captions from this session';
    review.append(summary, transcript);
    main.append(review);
  }
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

async function copyJoinLink() {
  if (!session) return;
  const button = $<HTMLButtonElement>('#copy-link');
  try { await navigator.clipboard.writeText(`${location.origin}/join/${session.room.code}`); if (button) button.innerHTML = `${icon('check')}Link copied`; announce('Join link copied.'); }
  catch { showNotice('live-warning', 'Share the room code', 'Copying isn’t available in this browser. Your audience can enter the six-character code instead.', 'warning'); }
}

function joinPage(initialCode = '') {
  document.title = 'Join a session — Front Row';
  app.innerHTML = shell(`${back()}<section class="join-page"><div class="eyebrow">Audience · Join</div><h1>Join a session</h1><p class="lead">Enter the code shared by your speaker.</p><form id="join-form" class="setup-form"><div class="field"><label for="room-code">Room code</label><input id="room-code" class="room-code-input" name="code" type="text" value="${esc(initialCode)}" placeholder="ABC234" maxlength="6" autocapitalize="characters" spellcheck="false" autocomplete="off" aria-describedby="code-hint" required><p id="code-hint" class="hint">6 characters, shown beside the speaker’s QR code.</p></div>${notice('join-error')}<button id="join-button" class="button block" type="submit">Read captions${icon('arrow')}</button></form><p class="join-note">${icon('qr')}<span>Have a QR code? Scan it with your camera to join directly.</span></p></section>`);
  $('#join-form')!.addEventListener('submit', event => {
    event.preventDefault();
    const code = $<HTMLInputElement>('#room-code')!.value.trim().toUpperCase();
    if (!ROOM_CODE_PATTERN.test(code)) { showNotice('join-error', 'That code doesn’t look right', 'Enter the six-character code shown by your speaker.'); return; }
    void navigate(`/join/${code}`);
  });
}
async function audiencePage(code: string) {
  document.title = 'Live captions — Front Row';
  const version = viewVersion;
  if (!ROOM_CODE_PATTERN.test(code)) { joinPage(code.slice(0, 6)); showNotice('join-error', 'That code doesn’t look right', 'Enter the six-character code shown by your speaker.'); return; }
  app.innerHTML = shell('<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span>Finding your room…</div>');
  try {
    const joined = await joinRoom(code);
    if (version !== viewVersion) return;
    session = joined; captions = [...joined.captions]; ended = joined.room.status === 'ended'; roomStatus = joined.room.status; connectionStatus = 'connecting';
    renderAudience();
    await connectToRoom();
    // Recover captions finalized between the initial join response and subscribing.
    const snapshot = await getSnapshot(joined);
    if (version !== viewVersion || session?.room.id !== joined.room.id) return;
    captions = mergeCaptions(captions, snapshot.captions);
    session.room = snapshot.room;
    updateStatus(snapshot.room.status);
    if (snapshot.room.status === 'ended') onRoomEnded();
    renderCaptions();
  } catch (error) {
    if (version !== viewVersion) return;
    await disposeSession();
    joinPage(code);
    showNotice('join-error', 'We couldn’t find an open room', message(error));
  }
}
function renderAudience() {
  if (!session) return;
  app.innerHTML = shell(`<div class="live-top"><div><div class="eyebrow">Audience · Live session</div><h1>${esc(session.room.title || 'Live captions')}</h1><p>Room ${esc(session.room.code)}</p></div>${statusMarkup()}</div>${notice('live-error')}${notice('live-warning')}<div class="audience-toolbar"><div class="size-control"><span id="size-label">Text size</span><div class="size-buttons" role="group" aria-labelledby="size-label"><button id="text-smaller" type="button" aria-label="Smaller caption text">A−</button><button id="text-larger" type="button" aria-label="Larger caption text">A+</button></div><span id="size-value" class="sr-only" role="status">${sizes[sizeIndex]} pixels</span></div><details class="reading-options"><summary>Reading options</summary><label class="announce-label"><input id="announce-captions" type="checkbox" ${announceCaptions ? 'checked' : ''}>Read new captions aloud with my screen reader</label></details><button id="catch-up" class="button quiet" type="button">Catch me up</button></div><div id="summary" class="summary-card" hidden></div><div id="transcript" class="transcript audience-transcript" aria-live="off" aria-label="Live captions">${emptyCaptions(false)}</div><p class="audience-session-note">${icon('captions')}Draft captions are italic until the words are confirmed.</p><button id="leave-session" class="button secondary" type="button">Finish reading</button>`, 'page audience-page');
  $('#text-smaller')!.addEventListener('click', () => changeTextSize(-1));
  $('#text-larger')!.addEventListener('click', () => changeTextSize(1));
  $('#announce-captions')!.addEventListener('change', event => { announceCaptions = (event.target as HTMLInputElement).checked; announce(announceCaptions ? 'Finalized caption announcements are on.' : 'Caption announcements are off.'); });
  $('#catch-up')!.addEventListener('click', () => void requestCatchUp());
  $('#leave-session')!.addEventListener('click', () => { void subscription?.close().catch(() => {}); announceCaptions = false; showCompletion(false); announce('You’ve finished reading captions.'); });
  changeTextSize(0);
  renderCaptions();
  updateStatus(roomStatus);
}
async function requestCatchUp() {
  if (!session) return;
  const button = $<HTMLButtonElement>('#catch-up');
  if (!button) return;
  button.disabled = true; button.textContent = 'Preparing…';
  try {
    const summary = await getSummary(session);
    const card = $('#summary');
    if (card) { card.innerHTML = summary.bullets.length ? `<strong>Catch me up</strong><ul>${summary.bullets.map(b => `<li>${esc(b.text)}</li>`).join('')}</ul><small>Generated by Gemini from recent captions. Summaries can contain mistakes.</small>` : '<strong>Catch me up</strong><p>There is not enough finalized caption context yet.</p>'; card.hidden = false; }
  } catch (error) { showNotice('live-error', 'Catch-up is unavailable', message(error)); }
  finally { button.disabled = false; button.textContent = 'Catch me up'; }
}
function changeTextSize(delta: number) {
  sizeIndex = Math.max(0, Math.min(sizes.length - 1, sizeIndex + delta));
  document.documentElement.style.setProperty('--caption-size', `${sizes[sizeIndex]}px`);
  const small = $<HTMLButtonElement>('#text-smaller'); const large = $<HTMLButtonElement>('#text-larger');
  if (small) small.disabled = sizeIndex === 0;
  if (large) large.disabled = sizeIndex === sizes.length - 1;
  const value = $('#size-value'); if (value) value.textContent = `${sizes[sizeIndex]} pixels`;
}
function privacyPage() {
  document.title = 'Your privacy — Front Row';
  app.innerHTML = shell(`${back()}<article class="privacy-page"><div class="eyebrow">Your information</div><h1>Privacy, plainly</h1><p class="lead">No account, advertising trackers, or analytics. Here’s what happens during a session.</p><section><h2>Audio is processed, not recorded by Front Row</h2><p>The speaker’s audio goes to ElevenLabs for transcription. Front Row doesn’t save raw audio. Provider retention depends on the organizer’s settings and <a href="https://elevenlabs.io/privacy-policy" target="_blank" rel="noopener noreferrer">ElevenLabs’ privacy policy</a>.</p></section><section><h2>Captions are saved temporarily</h2><p>Supabase stores room details and final captions during the session and for 24 hours after it ends, then they are scheduled for deletion. Draft captions are shared live. Room details include the title and language. If you request a catch-up summary, recent final captions and their segment IDs are sent to Gemini.</p></section><section><h2>The room code controls who can join</h2><p>Anyone with the active code can read the captions. Share it only with your intended audience. Ending the session closes the code; captions already received can remain visible on a viewer’s device. We count connected audience tabs, not identities.</p></section><section><h2>Automatic captions can make mistakes</h2><p>Names, noise, and overlapping voices can affect accuracy. Keep the speaker’s phone close to the sound source and its page open. Audio leaves the device for processing.</p></section><a class="button secondary privacy-return" href="/">Back to home</a></article>`);
}
async function disposeSession() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
  await subscription?.close(); subscription = undefined;
  publisher?.close(); publisher = undefined;
  await audio?.stop().catch(() => {}); audio = undefined;
  await wakeLock?.release().catch(() => {}); wakeLock = undefined;
  session = undefined; captions = []; ended = false; ending = false; qrUrl = ''; lastAnnouncedSegment = ''; endDestination = undefined;
}
async function navigate(path: string, push = true) {
  if (session?.role === 'speaker' && !ended) { openEndDialog(path); return; }
  viewVersion++;
  await disposeSession();
  if (push) history.pushState({}, '', path);
  const pathname = new URL(path, location.origin).pathname;
  if (pathname === '/speaker') void speakerSetup();
  else if (pathname === '/join') joinPage();
  else if (pathname.startsWith('/join/')) void audiencePage(decodeURIComponent(pathname.split('/')[2] ?? '').trim().toUpperCase());
  else if (pathname === '/privacy') privacyPage();
  else homePage();
  window.scrollTo(0, 0);
  $('#main')?.focus({ preventScroll: true });
}
document.addEventListener('click', event => {
  const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
  if (!anchor || anchor.target || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
  const url = new URL(anchor.href, location.origin);
  if (url.origin !== location.origin || url.hash) return;
  event.preventDefault();
  void navigate(url.pathname);
});
window.addEventListener('popstate', () => { if (session?.role === 'speaker' && !ended) { history.pushState({}, '', '/speaker'); openEndDialog(location.pathname); } else void navigate(location.pathname, false); });
window.addEventListener('beforeunload', event => { if (session?.role === 'speaker' && !ended) { event.preventDefault(); } });
document.addEventListener('visibilitychange', () => {
  if (!session || session.role !== 'speaker' || ended) return;
  if (document.visibilityState === 'hidden') showNotice('live-warning', 'Keep this page open while speaking', 'Your phone may pause the microphone when this page is hidden or the screen locks.', 'warning');
  else void acquireWakeLock();
});
void navigate(location.pathname, false);
