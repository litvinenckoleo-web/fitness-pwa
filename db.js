/**
 * db.js — тонкая обёртка над IndexedDB.
 *
 * Хранилища (см. задание):
 *   exercises  { id, name, muscleGroup }                  — личный справочник, ведёт пользователь
 *   workouts   { id, date, durationMinutes, note, createdAt, updatedAt,
 *                exercises: [{ exerciseId, exerciseName, muscleGroup, sets: [{ reps, weight, isWarmup }] }] }
 *   products   { id, name, kcal, protein, fat, carbs, category }  — значения на 100 г
 *   dishes     { id, name, servings, finalWeightGrams, createdAt, updatedAt,
 *                ingredients: [{ productId, productName, kcal, protein, fat, carbs, grams }] }
 *   meals      { id, date, mealType, kind: 'product'|'dish', productId?/dishId?, name,
 *                unit: 'g'|'portion', amount, grams, portionGrams,
 *                per100: { kcal, protein, fat, carbs }, createdAt, updatedAt }
 *   profile    { id: 'main', weight, height, age, sex, activity, goal, metStrength,
 *                productsSeedVersion }
 *
 * В dishes ингредиент хранит копию названия и КБЖУ продукта — блюдо считается
 * даже после удаления продукта из справочника (как exerciseName в тренировках).
 * Такой же снимок КБЖУ (per100) хранит запись дневника питания: дневник не
 * зависит от того, что сейчас лежит в справочнике продуктов и блюд.
 *
 * Все id числовые (autoIncrement), кроме profile — там фиксированный ключ 'main'.
 */

import { DEFAULT_PRODUCTS, productKey } from './product-catalog.js';

export const DB_NAME = 'sila-kbzhu';
export const DB_VERSION = 1;
export const PROFILE_ID = 'main';

/**
 * Версия базового набора продуктов (см. product-catalog.js).
 * Увеличивайте, если добавляете в каталог новые позиции: при следующем запуске
 * приложение досыплет недостающие продукты и не тронет то, что уже есть.
 */
export const PRODUCTS_SEED_VERSION = 1;

/** Имена хранилищ — используем константы, чтобы не опечататься в строках. */
export const STORES = {
  exercises: 'exercises',
  workouts: 'workouts',
  products: 'products',
  dishes: 'dishes',
  meals: 'meals',
  profile: 'profile',
};

/** Группы мышц для справочника упражнений. */
export const MUSCLE_GROUPS = ['Грудь', 'Спина', 'Ноги', 'Плечи', 'Руки', 'Пресс', 'Другое'];

/** Типы приёмов пищи. */
export const MEAL_TYPES = [
  { id: 'breakfast', name: 'Завтрак' },
  { id: 'lunch', name: 'Обед' },
  { id: 'dinner', name: 'Ужин' },
  { id: 'snack', name: 'Перекус' },
];

let dbPromise = null;

/**
 * Открывает базу (один раз за жизнь страницы) и при необходимости создаёт хранилища.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    // Создание/обновление схемы
    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORES.exercises)) {
        const store = database.createObjectStore(STORES.exercises, { keyPath: 'id', autoIncrement: true });
        store.createIndex('byMuscleGroup', 'muscleGroup', { unique: false });
        store.createIndex('byName', 'name', { unique: false });
      }

      if (!database.objectStoreNames.contains(STORES.workouts)) {
        const store = database.createObjectStore(STORES.workouts, { keyPath: 'id', autoIncrement: true });
        store.createIndex('byDate', 'date', { unique: false });
      }

      if (!database.objectStoreNames.contains(STORES.products)) {
        const store = database.createObjectStore(STORES.products, { keyPath: 'id', autoIncrement: true });
        store.createIndex('byName', 'name', { unique: false });
      }

      if (!database.objectStoreNames.contains(STORES.dishes)) {
        const store = database.createObjectStore(STORES.dishes, { keyPath: 'id', autoIncrement: true });
        store.createIndex('byName', 'name', { unique: false });
      }

      if (!database.objectStoreNames.contains(STORES.meals)) {
        const store = database.createObjectStore(STORES.meals, { keyPath: 'id', autoIncrement: true });
        store.createIndex('byDate', 'date', { unique: false });
      }

      if (!database.objectStoreNames.contains(STORES.profile)) {
        // Профиль один: ключ задаём сами ('main'), автоинкремент не нужен
        database.createObjectStore(STORES.profile, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      // Если другая вкладка решит обновить базу, не блокируем её
      database.onversionchange = () => database.close();
      resolve(database);
    };

    request.onerror = () => reject(request.error || new Error('Не удалось открыть IndexedDB'));
    request.onblocked = () => console.warn('[db] Обновление схемы заблокировано другой вкладкой');
  });

  return dbPromise;
}

/* ------------------------------------------------------------------ */
/* Внутренние помощники                                                */
/* ------------------------------------------------------------------ */

/** Превращает IDBRequest в Promise. */
function reqAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Ждём завершения транзакции (фиксацию изменений). */
function txDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('Транзакция отменена'));
    transaction.onerror = () => reject(transaction.error || new Error('Ошибка транзакции'));
  });
}
/**
 * Универсальный прогон операции в хранилище.
 * @param {string} storeName имя хранилища
 * @param {'readonly'|'readwrite'} mode режим транзакции
 * @param {(store: IDBObjectStore) => Promise<any>} fn операция над store
 */
async function withStore(storeName, mode, fn) {
  const database = await openDB();
  const transaction = database.transaction(storeName, mode);
  const done = txDone(transaction); // подписываемся заранее, до первого await
  const result = await fn(transaction.objectStore(storeName));
  await done;
  return result;
}



