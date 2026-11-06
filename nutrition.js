/**
 * nutrition.js — экран «Питание» (вкладка 2): дневник питания за день.
 *
 * Возможности (этап 4):
 *  - выбор даты: «‹» и «›», календарь по нажатию на дату, кнопка «Сегодня»;
 *  - четыре приёма пищи: завтрак, обед, ужин, перекус;
 *  - добавление продуктов (в граммах) и блюд (в граммах или порциях);
 *  - правка количества и удаление записи — тап по строке;
 *  - суммы КБЖУ за день и прогресс относительно нормы из профиля
 *    (норма считается в targets.js — те же числа покажет экран «Профиль»).
 *
 * Данные (хранилище meals):
 *   { id, date: 'YYYY-MM-DD', mealType: 'breakfast'|'lunch'|'dinner'|'snack',
 *     kind: 'product'|'dish', productId?/dishId?, name,
 *     unit: 'g'|'portion', amount, grams, portionGrams,
 *     per100: { kcal, protein, fat, carbs }, createdAt, updatedAt }
 *
 * per100 — снимок КБЖУ на 100 г на момент добавления: запись в дневнике
 * продолжает считаться, даже если продукт или блюдо удалили из справочника
 * (тот же приём, что и в блюдах).
 *
 * Контракт с app.js: export async function render(root, ctx).
 */
import { db, STORES, MEAL_TYPES, PROFILE_ID } from './db.js';
import { calcTargets } from './targets.js';
import { dishTotals } from './foods.js';
import {
  el,
  escapeHtml,
  fmtNum,
  macroGridHtml,
  parseNum,
  round,
  openModal,
  confirmDialog,
  showToast,
  todayISO,
  addDaysISO,
  formatDateShort,
  weekdayRu,
} from './ui.js';

/** Выбранная дата дневника. Живёт, пока открыто приложение. */
const state = { date: todayISO() };

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
/* Помощники                                                           */
/* ------------------------------------------------------------------ */

