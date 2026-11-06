/**
 * ui.js — небольшие общие утилиты интерфейса:
 * тосты, модальные шторки, форматирование чисел и дат.
 * Подключается всеми экранами, чтобы не дублировать код.
 */

/* ------------------------------ числа ------------------------------ */

/**
 * Число -> строка с запятой как десятичным разделителем.
 * fmtNum(61.25, 1) => '61,3'
 * @param {number} value
 * @param {number} [digits=0] сколько знаков после запятой
 */
export function fmtNum(value, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toFixed(digits).replace('.', ',');
}

/**
 * Строка с запятой или точкой -> число.
 * parseNum('61,5') => 61.5 ; parseNum('') => 0
 * @param {string|number} value
 */
export function parseNum(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  // Заменяем запятую на точку и выкидываем всё, кроме цифр, точки и минуса
  const cleaned = String(value).replace(/\s+/g, '').replace(',', '.').replace(/[^0-9.\-]/g, '');
  const number = parseFloat(cleaned);
  return Number.isFinite(number) ? number : 0;
}

/** Округление до заданного числа знаков (для КБЖУ). */
export function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

/* ------------------------------- даты ------------------------------- */

/** Date -> 'YYYY-MM-DD' по локальному времени (без сдвига часового пояса). */
export function toISODate(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Сегодняшняя дата в формате 'YYYY-MM-DD'. */
export function todayISO() {
  return toISODate(new Date());
}

/** 'YYYY-MM-DD' -> Date (локальная полночь). */
export function fromISODate(iso) {
  const [year, month, day] = String(iso).split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

/** Сдвиг даты на n дней: addDaysISO('2026-11-06', -1) => '2026-11-05'. */
export function addDaysISO(iso, days) {
  const date = fromISODate(iso);
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** '2026-11-06' -> '6 ноя 2026'. */
export function formatDateRu(iso) {
  if (!iso) return '';
  const date = fromISODate(iso);
  return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
}

/** '2026-11-06' -> '6 ноя, чт'. */
export function formatDateShort(iso) {
  if (!iso) return '';
  const date = fromISODate(iso);
  return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}, ${WEEKDAYS_SHORT[date.getDay()]}`;
}

/** Название дня недели: '2026-11-06' -> 'четверг'. */
export function weekdayRu(iso) {
  const names = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  return names[fromISODate(iso).getDay()];
}

/* ------------------------------ разное ------------------------------ */

/** Экранирование HTML перед вставкой через innerHTML. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Короткий обработчик: создаёт элемент с классом и HTML.
 * el('div', 'card', '<p>Привет</p>')
 */
export function el(tag, className = '', html = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html) node.innerHTML = html;
  return node;
}

/**
 * Четыре «плитки» КБЖУ: ккал / белки / жиры / углеводы.
 * Одинаково выглядят в карточке продукта, в блюде и в дневнике питания.
 * @param {{kcal?: number, protein?: number, fat?: number, carbs?: number}} values
 */
export function macroGridHtml({ kcal, protein, fat, carbs } = {}) {
  return `
    <div class="macro-grid">
      <div class="macro-cell"><b>${fmtNum(kcal)}</b><span>ккал</span></div>
      <div class="macro-cell"><b>${fmtNum(protein, 1)}</b><span>белки</span></div>
      <div class="macro-cell"><b>${fmtNum(fat, 1)}</b><span>жиры</span></div>
      <div class="macro-cell"><b>${fmtNum(carbs, 1)}</b><span>углеводы</span></div>
    </div>`;
}

/* ------------------------------ тосты ------------------------------ */

let toastTimer = null;

/** Показывает короткое всплывающее сообщение внизу экрана. */
export function showToast(message, duration = 2200) {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = el('div', 'toast');
    toast.id = 'app-toast';
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, duration);
}

/* --------------------------- модальные окна -------------------------- */

let activeModal = null;

/**
 * Открывает модальную «шторку» снизу.
 * @param {{title?: string, content?: string|Node, onClose?: Function}} options
 * @returns {{root: HTMLElement, close: Function}}
 */
export function openModal(options = {}) {
  closeModal();

  const overlay = el('div', 'modal-overlay');
  overlay.innerHTML = `
    <div class="modal-sheet" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2 class="modal-title"></h2>
        <button class="modal-close" type="button" aria-label="Закрыть">✕</button>
      </div>
      <div class="modal-body"></div>
    </div>`;

  overlay.querySelector('.modal-title').textContent = options.title || '';
  const body = overlay.querySelector('.modal-body');

  if (typeof options.content === 'string') {
    body.innerHTML = options.content;
  } else if (options.content instanceof Node) {
    body.appendChild(options.content);
  }

  overlay.querySelector('.modal-close').addEventListener('click', () => closeModal());
  overlay.addEventListener('click', (event) => {
    // Клик по затемнённому фону закрывает окно
    if (event.target === overlay) closeModal();
  });

  document.body.appendChild(overlay);
  document.body.classList.add('modal-open');
  activeModal = { overlay, onClose: options.onClose || null };

  return { root: body, close: closeModal };
}

/** Закрывает текущее модальное окно, если оно открыто. */
export function closeModal() {
  if (!activeModal) return;
  const { overlay, onClose } = activeModal;
  activeModal = null;
  overlay.remove();
  document.body.classList.remove('modal-open');
  if (typeof onClose === 'function') onClose();
}

/**
 * Простое подтверждение действия.
 * @returns {Promise<boolean>} true — пользователь подтвердил
 */
export function confirmDialog(message, { title = 'Подтверждение', confirmText = 'Удалить' } = {}) {
  return new Promise((resolve) => {
    const content = el('div', '');
    content.innerHTML = `
      <p>${escapeHtml(message)}</p>
      <div class="row">
        <button class="btn btn-secondary btn-block" type="button" data-action="cancel">Отмена</button>
        <button class="btn btn-danger btn-block" type="button" data-action="ok">${escapeHtml(confirmText)}</button>
      </div>`;

    const modal = openModal({ title, content, onClose: () => resolve(false) });

    content.querySelector('[data-action="cancel"]').addEventListener('click', () => {
      resolve(false);
      modal.close();
    });
    content.querySelector('[data-action="ok"]').addEventListener('click', () => {
      // Сначала закрываем без onClose-резолва, чтобы не перезаписать true
      activeModal.onClose = null;
      resolve(true);
      modal.close();
    });
  });
}

/** Escape закрывает открытое окно — удобно при работе с клавиатуры. */
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && activeModal) closeModal();
});
