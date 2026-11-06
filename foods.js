/**
 * foods.js — экран «Продукты и блюда» (вкладка 3).
 *
 * Продукты:
 *  - базовый набор из product-catalog.js (около 300 позиций) подставляется сам,
 *    но это обычный справочник: любой продукт можно изменить или удалить;
 *  - поиск по названию и фильтр по группам (мясо, рыба, крупы, овощи…);
 *  - свои продукты: название, категория и КБЖУ на 100 г;
 *  - кнопка «Добавить недостающие базовые продукты» возвращает удалённое.
 *
 * Блюда (их создаёт только пользователь, готовых нет):
 *  - конструктор: название, число порций, вес готового блюда;
 *  - ингредиенты в граммах — КБЖУ считается автоматически;
 *  - итог на всё блюдо, на 100 г и на одну порцию;
 *  - автосохранение правок (кнопки «Сохранить» нет), дата не нужна.
 *
 * Данные (хранилища products / dishes):
 *   products { id, name, kcal, protein, fat, carbs, category? } — на 100 г
 *   dishes   { id, name, servings, finalWeightGrams, createdAt, updatedAt,
 *              ingredients: [{ productId, productName, kcal, protein, fat, carbs, grams }] }
 * В ингредиенте хранится копия названия и КБЖУ продукта: блюдо продолжает
 * считаться, даже если продукт удалили из справочника.
 *
 * Контракт с app.js: export async function render(root, ctx).
 */
import { db, STORES, syncDefaultProducts } from './db.js';
import { DEFAULT_PRODUCTS, PRODUCT_CATEGORIES, productKey } from './product-catalog.js';
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
} from './ui.js';

/** Вид экрана: список (продукты или блюда) либо редактор блюда. */
const state = { tab: 'products', mode: 'list', dishId: null, query: '', category: '' };

/** Таймер автосохранения блюда и промис последней записи в базу. */
let saveTimer = null;
let pendingSave = Promise.resolve();

/* ------------------------------------------------------------------ */
/* Помощники                                                           */
/* ------------------------------------------------------------------ */

/** Русское склонение: 1 продукт, 2 продукта, 5 продуктов. */
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

/** 'Б 31 · Ж 3,6 · У 0 · 165 ккал' — строка КБЖУ (значения на 100 г). */
function kbjuLine(item) {
  return `Б ${fmtNum(item.protein, 1)} · Ж ${fmtNum(item.fat, 1)} · У ${fmtNum(item.carbs, 1)} · ${fmtNum(
    item.kcal
  )} ккал`;
}

/** КБЖУ порции ингредиента: значения продукта пересчитываются с 100 г. */
function portionOf(ingredient) {
  const factor = (Number(ingredient.grams) || 0) / 100;
  return {
    kcal: (Number(ingredient.kcal) || 0) * factor,
    protein: (Number(ingredient.protein) || 0) * factor,
    fat: (Number(ingredient.fat) || 0) * factor,
    carbs: (Number(ingredient.carbs) || 0) * factor,
  };
}

/** КБЖУ, умноженное на коэффициент (пересчёт «на 100 г» и «на порцию»). */
function scaleKbju(values, factor) {
  return {
    kcal: values.kcal * factor,
    protein: values.protein * factor,
    fat: values.fat * factor,
    carbs: values.carbs * factor,
  };
}

/**
 * Итоги блюда: сумма по ингредиентам, на 100 г и на одну порцию.
 * Вес готового блюда берётся из поля, а если оно пустое — сумма граммов.
 * Функция чистая, её же использует дневник питания (nutrition.js).
 */
export function dishTotals(dish) {
  const sum = { kcal: 0, protein: 0, fat: 0, carbs: 0 };
  let grams = 0;

  (dish.ingredients || []).forEach((ingredient) => {
    grams += Number(ingredient.grams) || 0;
    const portion = portionOf(ingredient);
    sum.kcal += portion.kcal;
    sum.protein += portion.protein;
    sum.fat += portion.fat;
    sum.carbs += portion.carbs;
  });

  const finalWeight = Number(dish.finalWeightGrams) || 0;
  const weight = finalWeight > 0 ? finalWeight : grams;
  const servings = Math.max(1, Math.round(Number(dish.servings) || 1));

  return {
    sum,
    grams,
    weight,
    servings,
    per100: weight > 0 ? scaleKbju(sum, 100 / weight) : { kcal: 0, protein: 0, fat: 0, carbs: 0 },
    perServing: scaleKbju(sum, 1 / servings),
  };
}

