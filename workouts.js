/**
 * workouts.js — экран «Тренировки» (вкладка 1).
 *
 * Что умеет:
 *  - список тренировок по датам (дату всегда выбирает пользователь);
 *  - создание, редактирование и удаление тренировки;
 *  - упражнения берутся из личного справочника: он не заполняется автоматически,
 *    в нём только то, что добавил сам пользователь (добавить/переименовать/удалить);
 *  - подходы в виде «повторы × вес», отметка разминочных подходов;
 *  - автосохранение каждой правки (кнопки «Сохранить» нет);
 *  - кнопка «Как в прошлый раз», подсказка «в прошлый раз: 60×8, 60×8»;
 *  - отметка личного рекорда по весу (🔥).
 *
 * Данные (хранилище workouts):
 *   { id, date: 'YYYY-MM-DD', durationMinutes, note, createdAt, updatedAt,
 *     exercises: [{ exerciseId, exerciseName, muscleGroup,
 *                   sets: [{ reps, weight, isWarmup }] }] }
 * exerciseName хранится копией: история читается даже после удаления упражнения
 * из справочника.
 *
 * Контракт с app.js: export async function render(root, ctx).
 */
import { db, STORES, MUSCLE_GROUPS } from './db.js';
import {
  el,
  escapeHtml,
  fmtNum,
  parseNum,
  formatDateShort,
  todayISO,
  openModal,
  confirmDialog,
  showToast,
} from './ui.js';

/** Текущий вид экрана: список тренировок или редактор одной тренировки. */
const state = { mode: 'list', workoutId: null };

/** Таймер автосохранения и промис последней записи в базу. */
let saveTimer = null;
let pendingSave = Promise.resolve();

/* ------------------------------------------------------------------ */
/* Помощники                                                           */
/* ------------------------------------------------------------------ */

/** Тренировки: свежие сверху (по дате, затем по id). */
function sortWorkouts(workouts) {
  return [...workouts].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return (b.id || 0) - (a.id || 0);
  });
}

/** Номер без лишних нулей: 60 -> '60', 62.5 -> '62,5'. */
function numShort(value) {
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : fmtNum(number, 1);
}

/** Итоги тренировки: рабочие подходы и тоннаж (разминка не считается). */
function workoutTotals(workout) {
  let workingSets = 0;
  let volume = 0;
  (workout.exercises || []).forEach((item) => {
    (item.sets || []).forEach((set) => {
      if (set.isWarmup) return;
      const reps = Number(set.reps) || 0;
      const weight = Number(set.weight) || 0;
      if (reps > 0) workingSets += 1;
      volume += reps * weight;
    });
  });
  return { workingSets, volume: Math.round(volume) };
}

/** Название упражнения: снимок в тренировке или текущее из справочника. */
function nameOf(item, dictionary) {
  if (item.exerciseName) return item.exerciseName;
  const exercise = dictionary.get(item.exerciseId);
  return exercise ? exercise.name : 'Упражнение';
}

/** '60×8, 60×8, 62,5×6' — рабочие подходы одной строкой. */
function setsLine(item) {
  const sets = (item.sets || []).filter((set) => !set.isWarmup && (Number(set.reps) || 0) > 0);
  if (!sets.length) return 'подходы не заполнены';
  return sets.map((set) => `${numShort(set.weight)}×${numShort(set.reps)}`).join(', ');
}

/** Лучшие веса по упражнениям среди остальных тренировок (для отметки рекорда). */
function bestWeights(workouts, excludeId) {
  const best = new Map();
  workouts.forEach((workout) => {
    if (workout.id === excludeId) return;
    (workout.exercises || []).forEach((item) => {
      (item.sets || []).forEach((set) => {
        if (set.isWarmup) return;
        const weight = Number(set.weight) || 0;
        if (weight > (best.get(item.exerciseId) || 0)) best.set(item.exerciseId, weight);
      });
    });
  });
  return best;
}

/** Тренировки, которые были раньше текущей (по дате, при равенстве — по id). */
function earlierWorkouts(workouts, workout) {
  return sortWorkouts(workouts).filter(
    (other) =>
      other.id !== workout.id &&
      (other.date < workout.date ||
        (other.date === workout.date && (other.id || 0) < (workout.id || 0)))
  );
}

