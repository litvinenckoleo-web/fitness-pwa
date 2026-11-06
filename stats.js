/**
 * stats.js — экран «Итоги» (вкладка 4).
 *
 * Этап 6:
 *  - «Сегодня»: сколько съедено, сколько потрачено на тренировках и баланс;
 *  - сводка за период 7 или 30 дней: средние значения, тоннаж, отклонение от нормы;
 *  - графики на Canvas: калории по дням (с линией нормы), тоннаж по дням,
 *    прогресс по выбранному упражнению (максимальный вес или тоннаж);
 *  - расход тренировок считается по MET и весу из профиля — формула общая
 *    с экраном «Профиль» (calcWorkoutKcal в targets.js).
 *
 * Данные берутся из хранилищ meals (снимок КБЖУ на 100 г + граммы) и workouts
 * (подходы «повторы × вес», разминочные не считаются).
 *
 * Контракт с app.js: export async function render(root, ctx).
 */
import { db, STORES, PROFILE_ID } from './db.js';
import { calcTargets, calcWorkoutKcal } from './targets.js';
import { escapeHtml, fmtNum, formatDateShort, todayISO, addDaysISO } from './ui.js';

/** Периоды сводки: 7 дней (неделя) и 30 дней (месяц). */
const PERIODS = [7, 30];

/** Состояние экрана: выбранный период и выбранное упражнение. */
const state = { period: 7, exerciseKey: null, model: null, redraw: null };

/**
 * Обработчики навешиваются один раз на <section>, а app.js только меняет
 * её содержимое, поэтому без флага они бы дублировались.
 */
const currentHandlers = { click: null, change: null };

function wire(root) {
  if (root.dataset.wired === '1') return;
  root.dataset.wired = '1';
  root.addEventListener('click', (event) => {
    if (typeof currentHandlers.click === 'function') currentHandlers.click(event);
  });
  root.addEventListener('change', (event) => {
    if (typeof currentHandlers.change === 'function') currentHandlers.change(event);
  });
}

/* ------------------------------------------------------------------ */
/* Помощники                                                           */
/* ------------------------------------------------------------------ */