/** Русское склонение: 1 порция, 2 порции, 5 порций. */
function plural(count, one, few, many) {
  const abs = Math.abs(Number(count) || 0);
  const tail = abs % 100;
  if (tail > 10 && tail < 20) return many;
  const last = tail % 10;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** Число без лишних нулей: 165 -> '165', 3.6 -> '3,6'. */
function numShort(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : fmtNum(number, 1);
}

/** Название приёма пищи по id ('lunch' -> 'Обед'). */
function mealName(mealType) {
  const meal = MEAL_TYPES.find((item) => item.id === mealType);
  return meal ? meal.name : 'Приём пищи';
}

/** Какой приём пищи сейчас уместен по времени суток (для «+» в шапке). */
function guessMealType() {
  const hour = new Date().getHours();
  if (hour < 11) return 'breakfast';
  if (hour < 16) return 'lunch';
  if (hour < 21) return 'dinner';
  return 'snack';
}

/**
 * КБЖУ на граммы по значениям на 100 г.
 * @param {{kcal: number, protein: number, fat: number, carbs: number}} per100
 * @param {number} grams
 */
function kbjuOf(per100, grams) {
  const factor = (Number(grams) || 0) / 100;
  const base = per100 || {};
  return {
    kcal: (Number(base.kcal) || 0) * factor,
    protein: (Number(base.protein) || 0) * factor,
    fat: (Number(base.fat) || 0) * factor,
    carbs: (Number(base.carbs) || 0) * factor,
  };
}

/** КБЖУ записи дневника (значения на 100 г умножаются на вес записи). */
function entryKbju(entry) {
  return kbjuOf(entry.per100, entry.grams);
}

/** Суммы КБЖУ по всем записям дня. */
function dayTotals(entries) {
  const sum = { kcal: 0, protein: 0, fat: 0, carbs: 0 };
  entries.forEach((entry) => {
    const kbju = entryKbju(entry);
    sum.kcal += kbju.kcal;
    sum.protein += kbju.protein;
    sum.fat += kbju.fat;
    sum.carbs += kbju.carbs;
  });
  return sum;
}

/** '200 г · Б 6,2 · Ж 3,2 · У 28' (для блюда ещё и порции). */
function entryAmountLine(entry) {
  const kbju = entryKbju(entry);
  const parts = [`${fmtNum(entry.grams)} г`];

  if (entry.unit === 'portion') {
    const portions = Number(entry.amount) || 0;
    parts.push(`${numShort(portions)} ${plural(portions, 'порция', 'порции', 'порций')}`);
  }

  parts.push(
    `Б ${fmtNum(kbju.protein, 1)} · Ж ${fmtNum(kbju.fat, 1)} · У ${fmtNum(kbju.carbs, 1)}`
  );
  return parts.join(' · ');
}

/** Сколько процентов нормы набрано (0–100, для полоски прогресса). */
function percentOf(value, target) {
  if (!(Number(target) > 0)) return 0;
  const percent = ((Number(value) || 0) / Number(target)) * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/* ------------------------------------------------------------------ */
/* Точка входа экрана                                                  */
/* ------------------------------------------------------------------ */

export async function render(root, ctx) {
  const [entries, profile] = await Promise.all([
    db.getAllByIndex(STORES.meals, 'byDate', state.date),
    db.get(STORES.profile, PROFILE_ID),
  ]);

  const targets = calcTargets(profile || {});
  const totals = dayTotals(entries);

  // «+» в шапке: сразу добавляем в тот приём пищи, который сейчас уместен
  const headerActions = ctx.actions(`
    <button class="icon-btn" type="button" data-action="quick-add"
            aria-label="Добавить в приём пищи" title="Добавить в приём пищи">+</button>
  `);
  headerActions.querySelector('[data-action="quick-add"]').addEventListener('click', () => {
    openAddSheet(ctx, guessMealType());
  });

  root.innerHTML = `
    ${dateCardHtml()}
    ${summaryHtml(totals, targets)}
    ${MEAL_TYPES.map((meal) =>
      mealCardHtml(meal, entries.filter((entry) => entry.mealType === meal.id))
    ).join('')}
  `;

  paintProgressBars(root);

  wire(root);

  // Календарь: нативный input type="date" спрятан, открываем его кнопкой даты
  const dateInput = root.querySelector('#diary-date');
  root.querySelector('[data-action="pick-date"]').addEventListener('click', () => {
    if (typeof dateInput.showPicker === 'function') {
      try {
        dateInput.showPicker();
        return;
      } catch (error) {
        // Safari без пользовательского жеста — падаем в обычный фокус
      }
    }
    dateInput.focus();
    dateInput.click();
  });

  dateInput.addEventListener('change', async () => {
    if (!dateInput.value) return;
    state.date = dateInput.value;
    await ctx.refresh();
  });

  currentHandlers.input = null;
  currentHandlers.change = null;
  currentHandlers.click = async (event) => {
    const addButton = event.target.closest('[data-action="add"]');
    if (addButton) {
      openAddSheet(ctx, addButton.dataset.meal);
      return;
    }

    const entryButton = event.target.closest('[data-entry]');
    if (entryButton) {
      const entry = entries.find((item) => item.id === Number(entryButton.dataset.entry));
      if (entry) openEntrySheet(ctx, entry);
      return;
    }

    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) return;

    const { action } = actionButton.dataset;
    if (action === 'prev-day') {
      state.date = addDaysISO(state.date, -1);
      await ctx.refresh();
      return;
    }
    if (action === 'next-day') {
      state.date = addDaysISO(state.date, 1);
      await ctx.refresh();
      return;
    }
    if (action === 'today') {
      state.date = todayISO();
      await ctx.refresh();
      return;
    }
    if (action === 'go-profile') {
      ctx.go('profile');
    }
  };
}

/* ------------------------------------------------------------------ */
/* Дата и итоги дня                                                    */
/* ------------------------------------------------------------------ */

/**
 * Ширину полосок прогресса задаём через CSSOM (`element.style.width`).
 * Inline-атрибут style запрещён Content-Security-Policy из index.html,
 * а изменения CSSOM политикой не блокируются — полоски работают как раньше.
 * @param {HTMLElement} root
 */
function paintProgressBars(root) {
  root.querySelectorAll('[data-progress]').forEach((bar) => {
    const percent = Number(bar.dataset.progress);
    const safe = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
    bar.style.width = `${safe}%`;
  });
}

function dateCardHtml() {
  const isToday = state.date === todayISO();
  const isYesterday = state.date === addDaysISO(todayISO(), -1);
  const dayHint = isToday ? 'сегодня' : isYesterday ? 'вчера' : weekdayRu(state.date);

  return `
    <div class="card">
      <div class="date-nav">
        <button class="icon-btn" type="button" data-action="prev-day" aria-label="Предыдущий день">‹</button>
        <button class="date-main-btn" type="button" data-action="pick-date">
          <span class="date-main">${formatDateShort(state.date)}</span>
          <span class="date-sub">${dayHint} · нажмите, чтобы выбрать дату</span>
        </button>
        <button class="icon-btn" type="button" data-action="next-day" aria-label="Следующий день">›</button>
      </div>
      <input id="diary-date" class="date-input" type="date" value="${state.date}" aria-label="Дата дневника">
      ${isToday ? '' : '<button class="btn btn-ghost btn-block" type="button" data-action="today">Вернуться к сегодня</button>'}
    </div>`;
}

/** Полоска «съедено из нормы» по одному макронутриенту. */
function macroRowHtml(key, name, value, target) {
  const percent = percentOf(value, target);
  const isOver = target > 0 && value > target;
  return `
    <div class="macro-row" data-macro="${key}">
      <span class="macro-name">${name}</span>
      <div class="progress"><div class="progress-bar${isOver ? ' is-over' : ''}" data-progress="${percent}"></div></div>
      <span class="macro-value tabnum">${fmtNum(value)} / ${fmtNum(target)} г</span>
    </div>`;
}

function summaryHtml(totals, targets) {
  if (!targets.valid) {
    return `
      <div class="card">
        <div class="card-row">
          <h2 class="card-title">Съедено за день</h2>
          <span class="badge">${fmtNum(totals.kcal)} ккал</span>
        </div>
        ${macroGridHtml(totals)}
        <p class="small muted">
          Норму пока не посчитать: в профиле не заполнены вес, рост или возраст.
          Показываю только суммы.
        </p>
        <button class="btn btn-secondary btn-block" type="button" data-action="go-profile">Заполнить профиль</button>
      </div>`;
  }

  const left = targets.kcal - totals.kcal;
  const percent = percentOf(totals.kcal, targets.kcal);

  return `
    <div class="card">
      <div class="card-row">
        <h2 class="card-title">Съедено за день</h2>
        <span class="badge badge-muted">норма ${fmtNum(targets.kcal)} ккал</span>
      </div>
      <div class="day-kcal">
        <b>${fmtNum(totals.kcal)}</b>
        <span class="muted">из ${fmtNum(targets.kcal)} ккал</span>
      </div>
      <div class="progress">
        <div class="progress-bar${left < 0 ? ' is-over' : ''}" data-progress="${percent}"></div>
      </div>
      <p class="small muted" id="day-left">
        ${left >= 0 ? `Осталось ${fmtNum(left)} ккал` : `Выше нормы на ${fmtNum(-left)} ккал`}
      </p>
      <div class="macro-rows">
        ${macroRowHtml('protein', 'Белки', totals.protein, targets.protein)}
        ${macroRowHtml('fat', 'Жиры', totals.fat, targets.fat)}
        ${macroRowHtml('carbs', 'Углеводы', totals.carbs, targets.carbs)}
      </div>
    </div>`;
}


/* ------------------------------------------------------------------ */
/* Приёмы пищи                                                         */
/* ------------------------------------------------------------------ */

function entryRowHtml(entry) {
  const kbju = entryKbju(entry);
  return `
    <li>
      <button class="meal-entry" type="button" data-entry="${entry.id}">
        <div class="list-item-main">
          <div class="list-item-title">${escapeHtml(entry.name || 'Без названия')}</div>
          <div class="list-item-sub">${entryAmountLine(entry)}</div>
        </div>
        <span class="tabnum nowrap">${fmtNum(kbju.kcal)} ккал</span>
      </button>
    </li>`;
}

function mealCardHtml(meal, entries) {
  const sorted = [...entries].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const kcal = sorted.reduce((sum, entry) => sum + entryKbju(entry).kcal, 0);

  return `
    <div class="card" data-meal-card="${meal.id}">
      <div class="card-row">
        <h3 class="card-title">${meal.name}</h3>
        <span class="badge${sorted.length ? '' : ' badge-muted'}">${
          sorted.length ? `${fmtNum(kcal)} ккал` : 'пусто'
        }</span>
      </div>
      ${sorted.length ? `<ul class="list">${sorted.map(entryRowHtml).join('')}</ul>` : ''}
      <button class="btn btn-secondary btn-block" type="button" data-action="add" data-meal="${meal.id}">
        + Добавить
      </button>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Шторка 1: выбор продукта или блюда                                  */
/* ------------------------------------------------------------------ */

/** Описание источника для новой записи: продукт (КБЖУ на 100 г). */
function productSource(product) {
  return {
    kind: 'product',
    id: product.id,
    name: product.name,
    per100: {
      kcal: Number(product.kcal) || 0,
      protein: Number(product.protein) || 0,
      fat: Number(product.fat) || 0,
      carbs: Number(product.carbs) || 0,
    },
    portionGrams: 0,
  };
}

/** Описание источника для новой записи: блюдо (на 100 г + вес порции). */
function dishSource(dish) {
  const totals = dishTotals(dish);
  return {
    kind: 'dish',
    id: dish.id,
    name: dish.name || 'Без названия',
    per100: {
      kcal: round(totals.per100.kcal, 1),
      protein: round(totals.per100.protein, 1),
      fat: round(totals.per100.fat, 1),
      carbs: round(totals.per100.carbs, 1),
    },
    portionGrams: totals.servings > 0 ? round(totals.weight / totals.servings, 1) : 0,
  };
}

/* Шторка выбора: строки списка продуктов и блюд */
function productPickHtml(product) {
  return `
    <li>
      <button class="list-item" type="button" data-pick-product="${product.id}">
        <div class="list-item-main">
          <div class="list-item-title">${escapeHtml(product.name)}</div>
          <div class="list-item-sub">Б ${fmtNum(product.protein, 1)} · Ж ${fmtNum(
    product.fat,
    1
  )} · У ${fmtNum(product.carbs, 1)} на 100 г</div>
        </div>
        <span class="badge">${fmtNum(product.kcal)} ккал</span>
      </button>
    </li>`;
}

function dishPickHtml(dish) {
  const totals = dishTotals(dish);
  const meta = [
    `${totals.servings} ${plural(totals.servings, 'порция', 'порции', 'порций')}`,
    totals.weight ? `${fmtNum(totals.weight)} г` : '',
    `Б ${fmtNum(totals.per100.protein, 1)} · Ж ${fmtNum(totals.per100.fat, 1)} · У ${fmtNum(
      totals.per100.carbs,
      1
    )} на 100 г`,
  ]
    .filter(Boolean)
    .join(' · ');

  return `
    <li>
      <button class="list-item" type="button" data-pick-dish="${dish.id}">
        <div class="list-item-main">
          <div class="list-item-title">${escapeHtml(dish.name || 'Без названия')}</div>
          <div class="list-item-sub">${escapeHtml(meta)}</div>
        </div>
        <span class="badge">${fmtNum(totals.perServing.kcal)} ккал</span>
      </button>
    </li>`;
}

function openAddSheet(ctx, mealType) {
  const content = el('div');
  content.innerHTML = `
    <div class="chips" id="add-tabs">
      <button class="chip is-active" type="button" data-kind="product">Продукты</button>
      <button class="chip" type="button" data-kind="dish">Блюда</button>
    </div>
    <div class="field">
      <input id="add-search" type="search" placeholder="Поиск по названию" autocomplete="off">
    </div>
    <ul class="list" id="add-list"></ul>
    <p class="small muted" id="add-hint"></p>
  `;

  const modal = openModal({ title: `Добавить в «${mealName(mealType).toLowerCase()}»`, content });
  const tabsEl = content.querySelector('#add-tabs');
  const searchEl = content.querySelector('#add-search');
  const listEl = content.querySelector('#add-list');
  const hintEl = content.querySelector('#add-hint');

  // Список продуктов длинный: показываем первые совпадения, остальное — поиском
  const LIMIT = 80;
  let kind = 'product';
  let products = [];
  let dishes = [];

  const draw = () => {
    const query = searchEl.value.trim().toLowerCase();

    if (kind === 'product') {
      const filtered = products.filter(
        (product) => !query || `${product.name} ${product.category || ''}`.toLowerCase().includes(query)
      );
      hintEl.textContent =
        filtered.length > LIMIT ? `Показаны первые ${LIMIT} из ${filtered.length} — уточните поиск` : '';
      listEl.innerHTML = filtered.length
        ? filtered.slice(0, LIMIT).map(productPickHtml).join('')
        : '<li class="empty small">Ничего не найдено — добавьте продукт на вкладке «Продукты»</li>';
      return;
    }

    const filteredDishes = dishes.filter(
      (dish) => !query || (dish.name || '').toLowerCase().includes(query)
    );
    hintEl.textContent = filteredDishes.length ? 'КБЖУ считается по составу блюда' : '';
    listEl.innerHTML = filteredDishes.length
      ? filteredDishes.map(dishPickHtml).join('')
      : '<li class="empty small">Пока нет блюд — соберите их на вкладке «Продукты и блюда»</li>';
  };

  const pickProduct = (product) => {
    modal.close();
    openAmountSheet({ ctx, mealType, source: productSource(product) });
  };

  const pickDish = (dish) => {
    modal.close();
    openAmountSheet({ ctx, mealType, source: dishSource(dish) });
  };

  tabsEl.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-kind]');
    if (!chip || chip.dataset.kind === kind) return;
    kind = chip.dataset.kind;
    tabsEl.querySelectorAll('[data-kind]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.kind === kind);
    });
    draw();
  });

  searchEl.addEventListener('input', draw);

  listEl.addEventListener('click', (event) => {
    const productButton = event.target.closest('[data-pick-product]');
    if (productButton) {
      const product = products.find((item) => item.id === Number(productButton.dataset.pickProduct));
      if (product) pickProduct(product);
      return;
    }

    const dishButton = event.target.closest('[data-pick-dish]');
    if (dishButton) {
      const dish = dishes.find((item) => item.id === Number(dishButton.dataset.pickDish));
      if (dish) pickDish(dish);
    }
  });

  (async () => {
    const [productList, dishList] = await Promise.all([
      db.getAll(STORES.products),
      db.getAll(STORES.dishes),
    ]);
    products = productList.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    dishes = dishList.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
    draw();
  })();
}


/* ------------------------------------------------------------------ */
/* Шторка 2: количество, правка и удаление записи                       */
/* ------------------------------------------------------------------ */

/** Граммы по введённому количеству: порции пересчитываются через вес порции. */
function gramsOf(amount, unit, source) {
  const value = Number(amount) || 0;
  if (unit === 'portion') return round(value * (Number(source.portionGrams) || 0), 1);
  return round(value, 1);
}

/** Быстрые значения для чипов: порции или граммы. */
function quickValues(unit) {
  return unit === 'portion' ? [0.5, 1, 1.5, 2, 3] : [50, 100, 150, 200, 250];
}

/**
 * Шторка количества. Одна и та же для добавления и для правки записи.
 * @param {{ctx: object, mealType: string, source: object, entry?: object}} options
 */
function openAmountSheet({ ctx, mealType, source, entry = null }) {
  const isEdit = Boolean(entry);
  // Порции доступны только у блюд с известным весом порции
  const canPortion = source.kind === 'dish' && Number(source.portionGrams) > 0;
  let unit = isEdit ? entry.unit : canPortion ? 'portion' : 'g';
  if (unit === 'portion' && !canPortion) unit = 'g';
  let amount = isEdit ? Number(entry.amount) || 0 : unit === 'portion' ? 1 : 100;

  const content = el('div');
  content.innerHTML = `
    <div class="amount-box">
      <div id="amount-preview"></div>
      <p class="small muted center" id="amount-note"></p>
    </div>
    ${
      canPortion
        ? `<div class="field">
             <span class="field-label">Как считать</span>
             <div class="chips" id="unit-tabs">
               <button class="chip${unit === 'portion' ? ' is-active' : ''}" type="button" data-unit="portion">Порциями</button>
               <button class="chip${unit === 'g' ? ' is-active' : ''}" type="button" data-unit="g">Граммами</button>
             </div>
           </div>`
        : ''
    }
    <div class="field">
      <label class="field-label" for="amount-input" id="amount-label"></label>
      <input id="amount-input" type="text" inputmode="decimal" autocomplete="off">
    </div>
    <div class="chips" id="amount-quick"></div>
    <button class="btn btn-primary btn-block" type="button" data-action="save">${
      isEdit ? 'Сохранить' : 'Добавить в дневник'
    }</button>
    ${
      isEdit
        ? '<button class="btn btn-danger btn-block" type="button" data-action="remove">Удалить из дневника</button>'
        : ''
    }
  `;

  const modal = openModal({ title: source.name, content });
  const inputEl = content.querySelector('#amount-input');
  const labelEl = content.querySelector('#amount-label');
  const quickEl = content.querySelector('#amount-quick');
  const previewEl = content.querySelector('#amount-preview');
  const noteEl = content.querySelector('#amount-note');
  const unitTabs = content.querySelector('#unit-tabs');

  const redraw = () => {
    const grams = gramsOf(amount, unit, source);
    previewEl.innerHTML = macroGridHtml(kbjuOf(source.per100, grams));
    labelEl.textContent = unit === 'portion' ? 'Порций' : 'Вес, г';
    noteEl.textContent =
      unit === 'portion'
        ? `${numShort(amount)} ${plural(amount, 'порция', 'порции', 'порций')} ≈ ${fmtNum(grams)} г`
        : `${fmtNum(grams)} г`;
  };

  const drawQuick = () => {
    quickEl.innerHTML = quickValues(unit)
      .map(
        (value) =>
          `<button class="chip" type="button" data-quick="${value}">${numShort(value)}</button>`
      )
      .join('');
  };

  inputEl.value = numShort(amount);
  drawQuick();
  redraw();


  inputEl.addEventListener('input', () => {
    amount = parseNum(inputEl.value);
    redraw();
  });

  quickEl.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-quick]');
    if (!chip) return;
    amount = parseNum(chip.dataset.quick);
    inputEl.value = numShort(amount);
    redraw();
  });

  // Переключение «порциями / граммами» сохраняет то же количество еды
  if (unitTabs) {
    unitTabs.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-unit]');
      if (!chip || chip.dataset.unit === unit) return;

      const grams = gramsOf(amount, unit, source);
      unit = chip.dataset.unit;
      amount = unit === 'portion' ? round(grams / (Number(source.portionGrams) || 1), 2) || 1 : grams || 100;

      inputEl.value = numShort(amount);
      unitTabs.querySelectorAll('[data-unit]').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.unit === unit);
      });
      drawQuick();
      redraw();
    });
  }

  content.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const value = parseNum(inputEl.value);
    if (!(value > 0)) {
      showToast(unit === 'portion' ? 'Укажите количество порций' : 'Укажите вес в граммах');
      inputEl.focus();
      return;
    }

    const grams = gramsOf(value, unit, source);
    const now = Date.now();
    const portionGrams = Number(source.portionGrams) || 0;

    if (isEdit) {
      await db.put(STORES.meals, {
        ...entry,
        unit,
        amount: value,
        grams,
        portionGrams,
        updatedAt: now,
      });
      showToast('Запись обновлена');
    } else {
      await db.add(STORES.meals, {
        date: state.date,
        mealType,
        kind: source.kind,
        ...(source.kind === 'product' ? { productId: source.id } : { dishId: source.id }),
        name: source.name,
        unit,
        amount: value,
        grams,
        portionGrams,
        per100: source.per100,
        createdAt: now,
        updatedAt: now,
      });
      showToast(`Добавлено в «${mealName(mealType).toLowerCase()}»`);
    }

    modal.close();
    await ctx.refresh();
  });

  const removeButton = content.querySelector('[data-action="remove"]');
  if (removeButton) {
    removeButton.addEventListener('click', async () => {
      const confirmed = await confirmDialog(
        `Удалить «${source.name}» из дневника за ${formatDateShort(state.date)}?`
      );

      if (!confirmed) {
        // Отменили — возвращаем шторку с теми же значениями
        openAmountSheet({ ctx, mealType, source, entry });
        return;
      }

      await db.remove(STORES.meals, entry.id);
      showToast('Удалено');
      await ctx.refresh();
    });
  }
}

/** Тап по строке дневника: та же шторка, но в режиме правки. */
function openEntrySheet(ctx, entry) {
  const source = {
    kind: entry.kind,
    id: entry.kind === 'product' ? entry.productId : entry.dishId,
    name: entry.name || 'Без названия',
    per100: entry.per100 || { kcal: 0, protein: 0, fat: 0, carbs: 0 },
    portionGrams: Number(entry.portionGrams) || 0,
  };
  openAmountSheet({ ctx, mealType: entry.mealType, source, entry });
}