/** Сколько базовых продуктов пользователь удалил (для кнопки восстановления). */
function countMissingDefaults(products) {
  const existing = new Set(products.map((product) => productKey(product.name)));
  return DEFAULT_PRODUCTS.filter((item) => !existing.has(productKey(item.name))).length;
}

/**
 * Слушатели вешаем на <section> один раз: app.js не пересоздаёт секции,
 * а только чистит содержимое, поэтому без флага обработчики бы дублировались.
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
  const [products, dishes] = await Promise.all([
    db.getAll(STORES.products),
    db.getAll(STORES.dishes),
  ]);

  if (state.mode === 'dish' && state.dishId != null) {
    const dish = await db.get(STORES.dishes, state.dishId);
    if (dish) {
      renderDishEditor(root, ctx, { dish });
      return;
    }
    // Блюдо удалили в другой вкладке — возвращаемся к списку
    state.mode = 'list';
    state.dishId = null;
  }

  renderList(root, ctx, { products, dishes });
}

/* ------------------------------------------------------------------ */
/* Вид 1: список продуктов и блюд                                      */
/* ------------------------------------------------------------------ */

function renderList(root, ctx, { products, dishes }) {
  const isProducts = state.tab === 'products';

  // Кнопки шапки живут вне <section>, поэтому подписываемся на них напрямую
  const headerActions = ctx.actions(`
    <button class="icon-btn" type="button" data-action="new"
            aria-label="${isProducts ? 'Новый продукт' : 'Новое блюдо'}"
            title="${isProducts ? 'Новый продукт' : 'Новое блюдо'}">+</button>
  `);
  headerActions.querySelector('[data-action="new"]').addEventListener('click', () => {
    if (isProducts) {
      openProductForm({ onSaved: () => ctx.refresh() });
    } else {
      openNewDishSheet(ctx);
    }
  });

  root.innerHTML = `
    <div class="chips" id="food-tabs">
      <button class="chip${isProducts ? ' is-active' : ''}" type="button" data-tab="products">
        Продукты (${products.length})
      </button>
      <button class="chip${isProducts ? '' : ' is-active'}" type="button" data-tab="dishes">
        Блюда (${dishes.length})
      </button>
    </div>
    <div id="food-body"></div>
  `;

  wire(root);

  root.querySelector('#food-tabs').addEventListener('click', async (event) => {
    const chip = event.target.closest('[data-tab]');
    if (!chip || chip.dataset.tab === state.tab) return;
    state.tab = chip.dataset.tab;
    state.query = '';
    state.category = '';
    await ctx.refresh();
  });

  const body = root.querySelector('#food-body');
  if (isProducts) {
    renderProductsTab(body, ctx, products);
  } else {
    renderDishesTab(body, ctx, dishes);
  }
}

/* ---------------------------- продукты ---------------------------- */

function productRowHtml(product) {
  return `
    <li>
      <button class="list-item" type="button" data-product="${product.id}">
        <div class="list-item-main">
          <div class="list-item-title">${escapeHtml(product.name)}</div>
          <div class="list-item-sub">Б ${fmtNum(product.protein, 1)} · Ж ${fmtNum(
    product.fat,
    1
  )} · У ${fmtNum(product.carbs, 1)}</div>
        </div>
        <span class="badge">${fmtNum(product.kcal)} ккал</span>
      </button>
    </li>`;
}