/** Русское склонение: 1 день, 2 дня, 5 дней. */
function plural(count, one, few, many) {
  const abs = Math.abs(Number(count) || 0);
  const tail = abs % 100;
  if (tail > 10 && tail < 20) return many;
  const last = tail % 10;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** 12400 -> '12 400' — разряды пробелом, читать числа проще. */
function groupNum(value) {
  const number = Math.round(Number(value) || 0);
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Число со знаком: -218 -> '-218', 0 -> '0'. */
function signedKcal(value) {
  const number = Math.round(Number(value) || 0);
  return number > 0 ? `+${groupNum(number)}` : groupNum(number);
}

/** '2026-11-06' -> '6' — короткая подпись дня на оси X. */
function dayLabel(iso) {
  return String(Number(String(iso).slice(8, 10)) || 0);
}

/** Даты периода по возрастанию: последним идёт сегодня. */
function daysRange(days, today) {
  const list = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    list.push(addDaysISO(today, -index));
  }
  return list;
}

/** КБЖУ на граммы по значениям на 100 г. */
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


/* ------------------------------------------------------------------ */
/* Агрегация данных                                                    */
/* ------------------------------------------------------------------ */

/** Пустая строка дня: сюда суммируем еду и тренировки. */
function emptyDay(date) {
  return {
    date,
    eaten: 0,
    protein: 0,
    fat: 0,
    carbs: 0,
    burned: 0,
    volume: 0,
    workouts: 0,
    entries: 0,
  };
}

/**
 * Раскладывает записи дневника и тренировки по дням периода.
 * Дни без записей остаются в списке с нулями — графику нужна ровная шкала.
 */
function buildDays(dates, meals, workouts, person) {
  const map = new Map(dates.map((date) => [date, emptyDay(date)]));

  meals.forEach((entry) => {
    const row = map.get(entry.date);
    if (!row) return;
    const kbju = kbjuOf(entry.per100, entry.grams);
    row.eaten += kbju.kcal;
    row.protein += kbju.protein;
    row.fat += kbju.fat;
    row.carbs += kbju.carbs;
    row.entries += 1;
  });

  workouts.forEach((workout) => {
    const row = map.get(workout.date);
    if (!row) return;
    const totals = workoutTotals(workout);
    row.volume += totals.volume;
    row.workouts += 1;
    row.burned += calcWorkoutKcal({
      met: person.metStrength,
      weight: person.weight,
      minutes: workout.durationMinutes,
    });
  });

  return dates.map((date) => map.get(date));
}

/**
 * Итоги периода.
 * Средние считаются только по дням, где есть еда: иначе «нули» за отпуск
 * занижали бы среднее и показывали ложный дефицит.
 */
function periodSummary(days, targets) {
  const sum = days.reduce(
    (acc, day) => {
      acc.eaten += day.eaten;
      acc.burned += day.burned;
      acc.volume += day.volume;
      acc.workouts += day.workouts;
      acc.entries += day.entries;
      if (day.eaten > 0) acc.foodDays += 1;
      if (day.workouts > 0) acc.workoutDays += 1;
      return acc;
    },
    { eaten: 0, burned: 0, volume: 0, workouts: 0, entries: 0, foodDays: 0, workoutDays: 0 }
  );

  const avgEaten = sum.foodDays ? Math.round(sum.eaten / sum.foodDays) : 0;
  const avgBalance = sum.foodDays ? Math.round((sum.eaten - sum.burned) / sum.foodDays) : 0;
  const deviation = targets.valid ? Math.round(sum.eaten - sum.burned - targets.kcal * sum.foodDays) : 0;

  return { ...sum, avgEaten, avgBalance, deviation };
}

/**
 * История по упражнениям за период.
 * Ключ — id упражнения, а если его нет (старые записи) — название.
 * Возвращает список с точками по датам: максимальный вес и тоннаж за день.
 */
function exerciseHistory(workouts, dates) {
  const inPeriod = new Set(dates);
  const groups = new Map();

  workouts.forEach((workout) => {
    if (!inPeriod.has(workout.date)) return;
    (workout.exercises || []).forEach((item) => {
      const name = item.exerciseName || '';
      if (!name && item.exerciseId == null) return;

      const key = item.exerciseId != null ? `id:${item.exerciseId}` : `name:${name}`;
      let group = groups.get(key);
      if (!group) {
        group = { key, name: name || 'Упражнение', points: new Map(), best: null, volume: 0, sets: 0 };
        groups.set(key, group);
      }

      let point = group.points.get(workout.date);
      if (!point) {
        point = { date: workout.date, maxWeight: 0, volume: 0, sets: 0, reps: 0 };
        group.points.set(workout.date, point);
      }

      (item.sets || []).forEach((set) => {
        if (set.isWarmup) return;
        const reps = Number(set.reps) || 0;
        const weight = Number(set.weight) || 0;
        if (reps <= 0) return;
        point.sets += 1;
        point.reps += reps;
        point.volume += reps * weight;
        group.volume += reps * weight;
        group.sets += 1;
        if (weight > point.maxWeight) point.maxWeight = weight;
        if (weight > 0 && (!group.best || weight > group.best.weight)) {
          group.best = { weight, reps, date: workout.date };
        }
      });
    });
  });

  const list = [...groups.values()]
    .map((group) => ({
      ...group,
      volume: Math.round(group.volume),
      points: [...group.points.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    }))
    .filter((group) => group.points.length > 0);

  // Сверху — упражнения, которые встречаются чаще: обычно это и есть основные
  list.sort((a, b) => b.points.length - a.points.length || a.name.localeCompare(b.name, 'ru'));
  return list;
}

/**
 * Значения для графика упражнения: максимальный рабочий вес по дням,
 * а если вес нигде не указан (упражнения с весом тела) — тоннаж.
 */
function exerciseSeries(group, dates) {
  const position = new Map(dates.map((date, index) => [date, index]));
  const values = dates.map(() => null);

  group.points.forEach((point) => {
    const index = position.get(point.date);
    if (index != null) values[index] = point.maxWeight;
  });

  const hasWeight = values.some((value) => (Number(value) || 0) > 0);
  if (!hasWeight) {
    group.points.forEach((point) => {
      const index = position.get(point.date);
      if (index != null) values[index] = point.volume;
    });
    return { values, metric: 'volume' };
  }
  return { values, metric: 'weight' };
}


/* ------------------------------------------------------------------ */
/* Рисование на Canvas                                                 */
/* ------------------------------------------------------------------ */

const CHART_FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/** Цвета текущей темы (светлая/тёмная) берём из CSS-переменных. */
function themePalette() {
  const style = getComputedStyle(document.body);
  const read = (name, fallback) => (style.getPropertyValue(name) || '').trim() || fallback;
  return {
    text: read('--text', '#14181f'),
    muted: read('--text-muted', '#6b727e'),
    border: read('--border', '#dcdfe5'),
    accent: read('--accent', '#2f6bff'),
    warning: read('--warning', '#d98a16'),
  };
}

/**
 * Готовит canvas к рисованию: размеры в CSS-пикселях, а буфер — с учётом
 * devicePixelRatio, иначе на iPhone линии и текст выглядят мыльными.
 */
function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (!(width > 0) || !(height > 0)) return null;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const bufferWidth = Math.round(width * dpr);
  const bufferHeight = Math.round(height * dpr);
  if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
    canvas.width = bufferWidth;
    canvas.height = bufferHeight;
  }

  const context = canvas.getContext('2d');
  if (!context) return null;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

/** 1850 -> '1,9к' — подписи оси Y остаются короткими. */
function axisLabel(value) {
  const number = Math.round(Number(value) || 0);
  if (Math.abs(number) >= 1000) return `${fmtNum(number / 1000, 1)}к`;
  return String(number);
}

/** Красивые шаги шкалы: подписи вида 0 / 400 / 800 / 1 200, а не 0 / 358 / 717. */
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/**
 * Верхняя граница графика: максимум с небольшим запасом, округлённый
 * до «круглого» шага сетки (делений по умолчанию три).
 */
function niceTop(maxValue, steps = 3) {
  const padded = Math.max(Number(maxValue) || 0, 1) * 1.12;
  const raw = padded / steps;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = (NICE_STEPS.find((value) => value * magnitude >= raw) || 10) * magnitude;
  return step * steps;
}

/** Скруглённый прямоугольник: ctx.roundRect есть не во всех Safari. */
function roundRectPath(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height);
  context.lineTo(x, y + height);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

/** Геометрия графика: поля и область построения. */
function chartFrame(width, height) {
  const pad = { left: 38, right: 10, top: 14, bottom: 22 };
  return {
    pad,
    plotWidth: width - pad.left - pad.right,
    plotHeight: height - pad.top - pad.bottom,
  };
}

/** Сетка по горизонтали и подписи значений по оси Y. */
function drawGrid(context, frame, topValue, palette) {
  const { pad, plotWidth, plotHeight } = frame;
  const steps = 3;

  context.save();
  context.font = CHART_FONT;
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  context.lineWidth = 1;

  for (let index = 0; index <= steps; index += 1) {
    const y = pad.top + plotHeight - (plotHeight * index) / steps;

    context.globalAlpha = index === 0 ? 0.9 : 0.35;
    context.strokeStyle = palette.border;
    context.beginPath();
    context.moveTo(pad.left, y);
    context.lineTo(pad.left + plotWidth, y);
    context.stroke();

    context.globalAlpha = 1;
    context.fillStyle = palette.muted;
    context.fillText(axisLabel((topValue * index) / steps), pad.left - 6, y);
  }
  context.restore();
}

/** Подписи дней по оси X: не чаще семи штук, последний день всегда подписан. */
function drawDayLabels(context, frame, labels, palette) {
  const { pad, plotWidth, plotHeight } = frame;
  const slot = plotWidth / labels.length;
  const step = Math.max(1, Math.ceil(labels.length / 7));

  context.save();
  context.font = CHART_FONT;
  context.fillStyle = palette.muted;
  context.textAlign = 'center';
  context.textBaseline = 'top';

  labels.forEach((label, index) => {
    const isLast = index === labels.length - 1;
    if (index % step !== 0 && !isLast) return;
    context.fillText(label, pad.left + slot * index + slot / 2, pad.top + plotHeight + 6);
  });
  context.restore();
}


/**
 * Столбики по дням: калории или тоннаж.
 * @param {HTMLCanvasElement} canvas
 * @param {{labels: string[], values: number[], target?: number, color?: string}} data
 */
function drawBars(canvas, { labels, values, target = 0, color }) {
  const prepared = prepareCanvas(canvas);
  if (!prepared || !labels.length) return;

  const { context, width, height } = prepared;
  const palette = themePalette();
  const frame = chartFrame(width, height);
  if (frame.plotWidth <= 0 || frame.plotHeight <= 0) return;

  const barColor = color || palette.accent;
  const maxValue = Math.max(...values, target, 1);
  const topValue = niceTop(maxValue);
  const scale = frame.plotHeight / topValue;

  drawGrid(context, frame, topValue, palette);

  const slot = frame.plotWidth / values.length;
  const barWidth = Math.max(2, Math.min(28, slot * 0.62));

  context.save();
  context.fillStyle = barColor;
  values.forEach((value, index) => {
    if (!(value > 0)) return;
    const barHeight = Math.max(2, value * scale);
    const x = frame.pad.left + slot * index + (slot - barWidth) / 2;
    const y = frame.pad.top + frame.plotHeight - barHeight;
    roundRectPath(context, x, y, barWidth, barHeight, Math.min(4, barWidth / 2));
    context.fill();
  });
  context.restore();

  if (target > 0) {
    const y = frame.pad.top + frame.plotHeight - target * scale;
    context.save();
    context.setLineDash([5, 4]);
    context.lineWidth = 1.5;
    context.strokeStyle = palette.warning;
    context.beginPath();
    context.moveTo(frame.pad.left, y);
    context.lineTo(frame.pad.left + frame.plotWidth, y);
    context.stroke();
    context.restore();
  }

  drawDayLabels(context, frame, labels, palette);

  // Значения для автотестов и отладки в браузере
  canvas.dataset.drawn = '1';
  canvas.dataset.points = String(values.length);
  canvas.dataset.top = String(Math.round(maxValue));
}

/**
 * Ломаная по дням (прогресс упражнения). Пропуски (null) разрывают линию:
 * день без упражнения не должен соединяться напрямую с соседним.
 * @param {HTMLCanvasElement} canvas
 * @param {{labels: string[], values: (number|null)[], unit?: string}} data
 */
function drawLine(canvas, { labels, values, unit = 'кг' }) {
  const prepared = prepareCanvas(canvas);
  if (!prepared || !labels.length) return;

  const { context, width, height } = prepared;
  const palette = themePalette();
  const frame = chartFrame(width, height);
  if (frame.plotWidth <= 0 || frame.plotHeight <= 0) return;

  canvas.dataset.drawn = '1';
  canvas.dataset.points = String(values.filter((value) => Number(value) > 0).length);

  const numbers = values.filter((value) => Number(value) > 0).map(Number);
  if (!numbers.length) return;

  const maxValue = Math.max(...numbers);
  const topValue = niceTop(maxValue);
  const scale = frame.plotHeight / topValue;
  const slot = frame.plotWidth / labels.length;
  const xOf = (index) => frame.pad.left + slot * index + slot / 2;
  const yOf = (value) => frame.pad.top + frame.plotHeight - Number(value) * scale;

  drawGrid(context, frame, topValue, palette);

  // Линия
  context.save();
  context.strokeStyle = palette.accent;
  context.lineWidth = 2;
  context.lineJoin = 'round';
  context.beginPath();
  let started = false;
  values.forEach((value, index) => {
    if (!(Number(value) > 0)) {
      started = false;
      return;
    }
    if (started) {
      context.lineTo(xOf(index), yOf(value));
    } else {
      context.moveTo(xOf(index), yOf(value));
      started = true;
    }
  });
  context.stroke();

  // Точки
  context.fillStyle = palette.accent;
  values.forEach((value, index) => {
    if (!(Number(value) > 0)) return;
    context.beginPath();
    context.arc(xOf(index), yOf(value), 3, 0, Math.PI * 2);
    context.fill();
  });
  context.restore();

  // Подписываем максимум: это и есть главный результат периода
  const maxIndex = values.findIndex((value) => Number(value) === maxValue);
  if (maxIndex >= 0) {
    context.save();
    context.font = CHART_FONT;
    context.fillStyle = palette.text;
    context.textAlign = 'center';
    context.textBaseline = 'bottom';
    context.fillText(
      `${groupNum(maxValue)} ${unit}`,
      Math.min(width - 30, Math.max(30, xOf(maxIndex))),
      Math.max(12, yOf(maxValue) - 6)
    );
    context.restore();
  }

  drawDayLabels(context, frame, labels, palette);

  canvas.dataset.top = String(Math.round(maxValue));
}

/** Перерисовка всех графиков экрана (после смены периода или поворота экрана). */
function drawCharts(root, model) {
  if (!model) return;

  const kcalCanvas = root.querySelector('#chart-kcal');
  if (kcalCanvas) {
    drawBars(kcalCanvas, {
      labels: model.labels,
      values: model.days.map((day) => Math.round(day.eaten)),
      target: model.targets.valid ? model.targets.kcal : 0,
    });
  }

  const volumeCanvas = root.querySelector('#chart-volume');
  if (volumeCanvas) {
    drawBars(volumeCanvas, {
      labels: model.labels,
      values: model.days.map((day) => Math.round(day.volume)),
    });
  }

  const exerciseCanvas = root.querySelector('#chart-exercise');
  if (exerciseCanvas && model.selected) {
    const series = exerciseSeries(model.selected, model.dates);
    drawLine(exerciseCanvas, {
      labels: model.labels,
      values: series.values,
      unit: series.metric === 'weight' ? 'кг' : 'кг тоннажа',
    });
  }
}

/** Поворот iPhone или изменение ширины — перерисовываем (один слушатель на страницу). */
let resizeWired = false;
function wireResize() {
  if (resizeWired) return;
  resizeWired = true;

  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (typeof state.redraw === 'function') state.redraw();
    }, 150);
  });
}


