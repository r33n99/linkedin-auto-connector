// Основной цикл: находим карточку → жмём Connect → закрываем модалку → ждём → дальше.

(() => {
  const {
    dom,
    hud,
    loadSettings,
    loadStats,
    bumpSent,
    markBlocked,
    takePendingStart,
    renderNote,
    randInt,
    sleep,
    interruptibleSleep,
  } = self.LAC;
  const { RE } = dom;

  const state = {
    running: false,
    settings: null,
    // Профили, которые уже обработаны в этой сессии (отправлено или отфильтровано).
    processed: new Set(),
    // Кому повторный заход уже давали — второй раз не возвращаемся, чтобы цикл
    // не гонял одного и того же человека бесконечно.
    retried: new Set(),
    sinceLongPause: 0,
    scrollAttempts: 0,
    lastStatus: 'Готов к работе',
    // Счётчики прогона — по ним понятно, что именно пошло не так.
    seen: 0,
    filtered: 0,
    sent: 0,
    // Месячный лимит персонализированных приглашений выбран: до конца прогона
    // даже не пытаемся заходить через «Персонализировать».
    noteBlocked: false,
  };

  const alive = () => state.running;

  function status(message) {
    state.lastStatus = message;
    hud.setStatus(message);
  }

  // --- Поиск следующей цели --------------------------------------------------

  function findNextTarget() {
    for (const button of dom.connectButtons()) {
      const card = dom.cardOf(button);
      if (!card) continue;

      const id = dom.profileUrl(card) || `${dom.personName(card)}|${dom.headline(card)}`;
      if (state.processed.has(id)) continue;

      state.seen += 1;
      const name = dom.personName(card);
      const verdict = dom.matchesFilters(card, state.settings);
      if (!verdict.ok) {
        state.processed.add(id);
        state.filtered += 1;
        hud.log(`${name} — пропуск (${verdict.reason})`, 'skip');
        continue;
      }
      return { card, button, id, name };
    }
    return null;
  }

  // После закрытия модалки LinkedIn перерисовывает карточку, и прежняя ссылка на
  // кнопку оказывается оторвана от документа — клик по ней уходит в пустоту.
  // Поэтому кнопку того же человека ищем заново, по идентификатору профиля.
  function relocateButton(target) {
    for (const button of dom.connectButtons()) {
      const card = dom.cardOf(button);
      if (!card) continue;
      const id = dom.profileUrl(card) || `${dom.personName(card)}|${dom.headline(card)}`;
      if (id === target.id) return { button, card };
    }
    return null;
  }

  async function tryLoadMore() {
    // Выдача догружается по скроллу; больше шести пустых попыток подряд — значит всё.
    if (state.scrollAttempts >= 6) return false;
    state.scrollAttempts += 1;

    const heightBefore = document.body.scrollHeight;
    window.scrollBy({ top: Math.round(window.innerHeight * 0.8), behavior: 'smooth' });
    status('Подгружаю результаты…');
    await sleep(1200);

    const grew = document.body.scrollHeight > heightBefore;
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 200;
    return grew || !atBottom;
  }

  const firstResultHref = () => document.querySelector('a[href*="/in/"]')?.href || '';

  async function goToNextPage() {
    // Пагинация подгружается только когда доскроллишь до низа выдачи.
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    await sleep(1500);

    let next = dom.nextPageButton();
    if (!next) {
      // Иногда низ страницы дорисовывается с задержкой — даём ему шанс.
      next = await dom.waitFor(dom.nextPageButton, 3000);
    }
    if (!next) {
      console.log('[Auto Connector] кнопка следующей страницы не найдена', {
        текущаяСтраница: dom.currentPageNumber(),
        подписи: [...document.querySelectorAll('button, a')]
          .filter((el) => dom.isVisible(el) && dom.text(el).length <= 20 && dom.text(el))
          .slice(-25)
          .map((el) => dom.text(el)),
      });
      return false;
    }

    const before = firstResultHref();
    const pageBefore = dom.currentPageNumber();

    await dom.humanClick(next);
    hud.log(`Страница ${pageBefore ? pageBefore + 1 : 'следующая'}`, 'ok');
    status('Гружу следующую страницу…');

    // Ждём смены выдачи: либо номер страницы, либо первый профиль в списке.
    const changed = await dom.waitFor(
      () =>
        (pageBefore && dom.currentPageNumber() > pageBefore) ||
        (firstResultHref() && firstResultHref() !== before),
      12000
    );
    if (!changed) {
      hud.log('Страница не сменилась', 'warn');
      return false;
    }

    window.scrollTo({ top: 0 });
    state.scrollAttempts = 0;
    // Ждём, пока карточки новой страницы реально появятся в DOM.
    await dom.waitFor(() => dom.connectButtons().length > 0, 8000);
    await sleep(randInt(1500, 3000));
    return true;
  }

  // --- Отправка приглашения --------------------------------------------------

  // Никаких сохранённых ссылок на модалку и её кнопки: Ember перерисовывает
  // содержимое, и удержанный узел оказывается оторван от документа — клик по
  // нему уходит в пустоту. Поэтому каждый раз ищем заново.
  async function closeModal() {
    const modal = dom.openModal();
    if (!modal) return true;

    // У реальной модалки крестик подписан «Пропустить», а не «Закрыть».
    const dismiss =
      modal.querySelector('[data-test-modal-close-btn], .artdeco-modal__dismiss') ||
      modal.querySelector('button[aria-label="Dismiss"], button[aria-label="Закрыть"]') ||
      dom.buttonIn(modal, RE.dismiss);

    if (dismiss) await dom.humanClick(dismiss);
    else {
      for (const target of [document.activeElement || document.body, modal, document]) {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })
        );
      }
    }
    return Boolean(await dom.waitFor(() => !dom.openModal(), 2500));
  }

  // Персонализированные приглашения у бесплатного аккаунта лимитированы. Когда
  // лимит выбран, LinkedIn либо не показывает «Персонализировать», либо не даёт
  // поле ввода. Один раз это распознаём — и до конца прогона больше не пытаемся:
  // иначе каждая карточка тратит впустую по четыре секунды.
  function blockNotes(reason) {
    if (state.noteBlocked) return;
    state.noteBlocked = true;
    hud.log(`Записки кончились (${reason}) — дальше без них`, 'warn');
  }

  // Путь с запиской: «Персонализировать» → текст в поле → «Отправить».
  // 'sent'  — приглашение ушло;
  // 'skip'  — записка недоступна, модалка не тронута, можно слать обычным путём;
  // 'reset' — «Персонализировать» уже нажали, модалка в режиме ввода, и кнопки
  //           «Отправить без заметки» в ней нет: нужен перезаход на карточку.
  async function sendWithNote(target) {
    const note = renderNote(state.settings.noteTemplate, {
      name: target.name,
      headline: dom.headline(target.card),
    });
    if (!note) return 'skip';

    const modal = dom.openModal();
    const personalize = modal && dom.buttonIn(modal, RE.personalize);
    if (!personalize) {
      blockNotes('кнопки «Персонализировать» нет');
      return 'skip';
    }

    await dom.humanClick(personalize);

    // Ждём развилку: либо появилось поле ввода, либо LinkedIn подсунул
    // Premium-заглушку про исчерпанные бесплатные записки.
    const outcome = await dom.waitFor(() => {
      const live = dom.openModal();
      if (live && RE.noteLimit.test(dom.text(live))) return { limit: true };
      const found = dom.noteField(live || document);
      return found ? { field: found } : null;
    }, 5000);

    if (outcome?.limit) {
      blockNotes('LinkedIn предлагает Premium');
      return 'reset';
    }

    const field = outcome?.field;
    if (!field) {
      blockNotes('поле ввода не появилось');
      return 'reset';
    }

    if (!dom.setFieldValue(field, note)) {
      blockNotes('текст не записывается в поле');
      return 'reset';
    }

    // Пауза как после набора текста: сразу после вставки жать «Отправить» странно.
    await sleep(randInt(700, 1800));

    const live = dom.openModal();
    const send = live && dom.buttonIn(live, RE.send);
    if (!send) {
      // Кнопка отправки заблокирована — например, записка не принята.
      blockNotes('кнопка отправки недоступна');
      return 'reset';
    }

    await dom.humanClick(send);
    if (!(await dom.waitFor(() => !dom.openModal(), 3500))) return 'reset';

    hud.log(`Записка: «${note.slice(0, 40)}${note.length > 40 ? '…' : ''}»`);
    return 'sent';
  }

  async function invite(target) {
    const { card } = target;
    // Не const: при повторном заходе кнопку приходится искать заново.
    let { button } = target;

    // Зависшая от прошлой попытки модалка перехватывает клики: без этой уборки
    // все последующие приглашения молча падали бы одно за другим.
    if (dom.openModal()) await closeModal();

    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(randInt(400, 1100));
    if (!alive()) return 'aborted';

    await dom.humanClick(button);

    const modal = await dom.waitFor(dom.openModal, 4000);
    if (!modal) {
      // Часть приглашений уходит без диалога — проверяем, сменилась ли кнопка на Pending.
      await sleep(900);
      const stillConnect = button.isConnected && RE.connect.test(dom.text(button));
      if (stillConnect) {
        // Модалка на экране есть, а в DOM её не видно — значит, лежит в теневом
        // дереве или в iframe. Дамп говорит, где именно.
        console.log('[Auto Connector] модалка не найдена', dom.whereIs(RE.sendWithoutNote));
      }
      return stillConnect ? 'failed' : 'sent';
    }

    const modalText = dom.text(modal);
    if (RE.inviteLimit.test(modalText)) {
      await closeModal();
      return 'blocked';
    }
    if (RE.emailRequired.test(modalText) || modal.querySelector('input[type="email"]')) {
      await closeModal();
      return 'email';
    }

    await sleep(randInt(500, 1400));

    // Режим с запиской. Если она недоступна — уходим на обычный путь ниже.
    if (state.settings.noteMode === 'note' && !state.noteBlocked) {
      const result = await sendWithNote(target);

      if (result === 'sent') {
        await sleep(500);
        const promo = dom.openModal();
        if (promo) {
          const blocked = RE.inviteLimit.test(dom.text(promo));
          await closeModal();
          if (blocked) return 'blocked';
        }
        return 'sent';
      }

      if (result === 'reset') {
        // В окне записки (или в Premium-заглушке) кнопки «Отправить без заметки»
        // нет. Закрываем и заходим на того же человека заново — без перезагрузки
        // страницы: после неё LinkedIn какое-то время отбивает первый запрос.
        await closeModal();
        await sleep(randInt(600, 1400));
        if (!alive()) return 'aborted';

        const again = relocateButton(target);
        if (!again) return 'retry';

        button = again.button;
        hud.log(`${target.name} — повтор без записки`, 'skip');
        await dom.humanClick(button);
        if (!(await dom.waitFor(dom.openModal, 4000))) return 'retry';
        await sleep(randInt(400, 900));
      }
    }

    // Три попытки разными способами: мышь может не дойти, если модалка ещё
    // доигрывает анимацию, а Enter вообще не зависит от координат и оверлеев.
    // Модалку и кнопку перезапрашиваем каждый раз — Ember их перерисовывает.
    let closed = false;
    let clicked = false;
    let lastButton = null;

    for (let attempt = 0; attempt < 3 && !closed; attempt += 1) {
      const live = dom.openModal();
      if (!live) {
        closed = true;
        break;
      }

      const btn = dom.buttonIn(live, RE.sendWithoutNote) || dom.buttonIn(live, RE.send);
      if (!btn) {
        console.log('[Auto Connector] в модалке нет кнопки отправки', {
          классы: live.className,
          текст: dom.text(live).slice(0, 200),
          кнопки: [...live.querySelectorAll('button')].map((b) => dom.label(b).slice(0, 60)),
        });
        break;
      }

      lastButton = btn;
      clicked = true;
      if (attempt === 2) dom.keyActivate(btn);
      else await dom.humanClick(btn);
      closed = Boolean(await dom.waitFor(() => !dom.openModal(), 3000));
    }

    // Модалка могла остаться открытой, а приглашение — уйти. Спрашиваем не её,
    // а саму карточку: кнопка «Установить контакт» после отправки сменится.
    if (!closed) {
      const buttonGone = !button.isConnected || !RE.connect.test(dom.label(button));
      console.log('[Auto Connector] приглашение не подтвердилось', {
        кликБыл: clicked,
        кнопка: lastButton ? dom.label(lastButton).slice(0, 80) : null,
        кнопкаВДокументе: lastButton ? lastButton.isConnected : null,
        карточкаОбновилась: buttonGone,
      });
      await closeModal();
      return buttonGone ? 'sent' : 'failed';
    }

    await sleep(500);

    // После отправки LinkedIn любит показать промо-модалку — её просто закрываем,
    // но если это предупреждение о лимите, останавливаемся.
    const afterModal = dom.openModal();
    if (afterModal) {
      const blocked = RE.inviteLimit.test(dom.text(afterModal));
      await closeModal();
      if (blocked) return 'blocked';
    }
    return 'sent';
  }

  // --- Паузы -----------------------------------------------------------------

  async function waitWithCountdown(ms, label) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!alive()) return false;
      const left = Math.ceil((until - Date.now()) / 1000);
      status(`${label} ${left} с`);
      await interruptibleSleep(1000, alive);
    }
    return alive();
  }

  // --- Цикл ------------------------------------------------------------------

  async function loop() {
    while (alive()) {
      if (!contextAlive()) return selfDestruct();

      const stats = await loadStats();
      hud.setStats(stats, state.settings);

      if (stats.daySent >= state.settings.dailyLimit) return finish('Дневной лимит выбран', 'warn');
      if (stats.weekSent >= state.settings.weeklyLimit) return finish('Недельный лимит выбран', 'warn');

      const target = findNextTarget();
      if (!target) {
        if (await tryLoadMore()) continue;
        if (state.settings.autoNextPage && (await goToNextPage())) continue;
        // Причин «целей нет» несколько, и путать их нельзя: одна означает
        // сломанный детект, остальные — штатный конец работы.
        if (state.seen === 0) {
          const left = dom.connectButtons().length;
          if (left > 0) return finish(`Все ${left} карточек уже обработаны в этой сессии`, 'skip');
          if (state.sent > 0) return finish('Свободных карточек не осталось', 'skip');
          console.log('[Auto Connector] диагностика страницы', dom.debugScan());
          return finish('Кнопок «Установить контакт» не видно — смотри диагностику в консоли (F12)', 'warn', 'error');
        }

        const { includeKeywords } = state.settings;
        if (state.filtered === state.seen && includeKeywords.length) {
          return finish(
            `Ни одна из ${state.seen} карточек не совпала с «${includeKeywords.join(', ')}» — ослабь фильтр`,
            'warn'
          );
        }
        return finish(
          `Готово: отправлено ${state.sent}, отфильтровано ${state.filtered} из ${state.seen}`,
          'skip'
        );
      }

      state.processed.add(target.id);
      state.scrollAttempts = 0;
      status(`Приглашаю: ${target.name}`);

      const result = await invite(target);
      if (!alive()) return;

      if (result === 'blocked') {
        await markBlocked();
        return finish('LinkedIn показал лимит приглашений — остановился', 'warn', 'error');
      }
      if (result === 'retry') {
        // Человек, на котором кончились записки, не должен потеряться: снимаем
        // отметку «обработан», чтобы следующий проход взял его обычным путём —
        // режим записок к этому моменту уже выключен.
        if (!state.retried.has(target.id)) {
          state.retried.add(target.id);
          state.processed.delete(target.id);
          hud.log(`${target.name} — вернусь к нему следующим проходом`, 'skip');
        } else {
          hud.log(`${target.name} — не удалось отправить`, 'warn');
        }
      } else if (result === 'email') {
        hud.log(`${target.name} — нужен email, пропуск`, 'skip');
      } else if (result === 'failed') {
        hud.log(`${target.name} — не удалось отправить`, 'warn');
      } else if (result === 'sent') {
        const next = await bumpSent();
        hud.setStats(next, state.settings);
        hud.log(`${target.name} — приглашение отправлено`, 'ok');
        state.sinceLongPause += 1;
        state.sent += 1;

        if (next.daySent >= state.settings.dailyLimit) return finish('Дневной лимит выбран', 'warn');
        if (next.weekSent >= state.settings.weeklyLimit) return finish('Недельный лимит выбран', 'warn');
      }

      if (state.sinceLongPause >= state.settings.longPauseEvery) {
        state.sinceLongPause = 0;
        hud.log('Длинный перерыв', 'skip');
        if (!(await waitWithCountdown(state.settings.longPauseSec * 1000, 'Перерыв,'))) return;
      } else {
        const pause = randInt(state.settings.delayMinSec, state.settings.delayMaxSec) * 1000;
        if (!(await waitWithCountdown(pause, 'Пауза,'))) return;
      }
    }
  }

  function finish(message, logKind = '', panelState = 'idle') {
    state.running = false;
    hud.setState(panelState);
    status(message);
    hud.log(message, logKind);
  }

  // --- Управление ------------------------------------------------------------

  async function start() {
    if (state.running) return;
    if (!dom.isPeopleSearchPage()) {
      hud.log('Работает только на странице поиска людей', 'warn');
      return;
    }

    state.settings = await loadSettings();
    state.sinceLongPause = 0;
    state.scrollAttempts = 0;
    state.seen = 0;
    state.filtered = 0;
    state.sent = 0;
    // Новый прогон — новая попытка: месяц мог смениться, лимит записок обновиться.
    state.noteBlocked = false;
    // Новый прогон смотрит выдачу заново: уже приглашённые отсеются сами —
    // их кнопка сменилась на «На рассмотрении».
    state.processed.clear();
    state.retried.clear();
    state.running = true;

    hud.setState('running');
    hud.log('Старт', 'ok');

    // Сразу показываем, что расширение видит на странице и с какими фильтрами идёт —
    // иначе «ничего не произошло» невозможно отличить от «всё отфильтровано».
    const scan = dom.debugScan();
    console.log('[Auto Connector] диагностика страницы', scan);
    hud.log(`Кнопок «Установить контакт»: ${scan.кнопокConnect}`, scan.кнопокConnect ? 'ok' : 'warn');
    const { includeKeywords, excludeKeywords } = state.settings;
    hud.log(includeKeywords.length ? `Ключевые: ${includeKeywords.join(', ')}` : 'Ключевые: любые');
    if (excludeKeywords.length) hud.log(`Стоп-слова: ${excludeKeywords.join(', ')}`);

    status('Ищу карточки…');

    try {
      await loop();
    } catch (err) {
      console.error('[Auto Connector]', err);
      finish(`Ошибка: ${err.message}`, 'warn', 'error');
    }
  }

  function stop(reason = 'Остановлено вручную') {
    if (!state.running) return;
    state.running = false;
    hud.setState('idle');
    status(reason);
    hud.log(reason, 'skip');
  }

  // --- Подключение к странице ------------------------------------------------

  async function mountForPage() {
    if (!dom.isPeopleSearchPage()) {
      stop('Ушли со страницы поиска');
      hud.unmount();
      return;
    }
    hud.mount({ onStart: start, onStop: () => stop() });
    hud.setState(state.running ? 'running' : 'idle');
    hud.setStatus(state.lastStatus);
    const [settings, stats] = await Promise.all([loadSettings(), loadStats()]);
    hud.setStats(stats, settings);

    // Попап перекинул нас сюда и попросил сразу начать. Ждём, пока выдача
    // отрисуется: сразу после навигации карточек в DOM ещё нет.
    if (!state.running && (await takePendingStart())) {
      hud.log('Автозапуск после перехода', 'ok');
      status('Жду загрузки выдачи…');
      await dom.waitFor(() => dom.connectButtons().length > 0, 15000);
      await sleep(randInt(800, 2000));
      start();
    }
  }

  // После обновления распакованного расширения старая копия скрипта остаётся жить
  // на уже открытой вкладке с мёртвым контекстом: любой вызов chrome.* оттуда
  // уходит в chrome-extension://invalid/ и засыпает консоль ошибками. Проверяем и
  // самоуничтожаемся.
  const contextAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  function selfDestruct() {
    clearInterval(urlWatcher);
    state.running = false;
    hud.unmount();
  }

  // LinkedIn — SPA: смену адреса ловим опросом, это надёжнее патчинга history.
  let lastHref = location.href;
  const urlWatcher = setInterval(() => {
    if (!contextAlive()) return selfDestruct();
    if (location.href === lastHref) return;
    lastHref = location.href;
    state.processed.clear();
    mountForPage();
  }, 1000);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'LAC_START') {
      start();
      sendResponse({ ok: true });
    } else if (msg?.type === 'LAC_STOP') {
      stop();
      sendResponse({ ok: true });
    } else if (msg?.type === 'LAC_STATE') {
      sendResponse({
        ok: true,
        running: state.running,
        onSearchPage: dom.isPeopleSearchPage(),
        status: state.lastStatus,
      });
    }
    return true;
  });

  mountForPage();
})();
