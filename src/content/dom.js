// Весь хрупкий код завязки на вёрстку LinkedIn собран здесь.
// Если расширение вдруг перестало находить кнопки — чинить нужно этот файл,
// остальная логика от разметки не зависит.

(() => {
  const { sleep } = self.LAC;

  // LinkedIn отдаёт интерфейс на языке аккаунта, поэтому везде ловим и en, и ru.
  // Проверки — по подстроке, а не по точному совпадению: внутри кнопки часто лежит
  // ещё и скрытый span с дублем подписи, из-за него innerText не равен ярлыку.
  const RE = {
    connect: /(установить контакт|подключиться|связаться|пригласить|\bconnect\b)/i,
    // Кнопки соседних действий, которые тоже живут в карточке.
    // Без \b вокруг кириллицы: в JS \b работает только по ASCII-словам.
    notConnect: /(сообщени|подписа|отписа|отправлено|ожидан|рассмотрени|\bmessage\b|\bfollow\b|\bpending\b|\bmore\b)/i,
    // Подпись гуляет между сборками: «без заметки», «без записки», «без сообщения».
    // Поэтому ловим по «без <чего-то>», а не по полной фразе.
    sendWithoutNote: /(без заметки|без записки|без сообщения|without a note|without note)/i,
    personalize: /(персонализировать|добавить заметку|add a note|personalize)/i,
    // Premium-заглушка вместо поля записки: «У вас закончились бесплатные
    // персонализированные сообщения». Формулировка «Персонализируйте своё
    // приглашение» из обычной модалки под этот шаблон не попадает.
    noteLimit:
      /(персонализированн[а-яё]*\s+(приглашен|сообщен)|personalized\s+(invitation|message)s?\s+(are|have|ran)|out of personalized)/i,
    send: /^(send|send now|отправить|отправить сейчас|готово|done)$/i,
    dismiss: /^(cancel|dismiss|отмена|закрыть|назад|пропустить)$/i,
    // «Далее ›», «Next», «Следующая страница» — с любым хвостом-шевроном.
    nextPage: /^(далее|дальше|next|следующая(\s+страница)?|next\s+page)\s*[›»>→\s]*$/i,
    // Модалка «вы исчерпали лимит приглашений» — сигнал немедленно остановиться.
    inviteLimit:
      /(weekly invitation limit|invitation limit|достигли.*лимит|лимит приглашений|too many invitations)/i,
    // Модалка «укажите email, чтобы пригласить» — такой контакт просто пропускаем.
    emailRequired: /(enter .*email|email address to connect|укажите.*(email|адрес электронной))/i,
    pending: /^(pending|ожидание|ожидает|запрос отправлен)$/i,
  };

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // textContent, а не innerText: innerText форсирует пересчёт лейаута на каждом
  // обращении, а мы читаем текст у сотен элементов — страница уходила в занос.
  const text = (el) => norm(el?.textContent);

  // Там, где важна построчная структура (запасной разбор должности), нужен innerText.
  const rawText = (el) => String(el?.innerText ?? el?.textContent ?? '');

  // Подпись кнопки = видимый текст + aria-label. LinkedIn кладёт человекочитаемое
  // название то туда, то сюда, поэтому смотрим сразу в оба места.
  const label = (el) => norm(`${text(el)} ${el?.getAttribute?.('aria-label') || ''}`);

  // Проверка «элемент вообще отрисован», а не «виден в окне». Важно: у LinkedIn
  // списки результатов помечены content-visibility, и у карточек за пределами
  // экрана лейаут пропущен — getBoundingClientRect честно возвращает 0×0, из-за
  // чего прежняя проверка выбрасывала почти всю выдачу.
  const isVisible = (el) => {
    if (!el) return false;
    if (typeof el.checkVisibility === 'function') return el.checkVisibility();
    const rect = el.getBoundingClientRect();
    return (rect.width > 0 && rect.height > 0) || el.offsetParent !== null;
  };

  // --- Поиск сквозь теневые деревья ------------------------------------------

  // querySelectorAll не заглядывает внутрь shadow-root, а LinkedIn часть
  // интерфейса рендерит именно там. Обход дорогой (перебор всех узлов), поэтому
  // вызывается только когда обычный поиск ничего не дал.
  function deepQueryAll(selector, root = document, depth = 0) {
    const found = [...root.querySelectorAll(selector)];
    if (depth > 6) return found;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...deepQueryAll(selector, el.shadowRoot, depth + 1));
    }
    return found;
  }

  // Диагностика: где именно лежит искомое, если в обычном дереве его нет.
  function whereIs(pattern) {
    const match = (el) => pattern.test(label(el));
    const light = [...document.querySelectorAll('button, [role="button"]')].filter(match);

    const hosts = [];
    const shadow = [];
    const walk = (root, depth) => {
      if (depth > 6) return;
      for (const el of root.querySelectorAll('*')) {
        if (!el.shadowRoot) continue;
        hosts.push(el.tagName.toLowerCase());
        shadow.push(...[...el.shadowRoot.querySelectorAll('button, [role="button"]')].filter(match));
        walk(el.shadowRoot, depth + 1);
      }
    };
    walk(document, 0);

    return {
      вОбычномДереве: light.length,
      вShadowDOM: shadow.length,
      хостыShadow: [...new Set(hosts)].slice(0, 10),
      iframes: [...document.querySelectorAll('iframe')].map((f) => f.src || f.name || '(без src)').slice(0, 10),
      диалогов: document.querySelectorAll('[role="dialog"]').length,
      artdecoМодалок: document.querySelectorAll('.artdeco-modal').length,
    };
  }

  // --- Карточки выдачи -------------------------------------------------------

  // Дешёвая проверка «похоже на кнопку приглашения» — без обращения к лейауту.
  const looksLikeConnect = (el) => RE.connect.test(label(el)) && !RE.notConnect.test(text(el));

  // Идём от кнопки к карточке. Никаких фиксированных селекторов контейнера: они
  // у LinkedIn живут пару месяцев. Поднимаемся вверх, пока в предке не появится
  // вторая кнопка приглашения — значит, мы вышли на уровень всего списка, и надо
  // вернуться на шаг назад. Карточка — последний предок со ссылкой на профиль.
  function cardOf(button) {
    let card = null;
    let el = button.parentElement;

    for (let depth = 0; el && depth < 15 && el !== document.body; depth += 1, el = el.parentElement) {
      const connectish = [...el.querySelectorAll('button, [role="button"], a')].filter(looksLikeConnect);
      if (connectish.length > 1) break;
      if (el.querySelector('a[href*="/in/"]')) card = el;
    }

    return card || button.parentElement;
  }

  // Порядок проверок важен: сперва дешёвые текстовые, и только у кандидатов —
  // isVisible, который дёргает лейаут.
  function isConnectButton(el) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (!RE.connect.test(label(el))) return false;
    // «Отправить сообщение», «Подписаться», уже отправленные «В ожидании» — мимо.
    if (RE.notConnect.test(text(el))) return false;
    return isVisible(el);
  }

  function connectButtons(root = document) {
    let matched = [...root.querySelectorAll('button')].filter(isConnectButton);
    if (!matched.length) {
      // Запасной путь на случай, если LinkedIn уйдёт с <button> на div'ы с role.
      matched = [...root.querySelectorAll('[role="button"], a')].filter(isConnectButton);
    }
    if (!matched.length) {
      matched = deepQueryAll('button, [role="button"]', root).filter(isConnectButton);
    }
    // Кнопка может быть вложена в другой role="button" — оставляем самый внутренний.
    return matched.filter((el) => !matched.some((other) => other !== el && el.contains(other)));
  }

  // Диагностика для консоли: что вообще есть на странице и почему не подошло.
  function debugScan() {
    const buttons = [...document.querySelectorAll('button')];
    const roleButtons = [...document.querySelectorAll('[role="button"], a[href*="/in/"]')];
    const sample = (nodes) =>
      nodes
        .map((el) => ({
          тег: el.tagName.toLowerCase(),
          текст: text(el).slice(0, 70),
          ariaLabel: norm(el.getAttribute('aria-label')).slice(0, 70),
          виден: isVisible(el),
          подходит: isConnectButton(el),
        }))
        .filter((r) => r.текст || r.ariaLabel)
        .slice(0, 40);

    return {
      кнопокConnect: connectButtons().length,
      всегоButton: buttons.length,
      всегоRoleButton: roleButtons.length,
      образцыButton: sample(buttons),
      образцыRoleButton: buttons.length ? [] : sample(roleButtons),
    };
  }

  function profileUrl(card) {
    const link = card?.querySelector('a[href*="/in/"]');
    if (!link) return null;
    return link.href.split('?')[0];
  }

  function personName(card) {
    // У имени в выдаче стабильно есть span[aria-hidden] внутри ссылки на профиль.
    const link = card?.querySelector('a[href*="/in/"]');
    const span = link?.querySelector('span[aria-hidden="true"]');
    const raw = text(span) || text(link);
    return raw.split('\n')[0].trim() || 'без имени';
  }

  function headline(card) {
    const selectors = [
      '.entity-result__primary-subtitle',
      '.entity-result__summary',
      '.t-14.t-black.t-normal',
      '[data-view-name*="subtitle"]',
    ];
    for (const sel of selectors) {
      const el = card?.querySelector(sel);
      if (el && text(el)) return text(el);
    }
    // Фолбэк: вторая непустая строка карточки — почти всегда должность.
    const lines = rawText(card).split('\n').map((l) => l.trim()).filter(Boolean);
    return lines[1] || '';
  }

  // Текст, по которому работают фильтры: должность, компания, локация — но не имя,
  // чтобы «Мария Связева» случайно не совпала с ключевым словом.
  // Имя вырезаем подстрокой, а не построчно: innerText не всегда даёт переносы там,
  // где их ждёшь, и карточка целиком схлопывалась бы в одну «строку с именем».
  function filterText(card) {
    // Здесь innerText оправдан: вызывается на десятке карточек, зато не склеивает
    // соседние блоки в «Product ManagerКыргызстан», как это делает textContent.
    const haystack = norm(rawText(card)).toLowerCase();
    const name = personName(card).toLowerCase();
    return name ? haystack.split(name).join(' ') : haystack;
  }

  function matchesFilters(card, settings) {
    const haystack = filterText(card);
    const { includeKeywords = [], excludeKeywords = [] } = settings;
    if (excludeKeywords.some((k) => haystack.includes(k))) return { ok: false, reason: 'стоп-слово' };
    if (includeKeywords.length && !includeKeywords.some((k) => haystack.includes(k))) {
      return { ok: false, reason: 'нет ключевых слов' };
    }
    return { ok: true };
  }

  // --- Модалки ---------------------------------------------------------------

  // На странице одновременно живёт несколько role="dialog" — оверлей «Сообщения»,
  // всплывашки, промо. Брать первый попавшийся нельзя: расширение искало кнопку
  // отправки в окне мессенджера. Поэтому считаем «похожесть на модалку
  // приглашения» и возвращаем только уверенное совпадение.
  function modalScore(el) {
    let score = 0;
    if (el.classList.contains('artdeco-modal')) score += 3;
    if (el.getAttribute('aria-modal') === 'true') score += 3;
    if (buttonIn(el, RE.sendWithoutNote)) score += 6;
    else if (buttonIn(el, RE.send)) score += 1; // у мессенджера тоже есть «Отправить»
    if (RE.inviteLimit.test(text(el)) || RE.emailRequired.test(text(el))) score += 4;
    return score;
  }

  const MODAL_SELECTOR = '.artdeco-modal, [role="dialog"], [role="alertdialog"]';

  function pickModal(dialogs) {
    const visible = dialogs.filter(isVisible);
    if (!visible.length) return null;
    // При равном счёте берём последний в DOM: свежий оверлей лежит поверх остальных.
    const best = visible.reduce((a, b) => (modalScore(b) >= modalScore(a) ? b : a), visible[0]);
    return modalScore(best) >= 3 ? best : null;
  }

  function openModal() {
    const found = pickModal([...document.querySelectorAll(MODAL_SELECTOR)]);
    if (found) return found;
    // В обычном дереве модалки нет — значит, она может жить в shadow-root.
    return pickModal(deepQueryAll(MODAL_SELECTOR));
  }

  function buttonIn(modal, re) {
    const usable = (b) => isVisible(b) && !b.disabled && (re.test(text(b)) || re.test(b.getAttribute('aria-label') || ''));
    return (
      [...modal.querySelectorAll('button')].find(usable) ||
      deepQueryAll('button, [role="button"]', modal).find(usable)
    );
  }

  // Голого el.click() Ember-компонентам LinkedIn мало: многие кнопки реагируют на
  // pointerdown/mousedown, а не на итоговый click. Воспроизводим полную
  // последовательность событий, как у настоящего курсора.
  const nextFrame = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  async function humanClick(el) {
    let rect = el.getBoundingClientRect();

    // Вне окна elementFromPoint бесполезен, да и настоящий курсор туда не дотянется.
    const outside =
      rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
    if (outside) {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      // Геометрия после программной прокрутки обновляется сразу, а дерево
      // хит-теста — с задержкой в неизвестное число кадров. Поэтому ждём не
      // «сколько-нибудь кадров», а факта: пока elementFromPoint не начнёт
      // попадать внутрь элемента. Иначе клик уходит мимо внутреннего span.
      for (let frame = 0; frame < 12; frame += 1) {
        await nextFrame();
        rect = el.getBoundingClientRect();
        const probe = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        );
        if (probe && el.contains(probe)) break;
      }
    }

    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // Настоящий курсор попадает в самый глубокий элемент под точкой — у artdeco
    // это <span class="artdeco-button__text">, а не сама кнопка. Обработчики,
    // которые смотрят на event.target, к этому чувствительны.
    const under = document.elementFromPoint(x, y);
    const hit = under && el.contains(under) ? under : el;
    if (under && !el.contains(under) && !under.contains(el)) {
      console.log('[Auto Connector] клик перехватывает другой элемент', {
        цель: label(el).slice(0, 60),
        перехватчик: under.tagName.toLowerCase() + '.' + String(under.className).slice(0, 60),
      });
    }

    // detail: 1 — критично. У синтетического MouseEvent это поле по умолчанию 0,
    // и ровно так выглядит программный клик; проверка «detail === 0 → игнорируем»
    // стоит во множестве UI-библиотек. Настоящий клик мышью всегда несёт detail: 1,
    // поэтому и el.click() (у него тоже 0) кнопку не будил.
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      detail: 1,
    };
    const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 };
    // Наведение курсора кликом не считается: там detail 0 и кнопка не нажата.
    const hover = { ...base, detail: 0, buttons: 0 };

    hit.dispatchEvent(new PointerEvent('pointerover', { ...pointer, ...hover, pressure: 0 }));
    hit.dispatchEvent(new MouseEvent('mouseover', hover));
    hit.dispatchEvent(new PointerEvent('pointermove', { ...pointer, ...hover, pressure: 0 }));
    hit.dispatchEvent(new MouseEvent('mousemove', hover));
    hit.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1, pressure: 0.5 }));
    hit.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.focus?.();
    hit.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0, pressure: 0 }));
    hit.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    hit.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
  }

  // Запасной способ нажать: доступная кнопка обязана реагировать на Enter, а этот
  // путь вообще не зависит от координат, оверлеев и обработчиков мыши.
  function keyActivate(el) {
    el.focus?.();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // Поле записки. Сначала известные идентификаторы LinkedIn, потом любая textarea.
  function noteField(root = document) {
    const selector = '#custom-message, textarea[name="message"], textarea';
    const usable = (el) => isVisible(el) && !el.disabled && !el.readOnly;
    return [...root.querySelectorAll(selector)].find(usable) || deepQueryAll(selector, root).find(usable);
  }

  // Присвоение через нативный сеттер: Ember и React держат собственное состояние
  // и на простое el.value = '...' не реагируют — текст пропадёт при отправке.
  function setFieldValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    el.focus?.();
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === value;
  }

  async function waitFor(predicate, timeoutMs = 5000, stepMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await sleep(stepMs);
    }
    return null;
  }

  // --- Пагинация -------------------------------------------------------------

  // Пагинация. Классы у LinkedIn меняются, подпись — нет: «Далее ›» / «Next».
  // Если и подпись не нашлась, идём от номеров страниц: ищем кнопку с числом на
  // единицу больше текущего. Это переживает и смену языка, и смену вёрстки.
  function nextPageButton() {
    const clickable = [...document.querySelectorAll('button, a[role="button"], a')].filter(
      (el) => isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
    );

    const byLabel = clickable.filter(
      (el) => RE.nextPage.test(text(el)) || RE.nextPage.test(norm(el.getAttribute('aria-label')))
    );
    if (byLabel.length) {
      // Блок пагинации внизу страницы; «Next» из каруселей и промо игнорируем.
      const inPagination = byLabel.filter((el) => el.closest('[class*="pagination"], [class*="Pagination"]'));
      const pool = inPagination.length ? inPagination : byLabel;
      return pool[pool.length - 1];
    }

    const numbered = clickable.filter((el) => /^\d{1,3}$/.test(text(el)));
    if (!numbered.length) return null;

    const current = numbered.find((el) => {
      const mark = el.getAttribute('aria-current');
      return mark === 'true' || mark === 'page' || /selected|active|current/i.test(String(el.className));
    });
    const currentNumber = current ? Number(text(current)) : null;
    if (!currentNumber) return null;

    return numbered.find((el) => Number(text(el)) === currentNumber + 1) || null;
  }

  // Номер открытой страницы выдачи — только для лога.
  function currentPageNumber() {
    const marked = [...document.querySelectorAll('button, a')].find(
      (el) =>
        /^\d{1,3}$/.test(text(el)) &&
        (['true', 'page'].includes(el.getAttribute('aria-current')) ||
          /selected|active|current/i.test(String(el.className)))
    );
    return marked ? Number(text(marked)) : null;
  }

  function isPeopleSearchPage() {
    return location.pathname.startsWith('/search/results/people');
  }

  self.LAC.dom = {
    RE,
    norm,
    text,
    rawText,
    label,
    debugScan,
    deepQueryAll,
    whereIs,
    isVisible,
    cardOf,
    connectButtons,
    profileUrl,
    personName,
    headline,
    filterText,
    matchesFilters,
    openModal,
    modalScore,
    buttonIn,
    noteField,
    setFieldValue,
    humanClick,
    keyActivate,
    waitFor,
    nextPageButton,
    currentPageNumber,
    isPeopleSearchPage,
  };
})();