/* ------------------------------------------------------------------ */
/* Разметка экрана                                                     */
/* ------------------------------------------------------------------ */

/** Плитка со значением: «Съедено — 150 ккал». */
function statTileHtml(label, value, unit, tone = '') {
  return `
    <div class="stat-tile">
      <span class="stat-label">${escapeHtml(label)}</span>
      <span class="stat-value tabnum${tone ? ` is-${tone}` : ''}">${escapeHtml(value)}${
        unit ? ` <i class="stat-unit">${escapeHtml(unit)}</i>` : ''
      }</span>
    </div>`;
}

/** Пояснение к балансу: в норме / выше / ниже. */
function balanceNote(balance, targets) {
  if (!targets.valid) return 'Норму не посчитать: заполните вес, рост и возраст в профиле.';
  const diff = balance - targets.kcal;
  if (Math.abs(diff) <= targets.kcal * 0.1) return 'Баланс в пределах нормы';
  return diff > 0
    ? `Выше нормы на ${groupNum(diff)} ккал`
    : `Ниже нормы на ${groupNum(-diff)} ккал`;
}

function todayCardHtml(day, targets) {
  const eaten = Math.round(day.eaten);
  const burned = Math.round(day.burned);
  const balance = eaten - burned;
  const normWithWorkout = targets.kcal + burned;
  const isEmpty = eaten === 0 && burned === 0;

  const tone = targets.valid && Math.abs(balance - targets.kcal) <= targets.kcal * 0.1 ? 'good' : '';
  const normLine = !targets.valid
    ? ''
    : burned > 0
      ? `Норма ${groupNum(targets.kcal)} ккал + тренировка ${groupNum(burned)} ккал = ${groupNum(normWithWorkout)} ккал.`
      : `Норма ${groupNum(targets.kcal)} ккал.`;

  return `
    <div class="card">
      <div class="card-row">
        <h2 class="card-title">Сегодня</h2>
        <span class="badge badge-muted">${escapeHtml(formatDateShort(day.date))}</span>
      </div>
      ${
        isEmpty
          ? `<div class="empty">За сегодня пока пусто: ни еды, ни тренировок.</div>
             <div class="row">
               <button class="btn btn-secondary btn-block" type="button" data-goto="nutrition">Дневник питания</button>
               <button class="btn btn-secondary btn-block" type="button" data-goto="workouts">Тренировки</button>
             </div>`
          : `<div class="stat-tiles stat-tiles-3">
               ${statTileHtml('Съедено', groupNum(eaten), 'ккал')}
               ${statTileHtml('Потрачено', groupNum(burned), 'ккал')}
               ${statTileHtml('Баланс', signedKcal(balance), 'ккал', tone)}
             </div>
             <p class="small muted">${escapeHtml(balanceNote(balance, targets))}</p>`
      }
      ${normLine ? `<p class="small muted">${escapeHtml(normLine)}</p>` : ''}
    </div>`;
}