function renderProductsTab(body, ctx, products) {
  const missing = countMissingDefaults(products);
  const sorted = [...products].sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  body.innerHTML = `
    <div class="field">
      <input id="food-search" type="search" placeholder="Поиск продукта" autocomplete="off"
             value="${escapeHtml(state.query)}">
    </div>
    <div class="chips" id="food-categories"></div>
    <p class="small muted" id="food-count"></p>
    <ul class="list" id="food-list"></ul>
    ${
      missing
        ? `<button class="btn btn-secondary btn-block" type="button" data-action="restore">
             ↻ Добавить недостающие базовые продукты (${missing})
           </button>`
        : ''
    }
    <p class="small muted center">
      Базовый набор — ${DEFAULT_PRODUCTS.length} продуктов в ${PRODUCT_CATEGORIES.length} группах.
      КБЖУ указано на 100 г, значения можно править под себя.
    </p>
  `;

  const listEl = body.querySelector('#food-list');
  const countEl = body.querySelector('#food-count');
  const categoriesEl = body.querySelector('#food-categories');

  // Категории в порядке каталога, затем те, что пользователь написал сам
  const counts = new Map();
  sorted.forEach((product) => {
    const category = product.category || 'Без категории';
    counts.set(category, (counts.get(category) || 0) + 1);
  });
  const known = PRODUCT_CATEGORIES.filter((category) => counts.has(category));
  const custom = [...counts.keys()].filter((category) => !PRODUCT_CATEGORIES.includes(category));
  const categories = [...known, ...custom];

  const paintCategories = () => {
    categoriesEl.innerHTML = [
      `<button class="chip${state.category ? '' : ' is-active'}" type="button"
               data-category="">Все (${sorted.length})</button>`,
      ...categories.map(
        (category) => `
        <button class="chip${state.category === category ? ' is-active' : ''}" type="button"
                data-category="${escapeHtml(category)}">${escapeHtml(category)} (${counts.get(
          category
        )})</button>`
      ),
    ].join('');
  };

  const paint = () => {
    const query = state.query.trim().toLowerCase();
    const filtered = sorted.filter((product) => {
      if (state.category && (product.category || 'Без категории') !== state.category) return false;
      if (!query) return true;
      return `${product.name} ${product.category || ''}`.toLowerCase().includes(query);
    });

    countEl.textContent = filtered.length
      ? `Найдено: ${filtered.length} ${plural(filtered.length, 'продукт', 'продукта', 'продуктов')}`
      : '';

    listEl.innerHTML = filtered.length
      ? filtered.map(productRowHtml).join('')
      : `<li class="empty small">Ничего не найдено. Измените запрос, выберите другую группу
           или добавьте продукт кнопкой «+» в шапке.</li>`;
  };

  paintCategories();
  paint();

  currentHandlers.input = (event) => {
    if (event.target.id !== 'food-search') return;
    state.query = event.target.value;
    paint();
  };
  currentHandlers.change = null;

  currentHandlers.click = async (event) => {
    const categoryChip = event.target.closest('[data-category]');
    if (categoryChip) {
      state.category = categoryChip.dataset.category || '';
      paintCategories();
      paint();
      return;
    }

    const row = event.target.closest('[data-product]');
    if (row) {
      await openProductSheet(ctx, Number(row.dataset.product));
      return;
    }

    if (event.target.closest('[data-action="restore"]')) {
      await restoreDefaultProducts(ctx);
    }
  };
}

/** Досыпает базовые продукты, которых нет в справочнике. */
async function restoreDefaultProducts(ctx) {
  const result = await syncDefaultProducts();
  await ctx.refresh();
  if (result.added > 0) {
    showToast(`Добавлено продуктов: ${result.added}`);
  } else {
    showToast('Все базовые продукты уже в справочнике');
  }
}

/* ----------------------------- блюда ------------------------------ */

function dishRowHtml(dish) {
  const totals = dishTotals(dish);
  const items = dish.ingredients || [];
  const meta = [
    `${items.length} ${plural(items.length, 'ингредиент', 'ингредиента', 'ингредиентов')}`,
    totals.weight ? `${fmtNum(totals.weight)} г` : '',
    totals.servings > 1
      ? `${totals.servings} ${plural(totals.servings, 'порция', 'порции', 'порций')}`
      : '1 порция',
  ]
    .filter(Boolean)
    .join(' · ');

  return `
    <li>
      <button class="list-item" type="button" data-dish="${dish.id}">
        <div class="list-item-main">
          <div class="list-item-title">${escapeHtml(dish.name || 'Без названия')}</div>
          <div class="list-item-sub">${escapeHtml(meta)}</div>
          <div class="list-item-sub">${kbjuLine(totals.per100)} на 100 г</div>
        </div>
        <span class="badge">${fmtNum(totals.perServing.kcal)} ккал</span>
      </button>
    </li>`;
}