/* ------------------------------------------------------------------ */
/* Публичный API                                                       */
/* ------------------------------------------------------------------ */

export const db = {
  /** Все записи хранилища. */
  getAll(storeName) {
    return withStore(storeName, 'readonly', (store) => reqAsPromise(store.getAll()));
  },

  /** Одна запись по ключу (или undefined). */
  get(storeName, key) {
    return withStore(storeName, 'readonly', (store) => reqAsPromise(store.get(key)));
  },

  /** Добавить запись, вернёт новый id. */
  add(storeName, value) {
    return withStore(storeName, 'readwrite', (store) => reqAsPromise(store.add(value)));
  },

  /** Добавить/перезаписать запись по ключу, вернёт ключ. */
  put(storeName, value) {
    return withStore(storeName, 'readwrite', (store) => reqAsPromise(store.put(value)));
  },

  /** Пакетное добавление (одна транзакция). Возвращает массив ключей. */
  addMany(storeName, values) {
    return withStore(storeName, 'readwrite', (store) =>
      Promise.all(values.map((value) => reqAsPromise(store.add(value))))
    );
  },

  /** Удалить запись по ключу. */
  remove(storeName, key) {
    return withStore(storeName, 'readwrite', (store) => reqAsPromise(store.delete(key)));
  },

  /** Очистить хранилище. */
  clear(storeName) {
    return withStore(storeName, 'readwrite', (store) => reqAsPromise(store.clear()));
  },

  /** Количество записей. */
  count(storeName) {
    return withStore(storeName, 'readonly', (store) => reqAsPromise(store.count()));
  },

  /** Все записи по значению индекса (например, все тренировки за дату). */
  getAllByIndex(storeName, indexName, value) {
    return withStore(storeName, 'readonly', (store) =>
      reqAsPromise(store.index(indexName).getAll(value))
    );
  },

  /**
   * Записи, у которых значение индекса попадает в диапазон [lower, upper].
   * Для дат используем строки 'YYYY-MM-DD' — они сортируются лексикографически.
   */
  getRange(storeName, indexName, lower, upper) {
    return withStore(storeName, 'readonly', (store) => {
      const range = IDBKeyRange.bound(lower, upper);
      return reqAsPromise(store.index(indexName).getAll(range));
    });
  },

  /** Полная очистка всех хранилищ (используется при импорте данных). */
  async clearAll() {
    for (const storeName of Object.values(STORES)) {
      await db.clear(storeName);
    }
  },
};

/* ------------------------------------------------------------------ */
/* Стартовые данные                                                    */
/* ------------------------------------------------------------------ */

/**
 * Справочник упражнений НЕ заполняется автоматически: пользователь добавляет
 * только те упражнения, которые делает сам (экран «Тренировки» -> справочник).
 */

/**
 * Базовый набор продуктов живёт в product-catalog.js (около 300 позиций).
 * Здесь только логика: что досыпать и как не наплодить дублей.
 */

/** Профиль по умолчанию: нейтральные значения, пользователь поправит сам. */
export function defaultProfile() {
  return {
    id: PROFILE_ID,
    weight: 70,          // кг
    height: 175,         // см
    age: 30,             // лет
    sex: 'male',         // 'male' | 'female'
    activity: 'moderate', // см. ACTIVITY_LEVELS в profile.js
    goal: 'maintain',    // 'cut' | 'maintain' | 'gain'
    metStrength: 5.0,    // MET силовой тренировки
  };
}

/**
 * Досыпает в справочник недостающие продукты из базового набора.
 * Дубликатов не будет: сравнение по названию (регистр, ё/е и лишние пробелы
 * не важны). Уже существующие продукты не перезаписываются — у них
 * заполняется только пустая категория, чтобы работал фильтр по группам.
 * Можно вызывать вручную из экрана «Продукты».
 * @returns {Promise<{added: number, patched: number}>}
 */
export async function syncDefaultProducts() {
  const products = await db.getAll(STORES.products);
  const existing = new Map(products.map((product) => [productKey(product.name), product]));

  const toAdd = [];
  const toPatch = [];

  DEFAULT_PRODUCTS.forEach((item) => {
    const found = existing.get(productKey(item.name));
    if (!found) {
      toAdd.push({ ...item, isDefault: true });
      return;
    }
    if (!found.category) toPatch.push({ ...found, category: item.category });
  });

  if (toAdd.length) await db.addMany(STORES.products, toAdd);
  for (const item of toPatch) {
    await db.put(STORES.products, item);
  }

  return { added: toAdd.length, patched: toPatch.length };
}

/**
 * Заполняет базу стартовыми данными.
 * Существующие данные не трогает, поэтому вызывать можно при каждом старте.
 *  - продукты: базовый набор (около 300 позиций) подставляется один раз,
 *    удалённые пользователем продукты повторно не возвращаются;
 *  - справочник упражнений не заполняется вовсе — его ведёт пользователь.
 * @returns {Promise<{seededProducts: boolean, seededProfile: boolean, addedProducts: number}>}
 */
export async function seedDatabase() {
  const result = { seededProducts: false, seededProfile: false, addedProducts: 0 };

  let profile = await db.get(STORES.profile, PROFILE_ID);
  if (!profile) {
    profile = defaultProfile();
    await db.put(STORES.profile, profile);
    result.seededProfile = true;
  }

  const catalogOutdated = (Number(profile.productsSeedVersion) || 0) < PRODUCTS_SEED_VERSION;
  if (catalogOutdated) {
    const { added } = await syncDefaultProducts();
    result.addedProducts = added;
    result.seededProducts = added > 0;
    profile.productsSeedVersion = PRODUCTS_SEED_VERSION;
    await db.put(STORES.profile, profile);
  }

  return result;
}