/**
 * Отклонение от нормы за период: значение для правой колонки списка
 * и пояснение (дефицит/профицит) — в подпись, чтобы строка не расползалась.
 */
function deviationValue(summary, targets) {
  if (!targets.valid) return '—';
  if (!summary.foodDays) return '—';
  if (summary.deviation === 0) return '0 ккал';
  return `${signedKcal(summary.deviation)} ккал`;
}

function deviationNote(summary, targets) {
  if (!targets.valid) return 'нужен профиль';
  if (!summary.foodDays) return 'нет данных';
  if (summary.deviation === 0) return 'ровно по норме';
  const kind = summary.deviation > 0 ? 'профицит' : 'дефицит';
  return `${kind} · ${summary.foodDays} ${plural(summary.foodDays, 'день', 'дня', 'дней')} с едой`;
}

function periodCardHtml(daysCount, summary, targets) {
  const chips = PERIODS.map(
    (days) => `
      <button class="chip${state.period === days ? ' is-active' : ''}" type="button"
              data-period="${days}" aria-pressed="${state.period === days ? 'true' : 'false'}">${days} дней</button>`
  ).join('');

  return `
    <div class="card">
      <div class="card-row">
        <h2 class="card-title">За ${daysCount} ${plural(daysCount, 'день', 'дня', 'дней')}</h2>
        <span class="badge badge-muted">дней с едой: ${summary.foodDays} из ${daysCount}</span>
      </div>
      <div class="chips">${chips}</div>
      <div class="stat-tiles">
        ${statTileHtml('Среднее в день', groupNum(summary.avgEaten), 'ккал')}
        ${statTileHtml('Тренировок', groupNum(summary.workouts), '')}
        ${statTileHtml('Тоннаж', groupNum(summary.volume), 'кг')}
        ${statTileHtml('Средний баланс', signedKcal(summary.avgBalance), 'ккал')}
      </div>
      <ul class="list">
        <li class="list-item">
          <div class="list-item-main">
            <div class="list-item-title">Всего съедено</div>
            <div class="list-item-sub">сумма по дневнику питания</div>
          </div>
          <div class="tabnum">${groupNum(summary.eaten)} ккал</div>
        </li>
        <li class="list-item">
          <div class="list-item-main">
            <div class="list-item-title">Потрачено на тренировках</div>
            <div class="list-item-sub">оценка по MET и весу из профиля</div>
          </div>
          <div class="tabnum">${groupNum(summary.burned)} ккал</div>
        </li>
        <li class="list-item">
          <div class="list-item-main">
            <div class="list-item-title">Отклонение от нормы</div>
            <div class="list-item-sub">${escapeHtml(deviationNote(summary, targets))}</div>
          </div>
          <div class="tabnum">${escapeHtml(deviationValue(summary, targets))}</div>
        </li>
      </ul>
    </div>`;
}


