/**
 * app.js — точка входа приложения.
 *  1. Открывает IndexedDB и заполняет её стартовыми данными при первом запуске.
 *  2. Роутит нижние вкладки (hash-навигация: #/workouts, #/nutrition, ...).
 *  3. Регистрирует service worker для офлайн-режима.
 *
 * Контракт экранов: каждый модуль экспортирует
 *   export async function render(root, ctx)
 * где root — свой <section>, ctx — помощники (кнопки в шапке, перерисовка).
 */

import { openDB, seedDatabase, STORES, db } from './db.js';
import { escapeHtml, showToast } from './ui.js';
import { APP_VERSION } from './version.js';

import * as workoutsScreen from './workouts.js';
import * as nutritionScreen from './nutrition.js';
import * as foodsScreen from './foods.js';
import * as statsScreen from './stats.js';
import * as profileScreen from './profile.js';

/** Список экранов в порядке вкладок. */
const SCREENS = [
  { id: 'workouts', title: 'Тренировки', module: workoutsScreen },
  { id: 'nutrition', title: 'Питание', module: nutritionScreen },
  { id: 'foods', title: 'Продукты и блюда', module: foodsScreen },
  { id: 'stats', title: 'Итоги', module: statsScreen },
  { id: 'profile', title: 'Профиль', module: profileScreen },
];

const DEFAULT_SCREEN = SCREENS[0].id;

/** Версия сборки живёт в version.js — её же показывает экран «Профиль». */

const screensEl = document.getElementById('screens');
const titleEl = document.getElementById('screen-title');
const actionsEl = document.getElementById('screen-actions');
const tabbarEl = document.getElementById('tabbar');

let currentScreenId = null;
let renderToken = 0; // защита от гонок при быстром переключении вкладок

/* ------------------------------------------------------------------ */
/* Контекст, который получает экран                                    */
/* ------------------------------------------------------------------ */

const ctx = {
  /**
   * Кнопки в шапке экрана.
   *   ctx.actions('<button class="icon-btn">+</button>');
   */
  actions(html) {
    actionsEl.innerHTML = html || '';
    actionsEl.querySelectorAll('button').forEach((button) => button.setAttribute('type', 'button'));
    return actionsEl;
  },

  /** Перерисовать текущий экран (после сохранения/удаления данных). */
  refresh() {
    return showScreen(currentScreenId, { keepScroll: true });
  },

  /** Перейти на другую вкладку: ctx.go('nutrition'). */
  go(screenId) {
    if (location.hash === `#/${screenId}`) {
      showScreen(screenId);
    } else {
      location.hash = `#/${screenId}`;
    }
  },

  /** Всплывающее сообщение. */
  toast: showToast,
};

/* ------------------------------------------------------------------ */
/* Роутинг                                                             */
/* ------------------------------------------------------------------ */

/** Читает id экрана из хэша. Неизвестное значение -> экран по умолчанию. */
function getScreenIdFromHash() {
  const raw = location.hash.replace(/^#\/?/, '').trim();
  return SCREENS.some((screen) => screen.id === raw) ? raw : DEFAULT_SCREEN;
}

/** Подсвечивает активную вкладку в таббаре. */
function updateTabbar(screenId) {
  tabbarEl.querySelectorAll('.tab').forEach((tab) => {
    const isActive = tab.dataset.tab === screenId;
    tab.classList.toggle('is-active', isActive);
    if (isActive) {
      tab.setAttribute('aria-current', 'page');
    } else {
      tab.removeAttribute('aria-current');
    }
  });
}

/**
 * Показывает экран: переключает <section>, обновляет заголовок и вызывает render модуля.
 * @param {string} screenId
 * @param {{keepScroll?: boolean}} [options]
 */
async function showScreen(screenId, options = {}) {
  const screen = SCREENS.find((item) => item.id === screenId) || SCREENS[0];
  const token = ++renderToken;
  currentScreenId = screen.id;

  updateTabbar(screen.id);
  titleEl.textContent = screen.title;
  ctx.actions('');

  // Показываем только нужную секцию
  screensEl.querySelectorAll('.screen').forEach((section) => {
    section.hidden = section.id !== `screen-${screen.id}`;
  });

  if (!options.keepScroll) window.scrollTo(0, 0);

  const root = document.getElementById(`screen-${screen.id}`);
  root.innerHTML = '';

  try {
    await screen.module.render(root, ctx);
  } catch (error) {
    console.error(`[app] Ошибка на экране «${screen.title}»`, error);
    root.innerHTML = `
      <div class="card">
        <h2 class="card-title">Не удалось показать экран</h2>
        <p class="muted small">${escapeHtml(error && error.message ? error.message : String(error))}</p>
      </div>`;
  }

  // Если пользователь успел переключить вкладку — дальше ничего не делаем
  if (token !== renderToken) return;
}

/** Клик по таббару. */
tabbarEl.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  const screenId = tab.dataset.tab;

  if (screenId === currentScreenId) {
    // Повторный тап по активной вкладке — прокрутка наверх
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  location.hash = `#/${screenId}`;
});

