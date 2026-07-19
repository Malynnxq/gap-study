(() => {
  'use strict';

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
    samples: [],
    activeElapsed: 0,
    activeSince: null,
    lastPaceMark: 0,
    timer: null,
    started: false,
    finishedAt: null
  };

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

  function resetEta() {
    if (eta.timer) clearInterval(eta.timer);
    eta.total = pages.reduce((sum, item) => sum + item.gaps.length, 0);
    eta.completed.clear();
    eta.samples = [];
    eta.activeElapsed = 0;
    eta.activeSince = null;
    eta.lastPaceMark = 0;
    eta.started = true;
    eta.finishedAt = null;
    resumeClock();
    eta.timer = window.setInterval(updateEta, 1000);
    updateEta();
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
      const saved = eta.completed.get(gapKey(input.dataset.gap));
      if (!saved) return;
      input.value = saved.answer;
      input.classList.remove('wrong');
      input.classList.add('correct');
      revealTextGap(input);
    });
  }

  function recordManualCompletions(inputs) {
    const fresh = inputs.filter(input => !eta.completed.has(gapKey(input.dataset.gap)));
    if (!fresh.length) return;

    resumeClock();
    const now = activeElapsed();
    const blockTime = Math.max(0, now - eta.lastPaceMark);
    const timePerGap = blockTime / fresh.length;

    fresh.forEach(input => {
      eta.completed.set(gapKey(input.dataset.gap), {
        answer: input.dataset.answer,
        revealed: false
      });
      eta.samples.push(timePerGap);
    });

    eta.lastPaceMark = now;
    updateEta();
  }

  function recordRevealedCompletions(inputs) {
    let changed = false;
    inputs.forEach(input => {
      const key = gapKey(input.dataset.gap);
      if (eta.completed.has(key)) return;
      eta.completed.set(key, { answer: input.dataset.answer, revealed: true });
      changed = true;
    });
    if (!changed) return;
    eta.lastPaceMark = activeElapsed();
    updateEta();
  }

  const originalShow = show;
  show = function showWithEta() {
    const result = originalShow();
    restoreCurrentPage();
    updateEta();
    return result;
  };

  const originalCheckOne = checkOne;
  checkOne = function checkOneWithEta(input) {
    const result = originalCheckOne(input);
    if (result) recordManualCompletions([input]);
    return result;
  };

  const generateButton = document.getElementById('generate');
  const originalGenerate = generateButton.onclick;
  generateButton.onclick = function generateWithEta(event) {
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
  const originalReveal = revealButton.onclick;
  revealButton.onclick = function revealWithEta(event) {
    const inputs = [...document.querySelectorAll('#answers input')];
    const result = originalReveal.call(this, event);
    recordRevealedCompletions(inputs);
    return result;
  };

  const backButton = document.getElementById('backSetup');
  const originalBack = backButton.onclick;
  backButton.onclick = function backWithPausedEta(event) {
    const result = originalBack.call(this, event);
    pauseClock();
    return result;
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseClock();
    else resumeClock();
    updateEta();
  });
  window.addEventListener('pagehide', pauseClock);
})();
