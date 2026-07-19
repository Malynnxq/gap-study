(() => {
  'use strict';

  const SESSION_KEY = 'gapStudyActiveSessionV2';

  const etaLabel = document.createElement('div');
  etaLabel.id = 'etaLabel';
  etaLabel.className = 'eta-label';
  etaLabel.setAttribute('aria-live', 'polite');
  etaLabel.hidden = true;
  document.querySelector('.progress')?.insertAdjacentElement('afterend', etaLabel);

  const etaStyle = document.createElement('style');
  etaStyle.textContent = `
    .eta-label{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;margin:10px 0 2px;color:var(--muted);font-size:.9rem;min-height:1.4em}
    .eta-label strong{color:var(--text);font-weight:700}
    @media(max-width:390px){.eta-label{font-size:.86rem;line-height:1.4}}
  `;
  document.head.appendChild(etaStyle);

  const eta = {
    total: 0,
    completed: new Map(),
    drafts: new Map(),
    samples: [],
    activeElapsed: 0,
    activeSince: null,
    lastPaceMark: 0,
    timer: null,
    saveTimer: null,
    started: false,
    finishedAt: null
  };

  let renderedPage = null;
  const gapKey = (num, pageIndex = page) => `${pageIndex}:${num}`;

  function studyIsVisible() {
    const study = document.getElementById('study');
    return !!study && getComputedStyle(study).display !== 'none';
  }

  function resumeClock() {
    if (!eta.started || document.hidden || !studyIsVisible() || eta.activeSince !== null) return;
    eta.activeSince = performance.now();
  }

  function pauseClock() {
    if (eta.activeSince === null) return;
    eta.activeElapsed += performance.now() - eta.activeSince;
    eta.activeSince = null;
  }

  function activeElapsed() {
    return eta.activeElapsed + (eta.activeSince === null ? 0 : performance.now() - eta.activeSince);
  }

  function formatClock(date) {
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return new Intl.DateTimeFormat(undefined, sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { weekday: 'short', hour: '2-digit', minute: '2-digit' }
    ).format(date);
  }

  function formatRemaining(milliseconds) {
    const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
    if (seconds < 60) return `${seconds} sec`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }

  function averageGapTime() {
    if (!eta.samples.length) return 0;
    return eta.samples.reduce((sum, value) => sum + value, 0) / eta.samples.length;
  }

  function updateEta() {
    if (!eta.started) {
      etaLabel.hidden = true;
      return;
    }

    etaLabel.hidden = false;
    const done = eta.completed.size;
    const remaining = Math.max(0, eta.total - done);

    if (!eta.total) {
      etaLabel.textContent = 'No gaps in this exercise.';
      return;
    }

    if (!remaining) {
      if (!eta.finishedAt) eta.finishedAt = new Date();
      etaLabel.innerHTML = `<strong>All gaps filled</strong><span>· finished at ${formatClock(eta.finishedAt)} · ${done}/${eta.total}</span>`;
      if (eta.timer) {
        clearInterval(eta.timer);
        eta.timer = null;
      }
      pauseClock();
      scheduleSave();
      return;
    }

    const average = averageGapTime();
    if (!average) {
      etaLabel.innerHTML = `<strong>Estimated finish:</strong><span>complete one gap to calculate · ${done}/${eta.total} filled</span>`;
      return;
    }

    const remainingMs = average * remaining;
    const finish = new Date(Date.now() + remainingMs);
    etaLabel.innerHTML = `<strong>Estimated finish: ${formatClock(finish)}</strong><span>· about ${formatRemaining(remainingMs)} left · ${done}/${eta.total} filled</span>`;
  }

  function captureCurrentPageInputs(pageIndex = renderedPage ?? page) {
    if (!eta.started || pageIndex == null) return;
    document.querySelectorAll('#answers input').forEach(input => {
      eta.drafts.set(gapKey(input.dataset.gap, pageIndex), {
        value: input.value,
        correct: input.classList.contains('correct'),
        wrong: input.classList.contains('wrong')
      });
    });
  }

  function saveSession() {
    if (!eta.started || !Array.isArray(pages) || !pages.length) return;
    captureCurrentPageInputs();
    const payload = {
      version: 2,
      source: document.getElementById('source')?.value || '',
      pages,
      page,
      totalCorrect,
      totalAnswered,
      completed: [...eta.completed.entries()],
      drafts: [...eta.drafts.entries()],
      samples: eta.samples,
      total: eta.total,
      activeElapsed: activeElapsed(),
      lastPaceMark: eta.lastPaceMark,
      finishedAt: eta.finishedAt ? eta.finishedAt.toISOString() : null,
      savedAt: new Date().toISOString()
    };
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch (error) {
      console.warn('Gap Study could not save the active exercise.', error);
    }
  }

  function scheduleSave() {
    if (eta.saveTimer) clearTimeout(eta.saveTimer);
    eta.saveTimer = window.setTimeout(() => {
      eta.saveTimer = null;
      saveSession();
    }, 120);
  }

  function readSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function clearEtaSession(removeSaved = true) {
    if (eta.timer) clearInterval(eta.timer);
    if (eta.saveTimer) clearTimeout(eta.saveTimer);
    pauseClock();
    eta.total = 0;
    eta.completed.clear();
    eta.drafts.clear();
    eta.samples = [];
    eta.activeElapsed = 0;
    eta.activeSince = null;
    eta.lastPaceMark = 0;
    eta.timer = null;
    eta.saveTimer = null;
    eta.started = false;
    eta.finishedAt = null;
    renderedPage = null;
    etaLabel.hidden = true;
    if (removeSaved) {
      try { localStorage.removeItem(SESSION_KEY); } catch {}
    }
  }

  function resetEta() {
    if (eta.timer) clearInterval(eta.timer);
    eta.total = pages.reduce((sum, item) => sum + item.gaps.length, 0);
    eta.completed.clear();
    eta.drafts.clear();
    eta.samples = [];
    eta.activeElapsed = 0;
    eta.activeSince = null;
    eta.lastPaceMark = 0;
    eta.started = true;
    eta.finishedAt = null;
    renderedPage = page;
    resumeClock();
    eta.timer = window.setInterval(updateEta, 1000);
    updateEta();
    saveSession();
  }

  function revealTextGap(input) {
    const num = input.dataset.gap;
    const gap = document.getElementById(`gap-${num}`);
    if (!gap) return;
    gap.textContent = input.dataset.answer;
    gap.classList.add('solved');
    gap.style.width = 'auto';
    gap.style.minWidth = '0';
    gap.removeAttribute('role');
    gap.removeAttribute('tabindex');
  }

  function restoreCurrentPage() {
    if (!eta.started) return;
    document.querySelectorAll('#answers input').forEach(input => {
      const key = gapKey(input.dataset.gap, renderedPage ?? page);
      const completed = eta.completed.get(key);
      const draft = eta.drafts.get(key);

      if (completed) {
        input.value = completed.answer;
        input.classList.remove('wrong');
        input.classList.add('correct');
        revealTextGap(input);
        return;
      }

      if (draft) {
        input.value = draft.value || '';
        input.classList.toggle('correct', !!draft.correct);
        input.classList.toggle('wrong', !!draft.wrong);
      }
    });
  }

  function recordManualCompletions(inputs) {
    const pageIndex = renderedPage ?? page;
    const fresh = inputs.filter(input => !eta.completed.has(gapKey(input.dataset.gap, pageIndex)));
    if (!fresh.length) {
      scheduleSave();
      return;
    }

    resumeClock();
    const now = activeElapsed();
    const blockTime = Math.max(0, now - eta.lastPaceMark);
    const timePerGap = blockTime / fresh.length;

    fresh.forEach(input => {
      const key = gapKey(input.dataset.gap, pageIndex);
      eta.completed.set(key, {
        answer: input.dataset.answer,
        revealed: false
      });
      eta.drafts.set(key, { value: input.dataset.answer, correct: true, wrong: false });
      eta.samples.push(timePerGap);
    });

    eta.lastPaceMark = now;
    updateEta();
    saveSession();
  }

  function recordRevealedCompletions(inputs) {
    const pageIndex = renderedPage ?? page;
    let changed = false;
    inputs.forEach(input => {
      const key = gapKey(input.dataset.gap, pageIndex);
      if (eta.completed.has(key)) return;
      eta.completed.set(key, { answer: input.dataset.answer, revealed: true });
      eta.drafts.set(key, { value: input.dataset.answer, correct: true, wrong: false });
      changed = true;
    });
    if (!changed) {
      scheduleSave();
      return;
    }
    eta.lastPaceMark = activeElapsed();
    updateEta();
    saveSession();
  }

  function currentRevealInput() {
    const active = document.activeElement;
    if (active?.matches?.('#answers input') && !active.classList.contains('correct')) return active;

    const focused = document.querySelector('.answer-row.focused input:not(.correct)');
    if (focused) return focused;

    const activeGap = document.querySelector('.gap.active[data-gap]');
    if (activeGap) {
      const input = document.querySelector(`#answers input[data-gap="${activeGap.dataset.gap}"]`);
      if (input && !input.classList.contains('correct')) return input;
    }

    return document.querySelector('#answers input:not(.correct)');
  }

  function restoreSavedSession() {
    const saved = readSession();
    if (!saved || saved.version !== 2 || !Array.isArray(saved.pages) || !saved.pages.length) return false;

    try {
      pages = saved.pages;
      page = Math.max(0, Math.min(Number(saved.page) || 0, pages.length - 1));
      totalCorrect = Number(saved.totalCorrect) || 0;
      totalAnswered = Number(saved.totalAnswered) || 0;
      eta.total = Number(saved.total) || pages.reduce((sum, item) => sum + item.gaps.length, 0);
      eta.completed = new Map(Array.isArray(saved.completed) ? saved.completed : []);
      eta.drafts = new Map(Array.isArray(saved.drafts) ? saved.drafts : []);
      eta.samples = Array.isArray(saved.samples) ? saved.samples.filter(Number.isFinite) : [];
      eta.activeElapsed = Math.max(0, Number(saved.activeElapsed) || 0);
      eta.activeSince = null;
      eta.lastPaceMark = Math.max(0, Number(saved.lastPaceMark) || 0);
      eta.started = true;
      eta.finishedAt = saved.finishedAt ? new Date(saved.finishedAt) : null;

      const source = document.getElementById('source');
      if (source && typeof saved.source === 'string') source.value = saved.source;
      document.getElementById('setup').style.display = 'none';
      document.getElementById('study').style.display = 'block';

      show();
      renderedPage = page;
      resumeClock();
      if (eta.completed.size < eta.total) eta.timer = window.setInterval(updateEta, 1000);
      updateEta();
      saveSession();
      return true;
    } catch (error) {
      console.warn('Gap Study could not restore the active exercise.', error);
      clearEtaSession(true);
      return false;
    }
  }

  const originalShow = show;
  show = function showWithEta() {
    captureCurrentPageInputs(renderedPage ?? page);
    const result = originalShow();
    renderedPage = page;
    restoreCurrentPage();
    updateEta();
    scheduleSave();
    return result;
  };

  const originalCheckOne = checkOne;
  checkOne = function checkOneWithEta(input) {
    const result = originalCheckOne(input);
    if (result) recordManualCompletions([input]);
    else scheduleSave();
    return result;
  };

  const generateButton = document.getElementById('generate');
  const originalGenerate = generateButton.onclick;
  generateButton.onclick = function generateWithEta(event) {
    clearEtaSession(true);
    const result = originalGenerate.call(this, event);
    if (pages.length && studyIsVisible()) resetEta();
    return result;
  };

  const checkButton = document.getElementById('check');
  const originalCheck = checkButton.onclick;
  checkButton.onclick = function checkAllWithEta(event) {
    const inputs = [...document.querySelectorAll('#answers input')];
    const result = originalCheck.call(this, event);
    recordManualCompletions(inputs.filter(input => norm(input.value) === norm(input.dataset.answer)));
    return result;
  };

  const revealButton = document.getElementById('reveal');
  revealButton.onclick = function revealCurrentGap() {
    const input = currentRevealInput();
    if (!input) {
      document.getElementById('feedback').innerHTML = '<span class="good">All gaps on this part are already filled.</span>';
      return;
    }

    const num = input.dataset.gap;
    input.value = input.dataset.answer;
    input.classList.remove('wrong');
    input.classList.add('correct');
    revealTextGap(input);
    document.getElementById('feedback').textContent = `Answer ${num} revealed.`;
    recordRevealedCompletions([input]);
    input.blur();
    window.setTimeout(() => scrollBackToGap(num), 120);
  };

  const backButton = document.getElementById('backSetup');
  const originalBack = backButton.onclick;
  backButton.onclick = function backWithPausedEta(event) {
    captureCurrentPageInputs();
    const result = originalBack.call(this, event);
    pauseClock();
    saveSession();
    return result;
  };

  document.getElementById('answers')?.addEventListener('input', event => {
    const input = event.target.closest('input[data-gap]');
    if (!input || !eta.started) return;
    const key = gapKey(input.dataset.gap, renderedPage ?? page);
    eta.drafts.set(key, {
      value: input.value,
      correct: input.classList.contains('correct'),
      wrong: input.classList.contains('wrong')
    });
    scheduleSave();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pauseClock();
      saveSession();
    } else {
      resumeClock();
      updateEta();
    }
  });

  window.addEventListener('pagehide', () => {
    pauseClock();
    saveSession();
  });
  window.addEventListener('beforeunload', saveSession);

  restoreSavedSession();
})();