/** Карточка с графиком: canvas или пустое состояние. */
function chartCardHtml({ id, title, hasData, emptyText, legend = '', note = '' }) {
  return `
    <div class="card">
      <div class="card-row">
        <h2 class="card-title">${escapeHtml(title)}</h2>
      </div>
      ${
        hasData
          ? `<div class="chart-box">
               <canvas class="chart-canvas" id="${escapeHtml(id)}" role="img"
                       aria-label="${escapeHtml(title)}"></canvas>
             </div>
             ${legend ? `<div class="chart-legend">${legend}</div>` : ''}`
          : `<div class="empty">${escapeHtml(emptyText)}</div>`
      }
      ${note ? `<p class="small muted">${note}</p>` : ''}
    </div>`;
}

function kcalCardHtml(targets, hasFood) {
  const legend = targets.valid
    ? `<span class="chart-key"><i class="chart-swatch"></i>съедено</span>
       <span class="chart-key"><i class="chart-swatch is-dashed"></i>норма ${groupNum(targets.kcal)} ккал</span>`
    : `<span class="chart-key"><i class="chart-swatch"></i>съедено</span>`;

  return chartCardHtml({
    id: 'chart-kcal',
    title: 'Калории по дням',
    hasData: hasFood,
    emptyText: 'За этот период в дневнике питания нет записей.',
    legend,
  });
}

