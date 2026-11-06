/**
 * profile.js — экран «Профиль» (вкладка 5).
 *
 * Этап 5:
 *  - параметры тела: вес, рост, возраст, пол;
 *  - уровень активности и цель (данные из targets.js);
 *  - MET силовой тренировки и расход калорий за час;
 *  - норма калорий и БЖУ — те же числа показывает дневник питания;
 *  - экспорт и импорт всех данных в JSON: перенос на другое устройство
 *    или на новый адрес (локальный сервер -> GitHub Pages).
 *
 * Контракт с app.js: export async function render(root, ctx).
 */
import { db, STORES, PROFILE_ID, DB_VERSION, defaultProfile } from './db.js';
import { ACTIVITY_LEVELS, GOALS, calcTargets, calcWorkoutKcal } from './targets.js';
import { APP_VERSION } from './version.js';
import {
  el,
  escapeHtml,
  fmtNum,
  macroGridHtml,
  openModal,
  parseNum,
  confirmDialog,
  showToast,
  todayISO,
} from './ui.js';

/** Допустимые диапазоны: защищают норму от опечаток (например, вес 700 кг). */
const LIMITS = {
  weight: { min: 30, max: 300, label: 'Вес', unit: 'кг' },
  height: { min: 100, max: 250, label: 'Рост', unit: 'см' },
  age: { min: 10, max: 100, label: 'Возраст', unit: 'лет' },
  metStrength: { min: 1, max: 15, label: 'MET', unit: 'MET' },
};

const SEX_OPTIONS = [
  { id: 'male', name: 'Мужской' },
  { id: 'female', name: 'Женский' },
];

/** Текущий профиль и таймер автосохранения. */
const state = { profile: null, saveTimer: null };

/**
 * Обработчики навешиваются один раз на <section>, а app.js только меняет
 * её содержимое, поэтому без флага они бы дублировались.
 */
const currentHandlers = { click: null, input: null, change: null };

function wire(root) {
  if (root.dataset.wired === '1') return;
  root.dataset.wired = '1';
  root.addEventListener('click', (event) => {
    if (typeof currentHandlers.click === 'function') currentHandlers.click(event);
  });
  root.addEventListener('input', (event) => {
    if (typeof currentHandlers.input === 'function') currentHandlers.input(event);
  });
  root.addEventListener('change', (event) => {
    if (typeof currentHandlers.change === 'function') currentHandlers.change(event);
  });
}

/* ------------------------------------------------------------------ */
/* Точка входа экрана                                                  */
/* ------------------------------------------------------------------ */

export async function render(root, ctx) {
  const stored = (await db.get(STORES.profile, PROFILE_ID)) || defaultProfile();
  state.profile = { ...defaultProfile(), ...stored };

  // Сколько данных лежит в базе — показываем в карточке «Данные»
  const counterStores = [STORES.exercises, STORES.workouts, STORES.products, STORES.dishes, STORES.meals];
  const counts = await Promise.all(counterStores.map((name) => db.count(name)));
  const stats = {};
  counterStores.forEach((name, index) => {
    stats[name] = counts[index];
  });

  root.innerHTML = `
    ${bodyCardHtml(state.profile)}
    ${activityCardHtml(state.profile)}
    ${goalCardHtml(state.profile)}
    ${targetsCardHtml(state.profile)}
    ${dataCardHtml(stats)}
  `;

  wire(root);

  currentHandlers.click = (event) => onClick(event, root, ctx);
  currentHandlers.input = (event) => onInput(event, root, ctx);
  currentHandlers.change = async (event) => {
    // На iPhone «Готово» в числовой клавиатуре приходит как change — сохраняем сразу
    if (event.target.matches('[data-field]')) {
      await saveProfile(root, ctx);
      return;
    }
    if (event.target.id === 'profile-import') {
      const file = event.target.files && event.target.files[0];
      event.target.value = ''; // чтобы тот же файл можно было выбрать повторно
      if (file) await importFile(root, ctx, file);
    }
  };
}