function renderDishesTab(body, ctx, dishes) {
  const sorted = [...dishes].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));

  body.innerHTML = sorted.length
    ? `<ul class="list">${sorted.map(dishRowHtml).join('')}</ul>
       <p class="small muted center">
         Готовых блюд нет — в списке только то, что вы собрали сами.
         КБЖУ считается по ингредиентам в граммах.
       </p>`
    : `<div class="empty">
         <p>Пока нет ни одного блюда</p>
         <p class="small">Нажмите «+» в шапке, назовите блюдо и добавьте продукты — КБЖУ посчитается само.</p>
       </div>`;

  currentHandlers.input = null;
  currentHandlers.change = null;
  currentHandlers.click = async (event) => {
    const row = event.target.closest('[data-dish]');
    if (!row) return;
    state.mode = 'dish';
    state.dishId = Number(row.dataset.dish);
    await ctx.refresh();
  };
}

/* ------------------------------------------------------------------ */
/* Вид 2: редактор блюда                                               */
/* ------------------------------------------------------------------ */

/** '150 г → 248 ккал · Б 46,5 · Ж 5,4 · У 0' */
function portionLine(ingredient, portion) {
  return `${fmtNum(ingredient.grams)} г → ${fmtNum(portion.kcal)} ккал · Б ${fmtNum(
    portion.protein,
    1
  )} · Ж ${fmtNum(portion.fat, 1)} · У ${fmtNum(portion.carbs, 1)}`;
}

function ingredientRowHtml(ingredient, index) {
  return `
    <div class="card ing-card" data-ing="${index}">
      <div class="ing-row">
        <button class="ing-name" type="button" data-action="swap-ingredient" data-ing="${index}">
          <span class="ing-title">${escapeHtml(ingredient.productName || 'Продукт')}</span>
          <span class="ing-sub">${numShort(ingredient.kcal)} ккал на 100 г</span>
        </button>
        <input class="ing-grams" type="text" inputmode="decimal" data-field="grams"
               value="${Number(ingredient.grams) ? numShort(ingredient.grams) : ''}"
               placeholder="г" aria-label="Вес ингредиента, граммы">
        <button class="modal-close" type="button" data-action="remove-ingredient" data-ing="${index}"
                aria-label="Убрать ингредиент">✕</button>
      </div>
      <p class="small muted" data-role="portion">${portionLine(ingredient, portionOf(ingredient))}</p>
    </div>`;
}