window.addEventListener('hashchange', () => {
  showScreen(getScreenIdFromHash());
});

/* ------------------------------------------------------------------ */
/* Service worker                                                      */
/* ------------------------------------------------------------------ */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // SW работает только на https и на localhost.
  // По локальной сети на iPhone (http://192.168.x.x) браузер его не зарегистрирует.
  const isSecure = location.protocol === 'https:'
    || location.hostname === 'localhost'
    || location.hostname === '127.0.0.1';

  if (!isSecure) {
    console.info('[app] Service worker выключен: нужен https или localhost.');
    return;
  }

  const register = () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((registration) => {
        // Проверяем обновления при каждом запуске — важно для standalone-режима на iPhone
        registration.update().catch(() => {});
      })
      .catch((error) => console.warn('[app] Не удалось зарегистрировать service worker', error));
  };

  // main() ждёт открытия базы, поэтому к этому моменту событие load может уже пройти —
  // тогда подписка на него никогда не сработает. Регистрируем сразу, если документ готов.
  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }
}

/* ------------------------------------------------------------------ */
/* Версия сборки и обновление на телефоне                              */
/* ------------------------------------------------------------------ */

/**
 * Сообщает, что service worker обновился и взял управление.
 * На iPhone это единственный заметный сигнал, что пришла новая версия:
 * старые файлы уже заменены, но страница ещё в памяти.
 */
function watchServiceWorkerUpdates() {
  if (!('serviceWorker' in navigator)) return;

  // При самой первой установке контроллера ещё нет — это не обновление.
  const hadController = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    showToast('Пришло обновление — закройте и откройте приложение');
  });
}

/* ------------------------------------------------------------------ */
/* Запуск                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  try {
    await openDB();
    const seeded = await seedDatabase();
    if (seeded.seededProfile || seeded.addedProducts > 0) {
      console.info('[app] Стартовые данные', seeded);
    }

    // Диагностика: помогает убедиться, что база заполнена (см. консоль)
    const [exercises, products] = await Promise.all([
      db.count(STORES.exercises),
      db.count(STORES.products),
    ]);
    console.info(`[app] Версия сборки: ${APP_VERSION}`);
    console.info(`[app] В базе: упражнений — ${exercises}, продуктов — ${products}`);
  } catch (error) {
    console.error('[app] Ошибка инициализации базы данных', error);
    screensEl.innerHTML = `
      <div class="card">
        <h2 class="card-title">База данных недоступна</h2>
        <p class="small muted">${escapeHtml(error && error.message ? error.message : String(error))}</p>
        <p class="small muted">В приватном режиме Safari IndexedDB может быть заблокирована — откройте приложение в обычной вкладке.</p>
      </div>`;
    return;
  }

  // Если хэша нет — прописываем его, чтобы адрес всегда отражал текущую вкладку
  if (!location.hash) {
    history.replaceState(null, '', `#/${DEFAULT_SCREEN}`);
  }

  await showScreen(getScreenIdFromHash());
  registerServiceWorker();
  watchServiceWorkerUpdates();
}

main();