/* ------------------------------------------------------------------ */
/* Разметка карточек                                                   */
/* ------------------------------------------------------------------ */

/** Число для поля ввода: без лишних нулей, с запятой как в русской раскладке. */
function numText(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return '';
  return number.toFixed(digits).replace(/\.0+$/, '').replace('.', ',');
}

/** Числовое поле «значение + единица измерения». */
function numberFieldHtml(profile, field, { digits = 1, hint = '' } = {}) {
  const limits = LIMITS[field];
  return `
    <label class="field" data-field-box="${field}">
      <span class="field-label">${limits.label}</span>
      <span class="field-suffix">
        <input type="text" inputmode="decimal" autocomplete="off" data-field="${field}"
               value="${escapeHtml(numText(profile[field], digits))}"
               aria-label="${limits.label} (${limits.unit})">
        <span>${limits.unit}</span>
      </span>
      <span class="field-hint" data-field-error="${field}" hidden></span>
      ${hint ? `<span class="small muted">${hint}</span>` : ''}
    </label>`;
}

function bodyCardHtml(profile) {
  const sexChips = SEX_OPTIONS.map(
    (option) => `
      <button class="chip${profile.sex === option.id ? ' is-active' : ''}" type="button"
              data-sex="${option.id}" aria-pressed="${profile.sex === option.id}">${option.name}</button>`
  ).join('');

  return `
    <div class="card">
      <div class="card-row">
        <h2 class="card-title">Параметры тела</h2>
        <span class="badge badge-muted">сохраняется само</span>
      </div>
      <div class="field-row">
        ${numberFieldHtml(profile, 'weight', { digits: 1 })}
        ${numberFieldHtml(profile, 'height', { digits: 0 })}
      </div>
      <div class="field-row">
        ${numberFieldHtml(profile, 'age', { digits: 0 })}
        ${numberFieldHtml(profile, 'metStrength', { digits: 1 })}
      </div>
      <p class="small muted">
        MET силовой тренировки: 3 — спокойный темп, 5 — обычный, 6 — тяжёлый.
      </p>
      <div class="field">
        <span class="field-label">Пол</span>
        <div class="chips">${sexChips}</div>
      </div>
    </div>`;
}