function volumeCardHtml(summary, hasWorkouts) {
  return chartCardHtml({
    id: 'chart-volume',
    title: 'Тоннаж по дням',
    hasData: hasWorkouts,
    emptyText: 'За этот период тренировок нет.',
    note: 'Тоннаж — сумма «повторы × вес» по рабочим подходам, разминка не считается.',
  });
}

/** Карточка прогресса по выбранному упражнению. */
function exerciseCardHtml(history, selected, dates) {
  if (!history.length) {
    return `
      <div class="card">
        <div class="card-row">
          <h2 class="card-title">Упражнение</h2>
        </div>
        <div class="empty">Пока нечего показать: за этот период в тренировках нет подходов.</div>
        <button class="btn btn-secondary btn-block" type="button" data-goto="workouts">Открыть тренировки</button>
      </div>`;
  }

  const series = exerciseSeries(selected, dates);
  const options = history
    .map(
      (group) => `<option value="${escapeHtml(group.key)}"${
        group.key === selected.key ? ' selected' : ''
      }>${escapeHtml(group.name)}</option>`
    )
    .join('');

  const best = selected.best;
  const bestValue = best ? `${groupNum(best.weight)} кг` : 'без веса';
  const bestNote = best
    ? `${formatDateShort(best.date)} · ${best.reps} ${plural(best.reps, 'повтор', 'повтора', 'повторов')}`
    : 'вес в подходах не указан';

  return `
    <div class="card">
      <div class="card-row">
        <h2 class="card-title">Прогресс упражнения</h2>
        <span class="badge badge-muted">${selected.points.length} ${plural(
          selected.points.length,
          'тренировка',
          'тренировки',
          'тренировок'
        )}</span>
      </div>
      <div class="field">
        <label class="field-label" for="stats-exercise">Упражнение</label>
        <select id="stats-exercise">${options}</select>
      </div>
      <div class="chart-box">
        <canvas class="chart-canvas" id="chart-exercise" role="img"
                aria-label="График упражнения ${escapeHtml(selected.name)}"></canvas>
      </div>
      <p class="small muted">
        ${series.metric === 'weight' ? 'Максимальный рабочий вес за тренировку, кг.' : 'Тоннаж за тренировку, кг — вес в подходах не указан.'}
      </p>
      <ul class="list">
        <li class="list-item">
          <div class="list-item-main">
            <div class="list-item-title">Рекорд</div>
            <div class="list-item-sub">${escapeHtml(bestNote)}</div>
          </div>
          <div class="tabnum">${bestValue}</div>
        </li>
        <li class="list-item">
          <div class="list-item-main">
            <div class="list-item-title">Тоннаж за период</div>
            <div class="list-item-sub">${selected.sets} ${plural(selected.sets, 'рабочий подход', 'рабочих подхода', 'рабочих подходов')}</div>
          </div>
          <div class="tabnum">${groupNum(selected.volume)} кг</div>
        </li>
      </ul>
    </div>`;
}