/** Прошлый подход к тому же упражнению: { workout, entry } или null. */
function previousEntry(workout, item, workouts) {
  for (const other of earlierWorkouts(workouts, workout)) {
    const found = (other.exercises || []).find(
      (candidate) =>
        candidate.exerciseId === item.exerciseId ||
        (candidate.exerciseName && candidate.exerciseName === item.exerciseName)
    );
    if (found) return { workout: other, entry: found };
  }
  return null;
}

/** Подпись даты: '6 ноя, чт' + пометка «сегодня». */
function dateLabel(iso) {
  if (!iso) return 'без даты';
  return iso === todayISO() ? `${formatDateShort(iso)} · сегодня` : formatDateShort(iso);
}

/** Новый подход: по умолчанию повторяет предыдущий (удобно на тренировке). */
function makeSet(previous) {
  if (!previous) return { reps: 8, weight: 0, isWarmup: false };
  return {
    reps: Number(previous.reps) || 0,
    weight: Number(previous.weight) || 0,
    isWarmup: false,
  };
}
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
 * Слушатели вешаем на <section> один раз: app.js не пересоздаёт секции,
 * а только чистит их содержимое, поэтому без флага обработчики бы дублировались.
 * Сами обработчики хранятся в currentHandlers и меняются для каждого вида.
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
  const [exercises, workouts] = await Promise.all([
    db.getAll(STORES.exercises),
    db.getAll(STORES.workouts),
  ]);

  if (state.mode === 'edit' && state.workoutId != null) {
    const workout = await db.get(STORES.workouts, state.workoutId);
    if (workout) {
      renderEditor(root, ctx, { workout, exercises, workouts });
      return;
    }
    // Тренировку удалили в другой вкладке — возвращаемся к списку
    state.mode = 'list';
    state.workoutId = null;
  }

  renderList(root, ctx, { exercises, workouts });
}
/* ------------------------------------------------------------------ */
/* Вид 1: список тренировок                                            */
/* ------------------------------------------------------------------ */

