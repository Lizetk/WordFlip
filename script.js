(function () {
  "use strict";

  const KEYS = {
    words: "wordflip.words.v1",
    settings: "wordflip.settings.v1",
    meta: "wordflip.meta.v1",
    sync: "wordflip.sync.v1",
    schedule: "wordflip.schedule.v1"
  };

  const GIST_FILE = "wordflip-data.json";
  const GIST_DESCRIPTION = "WordFlip — flashcards data";
  const FUZZY_THRESHOLD = 0.7;
  const GIST_API = "https://api.github.com";

  const SCHEDULE_INTERVALS = [0, 1, 2, 4, 7, 14, 30, 60, 180];
  const SCHEDULE_MAX_STEP = SCHEDULE_INTERVALS.length - 1;
  const SCHEDULE_DAILY_LIMIT = 300;
  const SPEECH_RATE = 0.9;
  const PUTER_TTS_VOICE = "Joanna";
  const PUTER_TTS_ENGINE = "neural";
  const PUTER_TTS_LANGUAGE = "en-US";
  const PUTER_TTS_TIMEOUT = 12000;
  // Окно входа в Puter закрывает пользователь, поэтому ему даём больше времени,
  // но не ждём вечно: иначе кнопка озвучки навсегда остаётся в «загрузке».
  const PUTER_AUTH_TIMEOUT = 60000;

  const DEMO_WORDS = [
    { english: "dream", russian: "мечта" },
    { english: "courage", russian: "смелость" }
  ];

  const state = {
    words: [],
    mode: "en",
    theme: "auto",
    query: "",
    view: "cards",
    flipped: new Set(),
    review: {
      started: false,
      queue: [],
      learned: new Set(),
      firstTry: new Set(),
      attempted: new Set(),
      flipped: false,
      summary: null,
      summarySaved: false
    },
    schedule: {
      words: [],
      daily: null,
      updatedAt: 0,
      flipped: false,
      manageOpen: false,
      search: "",
      listLimit: 100
    },
    pendingImport: [],
    importStep: 1,
    sync: {
      token: "",
      gistId: "",
      enabled: false,
      lastSync: 0
    },
    updatedAt: 0,
    syncBusy: false,
    syncState: "off",
    pendingPush: false
  };

  let els = {};
  let pushTimer = null;
  let schedulePushTimer = null;
  let lastScheduleDay = "";

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    cacheElements();
    loadState();
    bindSpeechVoices();
    primePuterAuth();
    lastScheduleDay = todayKey();
    ensureDailyPlan();
    bindEvents();
    applyTheme();
    renderMode();
    renderViews();
    updateDetection();
    render();
    updateSyncStatus();

    if (state.sync.enabled && hasSyncCredentials()) {
      window.setTimeout(autoSync, 700);
    }

    window.setInterval(checkScheduleDay, 60000);
  }

  /* ==========================================================
     Storage
     ========================================================== */

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      console.warn("localStorage недоступен:", error);
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      console.warn("Не удалось сохранить данные:", error);
      toast("Не удалось сохранить данные в браузере", "error");
      return false;
    }
  }

  function loadState() {
    const rawWords = storageGet(KEYS.words);
    const rawSettings = storageGet(KEYS.settings);
    const rawMeta = storageGet(KEYS.meta);
    const rawSync = storageGet(KEYS.sync);
    const rawSchedule = storageGet(KEYS.schedule);

    if (rawWords === null) {
      state.words = normalizeWordList(
        DEMO_WORDS.map(function (word) {
          return { id: uid(), english: word.english, russian: word.russian };
        })
      );
      state.updatedAt = Date.now();
      persistWords();
      saveMeta();
    } else {
      try {
        state.words = normalizeWordList(JSON.parse(rawWords));
      } catch (error) {
        console.warn("Повреждённые данные слов:", error);
        state.words = [];
        toast("Сохранённые слова повреждены — список очищен", "error");
      }
    }

    if (rawSettings) {
      try {
        const settings = JSON.parse(rawSettings);
        if (settings.mode === "en" || settings.mode === "ru") {
          state.mode = settings.mode;
        }
        if (settings.theme === "auto" || settings.theme === "light" || settings.theme === "dark") {
          state.theme = settings.theme;
        }
      } catch (error) {
        console.warn("Повреждённые настройки:", error);
      }
    }

    if (rawMeta) {
      try {
        const meta = JSON.parse(rawMeta);
        state.updatedAt = Number(meta.updatedAt) || 0;
      } catch (error) {
        console.warn("Повреждённые метаданные:", error);
      }
    }

    if (!state.updatedAt) {
      state.updatedAt = Date.now();
      saveMeta();
    }

    if (rawSync) {
      try {
        const sync = JSON.parse(rawSync);
        state.sync.token = typeof sync.token === "string" ? sync.token : "";
        state.sync.gistId = typeof sync.gistId === "string" ? sync.gistId : "";
        state.sync.enabled = Boolean(sync.enabled);
        state.sync.lastSync = Number(sync.lastSync) || 0;
      } catch (error) {
        console.warn("Повреждённые настройки синхронизации:", error);
      }
    }

    loadScheduleState(rawSchedule);
  }

  function persistWords() {
    storageSet(KEYS.words, JSON.stringify(state.words));
  }

  function saveMeta() {
    storageSet(KEYS.meta, JSON.stringify({ updatedAt: state.updatedAt }));
  }

  function saveSettings() {
    storageSet(
      KEYS.settings,
      JSON.stringify({ mode: state.mode, theme: state.theme })
    );
  }

  function saveSyncSettings() {
    storageSet(KEYS.sync, JSON.stringify(state.sync));
  }

  function saveWords(options) {
    const opts = options || {};
    state.updatedAt = Date.now();
    persistWords();
    saveMeta();
    if (opts.push !== false) {
      schedulePush();
    }
  }

  /* ==========================================================
     Models and text helpers
     ========================================================== */

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "w_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
  }

  function cleanText(value) {
    return String(value == null ? "" : value)
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalize(value) {
    return String(value == null ? "" : value)
      .toLowerCase()
      .normalize("NFKC")
      .replace(/ё/g, "е")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function pairKey(english, russian) {
    return normalize(english) + "\u0000" + normalize(russian);
  }

  function toWord(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const english = cleanText(raw.english != null ? raw.english : raw.word != null ? raw.word : raw.en);
    const russian = cleanText(raw.russian != null ? raw.russian : raw.translation != null ? raw.translation : raw.ru);
    if (!english || !russian) {
      return null;
    }
    return {
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : uid(),
      english: english,
      russian: russian
    };
  }

  function normalizeWordList(input) {
    if (!Array.isArray(input)) {
      return [];
    }
    const seenPairs = new Set();
    const seenIds = new Set();
    const result = [];

    input.forEach(function (raw) {
      const word = toWord(raw);
      if (!word) {
        return;
      }
      const key = pairKey(word.english, word.russian);
      if (seenPairs.has(key)) {
        return;
      }
      seenPairs.add(key);
      if (seenIds.has(word.id)) {
        word.id = uid();
      }
      seenIds.add(word.id);
      result.push(word);
    });

    return result;
  }

  function detectInfo(text) {
    const cyrillic = (String(text).match(/[а-яё]/gi) || []).length;
    const latin = (String(text).match(/[a-z]/gi) || []).length;
    let lang = null;
    if (cyrillic > 0 || latin > 0) {
      lang = cyrillic >= latin ? "ru" : "en";
    }
    return { cyrillic: cyrillic, latin: latin, lang: lang };
  }

  function hasCyrillic(text) {
    return /[а-яё]/i.test(String(text));
  }

  function hasLatin(text) {
    return /[a-z]/i.test(String(text));
  }

  function pairExists(english, russian) {
    const key = pairKey(english, russian);
    return state.words.some(function (word) {
      return pairKey(word.english, word.russian) === key;
    });
  }

  function sourceExists(word, lang) {
    const needle = normalize(word);
    return state.words.some(function (item) {
      return normalize(lang === "en" ? item.english : item.russian) === needle;
    });
  }

  function plural(count, one, few, many) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) {
      return one;
    }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
      return few;
    }
    return many;
  }

  function wordPlural(count) {
    return plural(count, "слово", "слова", "слов");
  }

  /* ==========================================================
     Spaced repetition schedule
     ========================================================== */

  function dateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function todayKey() {
    return dateKey(new Date());
  }

  function parseDateKey(key) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
    if (!match) {
      return null;
    }
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  function addDaysToKey(key, days) {
    const date = parseDateKey(key) || new Date();
    date.setDate(date.getDate() + days);
    return dateKey(date);
  }

  function formatDay(key) {
    const date = parseDateKey(key);
    if (!date) {
      return String(key || "");
    }
    return date.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long"
    });
  }

  // Повторы ищутся по точному совпадению фразы (без игнорирования пробелов).
  function scheduleKey(english, russian) {
    return (
      cleanText(english).toLocaleLowerCase("ru") +
      "\u0000" +
      cleanText(russian).toLocaleLowerCase("ru")
    );
  }

  function normalizeScheduleWord(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const english = cleanText(
      raw.english != null ? raw.english : raw.word != null ? raw.word : raw.en
    );
    const russian = cleanText(
      raw.russian != null
        ? raw.russian
        : raw.translation != null
          ? raw.translation
          : raw.ru
    );
    if (!english || !russian) {
      return null;
    }

    let step = Math.round(Number(raw.step));
    if (!Number.isFinite(step)) {
      step = 0;
    }
    step = Math.max(0, Math.min(SCHEDULE_MAX_STEP, step));

    let interval = Math.floor(Number(raw.interval));
    if (!Number.isFinite(interval) || interval < 0) {
      interval = SCHEDULE_INTERVALS[step];
    }

    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.dueDate || ""))
      ? raw.dueDate
      : todayKey();
    const addedAt =
      Number(raw.addedAt) || Number(raw.createdAt) || Date.now();
    const updatedAt = Number(raw.updatedAt) || addedAt;

    return {
      id:
        typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : uid(),
      english: english,
      russian: russian,
      addedAt: addedAt,
      updatedAt: updatedAt,
      step: step,
      interval: interval,
      dueDate: dueDate,
      lastReviewedOn:
        typeof raw.lastReviewedOn === "string" ? raw.lastReviewedOn : "",
      lastResult:
        raw.lastResult === "known" || raw.lastResult === "forgot"
          ? raw.lastResult
          : ""
    };
  }

  function normalizeScheduleWords(input) {
    const map = new Map();

    (Array.isArray(input) ? input : []).forEach(function (raw) {
      const word = normalizeScheduleWord(raw);
      if (!word) {
        return;
      }
      const key = scheduleKey(word.english, word.russian);
      const existing = map.get(key);
      if (!existing) {
        map.set(key, word);
        return;
      }
      // При повторе оставляем более старое слово.
      if (word.addedAt < existing.addedAt) {
        map.set(key, word);
      }
    });

    return Array.from(map.values());
  }

  function createScheduleWord(english, russian, options) {
    const opts = options || {};
    const now = Date.now();

    return {
      id: uid(),
      english: cleanText(english),
      russian: cleanText(russian),
      addedAt: Number(opts.addedAt) || now,
      updatedAt: now,
      step: 0,
      interval: SCHEDULE_INTERVALS[0],
      dueDate: opts.dueDate || todayKey(),
      lastReviewedOn: "",
      lastResult: ""
    };
  }

  function normalizeDaily(raw) {
    if (!raw || typeof raw.date !== "string") {
      return null;
    }
    return {
      date: raw.date,
      queue: Array.isArray(raw.queue)
        ? raw.queue.filter(function (id) {
            return typeof id === "string";
          })
        : [],
      completed: Array.isArray(raw.completed)
        ? raw.completed.filter(function (id) {
            return typeof id === "string";
          })
        : []
    };
  }

  function loadScheduleState(raw) {
    if (raw === null) {
      state.schedule.words = [];
      state.schedule.daily = null;
      state.schedule.updatedAt = Date.now();
      addWordsToSchedule(state.words, { save: false });
      persistSchedule();
      return;
    }

    try {
      const data = JSON.parse(raw);
      state.schedule.words = normalizeScheduleWords(
        Array.isArray(data) ? data : data && Array.isArray(data.words) ? data.words : []
      );
      state.schedule.updatedAt =
        Number(data && data.updatedAt) || Date.now();
      state.schedule.daily = normalizeDaily(data && data.daily);
    } catch (error) {
      console.warn("Повреждённое расписание:", error);
      state.schedule.words = [];
      state.schedule.daily = null;
      state.schedule.updatedAt = Date.now();
    }
  }

  function persistSchedule() {
    storageSet(
      KEYS.schedule,
      JSON.stringify({
        version: 1,
        updatedAt: state.schedule.updatedAt,
        words: state.schedule.words,
        daily: state.schedule.daily
      })
    );
  }

  function saveSchedule(options) {
    const opts = options || {};
    state.schedule.updatedAt = Date.now();
    persistSchedule();

    if (opts.sync === false) {
      return;
    }
    markScheduleChanged();
  }

  function markScheduleChanged() {
    if (!state.sync.enabled || !hasSyncCredentials()) {
      return;
    }
    state.updatedAt = Date.now();
    saveMeta();
    queueSchedulePush();
  }

  function queueSchedulePush() {
    if (!state.sync.enabled || !hasSyncCredentials()) {
      return;
    }
    if (schedulePushTimer) {
      window.clearTimeout(schedulePushTimer);
    }
    // Серию быстрых ответов склеиваем в один запрос, как и для слов:
    // изменения уходят в gist примерно через 1,6 секунды (README).
    const wait = 1600;
    schedulePushTimer = window.setTimeout(function () {
      schedulePushTimer = null;
      syncPush(true);
    }, wait);
  }

  function addWordsToSchedule(words, options) {
    const opts = options || {};
    const existing = new Set(
      state.schedule.words.map(function (word) {
        return scheduleKey(word.english, word.russian);
      })
    );
    const baseTime = Date.now();
    let added = 0;

    (Array.isArray(words) ? words : []).forEach(function (word, index) {
      const english = cleanText(word && word.english);
      const russian = cleanText(word && word.russian);
      if (!english || !russian) {
        return;
      }

      const key = scheduleKey(english, russian);
      if (existing.has(key)) {
        return;
      }
      existing.add(key);

      const scheduled = createScheduleWord(english, russian, {
        addedAt: baseTime + index
      });
      state.schedule.words.push(scheduled);

      const daily = state.schedule.daily;
      if (
        daily &&
        daily.date === todayKey() &&
        daily.queue.length + daily.completed.length < SCHEDULE_DAILY_LIMIT
      ) {
        daily.queue.push(scheduled.id);
      }
      added += 1;
    });

    if (added && opts.save !== false) {
      saveSchedule();
    }
    return added;
  }

  function mergeScheduleWords(incoming) {
    if (!Array.isArray(incoming) || !incoming.length) {
      return 0;
    }

    const map = new Map();
    state.schedule.words.forEach(function (word) {
      map.set(scheduleKey(word.english, word.russian), word);
    });

    let changed = 0;
    incoming.forEach(function (raw) {
      const word = normalizeScheduleWord(raw);
      if (!word) {
        return;
      }

      const key = scheduleKey(word.english, word.russian);
      const existing = map.get(key);
      if (!existing) {
        map.set(key, word);
        changed += 1;
        return;
      }

      // Идентичность и дату добавления берём у более старого слова,
      // а прогресс — у более свежей записи.
      if (word.addedAt < existing.addedAt) {
        existing.english = word.english;
        existing.russian = word.russian;
        existing.addedAt = word.addedAt;
      }
      if ((word.updatedAt || 0) > (existing.updatedAt || 0)) {
        existing.step = word.step;
        existing.interval = word.interval;
        existing.dueDate = word.dueDate;
        existing.lastReviewedOn = word.lastReviewedOn;
        existing.lastResult = word.lastResult;
        existing.updatedAt = word.updatedAt;
        changed += 1;
      }
    });

    if (changed) {
      state.schedule.words = Array.from(map.values());
    }
    return changed;
  }

  function findScheduleWord(id) {
    return state.schedule.words.find(function (word) {
      return word.id === id;
    });
  }

  function compareScheduleDue(left, right) {
    if (left.dueDate !== right.dueDate) {
      return left.dueDate < right.dueDate ? -1 : 1;
    }
    if (left.addedAt !== right.addedAt) {
      return left.addedAt - right.addedAt;
    }
    return left.english.localeCompare(right.english, "ru", {
      sensitivity: "base"
    });
  }

  function distributeOverflow(overflow, today) {
    const loads = new Map();
    state.schedule.words.forEach(function (word) {
      if (word.dueDate > today) {
        loads.set(word.dueDate, (loads.get(word.dueDate) || 0) + 1);
      }
    });

    let cursor = addDaysToKey(today, 1);
    const now = Date.now();

    overflow.forEach(function (word) {
      while ((loads.get(cursor) || 0) >= SCHEDULE_DAILY_LIMIT) {
        cursor = addDaysToKey(cursor, 1);
      }
      word.dueDate = cursor;
      word.updatedAt = now;
      loads.set(cursor, (loads.get(cursor) || 0) + 1);
    });
  }

  function buildDailyPlan(today) {
    const due = state.schedule.words
      .filter(function (word) {
        return word.dueDate <= today;
      })
      .sort(compareScheduleDue);

    const selected = due.slice(0, SCHEDULE_DAILY_LIMIT);
    const overflow = due.slice(SCHEDULE_DAILY_LIMIT);
    if (overflow.length) {
      distributeOverflow(overflow, today);
    }

    return {
      date: today,
      queue: selected.map(function (word) {
        return word.id;
      }),
      completed: []
    };
  }

  function pruneDaily(daily) {
    const ids = new Set(
      state.schedule.words.map(function (word) {
        return word.id;
      })
    );
    const seen = new Set();
    const queue = daily.queue.filter(function (id) {
      if (!ids.has(id) || seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
    const seenCompleted = new Set();
    const completed = daily.completed.filter(function (id) {
      if (!ids.has(id) || seen.has(id) || seenCompleted.has(id)) {
        return false;
      }
      seenCompleted.add(id);
      return true;
    });

    const changed =
      queue.length !== daily.queue.length ||
      completed.length !== daily.completed.length;

    return {
      daily: { date: daily.date, queue: queue, completed: completed },
      changed: changed
    };
  }

  function appendDueToDaily(daily, today) {
    const queued = new Set(daily.queue);
    const completed = new Set(daily.completed);
    let capacity =
      SCHEDULE_DAILY_LIMIT - queued.size - completed.size;

    if (capacity <= 0) {
      return false;
    }

    const candidates = state.schedule.words
      .filter(function (word) {
        return (
          word.dueDate <= today &&
          !queued.has(word.id) &&
          !completed.has(word.id)
        );
      })
      .sort(compareScheduleDue);

    if (!candidates.length) {
      return false;
    }

    candidates.slice(0, capacity).forEach(function (word) {
      daily.queue.push(word.id);
    });
    return true;
  }

  function ensureDailyPlan() {
    const today = todayKey();
    let daily = state.schedule.daily;

    if (!daily || daily.date !== today) {
      daily = buildDailyPlan(today);
      state.schedule.daily = daily;
      persistSchedule();
      return daily;
    }

    const pruned = pruneDaily(daily);
    daily = pruned.daily;
    state.schedule.daily = daily;

    if (appendDueToDaily(daily, today) || pruned.changed) {
      persistSchedule();
    }
    return daily;
  }

  function getNextScheduleInfo() {
    const today = todayKey();
    let nextDate = "";
    let count = 0;

    state.schedule.words.forEach(function (word) {
      if (word.dueDate <= today) {
        return;
      }
      if (!nextDate || word.dueDate < nextDate) {
        nextDate = word.dueDate;
        count = 1;
      } else if (word.dueDate === nextDate) {
        count += 1;
      }
    });

    return nextDate ? { date: nextDate, count: count } : null;
  }

  function checkScheduleDay() {
    const today = todayKey();
    if (today === lastScheduleDay) {
      return;
    }
    lastScheduleDay = today;
    state.schedule.flipped = false;
    ensureDailyPlan();
    updateScheduleBadge();
    if (state.view === "schedule") {
      renderSchedule({ focus: true });
    }
  }

  /* ==========================================================
     Elements and events
     ========================================================== */

  function cacheElements() {
    els = {
      modeButtons: Array.prototype.slice.call(document.querySelectorAll(".mode-switch button")),
      themeToggle: document.getElementById("theme-toggle"),
      syncOpen: document.getElementById("sync-open"),
      syncDot: document.querySelector(".sync-dot"),

      addForm: document.getElementById("add-form"),
      wordInput: document.getElementById("word-input"),
      translationInput: document.getElementById("translation-input"),
      detectBadge: document.getElementById("detect-badge"),

      searchInput: document.getElementById("search-input"),
      searchClear: document.getElementById("search-clear"),
      stats: document.getElementById("stats"),
      cards: document.getElementById("cards"),
      shuffleBtn: document.getElementById("shuffle-btn"),
      emptyState: document.getElementById("empty-state"),
      emptyTitle: document.getElementById("empty-title"),
      emptyText: document.getElementById("empty-text"),
      emptyAction: document.getElementById("empty-action"),

      viewTabs: Array.prototype.slice.call(
        document.querySelectorAll(".view-switch__tab")
      ),
      viewCards: document.getElementById("view-cards"),
      viewReview: document.getElementById("view-review"),
      reviewBadge: document.getElementById("review-badge"),
      reviewBar: document.getElementById("review-bar"),
      reviewStage: document.getElementById("review-stage"),
      reviewEmpty: document.getElementById("review-empty"),
      reviewEmptyAction: document.getElementById("review-empty-action"),
      reviewCount: document.getElementById("review-count"),
      reviewRemaining: document.getElementById("review-remaining"),
      reviewProgress: document.getElementById("review-progress"),
      reviewProgressBar: document.getElementById("review-progress-bar"),
      reviewRestart: document.getElementById("review-restart"),

      viewSchedule: document.getElementById("view-schedule"),
      scheduleBadge: document.getElementById("schedule-badge"),
      scheduleBar: document.getElementById("schedule-bar"),
      scheduleStage: document.getElementById("schedule-stage"),
      scheduleEmpty: document.getElementById("schedule-empty"),
      scheduleEmptyAction: document.getElementById("schedule-empty-action"),
      scheduleCount: document.getElementById("schedule-count"),
      scheduleRemaining: document.getElementById("schedule-remaining"),
      scheduleProgress: document.getElementById("schedule-progress"),
      scheduleProgressBar: document.getElementById("schedule-progress-bar"),
      scheduleManage: document.getElementById("schedule-manage"),
      scheduleManagePanel: document.getElementById("schedule-manage-panel"),
      scheduleManageClose: document.getElementById("schedule-manage-close"),
      scheduleStats: document.getElementById("schedule-stats"),
      scheduleForm: document.getElementById("schedule-form"),
      scheduleWord: document.getElementById("schedule-word"),
      scheduleTranslation: document.getElementById("schedule-translation"),
      scheduleSearch: document.getElementById("schedule-search"),
      scheduleList: document.getElementById("schedule-list"),
      scheduleMore: document.getElementById("schedule-more"),

      importOpen: document.getElementById("import-open"),
      exportBtn: document.getElementById("export-btn"),
      importJsonBtn: document.getElementById("import-json-btn"),
      clearAll: document.getElementById("clear-all"),
      jsonInput: document.getElementById("json-input"),

      importDialog: document.getElementById("import-dialog"),
      importText: document.getElementById("import-text"),
      importSubtitle: document.getElementById("import-subtitle"),
      importStepPaste: document.getElementById("import-step-paste"),
      importStepFill: document.getElementById("import-step-fill"),
      importList: document.getElementById("import-list"),
      importCount: document.getElementById("import-count"),
      importProgress: document.querySelector("#import-step-fill .progress"),
      importProgressBar: document.getElementById("import-progress-bar"),
      importBack: document.getElementById("import-back"),
      importParse: document.getElementById("import-parse"),
      importSave: document.getElementById("import-save"),

      syncDialog: document.getElementById("sync-dialog"),
      syncToken: document.getElementById("sync-token"),
      syncGist: document.getElementById("sync-gist"),
      syncStatus: document.getElementById("sync-status"),
      syncCreate: document.getElementById("sync-create"),
      syncPull: document.getElementById("sync-pull"),
      syncPush: document.getElementById("sync-push"),
      syncDisable: document.getElementById("sync-disable"),

      toasts: document.getElementById("toasts")
    };
  }

  function bindEvents() {
    els.modeButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        setMode(button.dataset.mode);
      });
    });

    els.viewTabs.forEach(function (button) {
      button.addEventListener("click", function () {
        setView(button.dataset.view);
      });
    });
    document
      .querySelector(".view-switch")
      .addEventListener("keydown", handleViewTabsKeydown);

    els.shuffleBtn.addEventListener("click", shuffleDeck);
    els.reviewRestart.addEventListener("click", restartReview);
    els.reviewStage.addEventListener("click", handleReviewStageClick);
    els.reviewStage.addEventListener("keydown", handleReviewStageKeydown);
    els.reviewEmptyAction.addEventListener("click", function () {
      setView("cards");
      els.wordInput.focus();
      els.wordInput.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    els.scheduleManage.addEventListener("click", function () {
      setScheduleManage(!state.schedule.manageOpen);
    });
    els.scheduleManageClose.addEventListener("click", function () {
      setScheduleManage(false);
    });
    els.scheduleEmptyAction.addEventListener("click", function () {
      setScheduleManage(true);
      els.scheduleWord.focus();
    });
    els.scheduleForm.addEventListener("submit", handleScheduleAdd);
    els.scheduleSearch.addEventListener("input", function () {
      state.schedule.search = els.scheduleSearch.value;
      state.schedule.listLimit = 100;
      renderScheduleManage();
    });
    els.scheduleList.addEventListener("click", handleScheduleListClick);
    els.scheduleMore.addEventListener("click", function () {
      state.schedule.listLimit += 100;
      renderScheduleManage();
    });
    els.scheduleStage.addEventListener("click", handleScheduleStageClick);
    els.scheduleStage.addEventListener("keydown", handleScheduleStageKeydown);

    els.themeToggle.addEventListener("click", cycleTheme);

    els.wordInput.addEventListener("input", updateDetection);
    els.addForm.addEventListener("submit", handleAdd);

    els.searchInput.addEventListener("input", function () {
      state.query = els.searchInput.value;
      els.searchClear.hidden = !state.query;
      render();
    });

    els.searchClear.addEventListener("click", function () {
      clearSearch();
      els.searchInput.focus();
    });

    els.cards.addEventListener("click", handleCardsClick);
    els.cards.addEventListener("keydown", handleCardsKeydown);
    els.emptyAction.addEventListener("click", handleEmptyAction);

    els.importOpen.addEventListener("click", openImport);
    els.importParse.addEventListener("click", parseImport);
    els.importBack.addEventListener("click", function () {
      showImportStep(1);
    });
    els.importSave.addEventListener("click", saveImport);
    els.importList.addEventListener("input", handleImportInput);
    els.importList.addEventListener("click", handleImportListClick);
    els.importList.addEventListener("keydown", handleImportListKeydown);
    els.importDialog.addEventListener("close", resetImport);

    els.exportBtn.addEventListener("click", exportJson);
    els.importJsonBtn.addEventListener("click", function () {
      els.jsonInput.click();
    });
    els.jsonInput.addEventListener("change", importJsonFile);
    els.clearAll.addEventListener("click", clearAllWords);

    els.syncOpen.addEventListener("click", openSyncDialog);
    els.syncCreate.addEventListener("click", createSyncGist);
    els.syncPull.addEventListener("click", pullFromGist);
    els.syncPush.addEventListener("click", function () {
      syncPush(false);
    });
    els.syncDisable.addEventListener("click", disableSync);

    document.querySelectorAll("[data-close]").forEach(function (button) {
      button.addEventListener("click", function () {
        const dialog = button.closest("dialog");
        if (dialog) {
          dialog.close();
        }
      });
    });

    [els.importDialog, els.syncDialog].forEach(function (dialog) {
      dialog.addEventListener("click", function (event) {
        if (event.target === dialog) {
          dialog.close();
        }
      });
    });

    window.addEventListener("online", function () {
      if (state.sync.enabled && hasSyncCredentials()) {
        autoSync();
      }
    });

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (schedulePushTimer) {
          window.clearTimeout(schedulePushTimer);
          schedulePushTimer = null;
          syncPush(true);
        }
        return;
      }
      if (state.sync.enabled && hasSyncCredentials()) {
        autoSync();
      }
    });

    window.addEventListener("storage", function (event) {
      if (event.key !== KEYS.words || event.newValue === null) {
        return;
      }
      try {
        state.words = normalizeWordList(JSON.parse(event.newValue));
        state.flipped.clear();

        const metaRaw = storageGet(KEYS.meta);
        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          state.updatedAt = Number(meta.updatedAt) || state.updatedAt;
        }

        render();
        updateSyncStatus();
      } catch (error) {
        console.warn("Не удалось обновить слова из другой вкладки:", error);
      }
    });
  }

  /* ==========================================================
     Theme and mode
     ========================================================== */

  function setMode(mode) {
    if ((mode !== "en" && mode !== "ru") || state.mode === mode) {
      return;
    }
    state.mode = mode;
    state.flipped.clear();
    state.review.flipped = false;
    state.schedule.flipped = false;
    saveSettings();
    renderMode();
    render();
  }

  function renderMode() {
    els.modeButtons.forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode));
    });
  }

  function cycleTheme() {
    const order = ["auto", "light", "dark"];
    const nextIndex = (order.indexOf(state.theme) + 1) % order.length;
    state.theme = order[nextIndex];
    applyTheme();
    saveSettings();
  }

  function applyTheme() {
    const root = document.documentElement;
    if (state.theme === "auto") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", state.theme);
    }

    const labels = {
      auto: "как в системе",
      light: "светлая",
      dark: "тёмная"
    };
    const label = labels[state.theme] || labels.auto;
    els.themeToggle.setAttribute("aria-label", "Тема: " + label + ". Нажмите, чтобы сменить");
    els.themeToggle.setAttribute("title", "Тема: " + label);

    const isDark =
      state.theme === "dark" ||
      (state.theme === "auto" &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) {
      themeColor.setAttribute("content", isDark ? "#0a0c13" : "#f4f5fa");
    }
  }

  /* ==========================================================
     Views, shuffle and review session
     ========================================================== */

  function renderViews() {
    els.viewCards.hidden = state.view !== "cards";
    els.viewReview.hidden = state.view !== "review";
    els.viewSchedule.hidden = state.view !== "schedule";

    els.viewTabs.forEach(function (button) {
      const selected = button.dataset.view === state.view;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  }

  function setView(view) {
    if (view !== "cards" && view !== "review" && view !== "schedule") {
      return;
    }
    state.view = view;
    renderViews();

    if (view === "review") {
      ensureReviewStarted();
      reconcileReview();
      renderReview();
    } else if (view === "schedule") {
      state.schedule.flipped = false;
      renderSchedule();
    }
  }

  function handleViewTabsKeydown(event) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (keys.indexOf(event.key) === -1) {
      return;
    }

    const tabs = els.viewTabs;
    const current = tabs.indexOf(document.activeElement);
    if (current === -1) {
      return;
    }

    event.preventDefault();
    let next = current;
    if (event.key === "ArrowRight") {
      next = (current + 1) % tabs.length;
    } else if (event.key === "ArrowLeft") {
      next = (current - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      next = 0;
    } else {
      next = tabs.length - 1;
    }

    setView(tabs[next].dataset.view);
    tabs[next].focus();
  }

  function shuffleArray(list) {
    const result = list.slice();
    for (let index = result.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      const temporary = result[index];
      result[index] = result[randomIndex];
      result[randomIndex] = temporary;
    }
    return result;
  }

  function shuffleDeck() {
    if (state.words.length < 2) {
      toast("Недостаточно карточек для перемешивания", "info");
      return;
    }

    state.words = shuffleArray(state.words);
    state.flipped.clear();
    persistWords();
    render();
    toast("Карточки перемешаны", "info");
  }

  function ensureReviewStarted() {
    if (state.review.started) {
      return;
    }

    const deckIds = state.words.map(function (word) {
      return word.id;
    });
    const queue = shuffleArray(deckIds);

    // Страховка: очередь повторения не должна совпадать с порядком колоды,
    // даже если случайное перемешивание вернуло исходный порядок.
    const deckOrder =
      queue.length === deckIds.length &&
      queue.every(function (id, index) {
        return id === deckIds[index];
      });
    if (deckOrder && queue.length > 1) {
      queue.push(queue.shift());
    }

    state.review.started = true;
    state.review.queue = queue;
    state.review.learned = new Set();
    state.review.firstTry = new Set();
    state.review.attempted = new Set();
    state.review.flipped = false;
    state.review.summary = null;
    state.review.summarySaved = false;
  }

  function reconcileReview() {
    const review = state.review;
    if (!review.started) {
      return;
    }

    const deckIds = state.words.map(function (word) {
      return word.id;
    });
    const deckSet = new Set(deckIds);
    const queued = new Set(review.queue);

    const filtered = review.queue.filter(function (id) {
      return deckSet.has(id);
    });
    if (filtered.length !== review.queue.length) {
      review.queue = filtered;

      // Удалённые слова не должны оставаться в уже показанных итогах сессии.
      if (review.summary) {
        const live = new Set(
          state.words.map(function (word) {
            return pairKey(word.english, word.russian);
          })
        );
        review.summary = review.summary.filter(function (item) {
          return live.has(item.key);
        });
      }
    }

    Array.from(review.learned).forEach(function (id) {
      if (!deckSet.has(id)) {
        review.learned.delete(id);
      }
    });

    Array.from(review.firstTry).forEach(function (id) {
      if (!deckSet.has(id)) {
        review.firstTry.delete(id);
      }
    });

    Array.from(review.attempted).forEach(function (id) {
      if (!deckSet.has(id)) {
        review.attempted.delete(id);
      }
    });

    const additions = deckIds.filter(function (id) {
      return !queued.has(id);
    });
    if (additions.length) {
      // Новые слова (например, после загрузки с GitHub) встают в конец
      // невыученных, но до первой выученной карточки и в случайном порядке.
      const boundary = review.queue.findIndex(function (id) {
        return review.learned.has(id);
      });
      const insertAt = boundary === -1 ? review.queue.length : boundary;
      review.queue.splice.apply(
        review.queue,
        [insertAt, 0].concat(shuffleArray(additions))
      );
    }
  }

  function updateReviewBadge() {
    if (!els.reviewBadge) {
      return;
    }

    const remaining = state.review.started
      ? Math.max(0, state.review.queue.length - state.review.learned.size)
      : 0;

    if (state.review.started && remaining > 0) {
      els.reviewBadge.hidden = false;
      els.reviewBadge.textContent = String(remaining);
    } else {
      els.reviewBadge.hidden = true;
      els.reviewBadge.textContent = "";
    }
  }

  function renderReview(options) {
    const opts = options || {};
    ensureReviewStarted();
    const review = state.review;

    const total = review.queue.length;
    const learned = review.learned.size;
    const remaining = Math.max(0, total - learned);
    const percent = total ? Math.round((learned / total) * 100) : 0;

    els.reviewCount.textContent = "Выучено: " + learned + " из " + total;
    els.reviewRemaining.textContent = remaining
      ? "Осталось: " + remaining + " " + wordPlural(remaining)
      : "Готово";
    els.reviewProgressBar.style.width = percent + "%";
    els.reviewProgress.setAttribute("aria-valuenow", String(percent));

    if (!state.words.length) {
      els.reviewBar.hidden = true;
      els.reviewStage.hidden = true;
      els.reviewStage.replaceChildren();
      els.reviewEmpty.hidden = false;
      updateReviewBadge();
      return;
    }

    els.reviewEmpty.hidden = true;
    els.reviewBar.hidden = false;
    els.reviewStage.hidden = false;

    if (!remaining) {
      if (!review.summarySaved) {
        review.summary = buildFirstTrySummary();
        review.summarySaved = true;
      }
      renderReviewDone(total);
      if (opts.focus) {
        const restart = els.reviewStage.querySelector(
          '[data-review-action="restart"]'
        );
        if (restart) {
          restart.focus({ preventScroll: true });
        }
      }
    } else {
      if (review.summarySaved) {
        review.summary = null;
        review.summarySaved = false;
      }
      renderReviewCard();
      if (opts.focus) {
        const card = els.reviewStage.querySelector(".card--review");
        if (card) {
          card.focus({ preventScroll: true });
        }
      }
    }

    updateReviewBadge();
  }

  function renderReviewCard() {
    const id = state.review.queue[0];
    const word = state.words.find(function (item) {
      return item.id === id;
    });

    if (!word) {
      state.review.queue.shift();
      renderReview();
      return;
    }

    const promptLang = state.mode;
    const answerLang = state.mode === "en" ? "ru" : "en";
    const prompt = promptLang === "en" ? word.english : word.russian;
    const answer = answerLang === "en" ? word.english : word.russian;
    const isFlipped = state.review.flipped;

    const card = document.createElement("article");
    card.className = "card card--review" + (isFlipped ? " is-flipped" : "");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-pressed", String(isFlipped));
    card.setAttribute(
      "aria-label",
      prompt + ". " + (isFlipped ? "Перевод показан" : "Показать перевод")
    );

    const inner = document.createElement("div");
    inner.className = "card__inner";

    const front = createCardFace(
      "front",
      promptLang.toUpperCase(),
      prompt,
      "Нажмите, чтобы увидеть перевод"
    );
    const back = createCardFace(
      "back",
      answerLang.toUpperCase(),
      answer,
      "Нажмите, чтобы скрыть перевод"
    );

    setFaceHidden(front, isFlipped);
    setFaceHidden(back, !isFlipped);

    inner.append(front, back);
    card.append(inner);

    const cardWrap = document.createElement("div");
    cardWrap.className = "review-card";
    cardWrap.append(card);

    const actions = document.createElement("div");
    actions.className = "review-actions";
    actions.hidden = !isFlipped;
    actions.append(createReviewButton("forgot"), createReviewButton("known"));

    els.reviewStage.replaceChildren(cardWrap, actions);
  }

  function createReviewButton(kind) {
    const known = kind === "known";

    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "btn review-action " +
      (known ? "review-action--known" : "review-action--forgot");
    button.dataset.reviewAction = kind;
    button.setAttribute("aria-label", known ? "Знаю" : "Не знаю / Забыл");

    const icon = document.createElement("span");
    icon.className = "review-action__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = known ? "✓" : "✕";

    const label = document.createElement("span");
    label.textContent = known ? "Знаю" : "Не знаю";

    button.append(icon, label);
    return button;
  }

  function renderReviewDone(total) {
    const panel = document.createElement("div");
    panel.className = "review-done";
    panel.setAttribute("role", "status");

    const icon = document.createElement("div");
    icon.className = "review-done__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "✓";

    const title = document.createElement("h2");
    title.textContent = "Все слова повторены!";

    const text = document.createElement("p");
    text.textContent = total
      ? "Выучено " +
        total +
        " " +
        wordPlural(total) +
        ". Отличная работа — можно пройти колоду ещё раз."
      : "Добавьте слова, чтобы начать повторение.";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn--primary";
    button.dataset.reviewAction = "restart";
    button.textContent = "Перезапуск";

    panel.append(icon, title, text);

    if (state.review.summary) {
      panel.append(createFirstTrySection(state.review.summary));
    }

    panel.append(button);
    els.reviewStage.replaceChildren(panel);
  }

  function buildFirstTrySummary() {
    const review = state.review;
    const items = [];

    review.firstTry.forEach(function (id) {
      const word = state.words.find(function (item) {
        return item.id === id;
      });
      if (!word) {
        return;
      }
      items.push({
        key: pairKey(word.english, word.russian),
        label: word.english + " — " + word.russian
      });
    });

    items.sort(function (left, right) {
      return left.label.localeCompare(right.label, "ru", { sensitivity: "base" });
    });

    return items;
  }

  function createFirstTrySection(items) {
    const section = document.createElement("div");
    section.className = "review-summary";

    const title = document.createElement("p");
    title.className = "review-summary__title";
    title.textContent =
      "С первого раза: " + items.length + " " + wordPlural(items.length);

    const hint = document.createElement("p");
    hint.className = "review-summary__hint";
    hint.textContent = items.length
      ? "Эти слова вы ответили правильно с первой попытки."
      : "В этой сессии не было слов, отвеченных правильно с первой попытки.";

    section.append(title, hint);

    if (items.length) {
      const list = document.createElement("ul");
      list.className = "review-words";

      items.forEach(function (item) {
        const entry = document.createElement("li");
        entry.className = "review-word";
        entry.textContent = item.label;
        list.append(entry);
      });

      section.append(list);
    }

    return section;
  }

  function toggleReviewFlip() {
    const card = els.reviewStage.querySelector(".card--review");
    if (!card) {
      return;
    }

    const isFlipped = !state.review.flipped;
    state.review.flipped = isFlipped;

    card.classList.toggle("is-flipped", isFlipped);
    card.setAttribute("aria-pressed", String(isFlipped));

    const front = card.querySelector(".card__face--front");
    const back = card.querySelector(".card__face--back");
    if (front) {
      setFaceHidden(front, isFlipped);
    }
    if (back) {
      setFaceHidden(back, !isFlipped);
    }

    const word = state.words.find(function (item) {
      return item.id === state.review.queue[0];
    });
    if (word) {
      const prompt = state.mode === "en" ? word.english : word.russian;
      card.setAttribute(
        "aria-label",
        prompt + ". " + (isFlipped ? "Перевод показан" : "Показать перевод")
      );
    }

    const actions = els.reviewStage.querySelector(".review-actions");
    if (actions) {
      actions.hidden = !isFlipped;
    }
  }

  function handleReviewStageClick(event) {
    const action = event.target.closest("[data-review-action]");
    if (action) {
      const value = action.dataset.reviewAction;
      if (value === "known") {
        answerReview(true);
      } else if (value === "forgot") {
        answerReview(false);
      } else if (value === "restart") {
        restartReview();
      }
      return;
    }

    if (event.target.closest(".card--review")) {
      toggleReviewFlip();
    }
  }

  function handleReviewStageKeydown(event) {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") {
      return;
    }
    if (
      event.target.closest("[data-review-action]") ||
      event.target.closest(".speak-btn")
    ) {
      return;
    }

    const card = event.target.closest(".card--review");
    if (!card) {
      return;
    }

    event.preventDefault();
    toggleReviewFlip();
  }

  function answerReview(known) {
    const review = state.review;
    if (!review.started || !review.queue.length) {
      return;
    }

    const id = review.queue.shift();
    if (!id) {
      return;
    }

    // «С первого раза» — только если самый первый ответ по карточке был
    // «Знаю». Последующие повторы уже не считаются.
    const firstAttempt = !review.attempted.has(id);
    review.attempted.add(id);

    if (known) {
      if (firstAttempt) {
        review.firstTry.add(id);
      }
      review.learned.add(id);
      review.queue.push(id);
    } else {
      review.learned.delete(id);
      // Первая выученная карточка — граница, за которую нельзя вставлять.
      const boundary = review.queue.findIndex(function (item) {
        return review.learned.has(item);
      });
      const unlearned = boundary === -1 ? review.queue.length : boundary;
      review.queue.splice(pickReinsertionIndex(unlearned), 0, id);
    }

    review.flipped = false;
    renderReview({ focus: true });
  }

  function pickReinsertionIndex(unlearnedCount) {
    if (unlearnedCount <= 0) {
      return 0;
    }

    // Мало невыученных — выбираем позицию внутри всего оставшегося отрезка.
    if (unlearnedCount < 30) {
      return 1 + Math.floor(Math.random() * unlearnedCount);
    }

    // Иначе возвращаем карточку на 10–30-е место, но до первой выученной.
    return 9 + Math.floor(Math.random() * 21);
  }

  function restartReview() {
    state.review.started = true;
    state.review.queue = shuffleArray(
      state.words.map(function (word) {
        return word.id;
      })
    );
    state.review.learned = new Set();
    state.review.firstTry = new Set();
    state.review.attempted = new Set();
    state.review.flipped = false;
    state.review.summary = null;
    state.review.summarySaved = false;

    if (!state.words.length) {
      renderReview();
      return;
    }

    renderReview({ focus: true });
    toast("Колода перемешана — начинаем заново", "info");
  }

  /* ==========================================================
     Schedule view
     ========================================================== */

  function renderSchedule(options) {
    const opts = options || {};
    const daily = ensureDailyPlan();
    const done = daily.completed.length;
    const total = done + daily.queue.length;
    const remaining = daily.queue.length;
    const percent = total ? Math.round((done / total) * 100) : 0;

    els.scheduleCount.textContent = "Сегодня: " + done + " из " + total;
    els.scheduleRemaining.textContent = remaining
      ? "Осталось: " + remaining + " " + wordPlural(remaining)
      : "Готово";
    els.scheduleProgressBar.style.width = percent + "%";
    els.scheduleProgress.setAttribute("aria-valuenow", String(percent));
    els.scheduleManage.textContent = "Слова (" + state.schedule.words.length + ")";

    if (!state.schedule.words.length) {
      els.scheduleBar.hidden = true;
      els.scheduleStage.hidden = true;
      els.scheduleStage.replaceChildren();
      els.scheduleEmpty.hidden = false;
      updateScheduleBadge();
      if (state.schedule.manageOpen) {
        renderScheduleManage();
      }
      return;
    }

    els.scheduleEmpty.hidden = true;
    els.scheduleBar.hidden = false;
    els.scheduleStage.hidden = false;

    if (!remaining) {
      renderScheduleDone(total);
      if (opts.focus) {
        const action = els.scheduleStage.querySelector("[data-schedule-action]");
        if (action) {
          action.focus({ preventScroll: true });
        }
      }
    } else {
      renderScheduleCard();
      if (opts.focus) {
        const card = els.scheduleStage.querySelector(".card--review");
        if (card) {
          card.focus({ preventScroll: true });
        }
      }
    }

    updateScheduleBadge();
    if (state.schedule.manageOpen) {
      renderScheduleManage();
    }
  }

  function updateScheduleBadge() {
    if (!els.scheduleBadge) {
      return;
    }
    const daily = state.schedule.daily;
    const remaining =
      daily && daily.date === todayKey() ? daily.queue.length : 0;

    if (remaining > 0) {
      els.scheduleBadge.hidden = false;
      els.scheduleBadge.textContent = String(remaining);
    } else {
      els.scheduleBadge.hidden = true;
      els.scheduleBadge.textContent = "";
    }
  }

  function renderScheduleCard() {
    const id = state.schedule.daily.queue[0];
    const word = findScheduleWord(id);
    if (!word) {
      state.schedule.daily.queue.shift();
      renderSchedule();
      return;
    }

    const promptLang = state.mode;
    const answerLang = state.mode === "en" ? "ru" : "en";
    const prompt = promptLang === "en" ? word.english : word.russian;
    const answer = answerLang === "en" ? word.english : word.russian;
    const isFlipped = state.schedule.flipped;

    const card = document.createElement("article");
    card.className = "card card--review" + (isFlipped ? " is-flipped" : "");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-pressed", String(isFlipped));
    card.setAttribute(
      "aria-label",
      prompt + ". " + (isFlipped ? "Перевод показан" : "Показать перевод")
    );

    const inner = document.createElement("div");
    inner.className = "card__inner";

    const front = createCardFace(
      "front",
      promptLang.toUpperCase(),
      prompt,
      "Нажмите, чтобы увидеть перевод"
    );
    const back = createCardFace(
      "back",
      answerLang.toUpperCase(),
      answer,
      "Нажмите, чтобы скрыть перевод"
    );

    setFaceHidden(front, isFlipped);
    setFaceHidden(back, !isFlipped);

    inner.append(front, back);
    card.append(inner);

    const cardWrap = document.createElement("div");
    cardWrap.className = "review-card";
    cardWrap.append(card);

    const actions = document.createElement("div");
    actions.className = "review-actions";
    actions.hidden = !isFlipped;
    actions.append(
      createScheduleButton("forgot"),
      createScheduleButton("known")
    );

    els.scheduleStage.replaceChildren(cardWrap, actions);
  }

  function createScheduleButton(kind) {
    const known = kind === "known";

    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "btn review-action " +
      (known ? "review-action--known" : "review-action--forgot");
    button.dataset.scheduleAction = kind;
    button.setAttribute("aria-label", known ? "Знаю" : "Не знаю / Забыл");

    const icon = document.createElement("span");
    icon.className = "review-action__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = known ? "✓" : "✕";

    const label = document.createElement("span");
    label.textContent = known ? "Знаю" : "Не знаю";

    button.append(icon, label);
    return button;
  }

  function renderScheduleDone(total) {
    const panel = document.createElement("div");
    panel.className = "review-done";
    panel.setAttribute("role", "status");

    const icon = document.createElement("div");
    icon.className = "review-done__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "✓";

    const title = document.createElement("h2");
    title.textContent = total ? "На сегодня всё!" : "Сегодня повторений нет";

    const text = document.createElement("p");
    if (total) {
      text.textContent =
        "Повторено " +
        total +
        " " +
        wordPlural(total) +
        ". Прогресс сохранён.";
    } else {
      text.textContent = "Загляните позже — слова появятся по расписанию.";
    }

    const next = getNextScheduleInfo();
    if (next) {
      text.textContent +=
        " Следующее повторение: " +
        formatDay(next.date) +
        " — " +
        next.count +
        " " +
        wordPlural(next.count) +
        ".";
    }

    const note = document.createElement("p");
    note.className = "schedule-done__note";
    note.textContent =
      "Лимит — " +
      SCHEDULE_DAILY_LIMIT +
      " слов в день, просроченные переносятся на следующие дни.";

    const actions = document.createElement("div");
    actions.className = "schedule-done__actions";

    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "btn btn--ghost";
    manage.dataset.scheduleAction = "manage";
    manage.textContent = "Слова в расписании";

    const cards = document.createElement("button");
    cards.type = "button";
    cards.className = "btn btn--primary";
    cards.dataset.scheduleAction = "cards";
    cards.textContent = "К карточкам";

    actions.append(manage, cards);
    panel.append(icon, title, text, note, actions);
    els.scheduleStage.replaceChildren(panel);
  }

  function toggleScheduleFlip() {
    const card = els.scheduleStage.querySelector(".card--review");
    if (!card) {
      return;
    }

    const isFlipped = !state.schedule.flipped;
    state.schedule.flipped = isFlipped;

    card.classList.toggle("is-flipped", isFlipped);
    card.setAttribute("aria-pressed", String(isFlipped));

    const front = card.querySelector(".card__face--front");
    const back = card.querySelector(".card__face--back");
    if (front) {
      setFaceHidden(front, isFlipped);
    }
    if (back) {
      setFaceHidden(back, !isFlipped);
    }

    const word = findScheduleWord(state.schedule.daily.queue[0]);
    if (word) {
      const prompt = state.mode === "en" ? word.english : word.russian;
      card.setAttribute(
        "aria-label",
        prompt + ". " + (isFlipped ? "Перевод показан" : "Показать перевод")
      );
    }

    const actions = els.scheduleStage.querySelector(".review-actions");
    if (actions) {
      actions.hidden = !isFlipped;
    }
  }

  function handleScheduleStageClick(event) {
    const action = event.target.closest("[data-schedule-action]");
    if (action) {
      const value = action.dataset.scheduleAction;
      if (value === "known") {
        answerSchedule(true);
      } else if (value === "forgot") {
        answerSchedule(false);
      } else if (value === "manage") {
        setScheduleManage(true);
      } else if (value === "cards") {
        setView("cards");
      }
      return;
    }

    if (event.target.closest(".card--review")) {
      toggleScheduleFlip();
    }
  }

  function handleScheduleStageKeydown(event) {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") {
      return;
    }
    if (
      event.target.closest("[data-schedule-action]") ||
      event.target.closest(".speak-btn")
    ) {
      return;
    }

    const card = event.target.closest(".card--review");
    if (!card) {
      return;
    }

    event.preventDefault();
    toggleScheduleFlip();
  }

  function answerSchedule(known) {
    const daily = state.schedule.daily;
    if (!daily || !daily.queue.length) {
      return;
    }

    const id = daily.queue.shift();
    const word = findScheduleWord(id);
    if (!word) {
      renderSchedule();
      return;
    }

    const today = todayKey();

    if (known) {
      word.step = Math.min(word.step + 1, SCHEDULE_MAX_STEP);
      word.interval = SCHEDULE_INTERVALS[word.step];
    } else {
      word.step = Math.max(0, word.step - 1);
      word.interval = Math.max(0, Math.floor(word.interval / 2));
    }

    word.dueDate = addDaysToKey(today, word.interval);
    word.lastReviewedOn = today;
    word.lastResult = known ? "known" : "forgot";
    word.updatedAt = Date.now();

    if (!known && word.interval === 0) {
      // Минимальный интервал — вернуть слово в конец сегодняшней очереди.
      daily.queue.push(id);
    } else if (daily.completed.indexOf(id) === -1) {
      daily.completed.push(id);
    }

    state.schedule.flipped = false;
    saveSchedule();
    renderSchedule({ focus: true });

    if (!daily.queue.length) {
      toast("На сегодня всё — расписание сохранено", "success");
    }
  }

  function setScheduleManage(open) {
    state.schedule.manageOpen = Boolean(open);
    els.scheduleManage.setAttribute(
      "aria-expanded",
      String(state.schedule.manageOpen)
    );
    els.scheduleManagePanel.hidden = !state.schedule.manageOpen;

    if (state.schedule.manageOpen) {
      renderScheduleManage();
    }
  }

  function getScheduleDueLabel(word) {
    const today = todayKey();
    if (word.dueDate < today) {
      return "просрочено";
    }
    if (word.dueDate === today) {
      return "сегодня";
    }
    if (word.dueDate === addDaysToKey(today, 1)) {
      return "завтра";
    }
    return formatDay(word.dueDate);
  }

  function getFilteredScheduleWords() {
    const query = normalize(state.schedule.search);
    return state.schedule.words
      .filter(function (word) {
        if (!query) {
          return true;
        }
        return (
          normalize(word.english).indexOf(query) !== -1 ||
          normalize(word.russian).indexOf(query) !== -1
        );
      })
      .sort(compareScheduleDue);
  }

  function renderScheduleManage() {
    const total = state.schedule.words.length;
    const daily = state.schedule.daily;
    const remaining = daily && daily.date === todayKey() ? daily.queue.length : 0;
    els.scheduleStats.textContent =
      "Всего: " + total + " " + wordPlural(total) + " · осталось сегодня: " + remaining;

    const filtered = getFilteredScheduleWords();
    const visible = filtered.slice(0, state.schedule.listLimit);
    const fragment = document.createDocumentFragment();

    if (!visible.length) {
      const empty = document.createElement("li");
      empty.className = "schedule-item schedule-item--empty";
      empty.textContent = total
        ? "Ничего не найдено по запросу «" + state.schedule.search.trim() + "»."
        : "Пока пусто. Добавьте первое слово.";
      fragment.append(empty);
    } else {
      visible.forEach(function (word) {
        const today = todayKey();
        const item = document.createElement("li");
        item.className = "schedule-item";

        const text = document.createElement("div");
        text.className = "schedule-item__text";

        const pair = document.createElement("span");
        pair.className = "schedule-item__pair";
        pair.textContent = word.english + " — " + word.russian;

        const meta = document.createElement("span");
        meta.className = "schedule-item__meta";
        meta.textContent =
          "Ступень " +
          (word.step + 1) +
          " из " +
          (SCHEDULE_MAX_STEP + 1) +
          " · " +
          getScheduleDueLabel(word);
        if (word.dueDate <= today) {
          meta.classList.add("is-due");
        }

        text.append(pair, meta);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "schedule-item__delete";
        remove.dataset.scheduleId = word.id;
        remove.setAttribute(
          "aria-label",
          "Удалить слово " + word.english + " из расписания"
        );
        remove.title = "Удалить из расписания";
        remove.textContent = "×";

        item.append(text, remove);
        fragment.append(item);
      });
    }

    els.scheduleList.replaceChildren(fragment);
    els.scheduleMore.hidden = filtered.length <= state.schedule.listLimit;
  }

  function handleScheduleListClick(event) {
    const button = event.target.closest("[data-schedule-id]");
    if (!button) {
      return;
    }
    deleteScheduleWord(button.dataset.scheduleId);
  }

  function handleScheduleAdd(event) {
    event.preventDefault();

    const first = cleanText(els.scheduleWord.value);
    const second = cleanText(els.scheduleTranslation.value);

    if (!first || !second) {
      toast("Заполните слово и перевод", "error");
      (first ? els.scheduleTranslation : els.scheduleWord).focus();
      return;
    }

    const info = detectInfo(first);
    if (!info.lang) {
      toast("Введите слово буквами", "error");
      els.scheduleWord.focus();
      return;
    }

    if (normalize(first) === normalize(second)) {
      toast("Слово и перевод не должны совпадать", "error");
      els.scheduleTranslation.focus();
      return;
    }

    const translationInfo = detectInfo(second);
    if (!translationInfo.lang) {
      toast("Перевод должен содержать буквы", "error");
      els.scheduleTranslation.focus();
      return;
    }

    if (translationInfo.lang === info.lang) {
      toast(
        "Перевод должен быть на " +
          (info.lang === "ru" ? "английском" : "русском") +
          " языке",
        "error"
      );
      els.scheduleTranslation.focus();
      return;
    }

    const english = info.lang === "ru" ? second : first;
    const russian = info.lang === "ru" ? first : second;

    if (
      state.schedule.words.some(function (word) {
        return scheduleKey(word.english, word.russian) === scheduleKey(english, russian);
      })
    ) {
      toast("Такое слово уже есть в расписании", "error");
      els.scheduleWord.focus();
      els.scheduleWord.select();
      return;
    }

    const added = addWordsToSchedule(
      [{ english: english, russian: russian }],
      { save: false }
    );
    if (!added) {
      toast("Не удалось добавить слово", "error");
      return;
    }

    saveSchedule();
    renderSchedule();
    els.scheduleForm.reset();
    els.scheduleWord.focus();
    toast("Слово добавлено в расписание", "success");
  }

  function deleteScheduleWord(id) {
    const word = findScheduleWord(id);
    if (!word) {
      return;
    }

    const approved = window.confirm(
      "Удалить «" + word.english + " — " + word.russian + "» из расписания?"
    );
    if (!approved) {
      return;
    }

    state.schedule.words = state.schedule.words.filter(function (item) {
      return item.id !== id;
    });

    if (state.schedule.daily) {
      state.schedule.daily.queue = state.schedule.daily.queue.filter(function (item) {
        return item !== id;
      });
      state.schedule.daily.completed = state.schedule.daily.completed.filter(function (item) {
        return item !== id;
      });
    }

    state.schedule.flipped = false;
    saveSchedule();
    renderSchedule();
    toast("Слово удалено из расписания", "info");
  }

  /* ==========================================================
     Add word
     ========================================================== */

  function updateDetection() {
    const value = els.wordInput.value.trim();
    if (!value) {
      els.detectBadge.hidden = true;
      els.detectBadge.className = "detect-badge";
      els.detectBadge.textContent = "";
      return;
    }

    const info = detectInfo(value);
    els.detectBadge.hidden = false;
    els.detectBadge.className = "detect-badge";

    if (!info.lang) {
      els.detectBadge.classList.add("is-warning");
      els.detectBadge.textContent = "Не удалось определить язык — используйте буквы";
      return;
    }

    const mixed = info.cyrillic > 0 && info.latin > 0;
    if (mixed) {
      els.detectBadge.classList.add("is-warning");
      els.detectBadge.textContent =
        "Смешанный текст · обработаем как " +
        (info.lang === "ru" ? "русское слово" : "английское слово");
      return;
    }

    if (info.lang === "ru") {
      els.detectBadge.classList.add("is-ru");
      els.detectBadge.textContent = "Определено: русское слово · сохраним в Russian";
    } else {
      els.detectBadge.classList.add("is-en");
      els.detectBadge.textContent = "Определено: английское слово · сохраним в English";
    }
  }

  function handleAdd(event) {
    event.preventDefault();

    const first = cleanText(els.wordInput.value);
    const second = cleanText(els.translationInput.value);

    if (!first || !second) {
      toast("Заполните слово и перевод", "error");
      (first ? els.translationInput : els.wordInput).focus();
      return;
    }

    const info = detectInfo(first);
    if (!info.lang) {
      toast("Введите слово буквами", "error");
      els.wordInput.focus();
      return;
    }

    if (normalize(first) === normalize(second)) {
      toast("Слово и перевод не должны совпадать", "error");
      els.translationInput.focus();
      return;
    }

    const translationInfo = detectInfo(second);
    if (!translationInfo.lang) {
      toast("Перевод должен содержать буквы", "error");
      els.translationInput.focus();
      return;
    }

    if (translationInfo.lang === info.lang) {
      toast(
        "Перевод должен быть на " +
          (info.lang === "ru" ? "английском" : "русском") +
          " языке",
        "error"
      );
      els.translationInput.focus();
      return;
    }

    let english;
    let russian;
    if (info.lang === "ru") {
      english = second;
      russian = first;
    } else {
      english = first;
      russian = second;
    }

    if (pairExists(english, russian)) {
      toast("Такая пара уже есть в словаре", "error");
      return;
    }

    const word = { id: uid(), english: english, russian: russian };
    state.words.unshift(word);
    addWordsToSchedule([word]);
    saveWords();
    render();

    els.addForm.reset();
    updateDetection();
    els.wordInput.focus();
    toast("Слово добавлено", "success");
  }

  /* ==========================================================
     Cards
     ========================================================== */

  function getVisibleWords() {
    const query = state.query.trim();
    if (!query) {
      return state.words.map(function (word) {
        return { word: word, score: 1 };
      });
    }

    const results = [];
    state.words.forEach(function (word) {
      const englishScore = scoreField(query, word.english);
      const russianScore = scoreField(query, word.russian);
      const best = Math.max(englishScore, russianScore);
      if (best >= FUZZY_THRESHOLD - 1e-9) {
        results.push({ word: word, score: best });
      }
    });

    results.sort(function (a, b) {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const left = state.mode === "en" ? a.word.english : a.word.russian;
      const right = state.mode === "en" ? b.word.english : b.word.russian;
      return left.localeCompare(right, "ru", { sensitivity: "base" });
    });

    return results;
  }

  function render() {
    const results = getVisibleWords();
    renderCards(results);
    renderStats(results.length);
    renderEmptyState(results);
    els.searchClear.hidden = !state.query;
    els.shuffleBtn.disabled = state.words.length < 2;
    reconcileReview();
    updateReviewBadge();
    updateScheduleBadge();

    if (state.view === "review") {
      renderReview();
    } else if (state.view === "schedule") {
      renderSchedule();
    }
  }

  function renderCards(results) {
    els.cards.replaceChildren();

    if (!results.length) {
      els.cards.hidden = true;
      return;
    }

    els.cards.hidden = false;
    const fragment = document.createDocumentFragment();
    const promptLang = state.mode;
    const answerLang = state.mode === "en" ? "ru" : "en";
    const promptBadge = promptLang.toUpperCase();
    const answerBadge = answerLang.toUpperCase();

    results.forEach(function (result) {
      const word = result.word;
      const prompt = promptLang === "en" ? word.english : word.russian;
      const answer = answerLang === "en" ? word.english : word.russian;
      const isFlipped = state.flipped.has(word.id);

      const card = document.createElement("article");
      card.className = "card" + (isFlipped ? " is-flipped" : "");
      card.dataset.id = word.id;
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-pressed", String(isFlipped));
      card.setAttribute(
        "aria-label",
        prompt + ". " + (isFlipped ? "Перевод показан" : "Показать перевод")
      );

      const inner = document.createElement("div");
      inner.className = "card__inner";

      const front = createCardFace(
        "front",
        promptBadge,
        prompt,
        "Нажмите, чтобы увидеть перевод"
      );
      const back = createCardFace(
        "back",
        answerBadge,
        answer,
        "Нажмите, чтобы скрыть перевод"
      );

      setFaceHidden(front, isFlipped);
      setFaceHidden(back, !isFlipped);

      inner.append(front, back);

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "card__delete";
      deleteButton.setAttribute("aria-label", "Удалить слово " + word.english);
      deleteButton.title = "Удалить";
      deleteButton.textContent = "×";

      card.append(inner, deleteButton);
      fragment.append(card);
    });

    els.cards.append(fragment);
  }

  /* ==========================================================
     Pronunciation (Puter.js + локальный Web Speech API)
     ========================================================== */

  let speechVoices = [];
  let speechTimer = null;
  let speechFallbackTimer = null;
  let pendingSpeech = null;
  let puterAudio = null;
  let puterRequest = 0;
  let puterSignedIn = null;
  let puterSignInPromise = null;
  let puterAuthDeclined = false;
  let puterLoadingButton = null;
  let puterFallbackNotified = false;

  function hasPuterSpeech() {
    return Boolean(
      window.puter &&
        window.puter.ai &&
        typeof window.puter.ai.txt2speech === "function"
    );
  }

  function hasPuterAuth() {
    return Boolean(
      window.puter &&
        window.puter.auth &&
        typeof window.puter.auth.isSignedIn === "function" &&
        typeof window.puter.auth.signIn === "function"
    );
  }

  // Puter работает по модели «платит пользователь» и может попросить вход.
  // Статус проверяется один раз при загрузке, чтобы не открывать попап зря.
  function primePuterAuth() {
    if (!hasPuterSpeech() || !hasPuterAuth()) {
      return;
    }

    try {
      puterSignedIn = Boolean(window.puter.auth.isSignedIn());
    } catch (error) {
      console.warn("Не удалось проверить вход в Puter:", error);
    }
  }

  function stopPuterAudio() {
    if (!puterAudio) {
      return;
    }

    try {
      puterAudio.pause();
      puterAudio.currentTime = 0;
    } catch (error) {
      console.warn("Не удалось остановить озвучку Puter:", error);
    }
    puterAudio = null;
  }

  function setSpeakLoading(button, loading) {
    if (!button) {
      return;
    }

    if (loading) {
      // Индикация всегда только на одной кнопке: при переходе к другому
      // слову старая кнопка не должна остаться «крутиться».
      if (puterLoadingButton && puterLoadingButton !== button) {
        setSpeakLoading(puterLoadingButton, false);
      }
      puterLoadingButton = button;
    } else if (puterLoadingButton === button) {
      puterLoadingButton = null;
    }

    button.classList.toggle("is-loading", Boolean(loading));
    button.setAttribute("aria-busy", String(Boolean(loading)));
  }

  function describePuterAuthError(error) {
    const code = error && (error.error || error.code);

    if (code === "auth_window_closed") {
      return "Вход в Puter отменён — озвучиваем системным голосом";
    }
    if (code === "popup_blocked") {
      return "Браузер заблокировал окно входа в Puter — озвучиваем системным голосом";
    }
    if (code === "unsupported_origin") {
      return "Для Puter нужен адрес http(s), а не файл с диска";
    }
    if (error && error.message === "Puter auth timeout") {
      return "Вход в Puter не завершён — озвучиваем системным голосом";
    }
    return "Не удалось войти в Puter — озвучиваем системным голосом";
  }

  function fallbackToLocalVoice(text, message) {
    const spoke = speakWithLocalVoice(text);

    if (!spoke) {
      toast(
        "Не удалось озвучить слово. Проверьте интернет и попробуйте ещё раз.",
        "error"
      );
      return;
    }

    if (message && !puterFallbackNotified) {
      puterFallbackNotified = true;
      toast(message, "info");
    }
  }

  // Puter может не ответить вовсе (например, если попап входа закрыт),
  // поэтому запрос ограничен по времени — кнопка не зависнет в загрузке.
  function puterTextToSpeech(text) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = window.setTimeout(function () {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error("Puter TTS timeout"));
      }, PUTER_TTS_TIMEOUT);

      window.puter.ai
        .txt2speech(text, {
          voice: PUTER_TTS_VOICE,
          engine: PUTER_TTS_ENGINE,
          language: PUTER_TTS_LANGUAGE
        })
        .then(
          function (audio) {
            if (settled) {
              // Ответ пришёл после таймаута — не играем его.
              try {
                audio.pause();
              } catch (error) {
                // ignore
              }
              return;
            }
            settled = true;
            window.clearTimeout(timer);
            resolve(audio);
          },
          function (error) {
            if (settled) {
              return;
            }
            settled = true;
            window.clearTimeout(timer);
            reject(error);
          }
        );
    });
  }

  // Ожидание окна входа ограничено по времени: попап могут заблокировать или
  // просто не закрыть, а кнопка озвучки не должна зависать в «загрузке».
  function waitPuterSignIn(promise) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = window.setTimeout(function () {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error("Puter auth timeout"));
      }, PUTER_AUTH_TIMEOUT);

      Promise.resolve(promise).then(
        function (value) {
          if (settled) {
            return;
          }
          settled = true;
          window.clearTimeout(timer);
          resolve(value);
        },
        function (error) {
          if (settled) {
            return;
          }
          settled = true;
          window.clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function requestPuterSpeech(text, button, requestId) {
    setSpeakLoading(button, true);

    puterTextToSpeech(text)
      .then(function (audio) {
        // Пока шёл запрос, могли нажать другое слово — старый ответ не играем.
        if (requestId !== puterRequest) {
          try {
            audio.pause();
          } catch (error) {
            // ignore
          }
          return;
        }

        setSpeakLoading(button, false);
        puterAudio = audio;

        try {
          audio.playbackRate = SPEECH_RATE;
        } catch (error) {
          console.warn("Не удалось изменить скорость озвучки:", error);
        }

        const forget = function () {
          if (puterAudio === audio) {
            puterAudio = null;
          }
        };
        audio.addEventListener("ended", forget);
        audio.addEventListener("pause", forget);

        const playing = audio.play();
        if (playing && typeof playing.catch === "function") {
          playing.catch(function (error) {
            console.warn("Не удалось воспроизвести озвучку:", error);
            toast("Не удалось воспроизвести озвучку", "error");
          });
        }
      })
      .catch(function (error) {
        if (requestId !== puterRequest) {
          return;
        }

        setSpeakLoading(button, false);
        console.warn("Puter TTS недоступен:", error);
        fallbackToLocalVoice(
          text,
          "Puter не ответил — включена системная озвучка"
        );
      });
  }

  function speakEnglish(word, button) {
    const text = cleanText(word);
    if (!text) {
      return;
    }

    const requestId = ++puterRequest;
    stopPuterAudio();
    clearSpeechTimers();
    pendingSpeech = null;

    // Если Puter.js не загрузился, остаётся системный английский голос.
    if (!hasPuterSpeech()) {
      speakWithLocalVoice(text);
      return;
    }

    if (hasPuterAuth() && puterSignedIn === false) {
      // Пользователь уже отказался от входа — не открываем попап повторно.
      if (puterAuthDeclined) {
        fallbackToLocalVoice(
          text,
          "Без входа в Puter озвучка идёт системным голосом"
        );
        return;
      }

      // Попап входа можно открыть только из обработчика клика.
      setSpeakLoading(button, true);

      let signing = puterSignInPromise;
      if (!signing) {
        try {
          signing = window.puter.auth.signIn();
        } catch (error) {
          signing = Promise.reject(error);
        }
      }

      puterSignInPromise = waitPuterSignIn(signing).then(
        function () {
          puterSignInPromise = null;
          puterSignedIn = true;
        },
        function (error) {
          puterSignInPromise = null;
          puterAuthDeclined = true;
          throw error;
        }
      );

      puterSignInPromise.then(
        function () {
          if (requestId !== puterRequest) {
            return;
          }
          requestPuterSpeech(text, button, requestId);
        },
        function (error) {
          if (requestId !== puterRequest) {
            return;
          }
          setSpeakLoading(button, false);
          console.warn("Вход в Puter не выполнен:", error);
          fallbackToLocalVoice(text, describePuterAuthError(error));
        }
      );
      return;
    }

    requestPuterSpeech(text, button, requestId);
  }

  function canSpeak() {
    return (
      typeof window !== "undefined" &&
      typeof window.speechSynthesis === "object" &&
      window.speechSynthesis !== null &&
      typeof window.SpeechSynthesisUtterance === "function"
    );
  }

  function bindSpeechVoices() {
    if (!canSpeak()) {
      return;
    }

    const synth = window.speechSynthesis;
    refreshSpeechVoices();

    // В Chrome и Firefox голоса подгружаются асинхронно: на первом клике
    // список может быть пустым, поэтому ждём voiceschanged и озвучиваем.
    synth.onvoiceschanged = function () {
      refreshSpeechVoices();

      if (!pendingSpeech || !speechVoices.length) {
        return;
      }

      const voice = pickEnglishVoice(speechVoices);
      clearSpeechTimers();

      const utterance = pendingSpeech;
      pendingSpeech = null;

      if (voice) {
        utterance.voice = voice;
        synth.speak(utterance);
        return;
      }

      warnMissingEnglishVoice(speechVoices);
      toast("В системе не найден английский голос", "error");
    };
  }

  function refreshSpeechVoices() {
    if (!canSpeak() || typeof window.speechSynthesis.getVoices !== "function") {
      return speechVoices;
    }

    const voices = window.speechSynthesis.getVoices();
    if (Array.isArray(voices) && voices.length) {
      speechVoices = voices;
    }
    return speechVoices;
  }

  function clearSpeechTimers() {
    if (speechTimer) {
      window.clearTimeout(speechTimer);
      speechTimer = null;
    }
    if (speechFallbackTimer) {
      window.clearTimeout(speechFallbackTimer);
      speechFallbackTimer = null;
    }
  }

  // Приоритет: en-US → en-GB → любой голос с lang, начинающимся на «en».
  function pickEnglishVoice(voices) {
    if (!Array.isArray(voices) || !voices.length) {
      return null;
    }

    const entries = voices.map(function (voice) {
      return {
        voice: voice,
        lang: String(voice.lang || "").replace(/_/g, "-").toLowerCase()
      };
    });

    const us = entries.find(function (entry) {
      return entry.lang === "en-us";
    });
    if (us) {
      return us.voice;
    }

    const gb = entries.find(function (entry) {
      return entry.lang === "en-gb";
    });
    if (gb) {
      return gb.voice;
    }

    const anyEnglish = entries.find(function (entry) {
      return entry.lang.indexOf("en") === 0;
    });
    return anyEnglish ? anyEnglish.voice : null;
  }

  function warnMissingEnglishVoice(voices) {
    const list = (Array.isArray(voices) ? voices : []).map(function (voice) {
      return voice.name + " (" + voice.lang + ")";
    });

    console.warn(
      "Английский голос не найден. Доступные голоса:",
      list.length ? list : "список пуст"
    );
  }

  function startSpeech(utterance, synth) {
    const voice = pickEnglishVoice(refreshSpeechVoices());

    if (voice) {
      utterance.voice = voice;
      synth.speak(utterance);
      return;
    }

    if (!speechVoices.length) {
      // Голоса ещё не загрузились — дождёмся onvoiceschanged.
      pendingSpeech = utterance;
      speechFallbackTimer = window.setTimeout(function () {
        speechFallbackTimer = null;
        if (pendingSpeech !== utterance) {
          return;
        }
        pendingSpeech = null;
        warnMissingEnglishVoice(refreshSpeechVoices());
        toast("В системе не найден английский голос", "error");
      }, 1000);
      return;
    }

    warnMissingEnglishVoice(speechVoices);
    toast("В системе не найден английский голос", "error");
  }

  function speakWithLocalVoice(word) {
    const text = cleanText(word);
    if (!text) {
      return false;
    }

    if (!canSpeak()) {
      toast(
        "Браузер не поддерживает озвучивание речи. Попробуйте Chrome, Edge или Safari.",
        "error"
      );
      return false;
    }

    const synth = window.speechSynthesis;
    refreshSpeechVoices();
    clearSpeechTimers();
    pendingSpeech = null;

    try {
      // Перед новой озвучкой всегда останавливаем предыдущую.
      synth.cancel();
    } catch (error) {
      console.warn("Не удалось остановить озвучку:", error);
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = SPEECH_RATE;

    utterance.onerror = function (event) {
      if (
        event &&
        (event.error === "canceled" || event.error === "interrupted")
      ) {
        return;
      }
      console.warn("Ошибка озвучки:", event && event.error);
    };

    // Chrome: speak() сразу после cancel() может быть отменён,
    // поэтому запускаем озвучку с небольшой задержкой.
    speechTimer = window.setTimeout(function () {
      speechTimer = null;
      startSpeech(utterance, synth);
    }, 50);

    return true;
  }

  function createSpeakButton(word) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "speak-btn";
    button.setAttribute("aria-label", "Произнести «" + word + "»");
    button.title = "Произнести";

    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "🔊";
    button.append(icon);

    button.addEventListener("click", function (event) {
      // Кнопка находится внутри карточки: не даём клику перевернуть её.
      event.stopPropagation();
      speakEnglish(word, button);
    });

    return button;
  }

  // Скрытая сторона карточки не должна попадать в Tab-навигацию.
  function setFaceHidden(face, hidden) {
    face.setAttribute("aria-hidden", String(hidden));
    face.querySelectorAll(".speak-btn").forEach(function (button) {
      button.tabIndex = hidden ? -1 : 0;
    });
  }

  function createCardFace(kind, badge, word, hint) {
    const face = document.createElement("div");
    face.className = "card__face card__face--" + kind;

    const lang = document.createElement("span");
    lang.className = "card__lang";
    lang.textContent = badge;

    const text = document.createElement("span");
    text.className = "card__word";
    text.textContent = word;

    let content = text;
    if (badge === "EN") {
      content = document.createElement("span");
      content.className = "card__word-line";
      content.append(text, createSpeakButton(word));
    }

    const note = document.createElement("span");
    note.className = "card__hint";
    note.textContent = hint;

    face.append(lang, content, note);
    return face;
  }

  function renderStats(foundCount) {
    const total = state.words.length;
    if (state.query.trim()) {
      els.stats.textContent =
        "Найдено " + foundCount + " из " + total + " " + wordPlural(total);
    } else {
      els.stats.textContent = total + " " + wordPlural(total);
    }
  }

  function renderEmptyState(results) {
    if (results.length) {
      els.emptyState.hidden = true;
      return;
    }

    els.emptyState.hidden = false;

    if (!state.words.length) {
      els.emptyTitle.textContent = "Пока пусто";
      els.emptyText.textContent =
        "Добавьте первое слово или импортируйте готовый список.";
      els.emptyAction.textContent = "Добавить слово";
      els.emptyAction.dataset.action = "add";
    } else {
      els.emptyTitle.textContent = "Ничего не найдено";
      els.emptyText.textContent =
        "По запросу «" +
        state.query.trim() +
        "» нет совпадений. Попробуйте изменить запрос или очистить поиск.";
      els.emptyAction.textContent = "Сбросить поиск";
      els.emptyAction.dataset.action = "clear";
    }
  }

  function handleCardsClick(event) {
    const deleteButton = event.target.closest(".card__delete");
    if (deleteButton) {
      event.stopPropagation();
      const card = deleteButton.closest(".card");
      if (card) {
        deleteWord(card.dataset.id);
      }
      return;
    }

    const card = event.target.closest(".card");
    if (card) {
      activateCard(card);
    }
  }

  function handleCardsKeydown(event) {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") {
      return;
    }
    if (
      event.target.closest(".card__delete") ||
      event.target.closest(".speak-btn")
    ) {
      return;
    }
    const card = event.target.closest(".card");
    if (!card) {
      return;
    }
    event.preventDefault();
    activateCard(card);
  }

  function activateCard(card) {
    const id = card.dataset.id;
    const word = state.words.find(function (item) {
      return item.id === id;
    });
    if (!word) {
      return;
    }

    const isFlipped = state.flipped.has(id);
    if (isFlipped) {
      state.flipped.delete(id);
    } else {
      state.flipped.add(id);
    }

    card.classList.toggle("is-flipped", !isFlipped);
    card.setAttribute("aria-pressed", String(!isFlipped));

    const front = card.querySelector(".card__face--front");
    const back = card.querySelector(".card__face--back");
    if (front) {
      setFaceHidden(front, !isFlipped);
    }
    if (back) {
      setFaceHidden(back, isFlipped);
    }

    const prompt = state.mode === "en" ? word.english : word.russian;
    card.setAttribute(
      "aria-label",
      prompt + ". " + (!isFlipped ? "Перевод показан" : "Показать перевод")
    );
  }

  function deleteWord(id) {
    const word = state.words.find(function (item) {
      return item.id === id;
    });
    if (!word) {
      return;
    }

    const approved = window.confirm(
      "Удалить «" + word.english + " — " + word.russian + "»?"
    );
    if (!approved) {
      return;
    }

    state.words = state.words.filter(function (item) {
      return item.id !== id;
    });
    state.flipped.delete(id);
    saveWords();
    render();
    toast("Слово удалено", "info");
  }

  /* ==========================================================
     Clear all
     ========================================================== */

  // Полный сброс колоды и расписания необратим, поэтому подтверждаем трижды.
  const CLEAR_ALL_PROMPTS = [
    "Вы уверены, что хотите удалить ВСЕ слова? Это действие нельзя отменить",
    "Удалить также всё расписание и прогресс повторений? Восстановить можно только из экспорта JSON",
    "Последнее подтверждение: колода и прогресс будут стёрты безвозвратно. Удалить?"
  ];

  function clearAllWords() {
    const hasWords = state.words.length > 0;
    const hasSchedule =
      state.schedule.words.length > 0 || Boolean(state.schedule.daily);

    if (!hasWords && !hasSchedule) {
      toast("Список уже пуст", "info");
      return;
    }

    for (let index = 0; index < CLEAR_ALL_PROMPTS.length; index += 1) {
      if (!window.confirm(CLEAR_ALL_PROMPTS[index])) {
        return;
      }
    }

    state.words = [];
    state.flipped.clear();
    state.pendingImport = [];

    state.review.started = false;
    state.review.queue = [];
    state.review.learned = new Set();
    state.review.firstTry = new Set();
    state.review.attempted = new Set();
    state.review.flipped = false;
    state.review.summary = null;
    state.review.summarySaved = false;

    state.schedule.words = [];
    state.schedule.daily = null;
    state.schedule.flipped = false;
    state.schedule.search = "";
    state.schedule.listLimit = 100;
    els.scheduleSearch.value = "";

    // Пишем пустые списки, а не удаляем ключи: иначе при следующей загрузке
    // приложение снова подставит демонстрационную колоду.
    saveWords({ push: false });
    saveSchedule();

    render();
    toast("Все слова и расписание удалены", "info");
  }

  function handleEmptyAction() {
    if (els.emptyAction.dataset.action === "clear") {
      clearSearch();
      els.searchInput.focus();
      return;
    }
    els.wordInput.focus();
    els.wordInput.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function clearSearch() {
    state.query = "";
    els.searchInput.value = "";
    els.searchClear.hidden = true;
    render();
  }

  /* ==========================================================
     Fuzzy search
     ========================================================== */

  function scoreField(query, target) {
    const q = normalize(query);
    const t = normalize(target);
    if (!q || !t) {
      return 0;
    }

    let best = baseScore(q, t);

    if (q.indexOf(" ") !== -1) {
      const queryParts = q.split(" ");
      const targetParts = t.split(" ");
      let minimum = 1;
      queryParts.forEach(function (part) {
        let partBest = 0;
        targetParts.forEach(function (token) {
          partBest = Math.max(partBest, baseScore(part, token));
        });
        minimum = Math.min(minimum, partBest);
      });
      best = Math.max(best, minimum);
    }

    return best;
  }

  function baseScore(q, t) {
    if (!q || !t) {
      return 0;
    }
    if (q === t) {
      return 1;
    }
    if (t.startsWith(q)) {
      return 0.95;
    }
    if (t.indexOf(q) !== -1) {
      return 0.85;
    }

    let best = 0;
    t.split(" ").forEach(function (token) {
      if (!token) {
        return;
      }
      if (token === q) {
        best = Math.max(best, 0.96);
      } else if (token.startsWith(q)) {
        best = Math.max(best, 0.92);
      } else if (token.indexOf(q) !== -1) {
        best = Math.max(best, 0.82);
      }
    });

    const maxLength = Math.max(q.length, t.length);
    if (maxLength > 0) {
      const lengthGap = Math.abs(q.length - t.length) / maxLength;
      if (lengthGap <= 1 - FUZZY_THRESHOLD) {
        const similarity = 1 - levenshtein(q, t) / maxLength;
        best = Math.max(best, similarity);
      }
    }

    return best;
  }

  function levenshtein(left, right) {
    const a = String(left);
    const b = String(right);
    if (!a.length) {
      return b.length;
    }
    if (!b.length) {
      return a.length;
    }

    let previous = new Array(b.length + 1);
    let current = new Array(b.length + 1);
    for (let index = 0; index <= b.length; index += 1) {
      previous[index] = index;
    }

    for (let row = 1; row <= a.length; row += 1) {
      current[0] = row;
      for (let column = 1; column <= b.length; column += 1) {
        current[column] = Math.min(
          previous[column] + 1,
          current[column - 1] + 1,
          previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1)
        );
      }
      const swap = previous;
      previous = current;
      current = swap;
    }

    return previous[b.length];
  }

  /* ==========================================================
     Bulk import
     ========================================================== */

  function openImport() {
    resetImport();
    els.importDialog.showModal();
    els.importText.focus();

    if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
      navigator.clipboard
        .readText()
        .then(function (text) {
          if (
            els.importDialog.open &&
            !els.importText.value.trim() &&
            text &&
            text.trim()
          ) {
            els.importText.value = text.trim();
            toast("Текст из буфера вставлен", "info");
          }
        })
        .catch(function () {
          /* доступ к буферу не выдан — пользователь вставит вручную */
        });
    }
  }

  function resetImport() {
    state.pendingImport = [];
    els.importText.value = "";
    els.importList.replaceChildren();
    showImportStep(1);
    updateImportFooter();
  }

  function showImportStep(step) {
    state.importStep = step;
    const isPaste = step === 1;

    els.importStepPaste.hidden = !isPaste;
    els.importStepFill.hidden = isPaste;
    els.importParse.hidden = !isPaste;
    els.importBack.hidden = isPaste;
    els.importSave.hidden = isPaste;
    els.importSubtitle.textContent = isPaste
      ? "Вставьте слова — по одному в строке"
      : "Допишите переводы и сохраните";

    if (!isPaste && els.importDialog.open) {
      renderImportList();
    }
    if (isPaste && els.importDialog.open) {
      els.importText.focus();
    }
  }

  function parseImportLines(text) {
    const lines = String(text).split(/\r?\n/);
    const items = [];
    const seenSources = new Set();
    const skipped = { total: 0, exists: 0, duplicate: 0, unrecognized: 0 };

    const skip = function (reason) {
      skipped.total += 1;
      skipped[reason] += 1;
    };

    lines.forEach(function (rawLine) {
      let line = rawLine.trim();
      if (!line) {
        return;
      }

      line = line.replace(/^\s*(?:[-*•·–—]|\d+[.)])\s*/, "").trim();
      if (!line) {
        return;
      }

      let left = line;
      let right = "";
      const match = line.match(
        /^(.+?)\s*(?:\t+|\s*[—–―−]\s*|\s+-\s+|\s*[|｜]\s*|\s*=\s*|\s*:\s*|\s*;\s*|\s*,\s*)\s*(.+)$/
      );
      if (match) {
        left = match[1].trim();
        right = match[2].trim();
      }

      left = cleanText(left);
      right = cleanText(right);
      if (!left) {
        return;
      }

      const info = detectInfo(left);
      if (!info.lang) {
        skip("unrecognized");
        return;
      }

      const sourceKey = normalize(left);
      if (seenSources.has(sourceKey)) {
        skip("duplicate");
        return;
      }
      seenSources.add(sourceKey);

      if (sourceExists(left, info.lang)) {
        skip("exists");
        return;
      }

      items.push({
        id: uid(),
        word: left,
        lang: info.lang,
        translation: right
      });
    });

    return { items: items, skipped: skipped };
  }

  function describeImportSkipped(skipped) {
    const parts = [];
    if (skipped.exists) {
      parts.push("уже есть в словаре: " + skipped.exists);
    }
    if (skipped.duplicate) {
      parts.push("повторяются в списке: " + skipped.duplicate);
    }
    if (skipped.unrecognized) {
      parts.push("не распознаны: " + skipped.unrecognized);
    }
    if (skipped.invalid) {
      parts.push("проверьте перевод: " + skipped.invalid);
    }

    return "Пропущено " +
      skipped.total +
      " " +
      wordPlural(skipped.total) +
      " (" +
      parts.join(", ") +
      ")";
  }

  function parseImport() {
    const parsed = parseImportLines(els.importText.value);
    if (!parsed.items.length) {
      if (parsed.skipped.total) {
        toast(
          parsed.skipped.exists === parsed.skipped.total
            ? "Все эти слова уже есть в словаре"
            : describeImportSkipped(parsed.skipped),
          parsed.skipped.exists === parsed.skipped.total ? "info" : "error"
        );
      } else {
        toast("Вставьте хотя бы одно слово", "error");
      }
      return;
    }

    state.pendingImport = parsed.items;
    showImportStep(2);
    updateImportFooter();

    if (parsed.skipped.total) {
      els.importSubtitle.textContent =
        "Новых слов: " + parsed.items.length + " · " + describeImportSkipped(parsed.skipped);
      toast(describeImportSkipped(parsed.skipped), "info");
    }

    window.requestAnimationFrame(function () {
      const firstInput = els.importList.querySelector("input");
      if (firstInput) {
        firstInput.focus();
      }
    });
  }

  function renderImportList() {
    els.importList.replaceChildren();

    if (!state.pendingImport.length) {
      const empty = document.createElement("div");
      empty.className = "import-empty";
      empty.textContent =
        "Все строки убраны. Вернитесь назад и вставьте список заново.";
      els.importList.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();

    state.pendingImport.forEach(function (item) {
      const row = document.createElement("div");
      row.className = "import-row";
      row.dataset.id = item.id;

      const wordWrap = document.createElement("div");
      wordWrap.className = "import-row__word";

      const tag = document.createElement("span");
      tag.className = "lang-tag";
      tag.textContent = item.lang.toUpperCase();

      const wordText = document.createElement("span");
      wordText.textContent = item.word;

      wordWrap.append(tag, wordText);

      const input = document.createElement("input");
      input.type = "text";
      input.value = item.translation;
      input.maxLength = 80;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder =
        item.lang === "en" ? "Перевод на русский" : "English translation";
      input.setAttribute(
        "aria-label",
        "Перевод для слова " + item.word
      );

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "import-row__remove";
      remove.setAttribute("aria-label", "Убрать слово " + item.word);
      remove.title = "Убрать";
      remove.textContent = "×";

      row.append(wordWrap, input, remove);
      fragment.append(row);
    });

    els.importList.append(fragment);
  }

  function handleImportInput(event) {
    const input = event.target.closest(".import-row input");
    if (!input) {
      return;
    }
    const row = input.closest(".import-row");
    const item = state.pendingImport.find(function (entry) {
      return entry.id === row.dataset.id;
    });
    if (item) {
      item.translation = input.value;
    }
    updateImportFooter();
  }

  function handleImportListClick(event) {
    const remove = event.target.closest(".import-row__remove");
    if (!remove) {
      return;
    }
    const row = remove.closest(".import-row");
    state.pendingImport = state.pendingImport.filter(function (item) {
      return item.id !== row.dataset.id;
    });
    renderImportList();
    updateImportFooter();
  }

  function handleImportListKeydown(event) {
    if (event.key !== "Enter" || event.target.tagName !== "INPUT") {
      return;
    }
    event.preventDefault();
    const inputs = Array.prototype.slice.call(
      els.importList.querySelectorAll("input")
    );
    const index = inputs.indexOf(event.target);
    if (index >= 0 && index < inputs.length - 1) {
      inputs[index + 1].focus();
    } else {
      event.target.blur();
    }
  }

  function updateImportFooter() {
    const total = state.pendingImport.length;
    let filled = 0;
    state.pendingImport.forEach(function (item) {
      if (item.translation.trim()) {
        filled += 1;
      }
    });

    const percent = total ? Math.round((filled / total) * 100) : 0;
    els.importCount.textContent = "Заполнено " + filled + " из " + total;
    els.importProgressBar.style.width = percent + "%";
    if (els.importProgress) {
      els.importProgress.setAttribute("aria-valuenow", String(percent));
    }

    els.importSave.textContent = filled ? "Сохранить (" + filled + ")" : "Сохранить";
    els.importSave.disabled = filled === 0;
  }

  function saveImport() {
    const added = [];
    const skipped = { total: 0, exists: 0, duplicate: 0, invalid: 0 };

    const skip = function (reason) {
      skipped.total += 1;
      skipped[reason] += 1;
    };

    state.pendingImport.forEach(function (item) {
      const translation = cleanText(item.translation);
      const source = cleanText(item.word);
      if (!translation || !source) {
        // Строка без перевода не добавляется — но и молча исчезать не должна:
        // показываем её в итоговом сообщении как «проверьте перевод».
        skip("invalid");
        return;
      }

      const english = item.lang === "en" ? source : translation;
      const russian = item.lang === "ru" ? source : translation;

      if (!english || !russian || normalize(english) === normalize(russian)) {
        skip("invalid");
        return;
      }

      // Перевод должен быть на другом языке. Раньше здесь сравнивалось
      // соотношение букв, и переводы вроде «видеть (saw, seen)» ошибочно
      // считались английскими и пропускались.
      const translationLangOk =
        item.lang === "en" ? hasCyrillic(translation) : hasLatin(translation);
      if (!translationLangOk) {
        skip("invalid");
        return;
      }

      if (sourceExists(source, item.lang)) {
        skip("exists");
        return;
      }

      const duplicateInBatch = added.some(function (word) {
        return (
          normalize(item.lang === "en" ? word.english : word.russian) ===
          normalize(source)
        );
      });
      if (duplicateInBatch) {
        skip("duplicate");
        return;
      }

      added.push({ id: uid(), english: english, russian: russian });
    });

    if (!added.length) {
      toast(
        skipped.total && skipped.exists === skipped.total
          ? "Ничего не добавлено: эти слова уже есть в словаре"
          : "Ничего не добавлено: проверьте переводы",
        "error"
      );
      return;
    }

    state.words = added.concat(state.words);
    addWordsToSchedule(added);
    saveWords();
    render();
    els.importDialog.close();

    toast(
      "Добавлено " +
        added.length +
        " " +
        wordPlural(added.length) +
        (skipped.total ? " · " + describeImportSkipped(skipped) : ""),
      "success"
    );
  }

  /* ==========================================================
     JSON export/import
     ========================================================== */

  function exportJson() {
    const data = JSON.stringify(
      {
        app: "WordFlip",
        version: 2,
        exportedAt: new Date().toISOString(),
        words: state.words,
        schedule: state.schedule.words
      },
      null,
      2
    );
    const blob = new Blob([data], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);

    link.href = url;
    link.download = "wordflip-" + date + ".json";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);

    toast(
      "Экспортировано " +
        state.words.length +
        " " +
        wordPlural(state.words.length) +
        " и расписание",
      "success"
    );
  }

  function importJsonFile(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }

    file
      .text()
      .then(function (text) {
        const data = JSON.parse(text);
        const array = Array.isArray(data)
          ? data
          : data && Array.isArray(data.words)
            ? data.words
            : [];
        const scheduleArray =
          data && !Array.isArray(data) && data.schedule
            ? Array.isArray(data.schedule)
              ? data.schedule
              : Array.isArray(data.schedule.words)
                ? data.schedule.words
                : []
            : [];

        if (!Array.isArray(data) && !(data && Array.isArray(data.words)) && !scheduleArray.length) {
          throw new Error("Неверный формат файла");
        }

        const incoming = normalizeWordList(array);
        const existing = new Set(
          state.words.map(function (word) {
            return pairKey(word.english, word.russian);
          })
        );
        // normalizeWordList чинит дубли id только внутри файла: id из файла
        // может совпасть с уже существующим словом. Тогда две карточки делят
        // один data-id — переворот и удаление срабатывают сразу на обеих.
        const usedIds = new Set(
          state.words.map(function (word) {
            return word.id;
          })
        );
        const fresh = [];

        incoming.forEach(function (word) {
          const key = pairKey(word.english, word.russian);
          if (!existing.has(key)) {
            existing.add(key);
            if (usedIds.has(word.id)) {
              word.id = uid();
            }
            usedIds.add(word.id);
            fresh.push(word);
          }
        });

        const scheduleChanged = scheduleArray.length
          ? mergeScheduleWords(normalizeScheduleWords(scheduleArray))
          : 0;

        if (!fresh.length && !scheduleChanged) {
          toast("Все слова из файла уже есть", "info");
          return;
        }

        if (fresh.length) {
          state.words = fresh.concat(state.words);
          addWordsToSchedule(fresh, { save: false });
          saveWords();
        }

        if (fresh.length || scheduleChanged) {
          saveSchedule();
        }
        render();

        const parts = [];
        if (fresh.length) {
          parts.push(
            "добавлено " + fresh.length + " " + wordPlural(fresh.length)
          );
        }
        if (scheduleChanged) {
          parts.push("расписание обновлено");
        }
        toast(parts.join(", "), "success");
      })
      .catch(function (error) {
        console.warn("Ошибка импорта JSON:", error);
        toast("Не удалось прочитать JSON-файл", "error");
      })
      .finally(function () {
        els.jsonInput.value = "";
      });
  }

  /* ==========================================================
     GitHub Gist sync
     ========================================================== */

  function hasSyncCredentials() {
    return Boolean(state.sync.token && state.sync.gistId);
  }

  function parseGistId(value) {
    const raw = String(value || "").trim();
    if (!raw) {
      return "";
    }

    // Ссылку принимаем и без схемы: gist.github.com/user/abc123, и с хвостом
    // raw/revisions — id всегда первый hex-сегмент после имени пользователя.
    const linkMatch = raw.match(
      /^(?:https?:\/\/)?(?:www\.)?gist\.github\.com\/(?:[^/?#]+\/)?([0-9a-f]+)/i
    );
    if (linkMatch) {
      return linkMatch[1];
    }

    let result = raw;
    if (/^https?:\/\//i.test(result)) {
      try {
        const url = new URL(result);
        const parts = url.pathname.split("/").filter(Boolean);
        result = parts.length ? parts[parts.length - 1] : "";
      } catch (error) {
        /* оставляем строку как есть */
      }
    }
    return result.split(/[?#]/)[0].replace(/\/+$/, "");
  }

  function readSyncCredentials(requireGist) {
    const token = els.syncToken.value.trim();
    if (!token) {
      toast("Введите GitHub token", "error");
      els.syncToken.focus();
      return null;
    }

    const gistId = parseGistId(els.syncGist.value);
    if (requireGist && !gistId) {
      toast("Введите ID или ссылку на gist", "error");
      els.syncGist.focus();
      return null;
    }

    state.sync.token = token;
    if (gistId) {
      state.sync.gistId = gistId;
      els.syncGist.value = gistId;
    }
    saveSyncSettings();
    return { token: token, gistId: gistId };
  }

  function openSyncDialog() {
    els.syncToken.value = state.sync.token;
    els.syncGist.value = state.sync.gistId;
    updateSyncStatus();
    els.syncDialog.showModal();

    window.setTimeout(function () {
      if (state.sync.token) {
        els.syncGist.focus();
      } else {
        els.syncToken.focus();
      }
    }, 30);
  }

  async function githubRequest(path, options) {
    const opts = options || {};
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + state.sync.token,
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (opts.body) {
      headers["Content-Type"] = "application/json";
    }

    let response;
    try {
      response = await fetch(GIST_API + path, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body
      });
    } catch (error) {
      throw new Error("Нет соединения с GitHub");
    }

    if (!response.ok) {
      let message = "";
      try {
        const payload = await response.json();
        message = payload && payload.message ? payload.message : "";
      } catch (error) {
        /* тело ответа не JSON */
      }

      if (response.status === 401) {
        message = "Неверный или просроченный токен GitHub";
      } else if (response.status === 404) {
        message = "Gist не найден или у токена нет доступа";
      } else if (response.status === 403) {
        message = message || "Доступ запрещён — проверьте scope gist";
      } else if (!message) {
        message = "Ошибка GitHub (" + response.status + ")";
      }

      throw new Error(message);
    }

    if (response.status === 204) {
      return null;
    }
    return response.json();
  }

  function gistPayload(updatedAt) {
    return JSON.stringify(
      {
        app: "WordFlip",
        version: 2,
        updatedAt: updatedAt,
        scheduleUpdatedAt: state.schedule.updatedAt,
        words: state.words,
        schedule: {
          updatedAt: state.schedule.updatedAt,
          words: state.schedule.words
        }
      },
      null,
      2
    );
  }

  async function patchGist(updatedAt) {
    return githubRequest("/gists/" + encodeURIComponent(state.sync.gistId), {
      method: "PATCH",
      body: JSON.stringify({
        files: {
          [GIST_FILE]: {
            content: gistPayload(updatedAt)
          }
        }
      })
    });
  }

  async function fetchGist() {
    if (!hasSyncCredentials()) {
      throw new Error("Синхронизация не настроена");
    }

    const gist = await githubRequest(
      "/gists/" + encodeURIComponent(state.sync.gistId)
    );
    const file = gist && gist.files ? gist.files[GIST_FILE] : null;
    if (!file) {
      throw new Error("В gist нет файла " + GIST_FILE);
    }

    let content = file.content;
    if (file.truncated && file.raw_url) {
      const rawResponse = await fetch(file.raw_url);
      if (!rawResponse.ok) {
        throw new Error("Не удалось прочитать файл из gist");
      }
      content = await rawResponse.text();
    }

    let data;
    try {
      data = JSON.parse(content);
    } catch (error) {
      throw new Error("Файл в gist повреждён");
    }

    const incoming = Array.isArray(data)
      ? data
      : data && Array.isArray(data.words)
        ? data.words
        : [];
    const incomingSchedule =
      data && !Array.isArray(data) && data.schedule
        ? Array.isArray(data.schedule)
          ? data.schedule
          : Array.isArray(data.schedule.words)
            ? data.schedule.words
            : []
        : [];

    const updatedAt =
      Number(data && data.updatedAt) ||
      Date.parse(gist.updated_at || "") ||
      Date.now();

    return {
      words: normalizeWordList(incoming),
      schedule: normalizeScheduleWords(incomingSchedule),
      scheduleUpdatedAt:
        Number(data && data.schedule && data.schedule.updatedAt) ||
        Number(data && data.scheduleUpdatedAt) ||
        0,
      updatedAt: updatedAt
    };
  }

  function applyRemote(remote) {
    state.words = remote.words;
    state.updatedAt = remote.updatedAt || Date.now();
    state.flipped.clear();
    persistWords();
    saveMeta();

    // Сначала накладываем прогресс из gist: mergeScheduleWords сам добавит
    // отсутствующие записи вместе со ступенью и датой повтора. Если сделать
    // наоборот, addWordsToSchedule создаст слова с updatedAt = сейчас, и мердж
    // уже не сможет применить более старый (но верный) прогресс.
    if (remote.schedule && remote.schedule.length) {
      mergeScheduleWords(remote.schedule);
    }

    addWordsToSchedule(state.words, { save: false });

    state.schedule.updatedAt = Math.max(
      state.schedule.updatedAt,
      remote.scheduleUpdatedAt || 0
    );
    persistSchedule();

    render();
  }

  async function createSyncGist() {
    const credentials = readSyncCredentials(false);
    if (!credentials) {
      return;
    }
    if (!window.confirm("Создать новый секретный gist с текущими словами?")) {
      return;
    }
    if (state.syncBusy) {
      toast("Дождитесь завершения текущей операции", "info");
      return;
    }

    setSyncBusy(true);
    setSyncState("syncing");

    try {
      const now = Date.now();
      state.updatedAt = now;
      saveMeta();

      const gist = await githubRequest("/gists", {
        method: "POST",
        body: JSON.stringify({
          description: GIST_DESCRIPTION,
          public: false,
          files: {
            [GIST_FILE]: {
              content: gistPayload(now)
            }
          }
        })
      });

      state.sync.gistId = gist.id;
      state.sync.enabled = true;
      state.sync.lastSync = Date.now();
      saveSyncSettings();
      els.syncGist.value = gist.id;
      setSyncState("ok");
      toast("Gist создан — синхронизация включена", "success");
    } catch (error) {
      setSyncState("error");
      toast("Не удалось создать gist: " + error.message, "error");
    } finally {
      setSyncBusy(false);
    }
  }

  async function pullFromGist() {
    const credentials = readSyncCredentials(true);
    if (!credentials) {
      return;
    }
    if (!window.confirm("Заменить локальные слова данными из GitHub?")) {
      return;
    }
    if (state.syncBusy) {
      toast("Дождитесь завершения текущей операции", "info");
      return;
    }

    setSyncBusy(true);
    setSyncState("syncing");

    try {
      const remote = await fetchGist();
      applyRemote(remote);

      state.sync.enabled = true;
      state.sync.lastSync = Date.now();
      saveSyncSettings();
      setSyncState("ok");
      toast(
        "Загружено " + state.words.length + " " + wordPlural(state.words.length) + " с GitHub",
        "success"
      );
    } catch (error) {
      setSyncState("error");
      toast("Не удалось загрузить: " + error.message, "error");
    } finally {
      setSyncBusy(false);
    }
  }

  async function syncPush(auto) {
    if (auto) {
      if (!state.sync.enabled || !hasSyncCredentials()) {
        return;
      }
      if (state.syncBusy) {
        state.pendingPush = true;
        return;
      }
    } else {
      const credentials = readSyncCredentials(true);
      if (!credentials) {
        return;
      }
      if (
        !window.confirm(
          "Загрузить локальные слова на GitHub? Данные в gist будут заменены."
        )
      ) {
        return;
      }
      if (state.syncBusy) {
        toast("Дождитесь завершения текущей операции", "info");
        return;
      }
    }

    setSyncBusy(true);
    setSyncState("syncing");

    try {
      const now = Date.now();
      state.updatedAt = now;
      saveMeta();
      await patchGist(now);

      state.sync.enabled = true;
      state.sync.lastSync = Date.now();
      saveSyncSettings();
      setSyncState("ok");

      if (!auto) {
        toast(
          "Сохранено " +
            state.words.length +
            " " +
            wordPlural(state.words.length) +
            " на GitHub",
          "success"
        );
      }
    } catch (error) {
      setSyncState("error");
      if (!auto) {
        toast("Не удалось сохранить: " + error.message, "error");
      } else {
        console.warn("Автосохранение в gist не удалось:", error);
      }
    } finally {
      setSyncBusy(false);
    }
  }

  async function autoSync() {
    if (!state.sync.enabled || !hasSyncCredentials() || state.syncBusy) {
      return;
    }

    setSyncBusy(true);
    setSyncState("syncing");

    try {
      const remote = await fetchGist();

      if (remote.updatedAt > state.updatedAt + 1500) {
        applyRemote(remote);
        state.sync.lastSync = Date.now();
        saveSyncSettings();
        setSyncState("ok");
        toast("Загружены изменения с GitHub", "success");
      } else {
        if (state.updatedAt > remote.updatedAt + 1500) {
          const now = Date.now();
          state.updatedAt = now;
          saveMeta();
          await patchGist(now);
        }
        state.sync.lastSync = Date.now();
        saveSyncSettings();
        setSyncState("ok");
      }
    } catch (error) {
      console.warn("Автосинхронизация не удалась:", error);
      setSyncState("error");
    } finally {
      setSyncBusy(false);
    }
  }

  function schedulePush() {
    if (!state.sync.enabled || !hasSyncCredentials()) {
      return;
    }
    if (pushTimer) {
      window.clearTimeout(pushTimer);
    }
    pushTimer = window.setTimeout(function () {
      pushTimer = null;
      syncPush(true);
    }, 1600);
  }

  function disableSync() {
    if (!state.sync.enabled && !state.sync.token && !state.sync.gistId) {
      toast("Синхронизация уже отключена", "info");
      return;
    }

    const approved = window.confirm(
      "Отключить синхронизацию и удалить токен из этого браузера? Данные в gist останутся на GitHub."
    );
    if (!approved) {
      return;
    }

    state.sync.enabled = false;
    state.sync.token = "";
    saveSyncSettings();
    els.syncToken.value = "";
    setSyncState("off");
    toast("Синхронизация отключена", "info");
  }

  function setSyncBusy(busy) {
    state.syncBusy = busy;
    [els.syncCreate, els.syncPull, els.syncPush].forEach(function (button) {
      if (button) {
        button.disabled = busy;
      }
    });
    updateSyncStatus();

    if (!busy && state.pendingPush) {
      state.pendingPush = false;
      window.setTimeout(function () {
        syncPush(true);
      }, 300);
    }
  }

  function setSyncState(next) {
    state.syncState = next;
    updateSyncStatus();
  }

  function updateSyncStatus() {
    if (!els.syncStatus) {
      return;
    }

    let text;
    let kind;

    if (state.syncBusy || state.syncState === "syncing") {
      text = "Синхронизация…";
      kind = "syncing";
    } else if (state.syncState === "error") {
      text = "Ошибка синхронизации. Проверьте токен и подключение.";
      kind = "error";
    } else if (state.sync.enabled && hasSyncCredentials()) {
      text = state.sync.lastSync
        ? "Включена · последняя синхронизация " + formatDate(state.sync.lastSync)
        : "Включена";
      kind = "ok";
    } else {
      text = "Синхронизация отключена";
      kind = "";
    }

    els.syncStatus.textContent = text;
    els.syncStatus.dataset.state = kind;
    els.syncDot.dataset.state = kind;
    els.syncOpen.setAttribute("title", "Синхронизация с GitHub. " + text);
    els.syncOpen.setAttribute(
      "aria-label",
      "Синхронизация с GitHub. " + text
    );

    els.syncDisable.disabled =
      !state.sync.enabled && !state.sync.token && !state.sync.gistId;
    [els.syncCreate, els.syncPull, els.syncPush].forEach(function (button) {
      if (button) {
        button.disabled = state.syncBusy;
      }
    });
  }

  function formatDate(timestamp) {
    try {
      return new Intl.DateTimeFormat("ru-RU", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(timestamp));
    } catch (error) {
      return "только что";
    }
  }

  /* ==========================================================
     Toasts
     ========================================================== */

  function toast(message, type) {
    if (!els.toasts) {
      return;
    }

    const toastType = type || "info";
    const item = document.createElement("div");
    item.className = "toast toast--" + toastType;
    item.setAttribute("role", "status");
    item.textContent = message;

    els.toasts.append(item);
    while (els.toasts.children.length > 4) {
      els.toasts.firstElementChild.remove();
    }

    window.setTimeout(function () {
      item.classList.add("is-leaving");
      window.setTimeout(function () {
        item.remove();
      }, 240);
    }, 3400);
  }
})();