/** Пояснение формулы расхода — чтобы цифрам можно было доверять. */
function formulaCardHtml(person) {
  const met = Number(person.metStrength) || 0;
  return `
    <div class="card">
      <h3 class="card-title">Как считается расход</h3>
      <p class="small">ккал = MET × вес тела (кг) × длительность (ч) × 1,05</p>
      <p class="small muted">
        MET силовой тренировки сейчас ${fmtNum(met, 1)} — меняется в профиле.
        Значение оценочное: реальный расход зависит от темпа, отдыха и организма.
      </p>
      <button class="btn btn-ghost btn-block" type="button" data-goto="profile">Открыть профиль</button>
    </div>`;
}


/* ------------------------------------------------------------------ */
/* Точка входа экрана                                                  */
/* ------------------------------------------------------------------ */

/** Первый кадр после вставки разметки: тогда у canvas уже есть размеры. */
function scheduleDraw() {
  const run = () => {
    if (typeof state.redraw === 'function') state.redraw();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  // Страховка для случаев, когда кадр пришёл до раскладки (или вкладка скрыта)
  setTimeout(run, 120);
}

export async function render(root, ctx) {
  const [meals, workouts, profile] = await Promise.all([
    db.getAll(STORES.meals),
    db.getAll(STORES.workouts),
    db.get(STORES.profile, PROFILE_ID),
  ]);

  const person = profile || {};
  const targets = calcTargets(person);

  const today = todayISO();
  const dates = daysRange(state.period, today);
  const days = buildDays(dates, meals, workouts, person);
  const todayRow = days[days.length - 1] || emptyDay(today);

  const summary = periodSummary(days, targets);
  const history = exerciseHistory(workouts, dates);
  const selected = history.find((group) => group.key === state.exerciseKey) || history[0] || null;
  state.exerciseKey = selected ? selected.key : null;

  const hasFood = days.some((day) => day.eaten > 0);
  const hasWorkouts = days.some((day) => day.workouts > 0);

  root.innerHTML = [
    todayCardHtml(todayRow, targets),
    periodCardHtml(dates.length, summary, targets),
    kcalCardHtml(targets, hasFood),
    volumeCardHtml(summary, hasWorkouts),
    exerciseCardHtml(history, selected, dates),
    formulaCardHtml(person),
  ].join('');

  wire(root);

  state.model = { dates, labels: dates.map(dayLabel), days, targets, summary, history, selected };
  state.redraw = () => drawCharts(root, state.model);
  wireResize();
  scheduleDraw();

  currentHandlers.click = async (event) => {
    const periodButton = event.target.closest('[data-period]');
    if (periodButton) {
      const next = Number(periodButton.dataset.period);
      if (PERIODS.includes(next) && next !== state.period) {
        state.period = next;
        await ctx.refresh();
      }
      return;
    }

    const gotoButton = event.target.closest('[data-goto]');
    if (gotoButton) {
      ctx.go(gotoButton.dataset.goto);
    }
  };

  currentHandlers.change = async (event) => {
    const select = event.target.closest('#stats-exercise');
    if (!select) return;
    state.exerciseKey = select.value;
    await ctx.refresh();
  };
}

