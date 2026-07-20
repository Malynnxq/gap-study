(() => {
  'use strict';

  const SESSION_KEY = 'gapStudyActiveSessionV2';
  const CONFIG_KEY = 'gapStudyCloudConfigV1';
  const TABLE = 'gap_study_sessions';
  const LOCAL_POLL_MS = 1200;
  const REMOTE_POLL_MS = 5000;
  const builtInConfig = window.GAP_STUDY_CLOUD_CONFIG || {};

  let client = null;
  let clientPromise = null;
  let currentUser = null;
  let syncPromise = null;
  let localTimer = null;
  let remoteTimer = null;
  let lastLocalSignature = progressSignature(readLocal());

  const title = document.querySelector('.top h1');
  if (title) {
    title.style.setProperty('color', '#00838f', 'important');
    const old = title.querySelector('.gap-study-build');
    if (old) old.textContent = 'build sync-core-v2';
    else title.insertAdjacentHTML('beforeend', '<span class="gap-study-build">build sync-core-v2</span>');
  }

  const style = document.createElement('style');
  style.textContent = `
    .cloud-sync-button{white-space:nowrap}
    .cloud-sync-button[data-state="ok"]{border-color:var(--good);color:var(--good)}
    .cloud-sync-button[data-state="warn"]{border-color:#9b6a00;color:#9b6a00}
    .cloud-sync-button[data-state="error"]{border-color:var(--bad);color:var(--bad)}
    .cloud-sync-overlay{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:18px;background:rgba(0,0,0,.42);backdrop-filter:blur(8px)}
    .cloud-sync-overlay[hidden]{display:none}
    .cloud-sync-card{width:min(560px,100%);max-height:92vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:18px;box-shadow:0 24px 80px rgba(0,0,0,.28)}
    .cloud-sync-head{display:flex;justify-content:space-between;gap:16px;margin-bottom:14px}
    .cloud-sync-head h2{margin:0;font-size:1.25rem}.cloud-sync-head p{margin:.3rem 0 0;color:var(--muted);font-size:.92rem}
    .cloud-sync-grid{display:grid;gap:12px}.cloud-sync-grid .field input{width:100%;font-size:16px}
    .cloud-sync-row{display:flex;flex-wrap:wrap;gap:9px}.cloud-sync-row .btn{flex:1 1 140px}
    .cloud-sync-status{min-height:1.4em;margin:2px 0 0;color:var(--muted);font-size:.92rem}
    .cloud-sync-status.good{color:var(--good)}.cloud-sync-status.bad{color:var(--bad)}
  `;
  document.head.appendChild(style);

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'btn secondary cloud-sync-button';
  openButton.textContent = 'Cloud sync';
  openButton.dataset.state = 'idle';
  document.querySelector('.top')?.appendChild(openButton);

  const overlay = document.createElement('div');
  overlay.className = 'cloud-sync-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <section class="cloud-sync-card" role="dialog" aria-modal="true" aria-labelledby="cloudSyncTitle">
      <div class="cloud-sync-head">
        <div><h2 id="cloudSyncTitle">Cross-device progress</h2><p>Use the same email and password on every device.</p></div>
        <button type="button" class="btn secondary" id="cloudClose" aria-label="Close">×</button>
      </div>
      <div class="cloud-sync-grid">
        <div class="field"><label for="cloudProjectUrl">Supabase project URL</label><input id="cloudProjectUrl" type="url" autocomplete="off"></div>
        <div class="field"><label for="cloudAnonKey">Supabase anon key</label><input id="cloudAnonKey" type="password" autocomplete="off"></div>
        <button type="button" class="btn secondary" id="cloudSaveConfig">Save cloud configuration</button>
        <hr>
        <div class="field"><label for="cloudEmail">Email</label><input id="cloudEmail" type="email" autocomplete="username"></div>
        <div class="field"><label for="cloudPassword">Password</label><input id="cloudPassword" type="password" autocomplete="current-password" minlength="6"></div>
        <div class="cloud-sync-row">
          <button type="button" class="btn" id="cloudSignIn">Sign in</button>
          <button type="button" class="btn secondary" id="cloudSignUp">Create account</button>
          <button type="button" class="btn secondary" id="cloudSyncNow">Sync now</button>
          <button type="button" class="btn secondary" id="cloudSignOut">Sign out</button>
        </div>
        <p class="cloud-sync-status" id="cloudStatus" aria-live="polite"></p>
      </div>
    </section>`;
  document.body.appendChild(overlay);

  const $ = selector => overlay.querySelector(selector);
  const projectUrlInput = $('#cloudProjectUrl');
  const anonKeyInput = $('#cloudAnonKey');
  const emailInput = $('#cloudEmail');
  const passwordInput = $('#cloudPassword');
  const status = $('#cloudStatus');
  const syncNowButton = $('#cloudSyncNow');
  const signOutButton = $('#cloudSignOut');

  function parseJson(value, fallback = null) {
    try { return JSON.parse(value); } catch { return fallback; }
  }

  function readLocal() {
    return parseJson(localStorage.getItem(SESSION_KEY) || 'null');
  }

  function validPayload(payload) {
    return Boolean(payload && payload.version === 2 && Array.isArray(payload.pages) && payload.pages.length);
  }

  function sessionTime(payload) {
    const value = Date.parse(payload?.savedAt || '');
    return Number.isFinite(value) ? value : 0;
  }

  function canonicalProgress(payload) {
    if (!validPayload(payload)) return null;
    return {
      version: payload.version,
      source: payload.source || '',
      pages: payload.pages,
      page: Number(payload.page) || 0,
      completed: Array.isArray(payload.completed) ? [...payload.completed].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) : [],
      drafts: Array.isArray(payload.drafts) ? [...payload.drafts].sort((a, b) => String(a[0]).localeCompare(String(b[0]))) : [],
      totalCorrect: Number(payload.totalCorrect) || 0,
      totalAnswered: Number(payload.totalAnswered) || 0,
      total: Number(payload.total) || 0,
      finishedAt: payload.finishedAt || null
    };
  }

  function progressSignature(payload) {
    const canonical = canonicalProgress(payload);
    return canonical ? JSON.stringify(canonical) : '';
  }

  function sameExercise(a, b) {
    if (!validPayload(a) || !validPayload(b)) return false;
    if (typeof a.source === 'string' && typeof b.source === 'string' && a.source && b.source) return a.source === b.source;
    return JSON.stringify(a.pages) === JSON.stringify(b.pages);
  }

  function entryMap(entries) {
    return new Map(Array.isArray(entries) ? entries.filter(item => Array.isArray(item) && item.length >= 2) : []);
  }

  function textOf(value) {
    return String(value?.value ?? value?.answer ?? '').trim();
  }

  function mergeSessions(localPayload, remotePayload) {
    if (!validPayload(localPayload)) return remotePayload;
    if (!validPayload(remotePayload)) return localPayload;
    if (!sameExercise(localPayload, remotePayload)) return sessionTime(remotePayload) > sessionTime(localPayload) ? remotePayload : localPayload;

    const localNewer = sessionTime(localPayload) >= sessionTime(remotePayload);
    const newer = localNewer ? localPayload : remotePayload;
    const older = localNewer ? remotePayload : localPayload;
    const completed = entryMap(older.completed);
    for (const [key, value] of entryMap(newer.completed)) completed.set(key, value);

    const oldDrafts = entryMap(older.drafts);
    const newDrafts = entryMap(newer.drafts);
    const keys = new Set([...oldDrafts.keys(), ...newDrafts.keys(), ...completed.keys()]);
    const drafts = new Map();

    for (const key of keys) {
      const done = completed.get(key);
      if (done) {
        drafts.set(key, { value: done.answer ?? textOf(newDrafts.get(key)) ?? textOf(oldDrafts.get(key)), correct: true, wrong: false });
        continue;
      }
      const oldValue = oldDrafts.get(key);
      const newValue = newDrafts.get(key);
      const oldText = textOf(oldValue);
      const newText = textOf(newValue);
      if (newValue?.correct) drafts.set(key, newValue);
      else if (oldValue?.correct) drafts.set(key, oldValue);
      else if (newText) drafts.set(key, newValue);
      else if (oldText) drafts.set(key, oldValue);
      else if (newValue) drafts.set(key, newValue);
      else if (oldValue) drafts.set(key, oldValue);
    }

    return {
      ...older,
      ...newer,
      completed: [...completed.entries()],
      drafts: [...drafts.entries()],
      totalCorrect: Math.max(Number(localPayload.totalCorrect) || 0, Number(remotePayload.totalCorrect) || 0),
      totalAnswered: Math.max(Number(localPayload.totalAnswered) || 0, Number(remotePayload.totalAnswered) || 0),
      total: Math.max(Number(localPayload.total) || 0, Number(remotePayload.total) || 0),
      savedAt: newer.savedAt || new Date().toISOString()
    };
  }

  function savedConfig() {
    return parseJson(localStorage.getItem(CONFIG_KEY) || 'null', {}) || {};
  }

  function effectiveConfig() {
    const saved = savedConfig();
    return {
      supabaseUrl: String(builtInConfig.supabaseUrl || saved.supabaseUrl || '').trim(),
      supabaseAnonKey: String(builtInConfig.supabaseAnonKey || saved.supabaseAnonKey || '').trim()
    };
  }

  function configReady() {
    const config = effectiveConfig();
    return /^https:\/\/.+\.supabase\.co\/?$/i.test(config.supabaseUrl) && config.supabaseAnonKey.length > 30;
  }

  function setStatus(message, kind = '') {
    status.textContent = message;
    status.classList.toggle('good', kind === 'good');
    status.classList.toggle('bad', kind === 'bad');
  }

  function refreshUi() {
    syncNowButton.disabled = !currentUser;
    signOutButton.disabled = !currentUser;
    if (!configReady()) {
      openButton.textContent = 'Cloud sync: setup';
      openButton.dataset.state = 'warn';
    } else if (!navigator.onLine) {
      openButton.textContent = 'Cloud sync: offline';
      openButton.dataset.state = 'warn';
    } else if (currentUser) {
      openButton.textContent = 'Cloud sync: on';
      openButton.dataset.state = 'ok';
    } else {
      openButton.textContent = 'Cloud sync: sign in';
      openButton.dataset.state = 'idle';
    }
  }

  function fillConfig() {
    const config = effectiveConfig();
    projectUrlInput.value = config.supabaseUrl;
    anonKeyInput.value = config.supabaseAnonKey;
    const fixed = Boolean(builtInConfig.supabaseUrl && builtInConfig.supabaseAnonKey);
    projectUrlInput.disabled = fixed;
    anonKeyInput.disabled = fixed;
    $('#cloudSaveConfig').disabled = fixed;
  }

  async function getClient() {
    if (client) return client;
    if (clientPromise) return clientPromise;
    if (!configReady()) throw new Error('Cloud configuration is incomplete.');
    clientPromise = (async () => {
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      const config = effectiveConfig();
      client = createClient(config.supabaseUrl.replace(/\/$/, ''), config.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
      client.auth.onAuthStateChange((_event, session) => {
        currentUser = session?.user || null;
        refreshUi();
        if (currentUser) startLoops(); else stopLoops();
      });
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      currentUser = data.session?.user || null;
      refreshUi();
      return client;
    })().finally(() => { clientPromise = null; });
    return clientPromise;
  }

  async function fetchRemote() {
    const supabase = await getClient();
    if (!currentUser) return null;
    const { data, error } = await supabase.from(TABLE).select('payload').eq('user_id', currentUser.id).maybeSingle();
    if (error) throw error;
    return data?.payload || null;
  }

  async function upload(payload) {
    if (!validPayload(payload) || !currentUser) return;
    const supabase = await getClient();
    const { error } = await supabase.from(TABLE).upsert({
      user_id: currentUser.id,
      payload,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) throw error;
  }

  function applyRemote(payload) {
    if (!validPayload(payload)) return false;
    const signature = progressSignature(payload);
    if (!signature || signature === progressSignature(readLocal())) return false;
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    lastLocalSignature = signature;
    const appliedKey = 'gapStudyLastAppliedRemoteSignatureV2';
    if (sessionStorage.getItem(appliedKey) !== signature) {
      sessionStorage.setItem(appliedKey, signature);
      window.setTimeout(() => location.reload(), 120);
    }
    return true;
  }

  async function synchronize(reason = 'automatic') {
    if (syncPromise || !navigator.onLine || !configReady()) return syncPromise;
    syncPromise = (async () => {
      const supabase = await getClient();
      const { data } = await supabase.auth.getSession();
      currentUser = data.session?.user || null;
      refreshUi();
      if (!currentUser) return;
      if (reason === 'manual') setStatus('Synchronizing…');

      const localPayload = readLocal();
      const remotePayload = await fetchRemote();
      if (!validPayload(localPayload) && !validPayload(remotePayload)) {
        if (reason === 'manual') setStatus('There is no active exercise to synchronize.');
        return;
      }
      if (!validPayload(remotePayload)) {
        await upload(localPayload);
        lastLocalSignature = progressSignature(localPayload);
        if (reason === 'manual') setStatus('Progress uploaded.', 'good');
        return;
      }
      if (!validPayload(localPayload)) {
        applyRemote(remotePayload);
        return;
      }

      const merged = mergeSessions(localPayload, remotePayload);
      const mergedSignature = progressSignature(merged);
      if (mergedSignature !== progressSignature(remotePayload)) await upload(merged);
      if (mergedSignature !== progressSignature(localPayload)) {
        applyRemote(merged);
        return;
      }
      lastLocalSignature = mergedSignature;
      if (reason === 'manual') setStatus('Progress is up to date.', 'good');
    })().catch(error => {
      console.warn('Gap Study cloud synchronization failed.', error);
      openButton.textContent = 'Cloud sync: error';
      openButton.dataset.state = 'error';
      if (reason === 'manual' || !overlay.hidden) setStatus(error.message || 'Cloud synchronization failed.', 'bad');
    }).finally(() => { syncPromise = null; });
    return syncPromise;
  }

  function stopLoops() {
    if (localTimer) clearInterval(localTimer);
    if (remoteTimer) clearInterval(remoteTimer);
    localTimer = null;
    remoteTimer = null;
  }

  function startLoops() {
    stopLoops();
    localTimer = window.setInterval(() => {
      const signature = progressSignature(readLocal());
      if (signature !== lastLocalSignature) {
        lastLocalSignature = signature;
        synchronize('automatic');
      }
    }, LOCAL_POLL_MS);
    remoteTimer = window.setInterval(() => synchronize('automatic'), REMOTE_POLL_MS);
  }

  function credentials() {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !email.includes('@')) throw new Error('Enter a valid email address.');
    if (password.length < 6) throw new Error('Password must contain at least 6 characters.');
    return { email, password };
  }

  openButton.addEventListener('click', () => {
    fillConfig();
    overlay.hidden = false;
    refreshUi();
    setStatus(currentUser ? `Signed in as ${currentUser.email || 'your account'}.` : 'Enter your email and password.', currentUser ? 'good' : '');
  });
  $('#cloudClose').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', event => { if (event.target === overlay) overlay.hidden = true; });

  $('#cloudSaveConfig').addEventListener('click', async () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ supabaseUrl: projectUrlInput.value.trim(), supabaseAnonKey: anonKeyInput.value.trim() }));
    client = null;
    currentUser = null;
    stopLoops();
    refreshUi();
    try { await getClient(); setStatus('Cloud configuration saved.', 'good'); }
    catch (error) { setStatus(error.message || 'Could not connect to Supabase.', 'bad'); }
  });

  $('#cloudSignIn').addEventListener('click', async () => {
    try {
      const supabase = await getClient();
      setStatus('Signing in…');
      const { error } = await supabase.auth.signInWithPassword(credentials());
      if (error) throw error;
      const { data } = await supabase.auth.getSession();
      currentUser = data.session?.user || null;
      passwordInput.value = '';
      refreshUi();
      startLoops();
      await synchronize('manual');
    } catch (error) { setStatus(error.message || 'Could not sign in.', 'bad'); }
  });

  $('#cloudSignUp').addEventListener('click', async () => {
    try {
      const supabase = await getClient();
      setStatus('Creating account…');
      const { data, error } = await supabase.auth.signUp(credentials());
      if (error) throw error;
      if (!data.session) throw new Error('Account created, but email confirmation is still required in Supabase.');
      currentUser = data.session.user;
      passwordInput.value = '';
      refreshUi();
      startLoops();
      await synchronize('manual');
    } catch (error) { setStatus(error.message || 'Could not create the account.', 'bad'); }
  });

  syncNowButton.addEventListener('click', () => synchronize('manual'));
  signOutButton.addEventListener('click', async () => {
    try {
      const supabase = await getClient();
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      currentUser = null;
      stopLoops();
      refreshUi();
      setStatus('Signed out. Local progress remains on this device.', 'good');
    } catch (error) { setStatus(error.message || 'Could not sign out.', 'bad'); }
  });

  window.addEventListener('online', () => { refreshUi(); if (currentUser) { startLoops(); synchronize('automatic'); } });
  window.addEventListener('offline', () => { stopLoops(); refreshUi(); });
  window.addEventListener('pagehide', stopLoops);

  (async () => {
    fillConfig();
    refreshUi();
    if (!configReady()) return;
    try {
      await getClient();
      if (currentUser) {
        startLoops();
        await synchronize('automatic');
      }
    } catch (error) {
      console.warn('Gap Study cloud sync could not start.', error);
      openButton.textContent = 'Cloud sync: error';
      openButton.dataset.state = 'error';
    }
  })();
})();
