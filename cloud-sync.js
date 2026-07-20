(() => {
  'use strict';

  const LOCAL_SESSION_KEY = 'gapStudyActiveSessionV2';
  const LOCAL_CONFIG_KEY = 'gapStudyCloudConfigV1';
  const CLOUD_META_KEY = 'gapStudyCloudMetaV1';
  const TABLE_NAME = 'gap_study_sessions';
  const POLL_LOCAL_MS = 900;
  const POLL_REMOTE_MS = 7000;

  let client = null;
  let currentUser = null;
  let clientPromise = null;
  let syncPromise = null;
  let localTimer = null;
  let remoteTimer = null;
  let syncDebounce = null;
  let lastLocalRaw = localStorage.getItem(LOCAL_SESSION_KEY) || '';
  let pendingRemotePayload = null;
  let hasBootstrappedCloud = false;

  const builtInConfig = window.GAP_STUDY_CLOUD_CONFIG || {};

  const style = document.createElement('style');
  style.textContent = `
    .cloud-sync-button{white-space:nowrap}
    .cloud-sync-button[data-state="ok"]{border-color:var(--good);color:var(--good)}
    .cloud-sync-button[data-state="warn"]{border-color:#9b6a00;color:#9b6a00}
    .cloud-sync-button[data-state="error"]{border-color:var(--bad);color:var(--bad)}
    .cloud-sync-overlay{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:18px;background:rgba(0,0,0,.42);backdrop-filter:blur(8px)}
    .cloud-sync-overlay[hidden]{display:none}
    .cloud-sync-card{width:min(560px,100%);max-height:min(760px,92vh);overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 24px 80px rgba(0,0,0,.28)}
    .cloud-sync-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
    .cloud-sync-head h2{margin:0;font-size:1.25rem}.cloud-sync-head p{margin:.3rem 0 0;color:var(--muted);font-size:.92rem}
    .cloud-sync-close{min-width:42px;min-height:42px;padding:0;font-size:1.2rem}
    .cloud-sync-grid{display:grid;gap:12px}.cloud-sync-grid .field input{width:100%;font-size:16px}
    .cloud-sync-row{display:flex;flex-wrap:wrap;gap:9px}.cloud-sync-row .btn{flex:1 1 150px}
    .cloud-sync-status{margin:4px 0 0;min-height:1.45em;color:var(--muted);font-size:.92rem}
    .cloud-sync-status.good{color:var(--good)}.cloud-sync-status.bad{color:var(--bad)}
    .cloud-sync-note{font-size:.84rem;color:var(--muted);margin:0}
    .cloud-sync-banner{position:fixed;left:50%;bottom:max(16px,env(safe-area-inset-bottom));z-index:45;transform:translateX(-50%);display:flex;align-items:center;gap:10px;width:min(620px,calc(100% - 28px));padding:11px 12px;border:1px solid var(--line);border-radius:14px;background:var(--panel);box-shadow:0 12px 38px rgba(0,0,0,.2)}
    .cloud-sync-banner[hidden]{display:none}.cloud-sync-banner span{flex:1}.cloud-sync-banner .btn{padding:8px 11px}
    @media(max-width:520px){.cloud-sync-banner{align-items:stretch;flex-direction:column}.cloud-sync-banner .btn{width:100%}}
  `;
  document.head.appendChild(style);

  const header = document.querySelector('.top');
  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'btn secondary cloud-sync-button';
  openButton.textContent = 'Cloud sync';
  openButton.dataset.state = 'idle';
  header?.appendChild(openButton);

  const overlay = document.createElement('div');
  overlay.className = 'cloud-sync-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <section class="cloud-sync-card" role="dialog" aria-modal="true" aria-labelledby="cloudSyncTitle">
      <div class="cloud-sync-head">
        <div><h2 id="cloudSyncTitle">Cross-device progress</h2><p>Sign in with the same email on every device.</p></div>
        <button type="button" class="btn secondary cloud-sync-close" aria-label="Close">×</button>
      </div>
      <div class="cloud-sync-grid">
        <div class="field"><label for="cloudProjectUrl">Supabase project URL</label><input id="cloudProjectUrl" type="url" inputmode="url" autocomplete="off" placeholder="https://your-project.supabase.co"></div>
        <div class="field"><label for="cloudAnonKey">Supabase anon key</label><input id="cloudAnonKey" type="password" autocomplete="off" placeholder="Public anon key"></div>
        <div class="cloud-sync-row">
          <button type="button" class="btn secondary" id="saveCloudConfig">Save cloud configuration</button>
        </div>
        <hr>
        <div class="field"><label for="cloudEmail">Email</label><input id="cloudEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com"></div>
        <div class="cloud-sync-row">
          <button type="button" class="btn" id="cloudSignIn">Send sign-in link</button>
          <button type="button" class="btn secondary" id="cloudSyncNow">Sync now</button>
          <button type="button" class="btn secondary" id="cloudSignOut">Sign out</button>
        </div>
        <p class="cloud-sync-status" id="cloudSyncStatus" aria-live="polite"></p>
        <p class="cloud-sync-note">The anon key may be stored in public site code. The Supabase table must have Row Level Security enabled so each account can access only its own row.</p>
      </div>
    </section>
  `;
  document.body.appendChild(overlay);

  const banner = document.createElement('div');
  banner.className = 'cloud-sync-banner';
  banner.hidden = true;
  banner.innerHTML = '<span>Newer progress is available from another device.</span><button type="button" class="btn" id="applyCloudProgress">Load it</button><button type="button" class="btn secondary" id="dismissCloudProgress">Later</button>';
  document.body.appendChild(banner);

  const projectUrlInput = overlay.querySelector('#cloudProjectUrl');
  const anonKeyInput = overlay.querySelector('#cloudAnonKey');
  const emailInput = overlay.querySelector('#cloudEmail');
  const statusElement = overlay.querySelector('#cloudSyncStatus');
  const signOutButton = overlay.querySelector('#cloudSignOut');
  const syncNowButton = overlay.querySelector('#cloudSyncNow');

  function safeJsonParse(value, fallback = null) {
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function readSavedConfig() {
    return safeJsonParse(localStorage.getItem(LOCAL_CONFIG_KEY) || 'null', {}) || {};
  }

  function effectiveConfig() {
    const saved = readSavedConfig();
    return {
      supabaseUrl: String(builtInConfig.supabaseUrl || saved.supabaseUrl || '').trim(),
      supabaseAnonKey: String(builtInConfig.supabaseAnonKey || saved.supabaseAnonKey || '').trim()
    };
  }

  function configurationReady() {
    const config = effectiveConfig();
    return /^https:\/\/.+\.supabase\.co\/?$/i.test(config.supabaseUrl) && config.supabaseAnonKey.length > 30;
  }

  function fillConfigInputs() {
    const config = effectiveConfig();
    projectUrlInput.value = config.supabaseUrl;
    anonKeyInput.value = config.supabaseAnonKey;
    const fixed = Boolean(builtInConfig.supabaseUrl && builtInConfig.supabaseAnonKey);
    projectUrlInput.disabled = fixed;
    anonKeyInput.disabled = fixed;
    overlay.querySelector('#saveCloudConfig').disabled = fixed;
  }

  function setStatus(message, kind = '') {
    statusElement.textContent = message;
    statusElement.classList.toggle('good', kind === 'good');
    statusElement.classList.toggle('bad', kind === 'bad');
  }

  function setButtonState(label, state = 'idle') {
    openButton.textContent = label;
    openButton.dataset.state = state;
  }

  function refreshAuthUi() {
    signOutButton.disabled = !currentUser;
    syncNowButton.disabled = !currentUser;
    if (!configurationReady()) {
      setButtonState('Cloud sync: setup', 'warn');
      return;
    }
    if (!navigator.onLine) {
      setButtonState('Cloud sync: offline', 'warn');
      return;
    }
    if (currentUser) setButtonState('Cloud sync: on', 'ok');
    else setButtonState('Cloud sync: sign in', 'idle');
  }

  function openPanel() {
    fillConfigInputs();
    overlay.hidden = false;
    refreshAuthUi();
    if (currentUser) setStatus(`Signed in as ${currentUser.email || 'your account'}.`, 'good');
    else if (!configurationReady()) setStatus('Add the Supabase project URL and public anon key first.');
    else setStatus('Enter your email to receive a sign-in link.');
    window.setTimeout(() => (configurationReady() ? emailInput : projectUrlInput).focus(), 40);
  }

  function closePanel() {
    overlay.hidden = true;
    openButton.focus();
  }

  openButton.addEventListener('click', openPanel);
  overlay.querySelector('.cloud-sync-close').addEventListener('click', closePanel);
  overlay.addEventListener('click', event => { if (event.target === overlay) closePanel(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !overlay.hidden) closePanel(); });

  function sessionTime(payload) {
    const time = Date.parse(payload?.savedAt || '');
    return Number.isFinite(time) ? time : 0;
  }

  function isSessionPayload(payload) {
    return Boolean(payload && payload.version === 2 && Array.isArray(payload.pages) && payload.pages.length);
  }

  function readLocalPayload() {
    return safeJsonParse(localStorage.getItem(LOCAL_SESSION_KEY) || 'null');
  }

  function payloadSignature(payload) {
    if (!payload) return '';
    const copy = { ...payload };
    delete copy.savedAt;
    return JSON.stringify(copy);
  }

  function sameExercise(a, b) {
    if (!a || !b) return false;
    if (typeof a.source === 'string' && typeof b.source === 'string') return a.source === b.source;
    return JSON.stringify(a.pages || []) === JSON.stringify(b.pages || []);
  }

  function mergeEntryArrays(olderEntries, newerEntries) {
    const map = new Map(Array.isArray(olderEntries) ? olderEntries : []);
    for (const entry of Array.isArray(newerEntries) ? newerEntries : []) {
      if (Array.isArray(entry) && entry.length >= 2) map.set(entry[0], entry[1]);
    }
    return map;
  }

  function mergeSessions(localPayload, remotePayload) {
    if (!isSessionPayload(localPayload)) return remotePayload;
    if (!isSessionPayload(remotePayload)) return localPayload;

    const localNewer = sessionTime(localPayload) >= sessionTime(remotePayload);
    const newer = localNewer ? localPayload : remotePayload;
    const older = localNewer ? remotePayload : localPayload;

    if (!sameExercise(localPayload, remotePayload)) return newer;

    const completed = mergeEntryArrays(older.completed, newer.completed);
    const drafts = mergeEntryArrays(older.drafts, newer.drafts);
    for (const [key, value] of completed) {
      if (value?.answer != null) drafts.set(key, { value: value.answer, correct: true, wrong: false });
    }

    const newerCompletedCount = Array.isArray(newer.completed) ? newer.completed.length : 0;
    const newerDraftCount = Array.isArray(newer.drafts) ? newer.drafts.length : 0;
    const addedOlderProgress = completed.size > newerCompletedCount || drafts.size > newerDraftCount;

    return {
      ...older,
      ...newer,
      completed: [...completed.entries()],
      drafts: [...drafts.entries()],
      totalCorrect: Math.max(Number(localPayload.totalCorrect) || 0, Number(remotePayload.totalCorrect) || 0),
      totalAnswered: Math.max(Number(localPayload.totalAnswered) || 0, Number(remotePayload.totalAnswered) || 0),
      total: Math.max(Number(localPayload.total) || 0, Number(remotePayload.total) || 0),
      activeElapsed: Math.max(Number(localPayload.activeElapsed) || 0, Number(remotePayload.activeElapsed) || 0),
      lastPaceMark: Math.max(Number(localPayload.lastPaceMark) || 0, Number(remotePayload.lastPaceMark) || 0),
      samples: (Array.isArray(newer.samples) && newer.samples.length >= (older.samples?.length || 0)) ? newer.samples : (older.samples || []),
      savedAt: addedOlderProgress ? new Date().toISOString() : (newer.savedAt || new Date().toISOString())
    };
  }

  function pageIsBeingEdited() {
    const active = document.activeElement;
    return Boolean(active?.matches?.('#answers input, #source, textarea, input'));
  }

  function storeCloudMeta(payload) {
    try {
      localStorage.setItem(CLOUD_META_KEY, JSON.stringify({
        lastCloudSavedAt: payload?.savedAt || null,
        syncedAt: new Date().toISOString(),
        userId: currentUser?.id || null
      }));
    } catch {}
  }

  function applyCloudPayload(payload, force = false) {
    if (!isSessionPayload(payload)) return;
    if (!force && !document.hidden && pageIsBeingEdited()) {
      pendingRemotePayload = payload;
      banner.hidden = false;
      return;
    }

    const raw = JSON.stringify(payload);
    pendingRemotePayload = null;
    banner.hidden = true;
    lastLocalRaw = raw;
    localStorage.setItem(LOCAL_SESSION_KEY, raw);
    storeCloudMeta(payload);
    window.setTimeout(() => location.reload(), 80);
  }

  banner.querySelector('#applyCloudProgress').addEventListener('click', () => {
    if (pendingRemotePayload) applyCloudPayload(pendingRemotePayload, true);
  });
  banner.querySelector('#dismissCloudProgress').addEventListener('click', () => {
    banner.hidden = true;
  });

  async function createSupabaseClient() {
    if (client) return client;
    if (clientPromise) return clientPromise;
    if (!configurationReady()) throw new Error('Cloud configuration is incomplete.');

    clientPromise = (async () => {
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      const config = effectiveConfig();
      client = createClient(config.supabaseUrl.replace(/\/$/, ''), config.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });

      client.auth.onAuthStateChange((_event, session) => {
        currentUser = session?.user || null;
        refreshAuthUi();
        if (currentUser) {
          startSyncLoops();
          scheduleSync(60);
        } else stopSyncLoops();
      });

      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      currentUser = data.session?.user || null;
      refreshAuthUi();
      return client;
    })().finally(() => { clientPromise = null; });

    return clientPromise;
  }

  async function fetchRemotePayload() {
    const supabase = await createSupabaseClient();
    if (!currentUser) return null;
    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select('payload, updated_at')
      .eq('user_id', currentUser.id)
      .maybeSingle();
    if (error) throw error;
    return data?.payload || null;
  }

  async function uploadPayload(payload) {
    if (!isSessionPayload(payload)) return;
    const supabase = await createSupabaseClient();
    if (!currentUser) return;
    const { error } = await supabase.from(TABLE_NAME).upsert({
      user_id: currentUser.id,
      payload,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) throw error;
    storeCloudMeta(payload);
  }

  async function synchronize(reason = 'automatic') {
    if (syncPromise) return syncPromise;
    if (!navigator.onLine || !configurationReady()) return;

    syncPromise = (async () => {
      const supabase = await createSupabaseClient();
      const { data } = await supabase.auth.getSession();
      currentUser = data.session?.user || null;
      refreshAuthUi();
      if (!currentUser) return;

      if (reason === 'manual') setStatus('Synchronizing…');
      const localPayload = readLocalPayload();
      const remotePayload = await fetchRemotePayload();

      if (!isSessionPayload(localPayload) && !isSessionPayload(remotePayload)) {
        if (reason === 'manual') setStatus('There is no active exercise to synchronize.');
        return;
      }

      if (!isSessionPayload(remotePayload) && isSessionPayload(localPayload)) {
        await uploadPayload(localPayload);
        lastLocalRaw = JSON.stringify(localPayload);
        if (reason === 'manual') setStatus('Progress uploaded.', 'good');
        return;
      }

      if (!isSessionPayload(localPayload) && isSessionPayload(remotePayload)) {
        if (reason === 'manual') setStatus('Cloud progress found. Loading it…', 'good');
        applyCloudPayload(remotePayload, true);
        return;
      }

      const merged = mergeSessions(localPayload, remotePayload);
      const mergedSignature = payloadSignature(merged);
      const localSignature = payloadSignature(localPayload);
      const remoteSignature = payloadSignature(remotePayload);

      if (mergedSignature !== remoteSignature || sessionTime(merged) > sessionTime(remotePayload)) {
        await uploadPayload(merged);
      }

      if (mergedSignature !== localSignature || sessionTime(merged) > sessionTime(localPayload)) {
        if (!hasBootstrappedCloud || document.hidden || !pageIsBeingEdited()) applyCloudPayload(merged, true);
        else applyCloudPayload(merged, false);
        return;
      }

      lastLocalRaw = localStorage.getItem(LOCAL_SESSION_KEY) || '';
      storeCloudMeta(merged);
      if (reason === 'manual') setStatus('Progress is up to date.', 'good');
    })().catch(error => {
      console.warn('Gap Study cloud synchronization failed.', error);
      setButtonState('Cloud sync: error', 'error');
      if (reason === 'manual' || !overlay.hidden) setStatus(error.message || 'Cloud synchronization failed.', 'bad');
    }).finally(() => {
      hasBootstrappedCloud = true;
      syncPromise = null;
    });

    return syncPromise;
  }

  function scheduleSync(delay = 650) {
    if (!currentUser || !navigator.onLine) return;
    if (syncDebounce) clearTimeout(syncDebounce);
    syncDebounce = window.setTimeout(() => {
      syncDebounce = null;
      synchronize('automatic');
    }, delay);
  }

  function startSyncLoops() {
    stopSyncLoops();
    localTimer = window.setInterval(() => {
      const raw = localStorage.getItem(LOCAL_SESSION_KEY) || '';
      if (raw !== lastLocalRaw) {
        lastLocalRaw = raw;
        scheduleSync();
      }
    }, POLL_LOCAL_MS);
    remoteTimer = window.setInterval(() => synchronize('automatic'), POLL_REMOTE_MS);
  }

  function stopSyncLoops() {
    if (localTimer) clearInterval(localTimer);
    if (remoteTimer) clearInterval(remoteTimer);
    if (syncDebounce) clearTimeout(syncDebounce);
    localTimer = null;
    remoteTimer = null;
    syncDebounce = null;
  }

  overlay.querySelector('#saveCloudConfig').addEventListener('click', async () => {
    const config = {
      supabaseUrl: projectUrlInput.value.trim(),
      supabaseAnonKey: anonKeyInput.value.trim()
    };
    localStorage.setItem(LOCAL_CONFIG_KEY, JSON.stringify(config));
    client = null;
    currentUser = null;
    stopSyncLoops();
    refreshAuthUi();
    if (!configurationReady()) {
      setStatus('The project URL or anon key does not look complete.', 'bad');
      return;
    }
    try {
      await createSupabaseClient();
      setStatus('Cloud configuration saved.', 'good');
      if (currentUser) {
        startSyncLoops();
        await synchronize('manual');
      }
    } catch (error) {
      setStatus(error.message || 'Could not connect to Supabase.', 'bad');
    }
  });

  overlay.querySelector('#cloudSignIn').addEventListener('click', async () => {
    const email = emailInput.value.trim();
    if (!email || !email.includes('@')) {
      setStatus('Enter a valid email address.', 'bad');
      return;
    }
    try {
      const supabase = await createSupabaseClient();
      setStatus('Sending the sign-in link…');
      const redirectTo = `${location.origin}${location.pathname}`;
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo }
      });
      if (error) throw error;
      setStatus('Check your email and open the sign-in link on this device.', 'good');
    } catch (error) {
      setStatus(error.message || 'Could not send the sign-in link.', 'bad');
    }
  });

  syncNowButton.addEventListener('click', () => synchronize('manual'));

  signOutButton.addEventListener('click', async () => {
    try {
      const supabase = await createSupabaseClient();
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      currentUser = null;
      stopSyncLoops();
      refreshAuthUi();
      setStatus('Signed out. Local progress remains on this device.', 'good');
    } catch (error) {
      setStatus(error.message || 'Could not sign out.', 'bad');
    }
  });

  window.addEventListener('online', () => {
    refreshAuthUi();
    if (currentUser) {
      startSyncLoops();
      scheduleSync(100);
    }
  });
  window.addEventListener('offline', () => {
    stopSyncLoops();
    refreshAuthUi();
  });
  window.addEventListener('pagehide', stopSyncLoops);

  async function bootstrap() {
    fillConfigInputs();
    refreshAuthUi();
    if (!configurationReady()) return;
    try {
      await createSupabaseClient();
      if (currentUser) {
        startSyncLoops();
        await synchronize('automatic');
      }
    } catch (error) {
      console.warn('Gap Study cloud sync could not start.', error);
      setButtonState('Cloud sync: error', 'error');
    }
  }

  bootstrap();
})();
