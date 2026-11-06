/**
 * targets.js — норма калорий и БЖУ (одно место для всех экранов).
 *
 * Формула: Миффлина — Сан Жеора (базовый обмен, BMR),
 * затем умножаем на коэффициент активности и на поправку под цель.
 * Белки и жиры считаются от веса тела, углеводы — остаток калорий.
 *
 * Используется экраном «Питание» (прогресс за день) и экраном «Профиль».
 */

/** Уровни активности: коэффициент к BMR. */
export const ACTIVITY_LEVELS = [
  { id: 'sedentary', name: 'Сидячий образ жизни', factor: 1.2, hint: 'офис, без тренировок' },
  { id: 'light', name: 'Небольшая активность', factor: 1.375, hint: '1–3 тренировки в неделю' },
  { id: 'moderate', name: 'Средняя активность', factor: 1.55, hint: '3–5 тренировок в неделю' },
  { id: 'high', name: 'Высокая активность', factor: 1.725, hint: '6–7 тренировок в неделю' },
  { id: 'veryHigh', name: 'Очень высокая', factor: 1.9, hint: 'физическая работа + тренировки' },
];

/** Цели: поправка калорий и граммы белка/жира на килограмм веса. */
export const GOALS = [
  { id: 'cut', name: 'Похудение', kcalFactor: 0.8, proteinPerKg: 1.8, fatPerKg: 0.9 },
  { id: 'maintain', name: 'Поддержание веса', kcalFactor: 1, proteinPerKg: 1.6, fatPerKg: 1 },
  { id: 'gain', name: 'Набор массы', kcalFactor: 1.12, proteinPerKg: 1.8, fatPerKg: 1 },
];

/** Пол активность/цель по id — с запасным вариантом, если в профиле мусор. */
export function getActivity(id) {
  return ACTIVITY_LEVELS.find((level) => level.id === id) || ACTIVITY_LEVELS[2];
}

export function getGoal(id) {
  return GOALS.find((goal) => goal.id === id) || GOALS[1];
}

/**
 * Базовый обмен веществ по формуле Миффлина — Сан Жеора, ккал/сутки.
 * Возвращает 0, если данных не хватает (тогда норму не считаем).
 */
export function calcBmr({ weight, height, age, sex } = {}) {
  const w = Number(weight);
  const h = Number(height);
  const a = Number(age);
  if (!(w > 0) || !(h > 0) || !(a > 0)) return 0;

  const base = 10 * w + 6.25 * h - 5 * a;
  return sex === 'female' ? base - 161 : base + 5;
}

/**
 * Нормы за день.
 * @param {object} profile запись профиля из IndexedDB
 * @returns {{valid: boolean, bmr: number, tdee: number, kcal: number,
 *            protein: number, fat: number, carbs: number,
 *            activity: object, goal: object}}
 */
export function calcTargets(profile = {}) {
  const activity = getActivity(profile.activity);
  const goal = getGoal(profile.goal);
  const bmr = calcBmr(profile);

  if (!bmr) {
    return {
      valid: false,
      bmr: 0,
      tdee: 0,
      kcal: 0,
      protein: 0,
      fat: 0,
      carbs: 0,
      activity,
      goal,
    };
  }

  const tdee = bmr * activity.factor;
  const kcal = Math.round((tdee * goal.kcalFactor) / 10) * 10;

  const weight = Number(profile.weight) || 0;
  const protein = Math.round(weight * goal.proteinPerKg);
  const fat = Math.round(weight * goal.fatPerKg);
  // Углеводы — всё, что осталось от калорий после белков (4 ккал/г) и жиров (9 ккал/г)
  const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));

  return {
    valid: true,
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    kcal,
    protein,
    fat,
    carbs,
    activity,
    goal,
  };
}

/**
 * Расход калорий на силовую тренировку: MET × вес (кг) × время (ч) × 1,05.
 * Та же цифра показывается в профиле как «расход за час» (minutes = 60),
 * а экран «Итоги» считает по ней расход каждой тренировки за день.
 * @param {{met?: number|string, weight?: number|string, minutes?: number|string}} input
 * @returns {number} ккал (0, если данных не хватает)
 */
export function calcWorkoutKcal({ met, weight, minutes } = {}) {
  const metValue = Number(met) || 0;
  const weightValue = Number(weight) || 0;
  const minutesValue = Number(minutes) || 0;
  if (!(metValue > 0) || !(weightValue > 0) || !(minutesValue > 0)) return 0;
  return Math.round(metValue * weightValue * (minutesValue / 60) * 1.05);
}