function renderList(root, ctx, { exercises, workouts }) {
  const dictionary = new Map(exercises.map((exercise) => [exercise.id, exercise]));
  const sorted = sortWorkouts(workouts);

  const totals = sorted.reduce(
    (acc, workout) => {
      const one = workoutTotals(workout);
      acc.sets += one.workingSets;
      acc.volume += one.volume;
      return acc;
    },
    { sets: 0, volume: 0 }
  );

  // Кнопки шапки живут вне <section>, поэтому подписываемся на них напрямую:
  // ctx.actions() каждый раз создаёт новый элемент, дублей не будет.
  const headerActions = ctx.actions(`
    <button class="icon-btn" type="button" data-action="new" aria-label="Новая тренировка" title="Новая тренировка">+</button>
  `);
  headerActions.querySelector('[data-action="new"]').addEventListener('click', () => {
    openNewWorkoutSheet(ctx);
  });

  const itemsHtml = sorted
    .map((workout) => {
      const one = workoutTotals(workout);
      const items = workout.exercises || [];
      const duration = Number(workout.durationMinutes) || 0;
      const meta = [
        items.length
          ? `${items.length} ${plural(items.length, 'упражнение', 'упражнения', 'упражнений')}`
          : 'без упражнений',
        items.length ? `${one.workingSets} подх.` : '',
        duration ? `${duration} мин` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const preview = items.map((item) => nameOf(item, dictionary)).slice(0, 3).join(', ');
      const previewTail = items.length > 3 ? ', …' : '';

      return `
        <li>
          <button class="list-item" type="button" data-workout="${workout.id}">
            <div class="list-item-main">
              <div class="list-item-title">${escapeHtml(dateLabel(workout.date))}${
                workout.note ? ` — ${escapeHtml(workout.note)}` : ''
              }</div>
              <div class="list-item-sub">${escapeHtml(meta)}</div>
              ${preview ? `<div class="list-item-sub">${escapeHtml(preview + previewTail)}</div>` : ''}
            </div>
            <span class="badge${one.volume ? '' : ' badge-muted'}">${
              one.volume ? `${fmtNum(one.volume)} кг` : '—'
            }</span>
          </button>
        </li>`;
    })
    .join('');

  root.innerHTML = `
    ${
      exercises.length === 0
        ? `<div class="card">
             <h2 class="card-title">Сначала заведите упражнения</h2>
             <p class="small muted">
               Справочник пустой — он не заполняется автоматически, в нём только то,
               что делаете вы. Добавьте свои упражнения, и они появятся при наборе тренировки.
             </p>
             <button class="btn btn-secondary btn-block" type="button" data-action="dictionary">
               Открыть справочник
             </button>
           </div>`
        : ''
    }

    ${
      sorted.length
        ? `<div class="card">
             <div class="card-row">
               <h2 class="card-title">Дневник</h2>
               <span class="badge">${sorted.length} ${plural(
            sorted.length,
            'тренировка',
            'тренировки',
            'тренировок'
          )}</span>
             </div>
             <p class="small muted">
               Рабочих подходов: ${totals.sets} · общий объём: ${fmtNum(totals.volume)} кг
             </p>
           </div>
           <ul class="list">${itemsHtml}</ul>`
        : `<div class="empty">
             <p>Пока нет ни одной тренировки</p>
             <p class="small">Нажмите «+» в шапке, выберите дату — и добавляйте упражнения.</p>
           </div>`
    }

    <button class="btn btn-secondary btn-block" type="button" data-action="dictionary">
      📚 Справочник упражнений (${exercises.length})
    </button>
    <p class="small muted center">Изменения сохраняются автоматически.</p>
  `;

  wire(root);
  currentHandlers.click = async (event) => {
    const target = event.target.closest('[data-workout], [data-action]');
    if (!target) return;

    if (target.dataset.workout) {
      state.mode = 'edit';
      state.workoutId = Number(target.dataset.workout);
      await ctx.refresh();
      return;
    }

    if (target.dataset.action === 'dictionary') {
      openDictionary(ctx);
    }
  };
  currentHandlers.input = null;
  currentHandlers.change = null;
}
/* ------------------------------------------------------------------ */
/* Создание тренировки                                                 */
/* ------------------------------------------------------------------ */

function openNewWorkoutSheet(ctx) {
  const content = el('div');
  content.innerHTML = `
    <div class="field">
      <label class="field-label" for="new-date">Дата тренировки</label>
      <input id="new-date" type="date" value="${todayISO()}">
    </div>
    <div class="field">
      <label class="field-label" for="new-note">Название или заметка</label>
      <input id="new-note" type="text" placeholder="Например: день ног" autocomplete="off">
    </div>
    <p class="small muted">Дату выбираете вы — подойдёт любая, прошлая или будущая.</p>
    <div class="row">
      <button class="btn btn-secondary btn-block" type="button" data-action="cancel">Отмена</button>
      <button class="btn btn-primary btn-block" type="button" data-action="create">Создать</button>
    </div>
  `;

  const modal = openModal({ title: 'Новая тренировка', content });
  const createButton = content.querySelector('[data-action="create"]');

  content.querySelector('[data-action="cancel"]').addEventListener('click', () => modal.close());

  createButton.addEventListener('click', async () => {
    createButton.disabled = true;
    const date = content.querySelector('#new-date').value || todayISO();
    const note = content.querySelector('#new-note').value.trim();
    const now = Date.now();

    try {
      const id = await db.add(STORES.workouts, {
        date,
        note,
        durationMinutes: 0,
        exercises: [],
        createdAt: now,
        updatedAt: now,
      });
      modal.close();
      state.mode = 'edit';
      state.workoutId = Number(id);
      await ctx.refresh();
      ctx.toast('Тренировка создана — добавьте упражнения');
    } catch (error) {
      createButton.disabled = false;
      console.error('[workouts] Не удалось создать тренировку', error);
      ctx.toast('Не удалось сохранить тренировку');
    }
  });
}
/* ------------------------------------------------------------------ */
/* Вид 2: редактор тренировки                                          */
/* ------------------------------------------------------------------ */

function renderEditor(root, ctx, { workout, exercises, workouts }) {
  const dictionary = new Map(exercises.map((exercise) => [exercise.id, exercise]));
  const best = bestWeights(workouts, workout.id);
  const hasEarlier = earlierWorkouts(workouts, workout).some(
    (other) => (other.exercises || []).length > 0
  );

  const headerActions = ctx.actions(`
    <button class="icon-btn" type="button" data-action="back" aria-label="К списку тренировок" title="К списку тренировок">‹</button>
  `);

  root.innerHTML = `
    <div class="card">
      <div class="field">
        <label class="field-label" for="w-date">Дата тренировки</label>
        <input id="w-date" type="date" value="${escapeHtml(workout.date || todayISO())}">
      </div>
      <div class="field">
        <label class="field-label" for="w-note">Название или заметка</label>
        <input id="w-note" type="text" autocomplete="off" placeholder="Например: день ног"
               value="${escapeHtml(workout.note || '')}">
      </div>
      <div class="field-row">
        <div class="field">
          <label class="field-label" for="w-duration">Длительность, мин</label>
          <input id="w-duration" type="text" inputmode="numeric" placeholder="60"
                 value="${workout.durationMinutes ? numShort(workout.durationMinutes) : ''}">
        </div>
        <div class="field">
          <span class="field-label">Итог</span>
          <p class="small muted" id="w-totals"></p>
        </div>
      </div>
    </div>

    <div class="row-wrap">
      <button class="btn btn-primary" type="button" data-action="add-exercise">+ Упражнение</button>
      ${
        hasEarlier
          ? '<button class="btn btn-secondary" type="button" data-action="repeat">Как в прошлый раз</button>'
          : ''
      }
    </div>

    <div class="stack" id="w-exercises"></div>

    <button class="btn btn-danger btn-block" type="button" data-action="delete-workout">
      Удалить тренировку
    </button>
    <p class="small muted center">Заполняйте подходы — сохраняется автоматически.</p>
  `;

  const exercisesBox = root.querySelector('#w-exercises');
  const totalsBox = root.querySelector('#w-totals');
  if (!Array.isArray(workout.exercises)) workout.exercises = [];

  /** Переносит значения из полей в объект тренировки (без записи в базу). */
  const syncFromDom = () => {
    const dateInput = root.querySelector('#w-date');
    if (dateInput && dateInput.value) workout.date = dateInput.value;

    const noteInput = root.querySelector('#w-note');
    if (noteInput) workout.note = noteInput.value.trim();

    const durationInput = root.querySelector('#w-duration');
    if (durationInput) workout.durationMinutes = Math.max(0, Math.round(parseNum(durationInput.value)));

    exercisesBox.querySelectorAll('.set-row').forEach((row) => {
      const item = workout.exercises[Number(row.dataset.exercise)];
      if (!item || !Array.isArray(item.sets)) return;
      const set = item.sets[Number(row.dataset.set)];
      if (!set) return;

      const repsInput = row.querySelector('[data-field="reps"]');
      const weightInput = row.querySelector('[data-field="weight"]');
      if (repsInput) set.reps = Math.max(0, Math.round(parseNum(repsInput.value)));
      if (weightInput) set.weight = Math.max(0, parseNum(weightInput.value));
    });
  };

  /** Бейдж 🔥 обновляем без перерисовки полей, чтобы не сбивать ввод. */
  const updateRecordBadges = () => {
    exercisesBox.querySelectorAll('.exercise-block').forEach((block, index) => {
      const item = workout.exercises[index];
      const slot = block.querySelector('[data-role="record"]');
      if (!item || !slot) return;

      const previousBest = best.get(item.exerciseId) || 0;
      const currentMax = (item.sets || [])
        .filter((set) => !set.isWarmup)
        .reduce((max, set) => Math.max(max, Number(set.weight) || 0), 0);

      slot.innerHTML =
        previousBest > 0 && currentMax > previousBest
          ? ' <span class="badge">🔥 рекорд</span>'
          : '';
    });
  };

  const updateTotals = () => {
    const totals = workoutTotals(workout);
    totalsBox.textContent = `${totals.workingSets} подх. · ${fmtNum(totals.volume)} кг`;
    updateRecordBadges();
  };

  const drawExercises = () => {
    renderExerciseBlocks(exercisesBox, { workout, dictionary, workouts, best });
    updateTotals();
  };

  /** Записать тренировку в базу прямо сейчас. */
  const saveNow = () => {
    syncFromDom();
    updateTotals();
    clearTimeout(saveTimer);
    workout.updatedAt = Date.now();
    pendingSave = db.put(STORES.workouts, { ...workout }).catch((error) => {
      console.error('[workouts] Не удалось сохранить тренировку', error);
      showToast('Не удалось сохранить изменения');
    });
    return pendingSave;
  };

  /** Отложенное сохранение: не дёргаем диск на каждую цифру. */
  const queueSave = () => {
    syncFromDom();
    updateTotals();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  };

  /** Добавить упражнение из справочника (подходы — как в прошлый раз). */
  const addExercise = (exercise) => {
    syncFromDom();
    const entry = {
      exerciseId: exercise.id,
      exerciseName: exercise.name,
      muscleGroup: exercise.muscleGroup || '',
      sets: [],
    };

    const history = previousEntry(workout, entry, workouts);
    if (history) {
      entry.sets = (history.entry.sets || []).map((set) => ({
        reps: Number(set.reps) || 0,
        weight: Number(set.weight) || 0,
        isWarmup: Boolean(set.isWarmup),
      }));
      showToast(`Подходы взяты из прошлой тренировки (${formatDateShort(history.workout.date)})`);
    }
    if (!entry.sets.length) entry.sets = [makeSet(null), makeSet(null), makeSet(null)];

    workout.exercises.push(entry);
    drawExercises();
    saveNow();

    const block = exercisesBox.lastElementChild;
    if (block && typeof block.scrollIntoView === 'function') {
      block.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };

  drawExercises();
  /* ---------------------- обработчики редактора ---------------------- */

  /** Возврат к списку с сохранением текущих правок. */
  const goBack = async () => {
    await saveNow();
    state.mode = 'list';
    state.workoutId = null;
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
    const index = Number(button.dataset.exercise);
    const setIndex = Number(button.dataset.set);

    if (action === 'back') {
      await goBack();
      return;
    }

    if (action === 'add-exercise') {
      syncFromDom();
      openExercisePicker({ onPick: (exercise) => addExercise(exercise) });
      return;
    }

    if (action === 'repeat') {
      const source = earlierWorkouts(workouts, workout).find(
        (other) => (other.exercises || []).length > 0
      );
      if (!source) {
        showToast('Прошлых тренировок нет');
        return;
      }
      if ((workout.exercises || []).length) {
        const ok = await confirmDialog(
          `Заменить упражнения этой тренировки упражнениями из ${formatDateShort(source.date)}?`,
          { title: 'Как в прошлый раз', confirmText: 'Заменить' }
        );
        if (!ok) return;
      }

      workout.exercises = (source.exercises || []).map((item) => ({
        exerciseId: item.exerciseId,
        exerciseName: item.exerciseName || nameOf(item, dictionary),
        muscleGroup: item.muscleGroup || '',
        sets: (item.sets || []).map((set) => ({
          reps: Number(set.reps) || 0,
          weight: Number(set.weight) || 0,
          isWarmup: Boolean(set.isWarmup),
        })),
      }));
      drawExercises();
      await saveNow();
      showToast(`Скопировано из ${formatDateShort(source.date)}`);
      return;
    }

    if (action === 'add-set') {
      syncFromDom();
      const item = workout.exercises[index];
      if (!item) return;
      if (!Array.isArray(item.sets)) item.sets = [];
      item.sets.push(makeSet(item.sets[item.sets.length - 1]));
      drawExercises();
      saveNow();
      return;
    }

    if (action === 'remove-set') {
      syncFromDom();
      const item = workout.exercises[index];
      if (!item || !Array.isArray(item.sets)) return;
      item.sets.splice(setIndex, 1);
      drawExercises();
      saveNow();
      return;
    }

    if (action === 'toggle-warmup') {
      syncFromDom();
      const item = workout.exercises[index];
      const set = item && Array.isArray(item.sets) ? item.sets[setIndex] : null;
      if (!set) return;
      set.isWarmup = !set.isWarmup;
      drawExercises();
      saveNow();
      return;
    }

    if (action === 'remove-exercise') {
      syncFromDom();
      if (!workout.exercises[index]) return;
      workout.exercises.splice(index, 1);
      drawExercises();
      await saveNow();
      showToast('Упражнение убрано из тренировки');
      return;
    }

    if (action === 'delete-workout') {
      const ok = await confirmDialog(
        `Удалить тренировку за ${formatDateShort(workout.date)}? Восстановить её не получится.`,
        { title: 'Удаление тренировки', confirmText: 'Удалить' }
      );
      if (!ok) return;

      clearTimeout(saveTimer);
      await db.remove(STORES.workouts, workout.id);
      state.mode = 'list';
      state.workoutId = null;
      await ctx.refresh();
      showToast('Тренировка удалена');
    }
  };
}
/* ------------------------------------------------------------------ */
/* Упражнения и подходы внутри тренировки                              */
/* ------------------------------------------------------------------ */

function renderExerciseBlocks(container, { workout, dictionary, workouts, best }) {
  const items = workout.exercises || [];

  if (!items.length) {
    container.innerHTML = `
      <div class="empty">
        <p>В тренировке пока нет упражнений</p>
        <p class="small">Нажмите «+ Упражнение» и выберите из своего справочника.</p>
      </div>`;
    return;
  }

  container.innerHTML = items
    .map((item, index) => exerciseBlockHtml(item, index, { workout, dictionary, workouts, best }))
    .join('');
}

function exerciseBlockHtml(item, index, { workout, dictionary, workouts, best }) {
  const history = previousEntry(workout, item, workouts);
  const previousBest = best.get(item.exerciseId) || 0;
  const currentMax = (item.sets || [])
    .filter((set) => !set.isWarmup)
    .reduce((max, set) => Math.max(max, Number(set.weight) || 0), 0);
  const isRecord = previousBest > 0 && currentMax > previousBest;
  const recordBadge = isRecord ? ' <span class="badge">🔥 рекорд</span>' : '';

  const historyLine = history
    ? `В прошлый раз (${formatDateShort(history.workout.date)}): ${escapeHtml(setsLine(history.entry))}`
    : 'Это упражнение впервые в дневнике';

  return `
    <div class="card exercise-block">
      <div class="exercise-head">
        <div class="list-item-main">
          <div class="list-item-title">${escapeHtml(nameOf(item, dictionary))}</div>
          <div class="list-item-sub">${escapeHtml(item.muscleGroup || 'без группы')}<span data-role="record">${recordBadge}</span></div>
        </div>
        <button class="modal-close" type="button" data-action="remove-exercise" data-exercise="${index}"
                aria-label="Убрать упражнение из тренировки">✕</button>
      </div>

      <div class="sets">
        ${(item.sets || []).map((set, setIndex) => setRowHtml(set, index, setIndex)).join('')}
      </div>

      <div class="row">
        <button class="btn btn-secondary btn-sm" type="button" data-action="add-set" data-exercise="${index}">
          + подход
        </button>
        <span class="spacer"></span>
      </div>

      <p class="small muted">${historyLine}</p>
    </div>`;
}

function setRowHtml(set, index, setIndex) {
  const label = set.isWarmup ? 'Р' : String(setIndex + 1);
  const reps = Number(set.reps) ? numShort(set.reps) : '';
  const weight = Number(set.weight) ? numShort(set.weight) : '';

  return `
    <div class="set-row" data-exercise="${index}" data-set="${setIndex}">
      <span class="set-num">${label}</span>
      <input class="set-input" type="text" inputmode="decimal" data-field="weight" value="${weight}"
             placeholder="кг" aria-label="Вес, кг">
      <span class="set-x">×</span>
      <input class="set-input" type="text" inputmode="numeric" data-field="reps" value="${reps}"
             placeholder="повт." aria-label="Повторения">
      <button class="chip chip-sm${set.isWarmup ? ' is-active' : ''}" type="button"
              data-action="toggle-warmup" data-exercise="${index}" data-set="${setIndex}">разминка</button>
      <button class="modal-close" type="button" data-action="remove-set"
              data-exercise="${index}" data-set="${setIndex}" aria-label="Удалить подход">✕</button>
    </div>`;
}
/* ------------------------------------------------------------------ */
/* Личный справочник упражнений                                        */
/* ------------------------------------------------------------------ */

/**
 * Шторка выбора упражнения из справочника.
 * @param {{onPick: (exercise: {id:number,name:string,muscleGroup:string}) => void}} options
 */
function openExercisePicker({ onPick }) {
  const content = el('div');
  content.innerHTML = `
    <div class="field">
      <input id="pick-search" type="search" placeholder="Поиск по названию" autocomplete="off">
    </div>
    <button class="btn btn-primary btn-block" type="button" data-action="new-exercise">
      + Новое упражнение
    </button>
    <ul class="list" id="pick-list"></ul>
  `;

  const modal = openModal({ title: 'Выберите упражнение', content });
  const listEl = content.querySelector('#pick-list');
  const searchInput = content.querySelector('#pick-search');
  let exercises = [];

  const draw = () => {
    const query = searchInput.value.trim().toLowerCase();
    const filtered = exercises
      .filter((exercise) => !query || `${exercise.name} ${exercise.muscleGroup || ''}`.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    if (!filtered.length) {
      listEl.innerHTML = `<li class="empty small">
        ${exercises.length ? 'Ничего не найдено' : 'Справочник пуст — добавьте упражнение кнопкой выше'}
      </li>`;
      return;
    }

    listEl.innerHTML = filtered
      .map(
        (exercise) => `
        <li>
          <button class="list-item" type="button" data-id="${exercise.id}">
            <div class="list-item-main">
              <div class="list-item-title">${escapeHtml(exercise.name)}</div>
              <div class="list-item-sub">${escapeHtml(exercise.muscleGroup || '')}</div>
            </div>
            <span class="badge">+</span>
          </button>
        </li>`
      )
      .join('');
  };

  const load = async () => {
    exercises = await db.getAll(STORES.exercises);
    draw();
  };

  searchInput.addEventListener('input', draw);

  listEl.addEventListener('click', (event) => {
    const button = event.target.closest('[data-id]');
    if (!button) return;
    const exercise = exercises.find((item) => item.id === Number(button.dataset.id));
    if (!exercise) return;
    modal.close();
    onPick(exercise);
  });

  content.querySelector('[data-action="new-exercise"]').addEventListener('click', () => {
    openExerciseForm({
      title: 'Новое упражнение',
      onSaved: (exercise) => {
        modal.close();
        onPick(exercise);
      },
    });
  });

  load();
}

/**
 * Форма упражнения: добавить новое или переименовать существующее.
 * @param {{title?: string, exercise?: object, onSaved?: Function}} options
 */
function openExerciseForm({ title, exercise, onSaved }) {
  const content = el('div');
  content.innerHTML = `
    <div class="field">
      <label class="field-label" for="ex-name">Название</label>
      <input id="ex-name" type="text" autocomplete="off" placeholder="Например: жим лёжа"
             value="${escapeHtml(exercise ? exercise.name : '')}">
    </div>
    <div class="field">
      <label class="field-label" for="ex-group">Группа мышц</label>
      <select id="ex-group">
        ${MUSCLE_GROUPS.map(
          (group) =>
            `<option value="${escapeHtml(group)}"${
              exercise && exercise.muscleGroup === group ? ' selected' : ''
            }>${escapeHtml(group)}</option>`
        ).join('')}
      </select>
    </div>
    <div class="row">
      <button class="btn btn-secondary btn-block" type="button" data-action="cancel">Отмена</button>
      <button class="btn btn-primary btn-block" type="button" data-action="save">Сохранить</button>
    </div>
  `;

  const modal = openModal({ title: title || 'Упражнение', content });
  const nameInput = content.querySelector('#ex-name');
  const groupSelect = content.querySelector('#ex-group');
  const saveButton = content.querySelector('[data-action="save"]');

  content.querySelector('[data-action="cancel"]').addEventListener('click', () => modal.close());

  saveButton.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      showToast('Введите название упражнения');
      return;
    }

    saveButton.disabled = true;
    const values = { name, muscleGroup: groupSelect.value };

    try {
      let saved;
      if (exercise && exercise.id != null) {
        saved = { ...exercise, ...values };
        await db.put(STORES.exercises, saved);
      } else {
        const id = await db.add(STORES.exercises, values);
        saved = { id: Number(id), ...values };
      }
      modal.close();
      if (typeof onSaved === 'function') onSaved(saved);
    } catch (error) {
      saveButton.disabled = false;
      console.error('[workouts] Не удалось сохранить упражнение', error);
      showToast('Не удалось сохранить упражнение');
    }
  });

  setTimeout(() => nameInput.focus(), 60);
}