function renderDishEditor(root, ctx, { dish }) {
  const headerActions = ctx.actions(`
    <button class="icon-btn" type="button" data-action="back"
            aria-label="К списку блюд" title="К списку блюд">‹</button>
  `);

  if (!Array.isArray(dish.ingredients)) dish.ingredients = [];

  root.innerHTML = `
    <div class="card">
      <div class="field">
        <label class="field-label" for="dish-name">Название блюда</label>
        <input id="dish-name" type="text" autocomplete="off" placeholder="Например: омлет с сыром"
               value="${escapeHtml(dish.name || '')}">
      </div>
      <div class="field-row">
        <div class="field">
          <label class="field-label" for="dish-servings">Порций</label>
          <input id="dish-servings" type="text" inputmode="numeric"
                 value="${numShort(Math.max(1, Math.round(Number(dish.servings) || 1)))}">
        </div>
        <div class="field">
          <label class="field-label" for="dish-weight">Готовое блюдо, г</label>
          <input id="dish-weight" type="text" inputmode="decimal" placeholder="авто"
                 value="${Number(dish.finalWeightGrams) ? numShort(dish.finalWeightGrams) : ''}">
        </div>
      </div>
      <p class="small muted">Вес можно не заполнять — возьму сумму граммов ингредиентов.</p>
    </div>

    <div class="card" id="dish-totals"></div>

    <div class="stack" id="dish-ingredients"></div>

    <button class="btn btn-primary btn-block" type="button" data-action="add-ingredient">
      + Ингредиент
    </button>
    <button class="btn btn-danger btn-block" type="button" data-action="delete-dish">
      Удалить блюдо
    </button>
    <p class="small muted center">Изменения сохраняются автоматически.</p>
  `;

  const ingredientsBox = root.querySelector('#dish-ingredients');
  const totalsBox = root.querySelector('#dish-totals');

  /* --------------------------- отрисовка --------------------------- */

  const drawTotals = () => {
    const totals = dishTotals(dish);
    totalsBox.innerHTML = `
      <div class="card-row">
        <h2 class="card-title">КБЖУ блюда</h2>
        <span class="badge">${fmtNum(totals.weight)} г</span>
      </div>
      <p class="small muted">Все ингредиенты (${fmtNum(totals.grams)} г)</p>
      ${macroGridHtml(totals.sum)}
      <p class="small muted">На 100 г</p>
      ${macroGridHtml(totals.per100)}
      <p class="small muted">Одна порция — блюдо на ${totals.servings} ${plural(
      totals.servings,
      'порцию',
      'порции',
      'порций'
    )}</p>
      ${macroGridHtml(totals.perServing)}
    `;
  };

  const drawIngredients = () => {
    ingredientsBox.innerHTML = dish.ingredients.length
      ? dish.ingredients.map(ingredientRowHtml).join('')
      : `<div class="empty">
           <p>В блюде пока нет продуктов</p>
           <p class="small">Нажмите «+ Ингредиент» и выберите продукт из справочника.</p>
         </div>`;
  };

  drawIngredients();
  drawTotals();

  /* ------------------------- состояние и ввод ---------------------- */

  /** Переносит значения из полей в объект блюда (без записи в базу). */
  const syncFromDom = () => {
    const nameInput = root.querySelector('#dish-name');
    if (nameInput) dish.name = nameInput.value.trim();

    const servingsInput = root.querySelector('#dish-servings');
    if (servingsInput) {
      dish.servings = Math.max(1, Math.round(parseNum(servingsInput.value)) || 1);
    }

    const weightInput = root.querySelector('#dish-weight');
    if (weightInput) dish.finalWeightGrams = Math.max(0, parseNum(weightInput.value));

    ingredientsBox.querySelectorAll('.ing-card').forEach((row) => {
      const ingredient = dish.ingredients[Number(row.dataset.ing)];
      if (!ingredient) return;
      const gramsInput = row.querySelector('[data-field="grams"]');
      if (gramsInput) ingredient.grams = Math.max(0, parseNum(gramsInput.value));
    });
  };

  /** Пересчитывает строки ингредиентов и итоги, не перерисовывая поля ввода. */
  const updateLive = () => {
    dish.ingredients.forEach((ingredient, index) => {
      const row = ingredientsBox.querySelector(`.ing-card[data-ing="${index}"]`);
      if (!row) return;
      const slot = row.querySelector('[data-role="portion"]');
      if (slot) slot.textContent = portionLine(ingredient, portionOf(ingredient));
    });
    drawTotals();
  };

  /** Записать блюдо в базу прямо сейчас. */
  const saveNow = () => {
    syncFromDom();
    updateLive();
    clearTimeout(saveTimer);
    dish.updatedAt = Date.now();
    pendingSave = db.put(STORES.dishes, { ...dish }).catch((error) => {
      console.error('[foods] Не удалось сохранить блюдо', error);
      showToast('Не удалось сохранить блюдо');
    });
    return pendingSave;
  };

  /** Отложенное сохранение: не дёргаем диск на каждую цифру. */
  const queueSave = () => {
    syncFromDom();
    updateLive();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  };

  /** Добавить ингредиент или заменить продукт в уже добавленном. */
  const putIngredient = (product, index) => {
    const previous = index >= 0 ? dish.ingredients[index] : null;
    const ingredient = {
      productId: product.id,
      productName: product.name,
      kcal: Number(product.kcal) || 0,
      protein: Number(product.protein) || 0,
      fat: Number(product.fat) || 0,
      carbs: Number(product.carbs) || 0,
      grams: previous ? Number(previous.grams) || 0 : 100,
    };

    if (previous) {
      dish.ingredients[index] = ingredient;
    } else {
      dish.ingredients.push(ingredient);
    }

    drawIngredients();
    drawTotals();
    saveNow();

    if (!previous) {
      const block = ingredientsBox.lastElementChild;
      if (block && typeof block.scrollIntoView === 'function') {
        block.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  };

  /* ---------------------- обработчики редактора -------------------- */

  /** Возврат к списку с сохранением текущих правок. */
  const goBack = async () => {
    await saveNow();
    state.mode = 'list';
    state.dishId = null;
    await ctx.refresh();
  };

  headerActions.querySelector('[data-action="back"]').addEventListener('click', goBack);

  wire(root);

  currentHandlers.input = (event) => {
    if (event.target instanceof HTMLInputElement) queueSave();
  };
  currentHandlers.change = (event) => {
    if (event.target instanceof HTMLInputElement) queueSave();
  };

  currentHandlers.click = async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const action = button.dataset.action;
    const index = Number(button.dataset.ing);

    if (action === 'back') {
      await goBack();
      return;
    }

    if (action === 'add-ingredient') {
      syncFromDom();
      openProductPicker({ onPick: (product) => putIngredient(product, -1) });
      return;
    }

    if (action === 'swap-ingredient') {
      syncFromDom();
      if (!dish.ingredients[index]) return;
      openProductPicker({ onPick: (product) => putIngredient(product, index) });
      return;
    }

    if (action === 'remove-ingredient') {
      syncFromDom();
      if (!dish.ingredients[index]) return;
      dish.ingredients.splice(index, 1);
      drawIngredients();
      drawTotals();
      await saveNow();
      showToast('Ингредиент убран');
      return;
    }

    if (action === 'delete-dish') {
      const ok = await confirmDialog(
        `Удалить блюдо «${dish.name || 'Без названия'}»? Записи в дневнике питания за прошлые дни не изменятся.`,
        { title: 'Удаление блюда', confirmText: 'Удалить' }
      );
      if (!ok) return;

      clearTimeout(saveTimer);
      await db.remove(STORES.dishes, dish.id);
      state.mode = 'list';
      state.dishId = null;
      await ctx.refresh();
      showToast('Блюдо удалено');
    }
  };
}

/* ------------------------------------------------------------------ */
/* Шторки: новое блюдо, карточка продукта                              */
/* ------------------------------------------------------------------ */

function openNewDishSheet(ctx) {
  const content = el('div');
  content.innerHTML = `
    <div class="field">
      <label class="field-label" for="new-dish-name">Название блюда</label>
      <input id="new-dish-name" type="text" autocomplete="off" placeholder="Например: омлет с сыром">
    </div>
    <div class="field">
      <label class="field-label" for="new-dish-servings">На сколько порций</label>
      <input id="new-dish-servings" type="text" inputmode="numeric" value="1">
    </div>
    <p class="small muted">
      Дальше добавите продукты в граммах — КБЖУ посчитается само, отдельно «на 100 г» и «на порцию».
    </p>
    <div class="row">
      <button class="btn btn-secondary btn-block" type="button" data-action="cancel">Отмена</button>
      <button class="btn btn-primary btn-block" type="button" data-action="create">Создать</button>
    </div>
  `;

  const modal = openModal({ title: 'Новое блюдо', content });
  const nameInput = content.querySelector('#new-dish-name');
  const servingsInput = content.querySelector('#new-dish-servings');
  const createButton = content.querySelector('[data-action="create"]');

  content.querySelector('[data-action="cancel"]').addEventListener('click', () => modal.close());

  createButton.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      showToast('Введите название блюда');
      nameInput.focus();
      return;
    }

    createButton.disabled = true;
    const now = Date.now();

    try {
      const id = await db.add(STORES.dishes, {
        name,
        servings: Math.max(1, Math.round(parseNum(servingsInput.value)) || 1),
        finalWeightGrams: 0,
        ingredients: [],
        createdAt: now,
        updatedAt: now,
      });
      modal.close();
      state.mode = 'dish';
      state.dishId = Number(id);
      await ctx.refresh();
      showToast('Добавьте продукты в блюдо');
    } catch (error) {
      createButton.disabled = false;
      console.error('[foods] Не удалось создать блюдо', error);
      showToast('Не удалось создать блюдо');
    }
  });
}