function activityCardHtml(profile) {
  const items = ACTIVITY_LEVELS.map((level) => {
    const isActive = profile.activity === level.id;
    return `
      <li>
        <button class="option-item${isActive ? ' is-active' : ''}" type="button"
                data-activity="${level.id}" aria-pressed="${isActive}">
          <span class="option-item-main">
            <span class="option-item-title">${level.name}</span>
            <span class="option-item-sub">${level.hint} · коэффициент ${fmtNum(level.factor, 3)}</span>
          </span>
          <span class="option-check" aria-hidden="true">✓</span>
        </button>
      </li>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-row">
        <h2 class="card-title">Активность</h2>
      </div>
      <ul class="option-list">${items}</ul>
    </div>`;
}

function goalCardHtml(profile) {
  const chips = GOALS.map(
    (goal) => `
      <button class="chip${profile.goal === goal.id ? ' is-active' : ''}" type="button"
              data-goal="${goal.id}" aria-pressed="${profile.goal === goal.id}">${goal.name}</button>`
  ).join('');

  return `
    <div class="card">
      <div class="card-row">
        <h2 class="card-title">Цель</h2>
      </div>
      <div class="chips">${chips}</div>
      <p class="small muted">
        Белок и жир считаются от веса тела, углеводы — остаток калорий.
      </p>
    </div>`;
}

/** Расход калорий за час силовой тренировки: MET × вес × 1,05 (формула в targets.js). */
function strengthKcalPerHour(profile) {
  return calcWorkoutKcal({
    met: profile.metStrength,
    weight: profile.weight,
    minutes: 60,
  });
}

/** Внутренности карточки нормы — пересчитываются после каждой правки. */
function targetsInnerHtml(profile) {
  const targets = calcTargets(profile);

  if (!targets.valid) {
    return `
      <div class="card-row">
        <h2 class="card-title">Норма на день</h2>
        <span class="badge badge-muted">нет данных</span>
      </div>
      <div class="empty">Укажите вес, рост и возраст — покажу норму калорий и БЖУ.</div>`;
  }

  const perHour = strengthKcalPerHour(profile);

  return `
    <div class="card-row">
      <h2 class="card-title">Норма на день</h2>
      <span class="badge">${escapeHtml(targets.goal.name)}</span>
    </div>
    <div class="day-kcal">
      <b>${fmtNum(targets.kcal)}</b>
      <span class="muted">ккал</span>
    </div>
    ${macroGridHtml(targets)}
    <ul class="list">
      <li class="list-item">
        <div class="list-item-main">
          <div class="list-item-title">Базовый обмен (BMR)</div>
          <div class="list-item-sub">в покое, без активности</div>
        </div>
        <div class="tabnum">${fmtNum(targets.bmr)} ккал</div>
      </li>
      <li class="list-item">
        <div class="list-item-main">
          <div class="list-item-title">С учётом активности (TDEE)</div>
          <div class="list-item-sub">${escapeHtml(targets.activity.name)} · ×${fmtNum(targets.activity.factor, 3)}</div>
        </div>
        <div class="tabnum">${fmtNum(targets.tdee)} ккал</div>
      </li>
      <li class="list-item">
        <div class="list-item-main">
          <div class="list-item-title">Силовая тренировка</div>
          <div class="list-item-sub">${fmtNum(profile.metStrength, 1)} MET · расход за час</div>
        </div>
        <div class="tabnum">${perHour ? `≈ ${fmtNum(perHour)} ккал` : '—'}</div>
      </li>
    </ul>
    <p class="small muted">
      Те же числа показывает дневник питания: прогресс за день считается от этой нормы.
    </p>`;
}

function targetsCardHtml(profile) {
  return `
    <div class="card" id="profile-targets">
      ${targetsInnerHtml(profile)}
    </div>`;
}

function dataCardHtml(stats) {
  return `
    <div class="card">
      <div class="card-row">
        <h2 class="card-title">Данные</h2>
        <span class="badge badge-muted">${escapeHtml(APP_VERSION)}</span>
      </div>
      <p class="small muted">
        Записи хранятся только в этом браузере. Чтобы перенести их на другое устройство
        или на новый адрес сайта, сохраните копию в файл и загрузите её там.
      </p>
      <div class="stack">
        <button class="btn btn-secondary btn-block" type="button" data-action="export-file">Сохранить копию в файл</button>
        <button class="btn btn-secondary btn-block" type="button" data-action="export-view">Показать JSON</button>
        <button class="btn btn-secondary btn-block" type="button" data-action="import">Загрузить из файла</button>
        <button class="btn btn-danger btn-block" type="button" data-action="wipe">Удалить все данные</button>
      </div>
      <input id="profile-import" class="sr-only" type="file" accept="application/json,.json"
             aria-label="Файл с данными приложения">
      <p class="small muted">
        Сейчас в базе: продуктов — ${fmtNum(stats.products)},
        упражнений — ${fmtNum(stats.exercises)},
        тренировок — ${fmtNum(stats.workouts)},
        блюд — ${fmtNum(stats.dishes)},
        записей дневника — ${fmtNum(stats.meals)}.
      </p>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Ввод и автосохранение                                               */
/* ------------------------------------------------------------------ */

/** Читает числовое поле: пустое -> 0 (норма не считается), вне диапазона -> ошибка. */
function readField(input) {
  const field = input.dataset.field;
  const limits = LIMITS[field];
  const box = input.closest('[data-field-box]');
  const errorEl = box ? box.querySelector(`[data-field-error="${field}"]`) : null;
  const raw = String(input.value || '').trim();

  const setError = (message) => {
    if (box) box.classList.toggle('is-invalid', Boolean(message));
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = !message;
    }
  };

  if (!raw) {
    setError('');
    return { value: 0, error: '' };
  }

  const value = parseNum(raw);
  if (!(value > 0)) {
    const message = `${limits.label}: введите число`;
    setError(message);
    return { value: 0, error: message };
  }
  if (value < limits.min || value > limits.max) {
    const message = `${limits.label}: от ${limits.min} до ${limits.max} ${limits.unit}`;
    setError(message);
    return { value, error: message };
  }

  setError('');
  return { value, error: '' };
}

/** Значения всех числовых полей экрана (без записи в базу). */
function readForm(root) {
  const values = {};
  let hasError = false;
  root.querySelectorAll('[data-field]').forEach((input) => {
    const result = readField(input);
    if (result.error) hasError = true;
    values[input.dataset.field] = result.value;
  });
  return { values, hasError };
}

/** Подсвечивает выбранный вариант в группе (пол / активность / цель). */
function markActive(root, selector, key, value) {
  root.querySelectorAll(selector).forEach((button) => {
    const isActive = button.dataset[key] === value;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}

/** Перерисовывает только карточку нормы — фокус в поле ввода не теряется. */
function refreshTargets(root) {
  const card = root.querySelector('#profile-targets');
  if (card) card.innerHTML = targetsInnerHtml(state.profile);
}

/** Сохраняет профиль в IndexedDB и пересчитывает норму. */
async function saveProfile(root, ctx, { quiet = true } = {}) {
  const { values, hasError } = readForm(root);
  if (hasError) return false;

  state.profile = { ...state.profile, ...values };
  await db.put(STORES.profile, state.profile);
  refreshTargets(root);
  if (!quiet) showToast('Профиль сохранён');
  return true;
}

function onInput(event, root, ctx) {
  if (!event.target.matches('[data-field]')) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveProfile(root, ctx), 400);
}

async function onClick(event, root, ctx) {
  const sexButton = event.target.closest('[data-sex]');
  if (sexButton) {
    state.profile.sex = sexButton.dataset.sex;
    markActive(root, '[data-sex]', 'sex', state.profile.sex);
    await saveProfile(root, ctx);
    return;
  }

  const activityButton = event.target.closest('[data-activity]');
  if (activityButton) {
    state.profile.activity = activityButton.dataset.activity;
    markActive(root, '[data-activity]', 'activity', state.profile.activity);
    await saveProfile(root, ctx);
    return;
  }

  const goalButton = event.target.closest('[data-goal]');
  if (goalButton) {
    state.profile.goal = goalButton.dataset.goal;
    markActive(root, '[data-goal]', 'goal', state.profile.goal);
    await saveProfile(root, ctx);
    return;
  }

  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;

  switch (actionButton.dataset.action) {
    case 'export-file':
      await exportToFile();
      break;
    case 'export-view':
      await showBackupJson();
      break;
    case 'import': {
      const input = root.querySelector('#profile-import');
      if (input) input.click();
      break;
    }
    case 'wipe':
      await wipeAll(ctx);
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Экспорт и импорт JSON                                               */
/* ------------------------------------------------------------------ */

/** Русское склонение: 1 тренировка, 2 тренировки, 5 тренировок. */
function plural(count, one, few, many) {
  const abs = Math.abs(Number(count) || 0);
  const tail = abs % 100;
  if (tail > 10 && tail < 20) return many;
  const last = tail % 10;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/**
 * Слепок всей базы для резервной копии.
 * Профиль кладём объектом (он один), остальные хранилища — массивами.
 */
async function buildBackup() {
  const stores = {};
  for (const name of Object.values(STORES)) {
    stores[name] = name === STORES.profile
      ? (await db.get(STORES.profile, PROFILE_ID)) || defaultProfile()
      : await db.getAll(name);
  }

  return {
    app: 'sila-kbzhu',
    format: DB_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    stores,
  };
}

function backupFileName() {
  return `sila-kbzhu-${todayISO()}.json`;
}

/** Отдаёт файл браузеру: на iPhone он уходит в «Файлы» или в просмотрщик. */
function downloadJson(text, filename) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Ссылку освобождаем не сразу: Safari может начать скачивание с задержкой
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportToFile() {
  const text = JSON.stringify(await buildBackup(), null, 2);
  downloadJson(text, backupFileName());
  showToast('Копия сохранена в файл');
}

/** Показывает JSON в шторке: удобно, если скачивание на iPhone недоступно. */
async function showBackupJson() {
  const text = JSON.stringify(await buildBackup(), null, 2);

  const content = el('div', 'stack');
  content.innerHTML = `
    <p class="small muted">
      Скопируйте текст и сохраните в заметки. Затем на другом устройстве откройте
      приложение → «Профиль» → «Загрузить из файла».
    </p>
    <textarea class="code-box" readonly aria-label="Данные приложения в JSON"></textarea>
    <div class="row">
      <button class="btn btn-secondary btn-block" type="button" data-copy>Копировать</button>
      <button class="btn btn-primary btn-block" type="button" data-download>Скачать</button>
    </div>`;

  const area = content.querySelector('textarea');
  area.value = text; // через value, а не innerHTML — данные могут содержать любые символы

  content.querySelector('[data-copy]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Скопировано');
    } catch (error) {
      area.focus();
      area.select();
      showToast('Выделите текст и скопируйте вручную');
    }
  });
  content.querySelector('[data-download]').addEventListener('click', () => {
    downloadJson(text, backupFileName());
    showToast('Копия сохранена в файл');
  });

  openModal({ title: 'Данные приложения', content });
}


/** Чтение файла: Blob.text() есть в iOS 14+, FileReader — запасной путь. */
function readFileAsText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл'));
    reader.readAsText(file);
  });
}

/* ------------------------------------------------------------------ */
/* Ограничения импорта: защита от «подсунутого» файла                  */
/* ------------------------------------------------------------------ */

/** Больше 20 МБ копия быть не может — такой файл не читаем (защита от зависания). */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** Потолок записей в одном хранилище: защита от бесконечного цикла импорта. */
const MAX_IMPORT_ROWS = 200000;

/** Потолок длины строковых полей: длинные «простыни» ломают вёрстку и память. */
const MAX_TEXT_LENGTH = 500;

/**
 * Обрезает строку до разумной длины. В HTML такие значения всё равно попадают
 * только через escapeHtml, но лишний мегабайт текста в названии не нужен.
 * @param {unknown} value
 * @param {number} [limit]
 */
function textOf(value, limit = MAX_TEXT_LENGTH) {
  if (value == null) return '';
  return String(value).slice(0, limit);
}

/**
 * Число с ограничением диапазона.
 * Не число или не положительное значение -> fallback (0 = «не указано»).
 */
function numberInRange(value, min, max, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Рекурсивно приводит запись из файла к безопасному виду:
 *  - строки обрезаются до MAX_TEXT_LENGTH;
 *  - массивы ограничиваются 1000 элементами, глубина — 5 уровнями;
 *  - поля __proto__/constructor/prototype отбрасываются (защита от подмены прототипа).
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function limitStrings(value, depth = 0) {
  if (typeof value === 'string') return textOf(value);
  if (depth >= 5) return null;

  if (Array.isArray(value)) {
    return value.slice(0, 1000).map((item) => limitStrings(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    const result = {};
    Object.entries(value).forEach(([key, item]) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
      result[key] = limitStrings(item, depth + 1);
    });
    return result;
  }

  return value;
}

/**
 * Приводит профиль из файла к безопасному виду.
 * Подменённый JSON не должен попасть в расчёты как строка/объект:
 * числовые поля ограничиваем диапазоном, перечисления — только из списков.
 * @param {unknown} raw
 */
function sanitizeProfile(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const defaults = defaultProfile();
  const activityIds = ACTIVITY_LEVELS.map((level) => level.id);
  const goalIds = GOALS.map((goal) => goal.id);
  const sexIds = SEX_OPTIONS.map((option) => option.id);

  return {
    ...defaults,
    // Вес/рост/возраст: 0 значит «не указано» — норма тогда не считается.
    weight: numberInRange(source.weight, LIMITS.weight.min, LIMITS.weight.max),
    height: numberInRange(source.height, LIMITS.height.min, LIMITS.height.max),
    age: numberInRange(source.age, LIMITS.age.min, LIMITS.age.max),
    // MET — настройка формулы, а не личное данное: без него расход всегда 0,
    // поэтому невалидное значение заменяем значением по умолчанию (5.0).
    metStrength: numberInRange(
      source.metStrength,
      LIMITS.metStrength.min,
      LIMITS.metStrength.max,
      defaults.metStrength
    ),
    sex: sexIds.includes(source.sex) ? source.sex : defaults.sex,
    activity: activityIds.includes(source.activity) ? source.activity : defaults.activity,
    goal: goalIds.includes(source.goal) ? source.goal : defaults.goal,
    id: PROFILE_ID,
  };
}

/**
 * Разбирает файл и проверяет, что это копия «Сила и КБЖУ».
 * @param {string} text
 */
function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { error: 'Файл не похож на JSON' };
  }
  if (!data || typeof data !== 'object' || !data.stores || typeof data.stores !== 'object') {
    return { error: 'В файле нет данных приложения' };
  }
  return { data };
}

async function importFile(root, ctx, file) {
  // Копия приложения не бывает больше 20 МБ: такой файл не читаем вообще,
  // чтобы «тяжёлый» JSON не подвесил iPhone.
  if (Number(file.size) > MAX_IMPORT_BYTES) {
    showToast('Файл слишком большой — это не копия приложения');
    return;
  }

  let text = '';
  try {
    text = await readFileAsText(file);
  } catch (error) {
    showToast('Не удалось прочитать файл');
    return;
  }

  const { data, error } = parseBackup(text);
  if (error) {
    showToast(error);
    return;
  }

  const stores = data.stores;
  const counts = {};
  Object.values(STORES).forEach((name) => {
    counts[name] = Array.isArray(stores[name]) ? Math.min(stores[name].length, MAX_IMPORT_ROWS) : 0;
  });

  const confirmed = await confirmDialog(
    'Импорт заменит все текущие данные. В файле: '
      + `${counts.workouts} ${plural(counts.workouts, 'тренировка', 'тренировки', 'тренировок')}, `
      + `${counts.meals} ${plural(counts.meals, 'запись', 'записи', 'записей')} дневника, `
      + `${counts.products} ${plural(counts.products, 'продукт', 'продукта', 'продуктов')}. Продолжить?`,
    { title: 'Импорт данных', confirmText: 'Импортировать' }
  );
  if (!confirmed) return;

  await db.clearAll();

  for (const name of Object.values(STORES)) {
    if (name === STORES.profile) continue;
    const rows = Array.isArray(stores[name])
      ? stores[name]
          .slice(0, MAX_IMPORT_ROWS)
          .filter((row) => row && typeof row === 'object')
          .map((row) => limitStrings(row))
      : [];
    if (rows.length) await db.addMany(name, rows);
  }

  // Профиль один: ключ 'main', значения приводим к безопасному виду —
  // подменённый файл не должен сломать расчёты нормы.
  await db.put(STORES.profile, sanitizeProfile(stores.profile));

  showToast('Данные импортированы');
  await ctx.refresh();
}

async function wipeAll(ctx) {
  const confirmed = await confirmDialog(
    'Удалятся все тренировки, продукты, блюда, дневник питания и профиль. Отменить это будет нельзя.',
    { title: 'Удалить все данные', confirmText: 'Удалить' }
  );
  if (!confirmed) return;

  await db.clearAll();
  await db.put(STORES.profile, defaultProfile());
  showToast('Данные удалены');
  await ctx.refresh();
}
