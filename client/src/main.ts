import './styles.css';
import QRCode from 'qrcode';
import { LANGUAGES, ROOM_CODE_PATTERN, type AppConfig, type Caption, type RoomSession, type RoomStatus } from '../../shared/protocol';
import { prepareAudio, type PreparedAudio } from './audio';
import { getConfig, createRoom, joinRoom, getSnapshot, getSummary, getTranscriptionToken, setRoomState, heartbeat, endRoom, setSessionTitle, subscribeRoom, CaptionPublisher, type RoomSubscription } from './connection';
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
let qrUrl = '';
let lastAnnouncedSegment = '';
let previewMode = false;
const previewScreens = [['', 'Flow overview'], ['home', 'Home'], ['speaker', 'Start session'], ['live', 'Speaking'], ['share', 'Share QR'], ['end', 'End confirmation'], ['title', 'Session title'], ['done', 'Speaker finish'], ['join', 'Join session'], ['audience', 'Reading captions'], ['audience-done', 'Audience finish']] as const;
const route = (path: string) => previewMode ? `/preview${path === '/' ? '/home' : path}` : path;

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const wordmark = () => `<a class="wordmark" href="${route('/')}" aria-label="Front Row home">Front Row</a>`;
const header = () => `<header class="site-header">${wordmark()}${previewMode ? `<div class="preview-controls"><a href="/preview">All screens</a><label class="sr-only" for="preview-screen">Preview screen</label><select id="preview-screen">${previewScreens.map(([path, label]) => `<option value="${path ? `/preview/${path}` : '/preview'}" ${location.pathname === (path ? `/preview/${path}` : '/preview') ? 'selected' : ''}>${label}</option>`).join('')}</select><span class="preview-label">Preview · sample data</span></div>` : ''}</header>`;
const shell = (content: string, cls = 'page') => `${header()}<main id="main" class="${cls}" tabindex="-1">${content}</main>`;
const back = (label = 'Back') => `<a class="back-link" href="${route('/')}">${icon('back')}${label}</a>`;
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
  document.title = 'Front Row';
  app.innerHTML = shell(`<section class="hero"><h1>Live captions</h1><p class="hero-description">Start speaking or join to read along.</p><div class="choose-role"><a class="role-card" href="${route('/speaker')}">${icon('mic')}<span><strong>Start a session</strong><small>I’m speaking or hosting</small></span>${icon('arrow', 'role-arrow')}</a><a class="role-card secondary" href="${route('/join')}">${icon('captions')}<span><strong>Join a session</strong><small>I’m here to read captions</small></span>${icon('arrow', 'role-arrow')}</a></div></section>`, 'home-main');
}