/** Карточка продукта: КБЖУ на 100 г, изменение и удаление. */
async function openProductSheet(ctx, productId) {
  const product = await db.get(STORES.products, productId);
  if (!product) return;

  const content = el('div');
  content.innerHTML = `
    <p class="small muted">
      ${product.category ? `${escapeHtml(product.category)} · ` : ''}КБЖУ на 100 г
    </p>
    ${macroGridHtml(product)}
    <div class="row">
      <button class="btn btn-secondary btn-block" type="button" data-action="edit">Изменить</button>
      <button class="btn btn-danger btn-block" type="button" data-action="delete">Удалить</button>
    </div>
    <p class="small muted">
      На 100 г — ${fmtNum(product.kcal)} ккал. В блюдах и дневнике питания КБЖУ
      пересчитывается на нужное количество граммов.
    </p>
  `;

  openModal({ title: product.name, content });

  content.querySelector('[data-action="edit"]').addEventListener('click', () => {
    openProductForm({ product, onSaved: () => ctx.refresh() });
  });

  content.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    const ok = await confirmDialog(
      `Удалить «${product.name}» из справочника? Блюда, где он уже использован, не изменятся.`,
      { title: 'Удаление продукта', confirmText: 'Удалить' }
    );

    // Подтверждение закрывает шторку — при отказе открываем карточку заново
    if (!ok) {
      await openProductSheet(ctx, productId);
      return;
    }

    await db.remove(STORES.products, productId);
    await ctx.refresh();
    showToast('Продукт удалён');
  });
}

