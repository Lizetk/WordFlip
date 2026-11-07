(function () {
  "use strict";

  const KEYS = {
    words: "wordflip.words.v1",
    settings: "wordflip.settings.v1",
    meta: "wordflip.meta.v1",
    sync: "wordflip.sync.v1"
  };

  const GIST_FILE = "wordflip-data.json";
  const GIST_DESCRIPTION = "WordFlip — flashcards data";
  const FUZZY_THRESHOLD = 0.7;
  const GIST_API = "https://api.github.com";

  const DEMO_WORDS = [
    { english: "apple", russian: "яблоко" },
    { english: "journey", russian: "путешествие" },
    { english: "butterfly", russian: "бабочка" },
    { english: "knowledge", russian: "знание" },
    { english: "friend", russian: "друг" },
    { english: "window", russian: "окно" },
    { english: "sunflower", russian: "подсолнух" },
    { english: "quiet", russian: "тихий" },
    { english: "dream", russian: "мечта" },
    { english: "courage", russian: "смелость" }
  ];

  const state = {
    words: [],
    mode: "en",
    theme: "auto",
    query: "",
    flipped: new Set(),
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function init() {
    cacheElements();
    loadState();
    bindEvents();
    applyTheme();
    renderMode();
    updateDetection();
    render();
    updateSyncStatus();

    if (state.sync.enabled && hasSyncCredentials()) {
      window.setTimeout(autoSync, 700);
    }
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
      emptyState: document.getElementById("empty-state"),
      emptyTitle: document.getElementById("empty-title"),
      emptyText: document.getElementById("empty-text"),
      emptyAction: document.getElementById("empty-action"),

      importOpen: document.getElementById("import-open"),
      exportBtn: document.getElementById("export-btn"),
      importJsonBtn: document.getElementById("import-json-btn"),
      jsonInput: document.getElementById("json-input"),

      importDialog: document.getElementById("import-dialog"),
      importText: document.getElementById("import-text"),
      importSubtitle: document.getElementById("import-subtitle"),
      importStepPaste: document.getElementById("import-step-paste"),
      importStepFill: document.getElementById("import-step-fill"),
      importList: document.getElementById("import-list"),
      importCount: document.getElementById("import-count"),
      importProgress: document.querySelector(".progress"),
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
      if (!document.hidden && state.sync.enabled && hasSyncCredentials()) {
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

    state.words.unshift({ id: uid(), english: english, russian: russian });
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

      front.setAttribute("aria-hidden", String(isFlipped));
      back.setAttribute("aria-hidden", String(!isFlipped));

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

  function createCardFace(kind, badge, word, hint) {
    const face = document.createElement("div");
    face.className = "card__face card__face--" + kind;

    const lang = document.createElement("span");
    lang.className = "card__lang";
    lang.textContent = badge;

    const text = document.createElement("span");
    text.className = "card__word";
    text.textContent = word;

    const note = document.createElement("span");
    note.className = "card__hint";
    note.textContent = hint;

    face.append(lang, text, note);
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
    if (event.target.closest(".card__delete")) {
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
      front.setAttribute("aria-hidden", String(!isFlipped));
    }
    if (back) {
      back.setAttribute("aria-hidden", String(isFlipped));
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
    let skipped = 0;

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
        /^(.+?)\s*(?:\t+|\s+[—–]\s+|\s+-\s+|\s*=\s*|\s*:\s*|\s*;\s*|\s*,\s*)\s*(.+)$/
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
        skipped += 1;
        return;
      }

      const sourceKey = normalize(left);
      if (seenSources.has(sourceKey)) {
        skipped += 1;
        return;
      }
      seenSources.add(sourceKey);

      if (sourceExists(left, info.lang)) {
        skipped += 1;
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

  function parseImport() {
    const parsed = parseImportLines(els.importText.value);
    if (!parsed.items.length) {
      toast(
        parsed.skipped
          ? "Все слова уже есть в словаре или не распознаны"
          : "Вставьте хотя бы одно слово",
        "error"
      );
      return;
    }

    state.pendingImport = parsed.items;
    showImportStep(2);
    updateImportFooter();

    if (parsed.skipped) {
      toast("Пропущено строк: " + parsed.skipped, "info");
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
    let skipped = 0;

    state.pendingImport.forEach(function (item) {
      const translation = cleanText(item.translation);
      const source = cleanText(item.word);
      if (!translation || !source) {
        return;
      }

      const english = item.lang === "en" ? source : translation;
      const russian = item.lang === "ru" ? source : translation;

      if (!english || !russian || normalize(english) === normalize(russian)) {
        skipped += 1;
        return;
      }

      const translationInfo = detectInfo(translation);
      if (!translationInfo.lang || translationInfo.lang === item.lang) {
        skipped += 1;
        return;
      }

      if (sourceExists(source, item.lang)) {
        skipped += 1;
        return;
      }

      const duplicateInBatch = added.some(function (word) {
        return (
          normalize(item.lang === "en" ? word.english : word.russian) ===
          normalize(source)
        );
      });
      if (duplicateInBatch) {
        skipped += 1;
        return;
      }

      added.push({ id: uid(), english: english, russian: russian });
    });

    if (!added.length) {
      toast("Ничего не добавлено: проверьте переводы", "error");
      return;
    }

    state.words = added.concat(state.words);
    saveWords();
    render();
    els.importDialog.close();

    toast(
      "Добавлено " +
        added.length +
        " " +
        wordPlural(added.length) +
        (skipped ? ", пропущено " + skipped : ""),
      "success"
    );
  }

  /* ==========================================================
     JSON export/import
     ========================================================== */

  function exportJson() {
    const data = JSON.stringify(state.words, null, 2);
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
      "Экспортировано " + state.words.length + " " + wordPlural(state.words.length),
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
            : null;

        if (!array) {
          throw new Error("Неверный формат файла");
        }

        const incoming = normalizeWordList(array);
        const existing = new Set(
          state.words.map(function (word) {
            return pairKey(word.english, word.russian);
          })
        );
        const fresh = [];

        incoming.forEach(function (word) {
          const key = pairKey(word.english, word.russian);
          if (!existing.has(key)) {
            existing.add(key);
            fresh.push(word);
          }
        });

        if (!fresh.length) {
          toast("Все слова из файла уже есть в словаре", "info");
          return;
        }

        state.words = fresh.concat(state.words);
        saveWords();
        render();
        toast(
          "Импортировано " + fresh.length + " " + wordPlural(fresh.length),
          "success"
        );
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
    let result = String(value || "").trim();
    if (!result) {
      return "";
    }
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
        version: 1,
        updatedAt: updatedAt,
        words: state.words
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

    const updatedAt =
      Number(data && data.updatedAt) ||
      Date.parse(gist.updated_at || "") ||
      Date.now();

    return {
      words: normalizeWordList(incoming),
      updatedAt: updatedAt
    };
  }

  function applyRemote(remote) {
    state.words = remote.words;
    state.updatedAt = remote.updatedAt || Date.now();
    state.flipped.clear();
    persistWords();
    saveMeta();
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