async function speakerSetup() {
  document.title = 'Start a session — Front Row';
  const version = viewVersion;
  app.innerHTML = shell(`${back()}<section class="setup-layout"><h1>Start a session</h1><p class="lead">Keep your phone near your voice.</p><form id="speaker-form" class="setup-form"><div class="field"><label for="spoken-language">What language will you speak?</label><select id="spoken-language" name="language">${LANGUAGES.map(([code, name]) => `<option value="${code}">${name}</option>`).join('')}</select></div><p class="setup-expectation">${icon('mic')}<span>Allow your microphone next. Then share the QR code with your audience.</span></p>${notice('setup-error')}<button id="start-button" class="button block" type="submit" disabled><span>Checking availability…</span></button><p class="disclosure">Audio is processed by ElevenLabs. Final captions are kept for 24 hours after the session ends.</p></form></section>`);
  $('#speaker-form')!.addEventListener('submit', event => { event.preventDefault(); void startSpeaker(); });
  try { config = previewMode ? { ready: true, missing: [], tier: 1 } : await getConfig(); configError = ''; }
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
  if (previewMode) { await navigate(`/preview/live?language=${$<HTMLSelectElement>('#spoken-language')!.value}`); return; }
  const title = '';
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
  app.innerHTML = shell(`<div class="live-top"><div><h1>${esc(room.title || 'Live captions')}</h1><p>${esc(languageName)} captions</p></div>${statusMarkup()}</div>${notice('live-error')}${notice('live-warning')}<div class="speaker-grid"><section class="panel speaker-caption-panel" aria-labelledby="preview-title"><div class="mic-strip">${icon('mic')}<span class="mic-text">Microphone level</span><div id="mic-meter" class="mic-meter" role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="mic-fill" class="mic-fill"></div></div></div><div class="panel-header"><h2 id="preview-title" class="panel-title">Caption preview</h2></div><div id="transcript" class="transcript speaker-transcript" aria-live="off" tabindex="0" aria-label="Caption preview">${emptyCaptions(true)}</div></section><aside class="panel share-panel" aria-labelledby="share-title"><h2 id="share-title">Invite your audience</h2><p>Ask them to scan this QR code.</p><img id="room-qr" class="qr-image" alt="QR code to join this caption session" hidden><div class="code-wrap"><span class="code-label">Or enter room code</span><strong class="room-code">${esc(room.code)}</strong></div><div class="share-actions"><button id="expand-qr" class="button secondary" type="button">${icon('expand')}Enlarge QR code</button><button id="copy-link" class="button quiet" type="button">${icon('copy')}Copy join link</button></div><div class="audience-count">${icon('users')}<strong id="audience-count">0</strong><span>in the audience</span></div></aside></div><div class="speaker-bottom"><p id="wake-status" class="wake-status">${icon('sun')}<span>Keep this page visible and your phone unlocked.</span></p></div><button id="end-button" class="button danger speaker-end" type="button">End session</button><dialog id="end-dialog" aria-labelledby="end-dialog-title" aria-describedby="end-dialog-description"><h2 id="end-dialog-title">End this session?</h2><p id="end-dialog-description">Captions will stop for everyone, and the room code will no longer work.</p><div class="dialog-actions"><button id="cancel-end" class="button secondary" type="button" autofocus>Keep speaking</button><button id="confirm-end" class="button danger solid" type="button">End session</button></div></dialog><dialog id="qr-dialog" class="qr-full" aria-labelledby="qr-dialog-title"><button id="close-qr" class="close-button" type="button" aria-label="Close full-screen QR">${icon('close')}</button><div class="qr-full-inner">${wordmark()}<h2 id="qr-dialog-title">Scan to read captions</h2><p>Open your camera and scan to join the captions.</p><img id="fullscreen-qr" class="qr-image" alt="QR code to join this caption session"><span class="code-label">Or enter room code</span><strong class="room-code">${esc(room.code)}</strong><p id="qr-address" class="qr-url"></p></div></dialog>`, 'page speaker-page');
  $('#end-button')!.addEventListener('click', () => openEndDialog());
  $('#cancel-end')!.addEventListener('click', () => { $<HTMLDialogElement>('#end-dialog')!.close(); });
  $('#confirm-end')!.addEventListener('click', () => void finishSession());
  $('#expand-qr')!.addEventListener('click', () => $<HTMLDialogElement>('#qr-dialog')!.showModal());
  $('#close-qr')!.addEventListener('click', () => $<HTMLDialogElement>('#qr-dialog')!.close());
  $('#copy-link')!.addEventListener('click', () => void copyJoinLink());
  const joinUrl = `${location.origin}${route(`/join/${room.code}`)}`;
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
  const atBottom = !ended && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 70;
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
function openEndDialog() {
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
    if (previewMode) { currentSession.room.status = 'ended'; $<HTMLDialogElement>('#end-dialog')?.close(); onRoomEnded(); return; }
    await audio?.stop();
    await publisher?.flush();
    const result = await endRoom(currentSession);
    session.room = result.room;
    $<HTMLDialogElement>('#end-dialog')?.close();
    onRoomEnded();
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
  if (session?.role === 'speaker') postSessionTitle(); else showCompletion(true);
  announceCaptions = false;
  announce('The session has ended.');
  renderCaptions();
}
function postSessionTitle() {
  if (previewMode) history.replaceState({}, '', '/preview/title');
  document.title = 'Name your session — Front Row';
  app.innerHTML = shell(`<section class="setup-layout"><div class="completion-mark">${icon('check')}</div><h1>What was this session called?</h1><p class="lead">Your session has ended. Add a title to identify these captions.</p><form id="title-form" class="setup-form"><div class="field"><label for="session-title">Session title <span class="optional-label">Optional</span></label><input id="session-title" type="text" maxlength="120" placeholder="e.g. Community meeting" value="${esc(session?.room.title ?? '')}" autocomplete="off"></div>${notice('title-error')}<button id="finish-title" class="button block" type="submit">Finish</button><button id="skip-title" class="button quiet block" type="button">Skip for now</button></form></section>`);
  $('#title-form')!.addEventListener('submit', event => { event.preventDefault(); void saveTitle(); });
  $('#skip-title')!.addEventListener('click', () => { showCompletion(true); renderCaptions(); });
  $('#main')?.focus({ preventScroll: true });
}
async function saveTitle() {
  if (!session) return;
  const currentSession = session;
  const version = viewVersion;
  const title = $<HTMLInputElement>('#session-title')!.value.trim();
  const button = $<HTMLButtonElement>('#finish-title')!;
  button.disabled = true;
  $<HTMLButtonElement>('#skip-title')!.disabled = true;
  button.textContent = 'Finishing…';
  try {
    if (title) currentSession.room = previewMode ? { ...currentSession.room, title } : (await setSessionTitle(currentSession, title)).room;
    if (version !== viewVersion || session !== currentSession) return;
    showCompletion(true);
    renderCaptions();
  } catch (error) { if (version === viewVersion) showNotice('title-error', 'The title couldn’t be saved', message(error)); }
  finally { button.disabled = false; button.textContent = 'Finish'; const skip = $<HTMLButtonElement>('#skip-title'); if (skip) skip.disabled = false; }
}

function showCompletion(roomClosed: boolean) {
  if (previewMode) {
    const path = roomClosed ? '/preview/done' : '/preview/audience-done';
    history.replaceState({}, '', path);
    const selector = $<HTMLSelectElement>('#preview-screen');
    if (selector) selector.value = path;
  }
  const transcript = $('#transcript');
  if (!$('#main')) app.innerHTML = shell('');
  const main = $('#main')!;
  document.title = 'Session complete — Front Row';
  main.className = 'page completion-page';
  main.innerHTML = `<section class="completion"><div class="completion-mark">${icon('check')}</div><h1>${roomClosed ? 'Session complete' : 'You’re all done'}</h1><p class="lead">${roomClosed ? 'Live captions have stopped. This room is now closed.' : 'You’ve left the captions. The speaker’s session can continue.'}</p><a class="button block" href="${route('/')}">Back to home</a></section>`;
  if (captions.some(caption => caption.text.trim())) {
    const review = document.createElement('details');
    review.className = 'transcript-review';
    const summary = document.createElement('summary');
    summary.textContent = session?.room.title || 'Review captions from this session';
    const reviewTranscript = transcript ?? document.createElement('div');
    reviewTranscript.id = 'transcript';
    reviewTranscript.className = 'transcript';
    reviewTranscript.setAttribute('aria-label', 'Session captions');
    reviewTranscript.tabIndex = 0;
    review.append(summary, reviewTranscript);
    main.append(review);
  }
  renderCaptions();
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
  app.innerHTML = shell(`${back()}<section class="join-page"><h1>Join a session</h1><p class="lead">Enter the code shared by your speaker.</p><form id="join-form" class="setup-form"><div class="field"><label for="room-code">Room code</label><input id="room-code" class="room-code-input" name="code" type="text" value="${esc(initialCode)}" placeholder="ABC234" maxlength="6" autocapitalize="characters" spellcheck="false" autocomplete="off" aria-describedby="code-hint" required><p id="code-hint" class="hint">6 characters, shown beside the speaker’s QR code.</p></div>${notice('join-error')}<button id="join-button" class="button block" type="submit">Read captions${icon('arrow')}</button></form><p class="join-note">${icon('qr')}<span>Have a QR code? Scan it with your camera to join directly.</span></p></section>`);
  $('#join-form')!.addEventListener('submit', event => {
    event.preventDefault();
    const code = $<HTMLInputElement>('#room-code')!.value.trim().toUpperCase();
    if (!ROOM_CODE_PATTERN.test(code)) { showNotice('join-error', 'That code doesn’t look right', 'Enter the six-character code shown by your speaker.'); return; }
    void navigate(route(`/join/${code}`));
  });
}
async function audiencePage(code: string) {
  document.title = 'Live captions — Front Row';
  if (previewMode) { history.replaceState({}, '', '/preview/audience'); seedPreview('audience'); renderAudience(); return; }
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
  document.title = 'Live captions — Front Row';
  app.innerHTML = shell(`<div class="live-top"><div><h1>${esc(session.room.title || 'Live captions')}</h1><p>Room ${esc(session.room.code)}</p></div>${statusMarkup()}</div>${notice('live-error')}${notice('live-warning')}<div class="audience-toolbar"><div class="size-control"><span id="size-label">Text size</span><div class="size-buttons" role="group" aria-labelledby="size-label"><button id="text-smaller" type="button" aria-label="Smaller caption text">A−</button><button id="text-larger" type="button" aria-label="Larger caption text">A+</button></div><span id="size-value" class="sr-only" role="status">${sizes[sizeIndex]} pixels</span></div><details class="reading-options"><summary>Reading options</summary><label class="announce-label"><input id="announce-captions" type="checkbox" ${announceCaptions ? 'checked' : ''}>Read new captions aloud with my screen reader</label></details><button id="catch-up" class="button quiet" type="button">Catch me up</button></div><dialog id="summary" class="summary-card" aria-label="Catch-up summary"></dialog><div id="transcript" class="transcript audience-transcript" tabindex="0" aria-live="off" aria-label="Live captions">${emptyCaptions(false)}</div><p class="audience-session-note">${icon('captions')}Draft captions are italic until the words are confirmed.</p><button id="leave-session" class="button secondary" type="button">Finish reading</button>`, 'page audience-page');
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
  const currentSession = session;
  const version = viewVersion;
  try {
    const summary = previewMode ? { bullets: [{ text: 'Neighbors discussed a safer crossing near the library.' }] } : await getSummary(currentSession);
    if (version !== viewVersion || session !== currentSession) return;
    const card = $<HTMLDialogElement>('#summary');
    if (card) { card.innerHTML = summary.bullets.length ? `<strong>Catch me up</strong><ul>${summary.bullets.map(b => `<li>${esc(b.text)}</li>`).join('')}</ul><small>Generated by Gemini from recent captions. Summaries can contain mistakes.</small>` : '<strong>Catch me up</strong><p>There is not enough finalized caption context yet.</p>'; card.insertAdjacentHTML('beforeend', '<button id="close-summary" class="button secondary block" type="button">Back to captions</button>'); $('#close-summary')!.addEventListener('click', () => card.close()); card.showModal(); }
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
function seedPreview(role: 'speaker' | 'audience', closed = false) {
  const now = new Date().toISOString();
  const selectedLanguage = new URLSearchParams(location.search).get('language');
  const language = LANGUAGES.find(([code]) => code === selectedLanguage)?.[0] ?? 'en';
  session = { role, accessToken: '', room: { id: 'preview-room', code: 'ABC234', title: '', language, status: closed ? 'ended' : 'listening', createdAt: now, expiresAt: now, version: 1 }, captions: [], realtime: { url: '', publishableKey: '', token: '', expiresAt: 0, topic: '' } };
  captions = [
    { v: 1, type: 'caption', roomId: 'preview-room', segmentId: '1', revision: 1, final: true, text: 'Thank you for being here. Let’s talk about the crossing near the library.', startMs: 0, endMs: 6000 },
    { v: 1, type: 'caption', roomId: 'preview-room', segmentId: '2', revision: 1, final: true, text: 'We want everyone to feel safe walking through our neighborhood.', startMs: 6000, endMs: 12000 },
  ];
  ended = closed; roomStatus = closed ? 'ended' : 'listening'; connectionStatus = 'connected'; audienceCount = 3;
}
function previewPage(path: string) {
  if (path === '/home') { homePage(); return; }
  if (!path || path === '/') {
    document.title = 'Session flow preview — Front Row';
    app.innerHTML = shell(`<section class="preview-overview"><h1>See the whole flow</h1><p class="lead">Interactive screens with sample captions. No microphone or live services are used.</p><div class="flow-columns"><section><h2>Speaking</h2><ol>${[['speaker', 'Choose your language'], ['live', 'Share and speak'], ['end', 'End the session'], ['title', 'Add an optional title'], ['done', 'Review and finish']].map(([path, label]) => `<li><a href="/preview/${path}">${label}${icon('arrow')}</a></li>`).join('')}</ol></section><section><h2>Reading</h2><ol>${[['join', 'Enter the room code'], ['audience', 'Read the live captions'], ['audience-done', 'Review and finish']].map(([path, label]) => `<li><a href="/preview/${path}">${label}${icon('arrow')}</a></li>`).join('')}</ol><a class="button secondary block" href="/preview/home">See home screen</a></section></div></section>`);
    return;
  }
  seedPreview(path.startsWith('/audience') ? 'audience' : 'speaker', ['/title', '/done', '/audience-done'].includes(path));
  if (path === '/audience') renderAudience();
  else if (path === '/title') postSessionTitle();
  else if (path === '/done' || path === '/audience-done') { if (session && path === '/done') session.room.title = 'Neighborhood meeting'; showCompletion(path === '/done'); }
  else {
    speakerLive();
    $('#audience-count')!.textContent = '3';
    updateLevel(.45);
    if (path === '/share') $<HTMLDialogElement>('#qr-dialog')!.showModal();
    if (path === '/end') openEndDialog();
  }
}

async function disposeSession() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
  await subscription?.close(); subscription = undefined;
  publisher?.close(); publisher = undefined;
  await audio?.stop().catch(() => {}); audio = undefined;
  await wakeLock?.release().catch(() => {}); wakeLock = undefined;
  session = undefined; captions = []; ended = false; ending = false; qrUrl = ''; lastAnnouncedSegment = '';
}
async function navigate(path: string, push = true) {
  if (session?.role === 'speaker' && !ended && !previewMode) { openEndDialog(); return; }
  viewVersion++;
  await disposeSession();
  if (push) history.pushState({}, '', path);
  const pathname = new URL(path, location.origin).pathname;
  previewMode = import.meta.env.DEV && (pathname === '/preview' || pathname.startsWith('/preview/'));
  const screenPath = previewMode ? pathname.slice('/preview'.length) : pathname;
  if (previewMode && screenPath !== '/speaker' && screenPath !== '/join' && !screenPath.startsWith('/join/')) previewPage(screenPath);
  else if (screenPath === '/speaker') void speakerSetup();
  else if (screenPath === '/join') joinPage();
  else if (screenPath.startsWith('/join/')) void audiencePage(decodeURIComponent(screenPath.split('/')[2] ?? '').trim().toUpperCase());
  else homePage();
  window.scrollTo(0, 0);
  $('#main')?.focus({ preventScroll: true });
}
document.addEventListener('change', event => { const target = event.target as HTMLSelectElement; if (target.id === 'preview-screen') void navigate(target.value); });
document.addEventListener('click', event => {
  const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
  if (!anchor || anchor.target || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
  const url = new URL(anchor.href, location.origin);
  if (url.origin !== location.origin || url.hash) return;
  event.preventDefault();
  void navigate(url.pathname);
});
window.addEventListener('popstate', () => { if (session?.role === 'speaker' && !ended && !previewMode) { history.pushState({}, '', '/speaker'); openEndDialog(); } else void navigate(location.pathname, false); });
window.addEventListener('beforeunload', event => { if (session?.role === 'speaker' && !ended && !previewMode) { event.preventDefault(); } });
document.addEventListener('visibilitychange', () => {
  if (!session || session.role !== 'speaker' || ended || previewMode) return;
  if (document.visibilityState === 'hidden') showNotice('live-warning', 'Keep this page open while speaking', 'Your phone may pause the microphone when this page is hidden or the screen locks.', 'warning');
  else void acquireWakeLock();
});
void navigate(location.pathname, false);