/**
 * Шторка справочника: добавить, переименовать, удалить упражнение или очистить список.
 * Справочник ведёт сам пользователь — автоматически он не заполняется.
 */
function openDictionary(ctx) {
  const content = el('div');
  content.innerHTML = `
    <button class="btn btn-primary btn-block" type="button" data-action="new-exercise">
      + Новое упражнение
    </button>
    <ul class="list" id="dict-list"></ul>
    <button class="btn btn-danger btn-block" type="button" data-action="clear-all">
      Удалить все упражнения
    </button>
    <p class="small muted">
      В справочнике только ваши упражнения. В прошлых тренировках сохраняется название,
      поэтому история не пропадёт.
    </p>
  `;

  openModal({ title: 'Справочник упражнений', content });

  const listEl = content.querySelector('#dict-list');
  const clearButton = content.querySelector('[data-action="clear-all"]');
  let exercises = [];

  const draw = () => {
    clearButton.disabled = exercises.length === 0;

    if (!exercises.length) {
      listEl.innerHTML = `<li class="empty small">
        Справочник пуст. Нажмите «+ Новое упражнение», чтобы добавить первое.
      </li>`;
      return;
    }

    listEl.innerHTML = exercises
      .map(
        (exercise) => `
        <li class="list-item">
          <div class="list-item-main">
            <div class="list-item-title">${escapeHtml(exercise.name)}</div>
            <div class="list-item-sub">${escapeHtml(exercise.muscleGroup || 'без группы')}</div>
          </div>
          <button class="btn btn-secondary btn-sm" type="button" data-edit="${exercise.id}">Изменить</button>
          <button class="modal-close" type="button" data-delete="${exercise.id}"
                  aria-label="Удалить упражнение">✕</button>
        </li>`
      )
      .join('');
  };

  const reload = async () => {
    exercises = (await db.getAll(STORES.exercises)).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    draw();
    if (ctx) await ctx.refresh();
  };

  content.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action], [data-edit], [data-delete]');
    if (!button) return;

    if (button.dataset.edit) {
      const exercise = exercises.find((item) => item.id === Number(button.dataset.edit));
      if (!exercise) return;
      openExerciseForm({
        title: 'Изменить упражнение',
        exercise,
        onSaved: () => openDictionary(ctx),
      });
      return;
    }

    if (button.dataset.delete) {
      const exercise = exercises.find((item) => item.id === Number(button.dataset.delete));
      if (!exercise) return;
      const ok = await confirmDialog(
        `Удалить «${exercise.name}» из справочника? Прошлые тренировки не изменятся.`,
        { title: 'Удаление упражнения', confirmText: 'Удалить' }
      );
      if (!ok) return;

      await db.remove(STORES.exercises, exercise.id);
      // Диалог подтверждения закрыл шторку справочника — открываем её заново
      openDictionary(ctx);
      showToast('Упражнение удалено из справочника');
      return;
    }

    if (button.dataset.action === 'new-exercise') {
      openExerciseForm({
        title: 'Новое упражнение',
        onSaved: () => openDictionary(ctx),
      });
      return;
    }

    if (button.dataset.action === 'clear-all') {
      const ok = await confirmDialog(
        `Удалить все упражнения из справочника (${exercises.length})? Сами тренировки останутся.`,
        { title: 'Очистить справочник', confirmText: 'Удалить все' }
      );
      if (!ok) return;

      await db.clear(STORES.exercises);
      openDictionary(ctx);
      showToast('Справочник очищен');
    }
  });

  reload();
}