/**
 * Форма продукта: новый или изменение существующего (КБЖУ на 100 г).
 * @param {{product?: object, onSaved?: (product: object) => void}} options
 */
function openProductForm({ product, onSaved } = {}) {
  const content = el('div');
  const currentCategory = product && product.category ? product.category : '';
  const categoryOptions =
    !currentCategory || PRODUCT_CATEGORIES.includes(currentCategory)
      ? PRODUCT_CATEGORIES
      : [...PRODUCT_CATEGORIES, currentCategory];

  const numberField = (id, label, value) => `
    <div class="field">
      <label class="field-label" for="${id}">${label}</label>
      <input id="${id}" type="text" inputmode="decimal" placeholder="0" value="${escapeHtml(value)}">
    </div>`;

  content.innerHTML = `
    <div class="field">
      <label class="field-label" for="prod-name">Название</label>
      <input id="prod-name" type="text" autocomplete="off" placeholder="Например: творог 5%"
             value="${escapeHtml(product ? product.name : '')}">
    </div>
    <div class="field">
      <label class="field-label" for="prod-category">Группа продуктов</label>
      <select id="prod-category">
        <option value="">Без группы</option>
        ${categoryOptions
          .map(
            (category) =>
              `<option value="${escapeHtml(category)}"${
                currentCategory === category ? ' selected' : ''
              }>${escapeHtml(category)}</option>`
          )
          .join('')}
      </select>
    </div>
    <p class="small muted">КБЖУ на 100 г:</p>
    <div class="field-row">
      ${numberField('prod-kcal', 'Ккал', product ? numShort(product.kcal) : '')}
      ${numberField('prod-protein', 'Белки, г', product ? numShort(product.protein) : '')}
    </div>
    <div class="field-row">
      ${numberField('prod-fat', 'Жиры, г', product ? numShort(product.fat) : '')}
      ${numberField('prod-carbs', 'Углеводы, г', product ? numShort(product.carbs) : '')}
    </div>
    <div class="row">
      <button class="btn btn-secondary btn-block" type="button" data-action="cancel">Отмена</button>
      <button class="btn btn-primary btn-block" type="button" data-action="save">Сохранить</button>
    </div>
  `;

  const modal = openModal({
    title: product ? 'Изменить продукт' : 'Новый продукт',
    content,
  });

  const nameInput = content.querySelector('#prod-name');
  const saveButton = content.querySelector('[data-action="save"]');

  content.querySelector('[data-action="cancel"]').addEventListener('click', () => modal.close());

  saveButton.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      showToast('Введите название продукта');
      nameInput.focus();
      return;
    }

    const readNumber = (selector) =>
      Math.max(0, round(parseNum(content.querySelector(selector).value), 1));

    const value = {
      name,
      category: content.querySelector('#prod-category').value,
      kcal: readNumber('#prod-kcal'),
      protein: readNumber('#prod-protein'),
      fat: readNumber('#prod-fat'),
      carbs: readNumber('#prod-carbs'),
    };

    saveButton.disabled = true;

    try {
      const all = await db.getAll(STORES.products);
      const duplicate = all.find(
        (item) => productKey(item.name) === productKey(name) && (!product || item.id !== product.id)
      );
      if (duplicate) {
        saveButton.disabled = false;
        showToast('Такой продукт уже есть в справочнике');
        return;
      }

      let saved = value;
      if (product) {
        saved = { ...product, ...value };
        await db.put(STORES.products, saved);
      } else {
        const id = await db.add(STORES.products, value);
        saved = { ...value, id: Number(id) };
      }

      modal.close();
      if (typeof onSaved === 'function') onSaved(saved);
      showToast(product ? 'Продукт обновлён' : 'Продукт добавлен');
    } catch (error) {
      saveButton.disabled = false;
      console.error('[foods] Не удалось сохранить продукт', error);
      showToast('Не удалось сохранить продукт');
    }
  });
}

