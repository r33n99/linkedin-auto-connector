// Плавающая панель управления на странице выдачи.

(() => {
  let root = null;
  let handlers = { onStart: () => {}, onStop: () => {} };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  function build() {
    const panel = el('div', 'lac-panel');
    panel.dataset.state = 'idle';

    const head = el('div', 'lac-head');
    head.append(el('span', 'lac-dot'), el('span', 'lac-title', 'Auto Connector'));
    const collapse = el('button', 'lac-collapse', '—');
    collapse.title = 'Свернуть';
    collapse.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = panel.classList.toggle('lac-collapsed');
      collapse.textContent = collapsed ? '+' : '—';
      collapse.title = collapsed ? 'Развернуть' : 'Свернуть';
    });
    head.append(collapse);

    const body = el('div', 'lac-body');
    const status = el('p', 'lac-status', 'Готов к работе');

    const meters = el('div', 'lac-meters');
    const dayMeter = meter('Сегодня');
    const weekMeter = meter('За неделю');
    meters.append(dayMeter.box, weekMeter.box);

    const actions = el('div', 'lac-actions');
    const startBtn = el('button', 'lac-btn lac-btn-primary', 'Старт');
    const stopBtn = el('button', 'lac-btn lac-btn-ghost', 'Стоп');
    stopBtn.disabled = true;
    startBtn.addEventListener('click', () => handlers.onStart());
    stopBtn.addEventListener('click', () => handlers.onStop());
    actions.append(startBtn, stopBtn);

    const log = el('ul', 'lac-log');
    const hint = el('p', 'lac-hint', 'Лимиты и фильтры — в попапе расширения.');

    body.append(status, meters, actions, log, hint);
    panel.append(head, body);
    makeDraggable(panel, head);

    return { panel, status, dayMeter, weekMeter, startBtn, stopBtn, log };
  }

  function meter(label) {
    const box = el('div', 'lac-meter');
    const value = el('div', 'lac-meter-value', '0 / 0');
    box.append(el('div', 'lac-meter-label', label), value);
    return { box, value };
  }

  function makeDraggable(panel, handle) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    const onMove = (e) => {
      const left = Math.min(
        Math.max(0, originLeft + e.clientX - startX),
        window.innerWidth - panel.offsetWidth
      );
      const top = Math.min(
        Math.max(0, originTop + e.clientY - startY),
        window.innerHeight - 40
      );
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    handle.addEventListener('mousedown', (e) => {
      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  function mount(nextHandlers) {
    handlers = { ...handlers, ...nextHandlers };
    if (root?.panel.isConnected) return root;
    root = build();
    document.body.append(root.panel);
    return root;
  }

  function unmount() {
    root?.panel.remove();
    root = null;
  }

  function setState(state) {
    if (!root) return;
    root.panel.dataset.state = state;
    root.startBtn.disabled = state === 'running';
    root.stopBtn.disabled = state !== 'running';
    root.startBtn.textContent = state === 'running' ? 'Работает…' : 'Старт';
  }

  function setStatus(message) {
    if (root) root.status.textContent = message;
  }

  function setStats(stats, settings) {
    if (!root) return;
    const day = `${stats.daySent} / ${settings.dailyLimit}`;
    const week = `${stats.weekSent} / ${settings.weeklyLimit}`;
    root.dayMeter.value.textContent = day;
    root.weekMeter.value.textContent = week;
    root.dayMeter.value.classList.toggle('lac-maxed', stats.daySent >= settings.dailyLimit);
    root.weekMeter.value.classList.toggle('lac-maxed', stats.weekSent >= settings.weeklyLimit);
  }

  function log(message, kind = '') {
    if (!root) return;
    const item = el('li', kind ? `lac-${kind}` : '', message);
    root.log.append(item);
    while (root.log.children.length > 60) root.log.firstChild.remove();
    root.log.scrollTop = root.log.scrollHeight;
  }

  self.LAC.hud = { mount, unmount, setState, setStatus, setStats, log };
})();
