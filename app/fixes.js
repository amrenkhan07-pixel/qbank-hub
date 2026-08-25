/* QBank Hub safe UI fixes: explanation HTML + per-question 50s practice timer. */
(() => {
  let questionKey = '';
  let timerId = null;
  let deadline = 0;
  let timerNode = null;

  function renderExplanationHTML() {
    document.querySelectorAll('.notice p').forEach((p) => {
      const raw = p.textContent || '';
      if (/<[a-z][\s\S]*>/i.test(raw)) p.innerHTML = raw;
    });
  }

  function getQuestionKey() {
    const marker = document.querySelector('.question-layout .subtle');
    return marker ? marker.textContent.trim() : '';
  }

  function stopTimer() {
    if (timerId) clearInterval(timerId);
    timerId = null;
    if (timerNode) timerNode.remove();
    timerNode = null;
  }

  function startPracticeTimer() {
    const layout = document.querySelector('.question-layout');
    if (!layout) return;
    const mode = document.querySelector('.pill');
    if (!mode || mode.textContent.trim() !== 'Practice mode') return;

    const key = getQuestionKey();
    if (!key || key === questionKey) return;
    questionKey = key;
    stopTimer();

    const header = document.querySelector('main.shell > .row');
    if (!header) return;

    timerNode = document.createElement('div');
    timerNode.className = 'timer';
    timerNode.setAttribute('aria-label', 'Question time remaining');
    timerNode.textContent = '00:50';
    header.appendChild(timerNode);

    deadline = Date.now() + 50000;
    const tick = () => {
      const remaining = Math.max(0, deadline - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      timerNode.textContent = `00:${String(seconds).padStart(2, '0')}`;
      timerNode.classList.toggle('low', seconds <= 10);
      if (remaining <= 0) {
        stopTimer();
        const next = document.querySelector('[data-action="next"]');
        if (next && !next.disabled) next.click();
      }
    };
    tick();
    timerId = setInterval(tick, 250);
  }

  const observer = new MutationObserver(() => {
    renderExplanationHTML();
    startPracticeTimer();
  });

  window.addEventListener('beforeunload', stopTimer);
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(() => {
    renderExplanationHTML();
    startPracticeTimer();
  }, 500);
})();