/* ------------------------------------------------------------------ */
/* Шторка выбора продукта (для ингредиентов блюда)                     */
/* ------------------------------------------------------------------ */

function openProductPicker({ onPick }) {
  const content = el('div');
  content.innerHTML = `
    <div class="field">
      <input id="pick-product-search" type="search" placeholder="Поиск продукта" autocomplete="off">
    </div>
    <button class="btn btn-primary btn-block" type="button" data-action="new-product">
      + Новый продукт
    </button>
    <ul class="list" id="pick-product-list"></ul>
    <p class="small muted" id="pick-product-hint"></p>
  `;

  const modal = openModal({ title: 'Выберите продукт', content });
  const listEl = content.querySelector('#pick-product-list');
  const searchEl = content.querySelector('#pick-product-search');
  const hintEl = content.querySelector('#pick-product-hint');

  // Список длинный: показываем первые совпадения, остальное — через поиск
  const LIMIT = 80;
  let products = [];

  const draw = () => {
    const query = searchEl.value.trim().toLowerCase();
    const filtered = products.filter(
      (product) => !query || `${product.name} ${product.category || ''}`.toLowerCase().includes(query)
    );

    hintEl.textContent =
      filtered.length > LIMIT ? `Показаны первые ${LIMIT} из ${filtered.length} — уточните поиск` : '';

    listEl.innerHTML = filtered.length
      ? filtered
          .slice(0, LIMIT)
          .map(
            (product) => `
        <li>
          <button class="list-item" type="button" data-pick="${product.id}">
            <div class="list-item-main">
              <div class="list-item-title">${escapeHtml(product.name)}</div>
              <div class="list-item-sub">Б ${fmtNum(product.protein, 1)} · Ж ${fmtNum(
              product.fat,
              1
            )} · У ${fmtNum(product.carbs, 1)}</div>
            </div>
            <span class="badge">${fmtNum(product.kcal)} ккал</span>
          </button>
        </li>`
          )
          .join('')
      : `<li class="empty small">Ничего не найдено — добавьте продукт кнопкой выше</li>`;
  };

  const load = async () => {
    products = (await db.getAll(STORES.products)).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    draw();
  };

  searchEl.addEventListener('input', draw);

  listEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-pick]');
    if (!button) return;
    const product = products.find((item) => item.id === Number(button.dataset.pick));
    if (!product) return;
    modal.close();
    onPick(product);
  });

  content.querySelector('[data-action="new-product"]').addEventListener('click', () => {
    // Форма откроется поверх шторки; после сохранения сразу подставим продукт
    openProductForm({ onSaved: (product) => onPick(product) });
  });

  load();
}
