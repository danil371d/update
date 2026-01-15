// Popup script для отображения токена и результатов API запроса

// Конфигурация сервера
const SERVER_URL = 'https://alpha-production-5ab0.up.railway.app';

// Режим отладки (включить для диагностики)
const DEBUG_MODE = false;

// Глобальный массив для хранения успешно добавленных профилей (UID и ID)
let successfulProfiles = [];

// Глобальные переменные для модального окна
let successProfilesModal, closeSuccessProfilesModal, successProfilesList, clearSuccessProfilesBtn, maybeSuccessDetailsBtn, checkZeroActionsBtn;

// Функция логирования (только в debug режиме)
function log(...args) {
    if (DEBUG_MODE) {
        console.log('[Alpha Date Extension]', ...args);
    }
}

// Функция логирования ошибок (всегда)
function logError(...args) {
    console.error('[Alpha Date Extension]', ...args);
}

// ===== СИСТЕМА КЕШИРОВАНИЯ ДЛЯ POPUP =====
// Локальный кеш для popup (используем chrome.storage.local для персистентности)
const POPUP_CACHE_TTL = 5 * 60 * 1000; // 5 минут для popup

// Функция получения данных из popup кеша
async function getPopupCache(key) {
    try {
        const cacheKey = `popup_cache_${key}`;
        const result = await chrome.storage.local.get([cacheKey]);

        if (!result[cacheKey]) return null;

        const item = result[cacheKey];
        const now = Date.now();

        if (now - item.timestamp > POPUP_CACHE_TTL) {
            // Кеш устарел, удаляем
            await chrome.storage.local.remove([cacheKey]);
            return null;
        }

        return item.data;
    } catch (error) {
        logError('Ошибка чтения из popup кеша:', error);
        return null;
    }
}

// Функция сохранения данных в popup кеш
async function setPopupCache(key, data) {
    try {
        const cacheKey = `popup_cache_${key}`;
        await chrome.storage.local.set({
            [cacheKey]: {
                data: data,
                timestamp: Date.now()
            }
        });
    } catch (error) {
        logError('Ошибка сохранения в popup кеш:', error);
    }
}

// Функция очистки popup кеша
async function clearPopupCache() {
    try {
        const keys = await chrome.storage.local.get(null);
        const cacheKeys = Object.keys(keys).filter(key => key.startsWith('popup_cache_'));

        if (cacheKeys.length > 0) {
            await chrome.storage.local.remove(cacheKeys);
            log('Popup кеш очищен');
        }
    } catch (error) {
        logError('Ошибка очистки popup кеша:', error);
    }
}

// Проверка авторизации - единственный способ получить доступ к интерфейсу
async function checkAuthStatus() {
    try {
        const response = await chrome.runtime.sendMessage({ type: 'getAuthStatus' });

        if (!response.authorized) {
            // Авторизация не пройдена - блокируем доступ
            showAccessDenied();
            return false;
        }

        // Сохраняем привилегию пользователя глобально
        window.userPrivilege = response.privilege || 'operator';

        // Авторизация активна - загружаем информацию о подписке и инициализируем интерфейс
        await loadSubscriptionInfo();
        await initializeTabsBasedOnPrivilege();
        return true;
    } catch (error) {
        console.error('Ошибка проверки авторизации:', error);
        showAccessDenied();
        return false;
    }
}

// Загрузка и отображение информации о подписке
async function loadSubscriptionInfo() {
    try {
        // Проверяем, что контекст расширения еще валиден
        if (!chrome || !chrome.storage || !chrome.storage.local) {
            console.log('[Subscription] Контекст расширения недействителен, пропускаем проверку');
            return;
    }

        // Получаем session token
        const { sessionToken } = await chrome.storage.local.get(['sessionToken']);
        if (!sessionToken) return;

        // Проверяем, что DOM еще доступен
        const subscriptionInfo = document.getElementById('subscriptionInfo');
        if (!subscriptionInfo) {
            console.log('[Subscription] Элемент subscriptionInfo не найден, пропускаем');
            return;
        }

        // Запрашиваем информацию о подписке
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд таймаут

        const response = await fetch(`${SERVER_URL}/api/subscription-info`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        // Проверяем, что элемент все еще существует (popup мог закрыться)
        if (!document.getElementById('subscriptionInfo')) {
            console.log('[Subscription] Popup закрыт во время запроса, игнорируем результат');
        return;
    }

        if (response.ok) {
            const data = await response.json();

            if (data.has_subscription) {
                let message = '';
                let className = 'subscription-info';

                if (data.is_expired) {
                    message = '⚠️ Подписка истекла';
                    className += ' expired';
                } else if (data.days_remaining !== null) {
                    // Вычисляем точное время: дни + часы
                    const now = new Date();
                    const expiresAt = new Date(data.expires_at);
                    const diffMs = expiresAt - now;
                    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                    const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

                    if (diffDays <= 0 && diffHours <= 0) {
                        message = '⚠️ Подписка истекла';
                        className += ' expired';
                    } else if (diffDays <= 0) {
                        message = `⏰ Осталось ${diffHours} ч`;
                        className += ' warning';
                    } else if (diffDays <= 1) {
                        message = `⏰ Осталось ${diffDays} д ${diffHours} ч`;
                        className += ' warning';
                    } else if (diffDays <= 3) {
                        message = `⏰ Осталось ${diffDays} д ${diffHours} ч`;
                        className += ' warning';
                    } else if (diffDays <= 7) {
                        message = `⏰ Осталось ${diffDays} д`;
                        className += ' warning';
                    } else {
                        message = `✅ Осталось ${diffDays} д`;
            }
        } else {
                    message = '✅ Бессрочная подписка';
        }

                subscriptionInfo.textContent = message;
                subscriptionInfo.className = className;
                subscriptionInfo.style.display = 'block';
            } else {
                subscriptionInfo.textContent = '❌ Подписка не найдена';
                subscriptionInfo.className = 'subscription-info expired';
                subscriptionInfo.style.display = 'block';
        }
        } else {
            // Не показываем ошибку при network ошибках в фоне
            console.log('[Subscription] Не удалось загрузить статус подписки:', response.status);
        }
    } catch (error) {
        // Gracefully обрабатываем ошибки контекста
        if (error.message && error.message.includes('Extension context invalidated')) {
            console.log('[Subscription] Контекст расширения инвалидирован - это нормально');
            return;
        }

        console.error('Ошибка загрузки информации о подписке:', error);

        // Проверяем, что элемент еще существует
        const subscriptionInfo = document.getElementById('subscriptionInfo');
        if (subscriptionInfo) {
            subscriptionInfo.textContent = '❓ Ошибка загрузки статуса подписки';
            subscriptionInfo.className = 'subscription-info';
            subscriptionInfo.style.display = 'block';
                }
            }
}

// Инициализация вкладок в зависимости от привилегии пользователя
async function initializeTabsBasedOnPrivilege() {
    const userPrivilege = window.userPrivilege || 'operator';
    const lordTab = document.querySelector('.lord-tab');

    if (userPrivilege === 'lord') {
        // Показываем вкладку Лорд для пользователей с соответствующей привилегией
        if (lordTab) {
            lordTab.style.display = 'flex';
            console.log('[Alpha Date Extension] Вкладка "Лорд" активирована');
            // Инициализируем функциональность вкладки
            await initializeLordTab();
        }
    } else {
        // Скрываем вкладку Лорд для обычных операторов
        if (lordTab) {
            lordTab.style.display = 'none';
            console.log('[Alpha Date Extension] Вкладка "Лорд" скрыта (недостаточно привилегий)');
        }
    }
}

// Автоматическая проверка статуса подписки
function startSubscriptionStatusCheck() {
    // Для точного отображения времени - проверяем каждую секунду
    const CHECK_INTERVAL = 1 * 1000; // 1 секунда

    let intervalId = null;

    // Функция безопасной проверки
    const safeCheck = () => {
        // Проверяем, что popup все еще открыт и контекст валиден
        if (!document.body || !chrome || !chrome.storage) {
            console.log('[Subscription] Popup закрыт, останавливаем проверки');
            if (intervalId) {
                clearInterval(intervalId);
                intervalId = null;
            }
            return;
        }

        loadSubscriptionInfo();
    };

    // Первая проверка через 1 секунду после загрузки
    const initialTimeout = setTimeout(() => {
        safeCheck();
    }, 1000);

    // Затем проверяем каждые 30 секунд
    intervalId = setInterval(() => {
        safeCheck();
    }, CHECK_INTERVAL);

    // Проверяем при возвращении к расширению (visibilitychange)
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            // Небольшая задержка перед проверкой
            setTimeout(() => {
                safeCheck();
            }, 500);
        }
    });

    // Останавливаем проверки при выгрузке страницы
    window.addEventListener('beforeunload', () => {
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
        clearTimeout(initialTimeout);
    });

    console.log(`[Subscription] Автопроверка статуса каждую секунду (максимальная точность)`);
    console.log(`[Subscription] Дополнительная проверка при возвращении к расширению`);
}

// Показ блокировки доступа
function showAccessDenied() {
    const body = document.body;
    if (body) {
        const container = document.createElement('div');
        container.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 50%, #2a2a2a 100%);
            color: #ffffff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            padding: 20px;
        `;

        const errorBox = document.createElement('div');
        errorBox.style.cssText = `
            text-align: center;
            max-width: 500px;
            background: rgba(255, 255, 255, 0.02);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 16px;
            padding: 40px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
        `;

        const title = document.createElement('h2');
        title.textContent = 'Доступ заблокирован';
        title.style.cssText = 'color: #ff4444; margin-bottom: 20px; font-size: 24px;';

        const message = document.createElement('p');
        message.textContent = 'Требуется авторизация для доступа к системе.';
        message.style.cssText = 'color: #cccccc; margin-bottom: 15px; line-height: 1.5; font-size: 16px;';

        const hint = document.createElement('p');
        hint.textContent = 'Используйте ключ доступа для активации.';
        hint.style.cssText = 'color: #888888; margin-bottom: 30px; font-size: 14px;';

        const authBtn = document.createElement('button');
        authBtn.textContent = 'Авторизоваться';
        authBtn.style.cssText = `
            padding: 16px 32px;
            background: linear-gradient(135deg, #1a1a1a, #2a2a2a);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            color: #ffffff;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
            margin-right: 10px;
        `;
        authBtn.addEventListener('click', () => {
            window.location.href = 'auth.html';
        });

        errorBox.appendChild(title);
        errorBox.appendChild(message);
        errorBox.appendChild(hint);
        errorBox.appendChild(authBtn);
        container.appendChild(errorBox);

        body.innerHTML = '';
        body.appendChild(container);
        }
    }

document.addEventListener('DOMContentLoaded', async function() {
    // Инициализируем глобальные переменные для модального окна
    successProfilesModal = document.getElementById('successProfilesModal');
    closeSuccessProfilesModal = document.getElementById('closeSuccessProfilesModal');
    successProfilesList = document.getElementById('successProfilesList');
    clearSuccessProfilesBtn = document.getElementById('clearSuccessProfilesBtn');
    maybeSuccessDetailsBtn = document.getElementById('maybeSuccessDetailsBtn');
    checkZeroActionsBtn = document.getElementById('checkZeroActionsBtn');


    // Проверяем авторизацию перед загрузкой интерфейса
    const isAuthorized = await checkAuthStatus();
    if (!isAuthorized) {
        return; // showAccessDenied уже заблокировал доступ
    }

    // Запускаем автоматическую проверку статуса подписки
    startSubscriptionStatusCheck();
    const tokenDisplay = document.getElementById('tokenDisplay');
    const responseInfo = document.getElementById('responseInfo');
    const status = document.getElementById('status');
    const monitorStatus = document.getElementById('monitorStatus');
    const monitorToggle = document.getElementById('monitorToggle');
    const statIncomingLikes = document.getElementById('statIncomingLikes');
    const statIncomingWinks = document.getElementById('statIncomingWinks');
    const statIncomingLetters = document.getElementById('statIncomingLetters');
    const statReadMails = document.getElementById('statReadMails');
    const statLimitsUpdates = document.getElementById('statLimitsUpdates');
    const statSuccessfulChatMessages = document.getElementById('statSuccessfulChatMessages');
    const resetStatsBtn = document.getElementById('resetStatsBtn');
    const statsUpdatedInfo = document.getElementById('statsUpdatedInfo');
    const checkVideoBtn = document.getElementById('checkVideoBtn');
    const videoCheckStatus = document.getElementById('videoCheckStatus');
    const checkPhotoBtn = document.getElementById('checkPhotoBtn');
    const photoCheckStatus = document.getElementById('photoCheckStatus');
    const checkMirrorBtn = document.getElementById('checkMirrorBtn');
    const mirrorCheckStatus = document.getElementById('mirrorCheckStatus');
    const mirrorCheckHint = document.getElementById('mirrorCheckHint');
    const refreshBtn = document.getElementById('refreshBtn');
    const broadcastStatus = document.getElementById('broadcastStatus');
    const progressBar = document.getElementById('progressBar');
    const progressLabel = document.getElementById('progressLabel');

    const profilesContainer = document.getElementById('profilesContainer');
    const profilesCount = document.getElementById('profilesCount');

    const tabButtons = document.querySelectorAll('.tab-button');
    const tabSections = document.querySelectorAll('.tab-section');

    // Элементы для уведомлений
    const filterNewMessages = document.getElementById('filterNewMessages');
    const filterLikes = document.getElementById('filterLikes');
    const filterViews = document.getElementById('filterViews');
    const filterLetters = document.getElementById('filterLetters');
    const filterStats = document.getElementById('filterStats');
    const filterBroadcast = document.getElementById('filterBroadcast');
    const filterReadMail = document.getElementById('filterReadMail');
    const filterLimits = document.getElementById('filterLimits');
    const refreshNotifications = document.getElementById('refreshNotifications');
    const clearNotifications = document.getElementById('clearNotifications');
    const notificationsCount = document.getElementById('notificationsCount');
    const notificationsList = document.getElementById('notificationsList');

    // Элементы для общих настроек уведомлений
    const notificationsEnabled = document.getElementById('notificationsEnabled');


    // Элементы для настроек Chrome уведомлений
    const chromeNewMessages = document.getElementById('chromeNewMessages');
    const chromeLikes = document.getElementById('chromeLikes');
    const chromeViews = document.getElementById('chromeViews');
    const chromeLetters = document.getElementById('chromeLetters');
    const chromeStats = document.getElementById('chromeStats');
    const chromeBroadcast = document.getElementById('chromeBroadcast');
    const chromeReadMail = document.getElementById('chromeReadMail');
    const chromeLimits = document.getElementById('chromeLimits');

    // Элементы для управления именами пользователей
    const newUserId = document.getElementById('newUserId');
    const newUserName = document.getElementById('newUserName');
    const addUserNameBtn = document.getElementById('addUserNameBtn');
    const userNamesTableBody = document.getElementById('userNamesTableBody');
    const clearAllNamesBtn = document.getElementById('clearAllNamesBtn');

    // Элементы для автообновления
    const autoRefreshEnabled = document.getElementById('autoRefreshEnabled');

    // Элемент кнопки выхода
    const logoutBtn = document.getElementById('logoutBtn');

    // Элементы для массового добавления в Maybe
    const maybeIdsInput = document.getElementById('maybeIdsInput');
    const addToMaybeBtn = document.getElementById('addToMaybeBtn');
    const maybeStatus = document.getElementById('maybeStatus');
    const maybeLog = document.getElementById('maybeLog');
    const maybeStats = document.getElementById('maybeStats');
    const maybeTotalCount = document.getElementById('maybeTotalCount');
    const maybeSuccessCount = document.getElementById('maybeSuccessCount');
    const maybeNotFoundCount = document.getElementById('maybeNotFoundCount');
    const maybeErrorCount = document.getElementById('maybeErrorCount');

    // Элементы модального окна для деталей успешно добавленных профилей (уже инициализированы глобально)

    // Элементы для поиска по чату
    const extractChatUidBtn = document.getElementById('extractChatUidBtn');
    const currentChatUid = document.getElementById('currentChatUid');
    const loadChatHistoryBtn = document.getElementById('loadChatHistoryBtn');
    const chatSearchProgress = document.getElementById('chatSearchProgress');
    const chatSearchStatus = document.getElementById('chatSearchStatus');
    const chatSearchProgressBar = document.getElementById('chatSearchProgressBar');
    const chatSearchResults = document.getElementById('chatSearchResults');
    const chatMessagesCount = document.getElementById('chatMessagesCount');
    const chatSearchQuery = document.getElementById('chatSearchQuery');
    const searchInChatBtn = document.getElementById('searchInChatBtn');
    const clearChatSearchBtn = document.getElementById('clearChatSearchBtn');
    const chatSearchOutput = document.getElementById('chatSearchOutput');
    
    // Переменная для таймера обратного отсчета рассылки
    let countdownInterval = null;

    // Функции для уведомлений браузера
    async function showBrowserNotification(title, message, options = {}) {
        try {
            // Защищаемся от null/undefined options
            options = options || {};

            // Проверяем, включены ли уведомления для этого типа
            const notificationType = options.type;
            if (notificationType) {
                const settings = await chrome.storage.local.get(['notificationSettings']);
                const notifSettings = settings.notificationSettings || {};

                // Проверяем основной флаг уведомлений
                if (notifSettings.notificationsEnabled === false) {
                    log('Уведомления отключены, пропускаем:', notificationType);
                    return;
                }

                // Проверяем конкретный тип уведомления
                switch (notificationType) {
                    case 'showNewMessages':
                        if (notifSettings.chromeNewMessages === false) return;
                        break;
                    case 'showLetters':
                        if (notifSettings.chromeLetters === false) return;
                        break;
                    case 'showViews':
                        if (notifSettings.chromeViews === false) return;
                        break;
                    case 'showLikes':
                        if (notifSettings.chromeLikes === false) return;
                        break;
                    case 'showErrors':
                        // Ошибки всегда показываем (нет настройки для отключения)
                        break;
                    case 'showStats':
                        if (notifSettings.chromeStats === false) return;
                        break;
                    case 'showBroadcastComplete':
                        if (notifSettings.chromeBroadcast === false) return;
                        break;
                    case 'REACTION_LIMITS':
                    case 'read_mail':
                        if (notifSettings.chromeReadMail === false) return;
                        break;
                    case 'showLimits':
                        if (notifSettings.chromeLimits === false) return;
                        break;
                }
            }

            // Отправляем сообщение в background script для показа уведомления
            await chrome.runtime.sendMessage({
                type: 'showBrowserNotification',
                payload: {
                    title,
                    message,
                    notificationType: options.type || null,
                    options: {
                        priority: options.priority || 0,
                        requireInteraction: options.requireInteraction || false,
                        silent: options.silent || false,
                        ...options
                    }
                }
            });

            // Сохраняем уведомление в историю
            await saveNotificationToHistory({
                title,
                message,
                finalTitle: title,
                finalMessage: message,
                notificationType: options.type || 'unknown'
            });
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка при отправке уведомления:', error);
        }
    }

    // Специализированные функции для разных типов уведомлений
    async function showNewMessageNotification(name, message, chatType = 'chat') {
        await showBrowserNotification(
            `Новое ${chatType === 'chance' ? 'предложение' : 'сообщение'}`,
            `${name}: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`,
            {
                type: 'showNewMessages',
                requireInteraction: true,
                priority: 1
            }
        );
    }

    async function showBroadcastCompleteNotification(successCount, errorCount, totalCount) {
        const title = 'Рассылка завершена';
        const message = `Отправлено: ${successCount}/${totalCount}${errorCount > 0 ? `, ошибок: ${errorCount}` : ''}`;

        await showBrowserNotification(title, message, {
            type: 'showBroadcastComplete',
            requireInteraction: false,
            priority: 0
        });
    }

    async function showErrorNotification(errorMessage) {
        await showBrowserNotification(
            'Ошибка',
            errorMessage.substring(0, 200),
            {
                type: 'showErrors',
                requireInteraction: true,
                priority: 2
            }
        );
    }

    async function showStatsNotification(stats) {
        const message = `❤️ ${stats.incomingLikes} | 👀 ${stats.incomingWinks} | 💌 ${stats.incomingLetters} | 📤 ${stats.successfulMessages}`;

        await showBrowserNotification(
            'Статистика обновлена',
            message,
            {
                type: 'showStats',
                requireInteraction: false,
                priority: 0
            }
        );
    }

    // Функции для работы с историей уведомлений
    async function saveNotificationToHistory(notification) {
        try {
            const data = await chrome.storage.local.get(['notificationsHistory']);
            const history = data.notificationsHistory || [];

            // Добавляем новое уведомление в начало массива
            const notificationWithId = {
                id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                timestamp: new Date().toISOString(),
                ...notification
            };

            history.unshift(notificationWithId);

            // Ограничиваем историю до 100 уведомлений
            if (history.length > 100) {
                history.splice(100);
            }

            await chrome.storage.local.set({ notificationsHistory: history });
            log('Уведомление сохранено в историю:', notificationWithId);

            // Обновляем таблицу уведомлений если вкладка активна
            if (document.querySelector('.tab-button[data-tab="notifications"].active')) {
                await loadNotifications();
            }
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка сохранения уведомления в историю:', error);
        }
    }




    // Функция для проверки наличия chat_uid на текущей странице
    async function checkVideoButtonAvailability() {
        if (!checkVideoBtn) return;
        
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tabs || !tabs[0] || !tabs[0].url || !tabs[0].url.includes('alpha.date')) {
                checkVideoBtn.disabled = true;
                const videoCheckHint = document.getElementById('videoCheckHint');
                if (videoCheckHint) {
                    videoCheckHint.textContent = 'Откройте страницу alpha.date для проверки видео';
                    videoCheckHint.style.color = '#ff4d4f';
                }
                return;
            }

            // Проверяем, есть ли chat_uid в URL или это страница /letter
            const url = tabs[0].url;
            const chatMatch = url.match(/\/(chat|chance)\/([^\/\?]+)/);
            const letterMatch = url.includes('/letter');
            if ((chatMatch && chatMatch[2]) || letterMatch) {
                checkVideoBtn.disabled = false;
                const videoCheckHint = document.getElementById('videoCheckHint');
                if (videoCheckHint) {
                    videoCheckHint.textContent = 'Готово к проверке';
                    videoCheckHint.style.color = '#00ff88';
                }
            } else {
                checkVideoBtn.disabled = true;
                const videoCheckHint = document.getElementById('videoCheckHint');
                if (videoCheckHint) {
                    videoCheckHint.textContent = 'Откройте страницу чата (/chat/, /chance/) или письма (/letter/), чтобы активировать проверку';
                    videoCheckHint.style.color = '#a0a0a0';
                }
            }
        } catch (e) {
            console.error('Ошибка проверки доступности кнопки:', e);
            checkVideoBtn.disabled = true;
        }
    }

    async function checkPhotoButtonAvailability() {
        if (!checkPhotoBtn) return;

        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tabs || !tabs[0] || !tabs[0].url || !tabs[0].url.includes('alpha.date')) {
                checkPhotoBtn.disabled = true;
                const photoCheckHint = document.getElementById('photoCheckHint');
                if (photoCheckHint) {
                    photoCheckHint.textContent = 'Откройте страницу alpha.date для проверки фото';
                    photoCheckHint.style.color = '#ff4d4f';
                }
                return;
            }

            // Проверяем, есть ли chat_uid в URL или это страница /letter
            const url = tabs[0].url;
            const chatMatch = url.match(/\/(chat|chance)\/([^\/\?]+)/);
            const letterMatch = url.includes('/letter');
            if ((chatMatch && chatMatch[2]) || letterMatch) {
                checkPhotoBtn.disabled = false;
                const photoCheckHint = document.getElementById('photoCheckHint');
                if (photoCheckHint) {
                    photoCheckHint.textContent = 'Готово к проверке';
                    photoCheckHint.style.color = '#00ff88';
                }
            } else {
                checkPhotoBtn.disabled = true;
                const photoCheckHint = document.getElementById('photoCheckHint');
                if (photoCheckHint) {
                    photoCheckHint.textContent = 'Откройте страницу чата (/chat/, /chance/) или письма (/letter/), чтобы активировать проверку';
                    photoCheckHint.style.color = '#a0a0a0';
                }
            }
        } catch (e) {
            console.error('Ошибка проверки доступности кнопки:', e);
            checkPhotoBtn.disabled = true;
        }
    }

    // Функция для проверки доступности кнопки проверки зеркала
    async function checkMirrorButtonAvailability() {
        if (!checkMirrorBtn) return;
        
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tabs || !tabs[0] || !tabs[0].url || !tabs[0].url.includes('alpha.date')) {
                checkMirrorBtn.disabled = true;
                if (mirrorCheckHint) {
                    mirrorCheckHint.textContent = 'Откройте страницу alpha.date для проверки зеркала';
                    mirrorCheckHint.style.color = '#ff4d4f';
                }
                return;
            }

            // Проверяем, есть ли chat_uid в URL
            const url = tabs[0].url;
            const chatMatch = url.match(/\/(chat|chance)\/([^\/\?]+)/);
            if (chatMatch && chatMatch[2]) {
                checkMirrorBtn.disabled = false;
                if (mirrorCheckHint) {
                    mirrorCheckHint.textContent = 'Готово к проверке';
                    mirrorCheckHint.style.color = '#00ff88';
                }
            } else {
                checkMirrorBtn.disabled = true;
                if (mirrorCheckHint) {
                    mirrorCheckHint.textContent = 'Откройте страницу чата (/chat/ или /chance/), чтобы активировать проверку';
                    mirrorCheckHint.style.color = '#a0a0a0';
                }
            }
        } catch (e) {
            console.error('Ошибка проверки доступности кнопки зеркала:', e);
            checkMirrorBtn.disabled = true;
        }
    }

    function setActiveTab(tabName) {
        tabButtons.forEach((btn) => {
            if (btn.dataset.tab === tabName) {
                btn.classList.add('active');
                } else {
                btn.classList.remove('active');
                }
            });

        tabSections.forEach((section) => {
            if (section.dataset.tab === tabName) {
                section.classList.add('active');
            } else {
                section.classList.remove('active');
            }
            });

        // При переключении на вкладку "checks" проверяем доступность кнопок
        if (tabName === 'checks') {
            checkVideoButtonAvailability();
            checkPhotoButtonAvailability();
            checkMirrorButtonAvailability();
        }

        // При переключении на вкладку "monitoring" загружаем уведомления и настройки
        if (tabName === 'monitoring') {
            loadNotifications();
            loadNotificationSettings();
        }

        // При переключении на вкладку "checks" активируем кнопки проверок
        if (tabName === 'checks') {
            checkVideoButtonAvailability();
            checkPhotoButtonAvailability();
            checkMirrorButtonAvailability();
        }
        
        // При переключении на вкладку "broadcast" обновляем статус планировщика
        if (tabName === 'broadcast' && typeof updateScheduledBroadcastStatus === 'function') {
            updateScheduledBroadcastStatus();
            startCountdownTimer(); // Запускаем таймер обратного отсчета
        } else {
            stopCountdownTimer(); // Останавливаем таймер при переключении на другую вкладку
        }
    }

    if (tabButtons.length && tabSections.length) {
        tabButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab || 'profiles';
                setActiveTab(tab);
            });
        });
        // Стартовая вкладка — "Анкеты"
        setActiveTab('profiles');
            }

    // Локальный кэш текстов по анкетам:
    // { [externalId]: { chat?: string, letter?: string, winkReply?: string, likeReply?: string } }
    let profileBroadcastMessages = {};
    // Дефолтные тексты из персонального листа (Chat/Letter) по external_id
    let profileDefaultChatTexts = {};
    let profileDefaultLetterTexts = {};
    // Флаг, что сейчас идёт глобальная рассылка
    let isBroadcastingAll = false;
    
    // ===== СИНХРОНИЗАЦИЯ АВТО-ОТВЕТОВ С СЕРВЕРОМ =====
    let isSyncing = false; // Флаг для предотвращения параллельных синхронизаций
    let skipNextStorageSync = false; // Флаг для пропуска синхронизации после загрузки с сервера
    
    /**
     * Получает вкладку alpha.date (активную или любую)
     */
    async function getAlphaDateTab() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && tab.url && tab.url.includes('alpha.date')) {
                return tab;
            }
            // Попробуем найти любую вкладку alpha.date
            const alphaTabs = await chrome.tabs.query({ url: '*://*.alpha.date/*' });
            if (alphaTabs.length > 0) {
                return alphaTabs[0];
            }
            return null;
        } catch (error) {
            console.warn('[Sync] Ошибка поиска вкладки alpha.date:', error);
            return null;
        }
    }
    
    /**
     * Получает email оператора из localStorage сайта alpha.date через content script
     */
    async function getOperatorEmail() {
        try {
            const tab = await getAlphaDateTab();
            if (!tab) {
                console.log('[Sync] Вкладка alpha.date не найдена');
                return null;
            }
            
            // Получаем email через content script
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'getOperatorEmail' });
            if (response && response.email) {
                return response.email;
            }
            return null;
        } catch (error) {
            console.warn('[Sync] Ошибка получения email оператора:', error);
            return null;
        }
    }
    
    /**
     * Вызывает синхронизацию авто-ответов через content script
     */
    async function triggerSyncViaContentScript(direction = 'download') {
        try {
            const tab = await getAlphaDateTab();
            if (!tab) {
                console.log('[Sync] Вкладка alpha.date не найдена для синхронизации');
                return false;
            }
            
            const response = await chrome.tabs.sendMessage(tab.id, { 
                type: 'syncAutoReplies', 
                direction: direction 
            });
            
            if (response && response.ok) {
                console.log('[Sync] ✅ Синхронизация через content script:', response);
                return response.synced;
            }
            return false;
        } catch (error) {
            console.warn('[Sync] Ошибка синхронизации через content script:', error);
            return false;
        }
    }
    
    /**
     * Синхронизирует авто-ответы на сервер (СРАЗУ, без задержки)
     * Привязка по email оператора (одинаковый для админа и оператора)
     */
    async function syncAutoRepliesToServer() {
        if (isSyncing) {
            console.log('[Sync] Синхронизация уже выполняется, пропускаем...');
            return false;
        }
        
        isSyncing = true;
        try {
            const operatorEmail = await getOperatorEmail();
            if (!operatorEmail) {
                console.log('[Sync] Email оператора не найден, синхронизация пропущена');
                return false;
            }
            
            // Получаем актуальные данные из storage
            const data = await chrome.storage.local.get(['profileBroadcastMessages']);
            const autoReplies = data.profileBroadcastMessages || {};
            
            // Собираем авто-ответы (включая пустые поля для синхронизации удалений)
            const autoRepliesOnly = {};
            for (const [profileId, config] of Object.entries(autoReplies)) {
                const filtered = {};
                // Всегда включаем все поля - пустые значения тоже важны для синхронизации
                filtered.winkReply = config.winkReply || '';
                filtered.winkPhotoUrl = config.winkPhotoUrl || '';
                filtered.winkPhotoFilename = config.winkPhotoFilename || '';
                filtered.winkPhotoContentId = config.winkPhotoContentId || '';
                filtered.likeReply = config.likeReply || '';
                filtered.likePhotoUrl = config.likePhotoUrl || '';
                filtered.likePhotoFilename = config.likePhotoFilename || '';
                filtered.likePhotoContentId = config.likePhotoContentId || '';
                filtered.viewReply = config.viewReply || '';
                filtered.viewPhotoUrl = config.viewPhotoUrl || '';
                filtered.viewPhotoFilename = config.viewPhotoFilename || '';
                filtered.viewPhotoContentId = config.viewPhotoContentId || '';
                
                // Проверяем есть ли хоть что-то непустое (чтобы не создавать пустые профили)
                const hasAnyValue = Object.values(filtered).some(v => v && v.length > 0);
                if (hasAnyValue) {
                    autoRepliesOnly[profileId] = filtered;
                }
            }
            
            console.log('[Sync] 📤 Отправка авто-ответов на сервер для:', operatorEmail, ', профилей:', Object.keys(autoRepliesOnly).length);
            
            const response = await fetch(`${SERVER_URL}/api/sync-autoreplies`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    operator_email: operatorEmail,
                    auto_replies: autoRepliesOnly
                })
            });
            
            if (response.ok) {
                const result = await response.json();
                console.log('[Sync] ✅ Авто-ответы синхронизированы:', result);
                return true;
            } else {
                const error = await response.text();
                console.error('[Sync] ❌ Ошибка синхронизации:', response.status, error);
                return false;
            }
        } catch (error) {
            console.error('[Sync] ❌ Ошибка отправки авто-ответов:', error);
            return false;
        } finally {
            isSyncing = false;
        }
    }
    
    /**
     * Загружает авто-ответы с сервера и ПОЛНОСТЬЮ ЗАМЕНЯЕТ локальные
     * Привязка по email оператора
     */
    async function loadAutoRepliesFromServer() {
        try {
            const operatorEmail = await getOperatorEmail();
            if (!operatorEmail) {
                console.log('[Sync] Email оператора не найден, загрузка с сервера пропущена');
                return false;
            }

            // Проверяем кеш авто-ответов
            const cacheKey = `autoreplies_${operatorEmail}`;
            const cachedData = await getPopupCache(cacheKey);

            if (cachedData) {
                console.log('[Sync] 📋 Используем кешированные авто-ответы для:', operatorEmail);

                // Применяем кешированные данные
                const localData = await chrome.storage.local.get(['profileBroadcastMessages']);
                const localMessages = localData.profileBroadcastMessages || {};

                // Список авто-ответ полей
                const autoReplyFields = [
                    'winkReply', 'winkPhotoUrl', 'winkPhotoFilename', 'winkPhotoContentId',
                    'likeReply', 'likePhotoUrl', 'likePhotoFilename', 'likePhotoContentId',
                    'viewReply', 'viewPhotoUrl', 'viewPhotoFilename', 'viewPhotoContentId'
                ];

                // Применяем кешированные авто-ответы
                for (const [profileId, replies] of Object.entries(cachedData.auto_replies)) {
                    if (!localMessages[profileId]) {
                        localMessages[profileId] = {};
                    }

                    for (const field of autoReplyFields) {
                        if (replies[field]) {
                            localMessages[profileId][field] = replies[field];
                        }
                    }
                }

                // Сохраняем обновленные данные
                await chrome.storage.local.set({ profileBroadcastMessages: localMessages });
                console.log('[Sync] ✅ Кешированные авто-ответы применены, профилей:', Object.keys(cachedData.auto_replies).length);

                return true;
            }

            console.log('[Sync] 📥 Загрузка авто-ответов с сервера для:', operatorEmail);

            const response = await fetch(`${SERVER_URL}/api/sync-autoreplies`, {
                method: 'GET',
                headers: {
                    'X-Operator-Email': operatorEmail
                }
            });

            if (response.ok) {
                const result = await response.json();

                // Кешируем результат
                await setPopupCache(cacheKey, result);

                if (result.found && result.auto_replies && Object.keys(result.auto_replies).length > 0) {
                    console.log('[Sync] ✅ Авто-ответы загружены с сервера, профилей:', result.profiles_count);

                    // Получаем локальные данные
                    const localData = await chrome.storage.local.get(['profileBroadcastMessages']);
                    const localMessages = localData.profileBroadcastMessages || {};

                    // Список авто-ответ полей
                    const autoReplyFields = [
                        'winkReply', 'winkPhotoUrl', 'winkPhotoFilename', 'winkPhotoContentId',
                        'likeReply', 'likePhotoUrl', 'likePhotoFilename', 'likePhotoContentId',
                        'viewReply', 'viewPhotoUrl', 'viewPhotoFilename', 'viewPhotoContentId'
                    ];

                    // Удаляем авто-ответы из всех локальных профилей
                    for (const profileId of Object.keys(localMessages)) {
                        for (const field of autoReplyFields) {
                            delete localMessages[profileId][field];
                        }
                        // Если профиль пустой - удаляем его
                        if (Object.keys(localMessages[profileId]).length === 0) {
                            delete localMessages[profileId];
                        }
                    }
                    
                    // Теперь добавляем серверные авто-ответы
                    for (const [profileId, serverConfig] of Object.entries(result.auto_replies)) {
                        if (!localMessages[profileId]) {
                            localMessages[profileId] = {};
                        }
                        Object.assign(localMessages[profileId], serverConfig);
                    }
                    
                    // Пропускаем следующую синхронизацию на сервер (чтобы не создавать цикл)
                    skipNextStorageSync = true;
                    
                    // Сохраняем данные локально
                    await chrome.storage.local.set({ profileBroadcastMessages: localMessages });
                    
                    // Обновляем локальную переменную
                    profileBroadcastMessages = localMessages;
                    
                    console.log('[Sync] ✅ Авто-ответы полностью заменены серверными');
                    return true;
                } else {
                    console.log('[Sync] На сервере нет сохраненных авто-ответов');
                    return false;
                }
            } else {
                const error = await response.text();
                console.warn('[Sync] Ошибка загрузки с сервера:', response.status, error);
                return false;
            }
        } catch (error) {
            console.warn('[Sync] Ошибка загрузки авто-ответов:', error);
            return false;
        }
    }
    
    /**
     * Сохраняет авто-ответы локально И синхронизирует на сервер
     */
    async function saveAndSyncAutoReplies() {
        await chrome.storage.local.set({ profileBroadcastMessages });
        // Сразу синхронизируем на сервер (через content script для надежности)
        syncAutoRepliesToServer();
        triggerSyncViaContentScript('upload');
    }
    
    // Слушаем изменения в storage и автоматически синхронизируем
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes.profileBroadcastMessages) {
            // Пропускаем если это было обновление с сервера
            if (skipNextStorageSync) {
                skipNextStorageSync = false;
                console.log('[Sync] Пропускаем синхронизацию (данные пришли с сервера)');
                return;
            }
            console.log('[Sync] Обнаружено изменение авто-ответов, синхронизируем на сервер...');
            // Синхронизируем и из popup и через content script
            syncAutoRepliesToServer();
            triggerSyncViaContentScript('upload');
        }
    });
    
    // Загружаем авто-ответы с сервера при старте popup
    // Сначала пробуем через content script, потом напрямую
    (async () => {
        console.log('[Sync] 🔄 Запуск синхронизации авто-ответов при старте popup...');
        
        // Пробуем через content script (более надежно)
        const syncedViaContentScript = await triggerSyncViaContentScript('download');
        if (syncedViaContentScript) {
            console.log('[Sync] ✅ Авто-ответы загружены через content script');
            // Обновляем локальную переменную
            const data = await chrome.storage.local.get(['profileBroadcastMessages']);
            profileBroadcastMessages = data.profileBroadcastMessages || {};
            return;
        }
        
        // Если не удалось через content script - пробуем напрямую
        const loaded = await loadAutoRepliesFromServer();
        if (loaded) {
            console.log('[Sync] ✅ Авто-ответы загружены напрямую с сервера');
        } else {
            console.log('[Sync] ℹ️ Авто-ответы не загружены (возможно, нет данных на сервере)');
        }
    })();
    // ===== КОНЕЦ БЛОКА СИНХРОНИЗАЦИИ =====

    function applyBroadcastState(state) {
        if (!progressBar || !progressLabel) {
            return;
        }

        if (!state) {
            isBroadcastingAll = false;
            progressBar.style.width = '0%';
            progressLabel.textContent = 'Рассылка не запущена';
            if (status) {
                status.textContent = 'Готово';
            }
            if (broadcastStatus) {
                broadcastStatus.textContent = '';
            }
            return;
        }

        const total = state.total || (state.queue && state.queue.length) || 0;
        const index = state.index || 0;

        if (state.status === 'running') {
            isBroadcastingAll = true;
            const currentNum = total ? Math.min(index + 1, total) : index + 1;
            const name =
                state.currentProfileName ||
                (state.queue && state.queue[index] && state.queue[index].profileName) ||
                state.lastProfileName ||
                '';

            const label = total
                ? `Анкета ${currentNum}/${total} — ${name || ''}`
                : `Анкета ${currentNum} — ${name || ''}`;

            // Рассчитываем процент выполнения (используем index/total, но показываем текущую анкету)
            const percent = total > 0 ? Math.round((index / total) * 100) : 0;
            progressBar.style.width = `${Math.min(Math.max(percent, 0), 100)}%`;
            progressLabel.textContent = `Рассылка: ${label}`;

            if (status) {
                status.textContent = `Рассылка: ${label}`;
            }
            if (broadcastStatus) {
                broadcastStatus.textContent = `Рассылка: ${label}`;
            }
        } else if (state.status === 'finished') {
            isBroadcastingAll = false;
            progressBar.style.width = '100%';
            progressLabel.textContent = 'Рассылка завершена';
            if (status) {
                status.textContent = 'Рассылка завершена';
            }
            if (broadcastStatus) {
                broadcastStatus.textContent = 'Рассылка завершена';
            }
            
            // Через 3 секунды сбрасываем прогресс-бар
            setTimeout(() => {
                if (progressBar && progressLabel) {
                    progressBar.style.width = '0%';
                    progressLabel.textContent = 'Рассылка не запущена';
                }
            }, 3000);
        }
    }

    // Используем делегирование событий для обработки кликов по кнопкам сообщений и рассылки
    // Добавляем один раз при загрузке страницы
    profilesContainer.addEventListener('click', async function(e) {
        const toggle = e.target.closest('.messages-toggle');
        if (toggle) {
            e.stopPropagation();
            const toggleId = toggle.getAttribute('data-toggle-id');
            const messagesListId = toggle.getAttribute('data-messages-id');
            const messagesList = document.getElementById(messagesListId);
            const toggleIcon = document.getElementById(toggleId);
            
            if (messagesList && toggleIcon) {
                const card = toggle.closest('.profile-card');
                const externalId = card ? card.dataset.externalId : null;
                
                if (messagesList.classList.contains('expanded')) {
                    messagesList.classList.remove('expanded');
                    toggleIcon.classList.remove('expanded');
                    if (externalId) {
                        await saveCardState(externalId, 'messages', 'collapsed');
                    }
                } else {
                    messagesList.classList.add('expanded');
                    toggleIcon.classList.add('expanded');
                    if (externalId) {
                        await saveCardState(externalId, 'messages', 'expanded');
                    }
                }
            }
            return;
        }

        const broadcastBtn = e.target.closest('.broadcast-btn');
        if (broadcastBtn) {
            e.stopPropagation();
            const externalId = broadcastBtn.getAttribute('data-external-id');
            const profileName = broadcastBtn.getAttribute('data-name') || externalId || 'профиль';

            // Берём индивидуальный текст или дефолт из персонального листа (Chat)
            const profileCfg = profileBroadcastMessages[externalId] || {};
            let text = profileCfg.chat || '';
            if (!text && profileDefaultChatTexts[externalId]) {
                text = profileDefaultChatTexts[externalId];
            }

            // Если совсем нет текста — в крайнем случае спросим вручную
            if (!text) {
                text = prompt(`Текст рассылки для ${profileName}:`, '');
                if (!text) {
                    return;
                }
                if (!profileBroadcastMessages[externalId]) {
                    profileBroadcastMessages[externalId] = {};
                }
                profileBroadcastMessages[externalId].chat = text;
                chrome.storage.local.set({ profileBroadcastMessages });
                const textarea = profilesContainer.querySelector(`.profile-message-input[data-external-id="${externalId}"]`);
                if (textarea) {
                    textarea.value = text;
                }
            }

            await startBroadcastForProfile(externalId, profileName, text, 'chat');
            return;
        }

        const letterBtn = e.target.closest('.broadcast-letter-btn');
        if (letterBtn) {
            e.stopPropagation();
            const externalId = letterBtn.getAttribute('data-external-id');
            const profileName = letterBtn.getAttribute('data-name') || externalId || 'профиль';

            const profileCfg = profileBroadcastMessages[externalId] || {};
            let text = profileCfg.letter || '';
            if (!text && profileDefaultLetterTexts[externalId]) {
                text = profileDefaultLetterTexts[externalId];
            }

            if (!text) {
                text = prompt(`Текст письма для ${profileName}:`, '');
                if (!text) {
                    return;
                }
                if (!profileBroadcastMessages[externalId]) {
                    profileBroadcastMessages[externalId] = {};
                }
                profileBroadcastMessages[externalId].letter = text;
                chrome.storage.local.set({ profileBroadcastMessages });
                const textarea = profilesContainer.querySelector(`.profile-message-input-letter[data-external-id="${externalId}"]`);
                if (textarea) {
                    textarea.value = text;
                }
            }

            if (text.length < 300) {
                alert('Текст письма должен быть минимум 300 символов.');
                return;
            }

            await startBroadcastForProfile(externalId, profileName, text, 'letter');
        }
    });

    // Обработка изменений в текстах по анкетам (рассылки + автоответы)
    profilesContainer.addEventListener('input', function(e) {
        const chatInput = e.target.closest('.profile-message-input-chat');
        const letterInput = e.target.closest('.profile-message-input-letter');
        const winkInput = e.target.closest('.profile-auto-wink-input');
        const likeInput = e.target.closest('.profile-auto-like-input');
        const viewInput = e.target.closest('.profile-auto-view-input');

        if (!chatInput && !letterInput && !winkInput && !likeInput && !viewInput) return;

        const input = chatInput || letterInput || winkInput || likeInput || viewInput;
        const externalId = input.getAttribute('data-external-id');
        if (!externalId) return;

        if (!profileBroadcastMessages[externalId]) {
            profileBroadcastMessages[externalId] = {};
        }

        if (chatInput) {
            profileBroadcastMessages[externalId].chat = chatInput.value;
        }
        if (letterInput) {
            profileBroadcastMessages[externalId].letter = letterInput.value;
        }
        if (winkInput) {
            profileBroadcastMessages[externalId].winkReply = winkInput.value;
        }
        if (likeInput) {
            profileBroadcastMessages[externalId].likeReply = likeInput.value;
        }
        if (viewInput) {
            profileBroadcastMessages[externalId].viewReply = viewInput.value;
        }

        chrome.storage.local.set({ profileBroadcastMessages });
    });



    async function startBroadcastForProfile(externalId, profileName, text, kind = 'chat', existingTabId) {
        try {
            const [tab] = existingTabId
                ? [ { id: existingTabId } ]
                : await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab || typeof tab.id !== 'number') {
                status.textContent = 'Откройте вкладку alpha.date для рассылки';
                return { ok: false, error: 'no_tab' };
            }

            status.textContent = `Рассылка запущена для ${profileName}...`;
            if (broadcastStatus) {
                broadcastStatus.textContent = `Рассылка для анкеты ${profileName} запущена`;
            }
            if (progressLabel && !isBroadcastingAll) {
                progressLabel.textContent = `Рассылка для анкеты ${profileName} запущена`;
            }

            const response = await new Promise(resolve => {
                chrome.tabs.sendMessage(
                    tab.id,
                    {
                        type: 'startBroadcast',
                        payload: {
                            externalId,
                            profileName,
                            message: text,
                            kind,
                        },
                    },
                    (resp) => {
                        if (chrome.runtime.lastError) {
                            console.error('Ошибка при запуске рассылки:', chrome.runtime.lastError);
                            resolve({ ok: false, error: chrome.runtime.lastError.message });
                        } else {
                            resolve(resp || { ok: false, error: 'no_response' });
                        }
                    }
                );
            });

            if (response && response.ok) {
                const s = response.stats || {};
                const msg = `Рассылка завершена для ${profileName}: отправлено ${s.sent || 0} из ${s.targets || 0}`;
                status.textContent = msg;
                if (broadcastStatus) {
                    broadcastStatus.textContent = msg;
                }
            } else {
                const msg = `Ошибка рассылки для ${profileName}: ${(response && response.error) || ''}`;
                status.textContent = msg;
                if (broadcastStatus) {
                    broadcastStatus.textContent = msg;
                }
            }

            return response;
        } catch (error) {
            console.error('Ошибка при запуске рассылки:', error);
            status.textContent = 'Ошибка запуска рассылки';
            return { ok: false, error: error.message || String(error) };
        }
    }

    // Функция для отображения анкет с сообщениями
    async function renderProfiles(profilesData, senderListData = []) {
        profilesContainer.innerHTML = '';
        
        if (!profilesData || !Array.isArray(profilesData) || profilesData.length === 0) {
            profilesContainer.innerHTML = '<div class="no-profiles">Анкеты не найдены</div>';
            profilesCount.style.display = 'none';
            return;
        }

        // Группируем сообщения по woman_external_id
        const messagesByProfile = {};
        if (senderListData && Array.isArray(senderListData)) {
            senderListData.forEach(message => {
                const profileId = message.woman_external_id;
                if (profileId) {
                    if (!messagesByProfile[profileId]) {
                        messagesByProfile[profileId] = [];
                    }
                    messagesByProfile[profileId].push(message);
                }
            });
        }

        // Показываем количество
        const count = profilesData.length;
        profilesCount.textContent = `${count} ${count === 1 ? 'анкета' : count < 5 ? 'анкеты' : 'анкет'}`;
        profilesCount.style.display = 'inline-block';

        // Очищаем дефолтные тексты
        profileDefaultChatTexts = {};
        profileDefaultLetterTexts = {};

        // Загружаем сохраненные состояния карточек один раз
        const savedCardStates = await chrome.storage.local.get(['profileCardStates']);
        const cardStates = savedCardStates.profileCardStates || {};

        // Создаём карточки для каждой анкеты
        profilesData.forEach((profile, index) => {
            const card = document.createElement('div');
            card.className = 'profile-card';

            // Извлекаем данные
            const name = profile.name || profile.first_name || profile.full_name || 'Неизвестно';
            const age = profile.age !== undefined && profile.age !== null ? profile.age : 'N/A';
            const id = profile.id || profile._id || 'N/A';
            const externalId = profile.external_id || profile.externalId || 'N/A';

            const ageDisplay = age !== 'N/A' ? `${age} лет` : 'N/A';
            
            // Получаем сообщения для этой анкеты
            const profileMessages = messagesByProfile[externalId] || [];
            const chatMessages = profileMessages.filter(m => m.sender_type === 'Chat');
            const letterMessages = profileMessages.filter(m => m.sender_type === 'Letter');
            const totalMessages = profileMessages.length;

            // Сохраняем дефолтный текст из персонального листа (Chat/Letter) для этой анкеты
            if (chatMessages.length > 0) {
                const defaultChat = chatMessages[0].message_content || '';
                if (defaultChat) {
                    profileDefaultChatTexts[externalId] = defaultChat;
                }
            }
            if (letterMessages.length > 0) {
                const defaultLetter = letterMessages[0].message_content || '';
                if (defaultLetter) {
                    profileDefaultLetterTexts[externalId] = defaultLetter;
                }
            }

            // Формируем HTML для сообщений
            let messagesHTML = '';
            if (totalMessages > 0) {
                const messagesListId = `messages-${index}`;
                const toggleId = `toggle-${index}`;
                
                messagesHTML = `
                    <div class="profile-messages">
                        <div class="messages-toggle" data-toggle-id="${toggleId}" data-messages-id="${messagesListId}">
                            <div class="messages-toggle-text">
                                Сообщения
                                <span class="messages-count">${totalMessages}</span>
                                ${chatMessages.length > 0 ? `<span style="margin-left: 8px; color: #00a6ff;">Chat: ${chatMessages.length}</span>` : ''}
                                ${letterMessages.length > 0 ? `<span style="margin-left: 8px; color: #ff9f40;">Letter: ${letterMessages.length}</span>` : ''}
                            </div>
                            <div class="toggle-icon" id="${toggleId}">▼</div>
                        </div>
                        <div class="messages-list" id="${messagesListId}">
                            ${profileMessages.map(message => {
                                const isLetter = message.sender_type === 'Letter';
                                const createdAt = message.created_at ? 
                                    new Date(message.created_at).toLocaleString('ru-RU', {
                                        year: 'numeric',
                                        month: '2-digit',
                                        day: '2-digit',
                                        hour: '2-digit',
                                        minute: '2-digit'
                                    }) : 'N/A';
                                
                                return `
                                    <div class="message-item ${isLetter ? 'letter' : ''}">
                                        <div class="message-item-header">
                                            <div class="message-type-badge ${isLetter ? 'letter' : 'chat'}">
                                                ${message.sender_type || 'Unknown'}
                                            </div>
                                            <div class="message-invite">Invite: ${message.invite_id || 'N/A'}</div>
                                        </div>
                                        <div class="message-text">${message.message_content || 'Нет текста'}</div>
                                        <div class="message-date">${createdAt}</div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                `;
            }
            
            // Проверяем наличие автоответов (используем сохраненные данные)
            // Учитываем и текст, и фото
            const savedCfg = profileBroadcastMessages[externalId] || {};
            const hasAutoreplies = !!(savedCfg.winkReply || savedCfg.winkPhotoUrl || 
                                     savedCfg.likeReply || savedCfg.likePhotoUrl || 
                                     savedCfg.viewReply || savedCfg.viewPhotoUrl);
            
            card.innerHTML = `
                <button class="profile-card-toggle" data-external-id="${externalId}"></button>
                <div class="profile-header">
                    <div class="profile-name">${name}</div>
                    <div class="profile-age">${ageDisplay}</div>
                </div>
                <div class="profile-status-indicators">
                    ${totalMessages > 0 ? '<span class="status-badge has-messages">📨 Сообщения</span>' : ''}
                    ${hasAutoreplies ? '<span class="status-badge has-autoreplies">✅ Автоответы</span>' : '<span class="status-badge no-autoreplies">⚠️ Нет автоответов</span>'}
                </div>
                <div class="profile-details">
                    <div class="profile-detail-item">
                        <div class="profile-detail-label">ID</div>
                        <div class="profile-detail-value">${id}</div>
                    </div>
                    <div class="profile-detail-item">
                        <div class="profile-detail-label">External ID</div>
                        <div class="profile-detail-value">${externalId}</div>
                    </div>
                </div>
                <div class="profile-actions">
                    <div class="profile-actions-column">
                        <div class="profile-actions-label">Чат (Chance)</div>
                        <textarea class="profile-message-input profile-message-input-chat" data-external-id="${externalId}" placeholder="Текст для чата (если пусто — из персонального списка Chat)"></textarea>
                        <button class="broadcast-btn" data-external-id="${externalId}" data-name="${name}">
                            Рассылка Chance
                        </button>
                    </div>
                    <div class="profile-actions-column">
                        <div class="profile-actions-label">Письмо (минимум 300 символов)</div>
                        <textarea class="profile-message-input profile-message-input-letter" data-external-id="${externalId}" placeholder="Текст письма (если пусто — из персонального списка Letter, если есть)"></textarea>
                        <button class="broadcast-letter-btn" data-external-id="${externalId}" data-name="${name}">
                            Рассылка писем
                        </button>
                    </div>
                </div>
                <div class="autoreplies-section">
                    <div class="autoreplies-toggle" data-external-id="${externalId}">
                        <span class="autoreplies-toggle-text">⚙️ Автоответы</span>
                        <span class="autoreplies-toggle-icon">▼</span>
                    </div>
                    <div class="autoreplies-content" data-external-id="${externalId}">
                        <div class="profile-actions-column">
                            <div class="profile-actions-label">Автоответ на WINK</div>
                            <textarea class="profile-message-input profile-auto-wink-input" data-external-id="${externalId}" placeholder="Текст автоответа на WINK"></textarea>
                            <div class="wink-photo-preview" data-external-id="${externalId}" data-type="wink" style="margin-top: 8px;">
                                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                                    <button type="button" class="wink-photo-select-btn" data-external-id="${externalId}" style="padding: 6px 12px; background: rgba(0, 122, 255, 0.2); border: 1px solid rgba(0, 122, 255, 0.4); border-radius: 6px; color: #00a6ff; font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.2s ease;">
                                        📷 Выбрать фото
                                    </button>
                                    <div class="wink-photo-status" data-external-id="${externalId}" style="font-size: 11px; color: #a0a0a0;">Фото не выбрано</div>
                                </div>
                                <div class="wink-photo-preview-content" data-external-id="${externalId}" style="display: none;">
                                    <img class="wink-photo-preview-img" style="max-width: 150px; max-height: 150px; border-radius: 8px; border: 2px solid rgba(0, 166, 255, 0.5); display: block;">
                                    <div style="margin-top: 4px; font-size: 11px; color: #00ff88;">✓ Фото выбрано</div>
                                    <button type="button" class="wink-photo-remove-btn" data-external-id="${externalId}" style="margin-top: 4px; padding: 4px 8px; font-size: 11px; background: rgba(255, 77, 79, 0.3); border: 1px solid rgba(255, 77, 79, 0.5); border-radius: 4px; color: #ff4d4f; cursor: pointer;">Удалить фото</button>
                                </div>
                            </div>
                        </div>
                        <div class="profile-actions-column">
                            <div class="profile-actions-label">Автоответ на LIKE</div>
                            <textarea class="profile-message-input profile-auto-like-input" data-external-id="${externalId}" placeholder="Текст автоответа на LIKE"></textarea>
                            <div class="wink-photo-preview" data-external-id="${externalId}" data-type="like" style="margin-top: 8px;">
                                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                                    <button type="button" class="like-photo-select-btn" data-external-id="${externalId}" style="padding: 6px 12px; background: rgba(0, 122, 255, 0.2); border: 1px solid rgba(0, 122, 255, 0.4); border-radius: 6px; color: #00a6ff; font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.2s ease;">
                                        📷 Выбрать фото
                                    </button>
                                    <div class="like-photo-status" data-external-id="${externalId}" style="font-size: 11px; color: #a0a0a0;">Фото не выбрано</div>
                                </div>
                                <div class="like-photo-preview-content" data-external-id="${externalId}" style="display: none;">
                                    <img class="like-photo-preview-img" style="max-width: 150px; max-height: 150px; border-radius: 8px; border: 2px solid rgba(0, 166, 255, 0.5); display: block;">
                                    <div style="margin-top: 4px; font-size: 11px; color: #00ff88;">✓ Фото выбрано</div>
                                    <button type="button" class="like-photo-remove-btn" data-external-id="${externalId}" style="margin-top: 4px; padding: 4px 8px; font-size: 11px; background: rgba(255, 77, 79, 0.3); border: 1px solid rgba(255, 77, 79, 0.5); border-radius: 4px; color: #ff4d4f; cursor: pointer;">Удалить фото</button>
                                </div>
                            </div>
                        </div>
                        <div class="profile-actions-column" style="flex: 1 1 100%;">
                            <div class="profile-actions-label">Автоответ на просмотр профиля (CHANCE)</div>
                            <textarea class="profile-message-input profile-auto-view-input" data-external-id="${externalId}" placeholder="Текст автоответа на просмотр профиля в Chance"></textarea>
                            <div class="wink-photo-preview" data-external-id="${externalId}" data-type="view" style="margin-top: 8px;">
                                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                                    <button type="button" class="view-photo-select-btn" data-external-id="${externalId}" style="padding: 6px 12px; background: rgba(0, 122, 255, 0.2); border: 1px solid rgba(0, 122, 255, 0.4); border-radius: 6px; color: #00a6ff; font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.2s ease;">
                                        📷 Выбрать фото
                                    </button>
                                    <div class="view-photo-status" data-external-id="${externalId}" style="font-size: 11px; color: #a0a0a0;">Фото не выбрано</div>
                                </div>
                                <div class="view-photo-preview-content" data-external-id="${externalId}" style="display: none;">
                                    <img class="view-photo-preview-img" style="max-width: 150px; max-height: 150px; border-radius: 8px; border: 2px solid rgba(0, 166, 255, 0.5); display: block;">
                                    <div style="margin-top: 4px; font-size: 11px; color: #00ff88;">✓ Фото выбрано</div>
                                    <button type="button" class="view-photo-remove-btn" data-external-id="${externalId}" style="margin-top: 4px; padding: 4px 8px; font-size: 11px; background: rgba(255, 77, 79, 0.3); border: 1px solid rgba(255, 77, 79, 0.5); border-radius: 4px; color: #ff4d4f; cursor: pointer;">Удалить фото</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                ${messagesHTML}
            `;
            
            // Восстанавливаем состояние карточки из сохраненных данных
            const savedState = cardStates[externalId] || {};
            if (savedState.card === 'expanded') {
                card.classList.remove('compact');
            } else {
                card.classList.add('compact');
            }
            card.setAttribute('data-external-id', externalId);

            profilesContainer.appendChild(card);

            // Восстанавливаем состояние списка сообщений (после добавления в DOM)
            const messagesList = card.querySelector('.messages-list');
            const messagesToggle = card.querySelector('.messages-toggle');
            if (messagesList && messagesToggle) {
                const savedMessagesState = savedState.messages;
                if (savedMessagesState === 'expanded') {
                    messagesList.classList.add('expanded');
                    const toggleIcon = messagesToggle.querySelector('.toggle-icon');
                    if (toggleIcon) {
                        toggleIcon.classList.add('expanded');
                    }
                } else {
                    messagesList.classList.remove('expanded');
                    const toggleIcon = messagesToggle.querySelector('.toggle-icon');
                    if (toggleIcon) {
                        toggleIcon.classList.remove('expanded');
                    }
                }
            }

            // Проставляем стартовые тексты: сохранённые или дефолтные из Chat/Letter и автоответы
            const textareaChat = card.querySelector('.profile-message-input-chat');
            const textareaLetter = card.querySelector('.profile-message-input-letter');
            const textareaWink = card.querySelector('.profile-auto-wink-input');
            const textareaLike = card.querySelector('.profile-auto-like-input');
            const textareaView = card.querySelector('.profile-auto-view-input');

            const cfg = profileBroadcastMessages[externalId] || {};

            if (textareaChat) {
                const savedChat = cfg.chat || '';
                const defaultChatText = profileDefaultChatTexts[externalId] || '';
                textareaChat.value = savedChat || defaultChatText || '';
            }

            if (textareaLetter) {
                const savedLetter = cfg.letter || '';
                const defaultLetterText = profileDefaultLetterTexts[externalId] || '';
                textareaLetter.value = savedLetter || defaultLetterText || '';
            }

            if (textareaWink) {
                const savedWink = cfg.winkReply || '';
                textareaWink.value = savedWink || '';
            }
            
            // Обработка выбора фото для винка
            const winkPhotoSelectBtn = card.querySelector(`.wink-photo-select-btn[data-external-id="${externalId}"]`);
            const winkPhotoPreview = card.querySelector(`.wink-photo-preview[data-external-id="${externalId}"][data-type="wink"]`);
            const winkPhotoPreviewContent = winkPhotoPreview ? winkPhotoPreview.querySelector('.wink-photo-preview-content') : null;
            const winkPhotoPreviewImg = winkPhotoPreviewContent ? winkPhotoPreviewContent.querySelector('.wink-photo-preview-img') : null;
            const winkPhotoRemoveBtn = card.querySelector(`.wink-photo-remove-btn[data-external-id="${externalId}"]`);
            const winkPhotoStatus = card.querySelector(`.wink-photo-status[data-external-id="${externalId}"]`);
            
            // Загружаем сохраненное фото если есть
            if (cfg.winkPhotoUrl && cfg.winkPhotoUrl.startsWith('http') && winkPhotoPreviewContent && winkPhotoPreviewImg) {
                winkPhotoPreviewContent.style.display = 'block';
                winkPhotoPreviewImg.src = cfg.winkPhotoUrl;
                winkPhotoPreviewImg.alt = cfg.winkPhotoFilename || 'photo';
                if (winkPhotoStatus) {
                    winkPhotoStatus.textContent = '✓ Фото выбрано';
                    winkPhotoStatus.style.color = '#00ff88';
                }
            }
            
            // Обработчик кнопки выбора фото для WINK
            if (winkPhotoSelectBtn) {
                winkPhotoSelectBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await openPhotoGallery(externalId, 'wink');
                });
            }
            
            // Обработчик удаления фото
            if (winkPhotoRemoveBtn) {
                winkPhotoRemoveBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!profileBroadcastMessages[externalId]) {
                        profileBroadcastMessages[externalId] = {};
                    }
                    delete profileBroadcastMessages[externalId].winkPhotoUrl;
                    delete profileBroadcastMessages[externalId].winkPhotoFilename;
                    delete profileBroadcastMessages[externalId].winkPhotoContentId;
                    await chrome.storage.local.set({ profileBroadcastMessages });
                    
                    if (winkPhotoPreviewContent) {
                        winkPhotoPreviewContent.style.display = 'none';
                    }
                    if (winkPhotoStatus) {
                        winkPhotoStatus.textContent = 'Фото не выбрано';
                        winkPhotoStatus.style.color = '#a0a0a0';
                    }
                });
            }

            if (textareaLike) {
                const savedLike = cfg.likeReply || '';
                textareaLike.value = savedLike || '';
            }
            
            // Обработка выбора фото для LIKE
            const likePhotoSelectBtn = card.querySelector(`.like-photo-select-btn[data-external-id="${externalId}"]`);
            const likePhotoPreview = card.querySelector(`.wink-photo-preview[data-external-id="${externalId}"][data-type="like"]`);
            const likePhotoPreviewContent = likePhotoPreview ? likePhotoPreview.querySelector('.like-photo-preview-content') : null;
            const likePhotoPreviewImg = likePhotoPreviewContent ? likePhotoPreviewContent.querySelector('.like-photo-preview-img') : null;
            const likePhotoRemoveBtn = card.querySelector(`.like-photo-remove-btn[data-external-id="${externalId}"]`);
            const likePhotoStatus = card.querySelector(`.like-photo-status[data-external-id="${externalId}"]`);
            
            // Загружаем сохраненное фото если есть
            if (cfg.likePhotoUrl && cfg.likePhotoUrl.startsWith('http') && likePhotoPreviewContent && likePhotoPreviewImg) {
                likePhotoPreviewContent.style.display = 'block';
                likePhotoPreviewImg.src = cfg.likePhotoUrl;
                likePhotoPreviewImg.alt = cfg.likePhotoFilename || 'photo';
                if (likePhotoStatus) {
                    likePhotoStatus.textContent = '✓ Фото выбрано';
                    likePhotoStatus.style.color = '#00ff88';
                }
            }
            
            // Обработчик кнопки выбора фото для LIKE
            if (likePhotoSelectBtn) {
                likePhotoSelectBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await openPhotoGallery(externalId, 'like');
                });
            }
            
            // Обработчик удаления фото для LIKE
            if (likePhotoRemoveBtn) {
                likePhotoRemoveBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!profileBroadcastMessages[externalId]) {
                        profileBroadcastMessages[externalId] = {};
                    }
                    delete profileBroadcastMessages[externalId].likePhotoUrl;
                    delete profileBroadcastMessages[externalId].likePhotoFilename;
                    delete profileBroadcastMessages[externalId].likePhotoContentId;
                    await chrome.storage.local.set({ profileBroadcastMessages });
                    
                    if (likePhotoPreviewContent) {
                        likePhotoPreviewContent.style.display = 'none';
                    }
                    if (likePhotoStatus) {
                        likePhotoStatus.textContent = 'Фото не выбрано';
                        likePhotoStatus.style.color = '#a0a0a0';
                    }
                });
            }

            if (textareaView) {
                const savedView = cfg.viewReply || '';
                textareaView.value = savedView || '';
            }
            
            // Обработка выбора фото для VIEW
            const viewPhotoSelectBtn = card.querySelector(`.view-photo-select-btn[data-external-id="${externalId}"]`);
            const viewPhotoPreview = card.querySelector(`.wink-photo-preview[data-external-id="${externalId}"][data-type="view"]`);
            const viewPhotoPreviewContent = viewPhotoPreview ? viewPhotoPreview.querySelector('.view-photo-preview-content') : null;
            const viewPhotoPreviewImg = viewPhotoPreviewContent ? viewPhotoPreviewContent.querySelector('.view-photo-preview-img') : null;
            const viewPhotoRemoveBtn = card.querySelector(`.view-photo-remove-btn[data-external-id="${externalId}"]`);
            const viewPhotoStatus = card.querySelector(`.view-photo-status[data-external-id="${externalId}"]`);
            
            // Загружаем сохраненное фото если есть
            if (cfg.viewPhotoUrl && cfg.viewPhotoUrl.startsWith('http') && viewPhotoPreviewContent && viewPhotoPreviewImg) {
                viewPhotoPreviewContent.style.display = 'block';
                viewPhotoPreviewImg.src = cfg.viewPhotoUrl;
                viewPhotoPreviewImg.alt = cfg.viewPhotoFilename || 'photo';
                if (viewPhotoStatus) {
                    viewPhotoStatus.textContent = '✓ Фото выбрано';
                    viewPhotoStatus.style.color = '#00ff88';
                }
            }
            
            // Обработчик кнопки выбора фото для VIEW
            if (viewPhotoSelectBtn) {
                viewPhotoSelectBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await openPhotoGallery(externalId, 'view');
                });
            }
            
            // Обработчик удаления фото для VIEW
            if (viewPhotoRemoveBtn) {
                viewPhotoRemoveBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!profileBroadcastMessages[externalId]) {
                        profileBroadcastMessages[externalId] = {};
                    }
                    delete profileBroadcastMessages[externalId].viewPhotoUrl;
                    delete profileBroadcastMessages[externalId].viewPhotoFilename;
                    delete profileBroadcastMessages[externalId].viewPhotoContentId;
                    await chrome.storage.local.set({ profileBroadcastMessages });
                    
                    if (viewPhotoPreviewContent) {
                        viewPhotoPreviewContent.style.display = 'none';
                    }
                    if (viewPhotoStatus) {
                        viewPhotoStatus.textContent = 'Фото не выбрано';
                        viewPhotoStatus.style.color = '#a0a0a0';
                    }
                });
            }
            
            // Обработчик кнопки свернуть/развернуть карточку
            const toggleBtn = card.querySelector('.profile-card-toggle');
            if (toggleBtn) {
                toggleBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    card.classList.toggle('compact');
                    // Сохраняем состояние карточки
                    await saveCardState(externalId, 'card', card.classList.contains('compact') ? 'compact' : 'expanded');
                });
            }
            
            // Обработчик аккордеона автоответов
            const autorepliesToggle = card.querySelector('.autoreplies-toggle');
            const autorepliesContent = card.querySelector('.autoreplies-content');
            if (autorepliesToggle && autorepliesContent) {
                // Восстанавливаем состояние аккордеона автоответов
                const savedAutorepliesState = savedState.autoreplies;
                if (savedAutorepliesState === 'expanded') {
                    autorepliesToggle.classList.add('expanded');
                    autorepliesContent.classList.add('expanded');
                } else if (savedAutorepliesState === 'collapsed') {
                    autorepliesToggle.classList.remove('expanded');
                    autorepliesContent.classList.remove('expanded');
                } else {
                    // Если состояние не сохранено, используем старое поведение: разворачиваем если есть автоответы
                    const currentCfg = profileBroadcastMessages[externalId] || {};
                    const hasAnyAutoreply = !!(currentCfg.winkReply || currentCfg.winkPhotoUrl || 
                                             currentCfg.likeReply || currentCfg.likePhotoUrl || 
                                             currentCfg.viewReply || currentCfg.viewPhotoUrl);
                    if (hasAnyAutoreply) {
                        autorepliesToggle.classList.add('expanded');
                        autorepliesContent.classList.add('expanded');
                    }
                }
                
                autorepliesToggle.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const isExpanded = autorepliesToggle.classList.contains('expanded');
                    if (isExpanded) {
                        autorepliesToggle.classList.remove('expanded');
                        autorepliesContent.classList.remove('expanded');
                        await saveCardState(externalId, 'autoreplies', 'collapsed');
                    } else {
                        autorepliesToggle.classList.add('expanded');
                        autorepliesContent.classList.add('expanded');
                        await saveCardState(externalId, 'autoreplies', 'expanded');
                    }
                });
            }
        });
        
        // Добавляем обработчики поиска и фильтров
        setupSearchAndFilters();
    }
    
        // Настройка поиска и фильтров
    function setupSearchAndFilters() {
        const searchInput = document.getElementById('profileSearchInput');
        const filterBtns = document.querySelectorAll('.filter-btn');
        
        if (searchInput) {
            searchInput.addEventListener('input', applyFilters);
        }
        
        filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                filterBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                applyFilters();
            });
        });
        
        // Обработчики кнопок сворачивания/разворачивания всех карточек
        const collapseAllBtn = document.getElementById('collapseAllBtn');
        const expandAllBtn = document.getElementById('expandAllBtn');
        
        if (collapseAllBtn) {
            collapseAllBtn.addEventListener('click', async () => {
                const cards = document.querySelectorAll('.profile-card');
                const cardStates = {};
                cards.forEach(card => {
                    const externalId = card.dataset.externalId;
                    if (externalId) {
                        // Сворачиваем карточку
                        card.classList.add('compact');
                        cardStates[externalId] = {
                            card: 'compact',
                            autoreplies: 'collapsed',
                            messages: 'collapsed'
                        };
                        
                        // Сворачиваем аккордеон автоответов
                        const autorepliesToggle = card.querySelector('.autoreplies-toggle');
                        const autorepliesContent = card.querySelector('.autoreplies-content');
                        if (autorepliesToggle && autorepliesContent) {
                            autorepliesToggle.classList.remove('expanded');
                            autorepliesContent.classList.remove('expanded');
                        }
                        
                        // Сворачиваем список сообщений
                        const messagesList = card.querySelector('.messages-list');
                        const messagesToggle = card.querySelector('.messages-toggle');
                        if (messagesList && messagesToggle) {
                            messagesList.classList.remove('expanded');
                            const toggleIcon = messagesToggle.querySelector('.toggle-icon');
                            if (toggleIcon) {
                                toggleIcon.classList.remove('expanded');
                            }
                        }
                    }
                });
                await chrome.storage.local.set({ profileCardStates: cardStates });
            });
        }
        
        if (expandAllBtn) {
            expandAllBtn.addEventListener('click', async () => {
                const cards = document.querySelectorAll('.profile-card');
                const cardStates = {};
                cards.forEach(card => {
                    const externalId = card.dataset.externalId;
                    if (externalId) {
                        // Разворачиваем карточку
                        card.classList.remove('compact');
                        cardStates[externalId] = {
                            card: 'expanded',
                            autoreplies: 'expanded',
                            messages: 'expanded'
                        };
                        
                        // Разворачиваем аккордеон автоответов
                        const autorepliesToggle = card.querySelector('.autoreplies-toggle');
                        const autorepliesContent = card.querySelector('.autoreplies-content');
                        if (autorepliesToggle && autorepliesContent) {
                            autorepliesToggle.classList.add('expanded');
                            autorepliesContent.classList.add('expanded');
                        }
                        
                        // Разворачиваем список сообщений
                        const messagesList = card.querySelector('.messages-list');
                        const messagesToggle = card.querySelector('.messages-toggle');
                        if (messagesList && messagesToggle) {
                            messagesList.classList.add('expanded');
                            const toggleIcon = messagesToggle.querySelector('.toggle-icon');
                            if (toggleIcon) {
                                toggleIcon.classList.add('expanded');
                            }
                        }
                    }
                });
                await chrome.storage.local.set({ profileCardStates: cardStates });
            });
        }
    }
    
    // Функция сохранения состояния карточки
    async function saveCardState(externalId, stateType, state) {
        try {
            const saved = await chrome.storage.local.get(['profileCardStates']);
            const cardStates = saved.profileCardStates || {};
            if (!cardStates[externalId]) {
                cardStates[externalId] = {};
            }
            cardStates[externalId][stateType] = state;
            await chrome.storage.local.set({ profileCardStates: cardStates });
        } catch (error) {
            console.error('Ошибка сохранения состояния карточки:', error);
        }
    }
    
    // Открытие галереи фото
    let currentPhotoGalleryExternalId = null;
    let currentPhotoGalleryType = 'wink'; // 'wink', 'like', 'view'
    let selectedPhoto = null;
    
    async function openPhotoGallery(externalId, photoType = 'wink') {
        currentPhotoGalleryExternalId = externalId;
        currentPhotoGalleryType = photoType || 'wink';
        selectedPhoto = null;
        
        const modal = document.getElementById('photoGalleryModal');
        const grid = document.getElementById('photoGalleryGrid');
        const selectBtn = document.getElementById('photoGallerySelect');
        const closeBtn = document.getElementById('photoGalleryClose');
        
        if (!modal || !grid) return;
        
        modal.classList.add('active');
        grid.innerHTML = '<div class="photo-gallery-loading">Загрузка фото...</div>';
        selectBtn.disabled = true;
        
        // Обновляем заголовок в зависимости от типа
        const titleEl = document.getElementById('photoGalleryTitle');
        if (titleEl) {
            const typeNames = {
                'wink': 'WINK',
                'like': 'LIKE',
                'view': 'просмотр профиля'
            };
            titleEl.textContent = `Выберите фото для автоответа на ${typeNames[photoType] || 'WINK'}`;
        }
        
        // Скрываем статус выбора при открытии
        const selectedStatus = document.getElementById('photoGallerySelectedStatus');
        if (selectedStatus) {
            selectedStatus.style.display = 'none';
        }
        
        // Загружаем список фото
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tabs || !tabs[0] || !tabs[0].url || !tabs[0].url.includes('alpha.date')) {
                grid.innerHTML = '<div class="photo-gallery-loading" style="color: #ff4d4f;">Откройте страницу alpha.date</div>';
                return;
            }
            
            const response = await chrome.tabs.sendMessage(tabs[0].id, {
                type: 'getImagesList',
                externalId: externalId
            });
            
            console.log('[Photo Gallery] Ответ от API:', response);
            
            if (response && response.ok && response.images) {
                console.log('[Photo Gallery] Получено фото:', response.images.length);
                displayPhotoGallery(response.images, grid, selectBtn);
            } else {
                console.error('[Photo Gallery] Ошибка:', response);
                grid.innerHTML = '<div class="photo-gallery-loading" style="color: #ff4d4f;">Ошибка загрузки фото: ' + (response?.error || JSON.stringify(response) || 'Неизвестная ошибка') + '</div>';
            }
        } catch (error) {
            console.error('Ошибка загрузки фото:', error);
            grid.innerHTML = '<div class="photo-gallery-loading" style="color: #ff4d4f;">Ошибка: ' + (error.message || 'Неизвестная ошибка') + '</div>';
        }
        
        // Обработчик закрытия
        if (closeBtn) {
            closeBtn.onclick = () => {
                modal.classList.remove('active');
            };
        }
        
        // Обработчик выбора
        if (selectBtn) {
            selectBtn.onclick = async () => {
                if (selectedPhoto && currentPhotoGalleryExternalId) {
                    const extId = currentPhotoGalleryExternalId;
                    const photoType = currentPhotoGalleryType || 'wink';
                    
                    if (!profileBroadcastMessages[extId]) {
                        profileBroadcastMessages[extId] = {};
                    }
                    
                    // Сохраняем фото в зависимости от типа
                    if (photoType === 'wink') {
                        profileBroadcastMessages[extId].winkPhotoUrl = selectedPhoto.link;
                        profileBroadcastMessages[extId].winkPhotoFilename = selectedPhoto.filename;
                        profileBroadcastMessages[extId].winkPhotoContentId = selectedPhoto.id || null;
                    } else if (photoType === 'like') {
                        profileBroadcastMessages[extId].likePhotoUrl = selectedPhoto.link;
                        profileBroadcastMessages[extId].likePhotoFilename = selectedPhoto.filename;
                        profileBroadcastMessages[extId].likePhotoContentId = selectedPhoto.id || null;
                    } else if (photoType === 'view') {
                        profileBroadcastMessages[extId].viewPhotoUrl = selectedPhoto.link;
                        profileBroadcastMessages[extId].viewPhotoFilename = selectedPhoto.filename;
                        profileBroadcastMessages[extId].viewPhotoContentId = selectedPhoto.id || null;
                    }
                    
                    console.log('[Photo Gallery] Сохранено фото для', photoType, ':', {
                        url: selectedPhoto.link,
                        filename: selectedPhoto.filename,
                        contentId: selectedPhoto.id
                    });
                    await chrome.storage.local.set({ profileBroadcastMessages });
                    
                    // Показываем подтверждение выбора
                    const selectedStatus = document.getElementById('photoGallerySelectedStatus');
                    if (selectedStatus) {
                        selectedStatus.style.display = 'block';
                    }
                    
                    // Обновляем превью в карточке в зависимости от типа
                    const card = document.querySelector(`.profile-card[data-external-id="${extId}"]`);
                    if (card) {
                        let preview, previewContent, previewImg, photoStatus;
                        
                        if (photoType === 'wink') {
                            preview = card.querySelector(`.wink-photo-preview[data-external-id="${extId}"][data-type="wink"]`);
                            previewContent = preview ? preview.querySelector('.wink-photo-preview-content') : null;
                            previewImg = previewContent ? previewContent.querySelector('.wink-photo-preview-img') : null;
                            photoStatus = card.querySelector(`.wink-photo-status[data-external-id="${extId}"]`);
                        } else if (photoType === 'like') {
                            preview = card.querySelector(`.wink-photo-preview[data-external-id="${extId}"][data-type="like"]`);
                            previewContent = preview ? preview.querySelector('.like-photo-preview-content') : null;
                            previewImg = previewContent ? previewContent.querySelector('.like-photo-preview-img') : null;
                            photoStatus = card.querySelector(`.like-photo-status[data-external-id="${extId}"]`);
                        } else if (photoType === 'view') {
                            preview = card.querySelector(`.wink-photo-preview[data-external-id="${extId}"][data-type="view"]`);
                            previewContent = preview ? preview.querySelector('.view-photo-preview-content') : null;
                            previewImg = previewContent ? previewContent.querySelector('.view-photo-preview-img') : null;
                            photoStatus = card.querySelector(`.view-photo-status[data-external-id="${extId}"]`);
                        }
                        
                        if (previewContent && previewImg) {
                            previewContent.style.display = 'block';
                            previewImg.src = selectedPhoto.link;
                            previewImg.alt = selectedPhoto.filename;
                        }
                        if (photoStatus) {
                            photoStatus.textContent = '✓ Фото выбрано';
                            photoStatus.style.color = '#00ff88';
                        }
                    }
                    
                    // Закрываем модальное окно через небольшую задержку, чтобы пользователь увидел подтверждение
                    setTimeout(() => {
                        modal.classList.remove('active');
                    }, 500);
                }
            };
        }
    }
    
    function displayPhotoGallery(images, grid, selectBtn) {
        console.log('[Photo Gallery] Отображение фото, всего:', images?.length);
        
        if (!images || images.length === 0) {
            grid.innerHTML = '<div class="photo-gallery-loading">Фото не найдены</div>';
            return;
        }
        
        // Фильтруем только изображения
        const imageItems = images.filter(img => {
            const contentType = img.content_type || img.contentType || '';
            return contentType === 'image' || contentType === 'Image' || !contentType;
        });
        
        console.log('[Photo Gallery] Отфильтровано изображений:', imageItems.length);
        
        if (imageItems.length === 0) {
            grid.innerHTML = '<div class="photo-gallery-loading">Изображения не найдены (возможно, все файлы другого типа)</div>';
            return;
        }
        
        grid.innerHTML = '';
        
        // Оптимизация: создаем элементы порциями для лучшей производительности
        const batchSize = 50;
        let currentIndex = 0;
        
        function renderBatch() {
            const endIndex = Math.min(currentIndex + batchSize, imageItems.length);
            
            for (let i = currentIndex; i < endIndex; i++) {
                const image = imageItems[i];
                const item = document.createElement('div');
                item.className = 'photo-gallery-item';
                const imageLink = image.link || image.url || '';
                const imageFilename = image.filename || image.name || 'photo';
                
                item.innerHTML = `
                    <img src="${imageLink}" alt="${imageFilename}" loading="lazy" decoding="async">
                    <div class="photo-gallery-item-name">${imageFilename}</div>
                `;
                
                item.addEventListener('click', () => {
                    // Убираем выделение с других
                    grid.querySelectorAll('.photo-gallery-item').forEach(el => {
                        el.classList.remove('selected');
                    });
                    // Выделяем выбранное
                    item.classList.add('selected');
                    selectedPhoto = image;
                    if (selectBtn) {
                        selectBtn.disabled = false;
                    }
                    
                    // Скрываем статус при выборе нового фото (пока не подтверждено)
                    const selectedStatus = document.getElementById('photoGallerySelectedStatus');
                    if (selectedStatus) {
                        selectedStatus.style.display = 'none';
                    }
                    
                    console.log('[Photo Gallery] Выбрано фото:', image);
                });
                
                grid.appendChild(item);
            }
            
            currentIndex = endIndex;
            
            // Продолжаем рендеринг если есть еще элементы
            if (currentIndex < imageItems.length) {
                // Используем requestAnimationFrame для плавной загрузки
                requestAnimationFrame(renderBatch);
            }
        }
        
        // Начинаем рендеринг
        renderBatch();
    }
    
    // Применение фильтров и поиска
    function applyFilters() {
        const searchInput = document.getElementById('profileSearchInput');
        const activeFilter = document.querySelector('.filter-btn.active');
        const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
        const filterType = activeFilter ? activeFilter.dataset.filter : 'all';
        
        const cards = document.querySelectorAll('.profile-card');
        cards.forEach(card => {
            const externalId = card.dataset.externalId || '';
            const name = card.querySelector('.profile-name')?.textContent?.toLowerCase() || '';
            const id = card.querySelector('.profile-detail-value')?.textContent?.toLowerCase() || '';
            
            // Поиск
            const matchesSearch = !searchTerm || 
                name.includes(searchTerm) || 
                id.includes(searchTerm) || 
                externalId.includes(searchTerm);
            
            // Фильтры
            let matchesFilter = true;
            const savedCfg = profileBroadcastMessages[externalId] || {};
            
            if (filterType === 'with-messages') {
                const hasMessages = card.querySelector('.status-badge.has-messages');
                matchesFilter = !!hasMessages;
            } else if (filterType === 'without-messages') {
                const hasMessages = card.querySelector('.status-badge.has-messages');
                matchesFilter = !hasMessages;
            } else if (filterType === 'with-autoreplies') {
                const hasAutoreplies = card.querySelector('.status-badge.has-autoreplies');
                matchesFilter = !!hasAutoreplies;
            } else if (filterType === 'without-wink') {
                // Без автоответа на винк (нет ни текста, ни фото)
                const hasWink = !!(savedCfg.winkReply || savedCfg.winkPhotoUrl);
                matchesFilter = !hasWink;
            } else if (filterType === 'without-like') {
                // Без автоответа на лайк (нет ни текста, ни фото)
                const hasLike = !!(savedCfg.likeReply || savedCfg.likePhotoUrl);
                matchesFilter = !hasLike;
            } else if (filterType === 'without-view') {
                // Без автоответа на просмотр профиля (нет ни текста, ни фото)
                const hasView = !!(savedCfg.viewReply || savedCfg.viewPhotoUrl);
                matchesFilter = !hasView;
            }
            
            if (matchesSearch && matchesFilter) {
                card.classList.remove('hidden');
            } else {
                card.classList.add('hidden');
            }
        });
    }


    // Функция для обновления данных
    async function updateData() {
        status.textContent = 'Обновление...';
        
        try {
            // Получаем данные из storage
            const result = await chrome.storage.local.get([
                'token',
                'profilesResponse',
                'senderListResponse',
                'lastUpdate',
                'broadcastState',
                'profileBroadcastMessages',
                'monitorState',
                'stats',
            ]);
            
            // Отображаем статус токена (без самого токена)
            if (tokenDisplay) {
                if (result.token) {
                    tokenDisplay.textContent = 'Токен найден';
                    tokenDisplay.classList.remove('empty');
                } else {
                    tokenDisplay.textContent = 'Токен не найден';
                    tokenDisplay.classList.add('empty');
                }
            }

            // Отображаем статус мониторинга
            const ms = result.monitorState || {};
            const enabled = ms.enabled !== false; // по умолчанию включен
            if (monitorStatus) {
                if (ms.running && enabled) {
                    monitorStatus.textContent = 'Мониторинг сообщений: включен';
                    monitorStatus.style.color = '#00ff88';
                } else if (enabled) {
                    monitorStatus.textContent = 'Мониторинг сообщений: включен (ожидание следующей проверки)';
                    monitorStatus.style.color = '#00ff88';
                } else {
                    monitorStatus.textContent = 'Мониторинг сообщений: выключен';
                    monitorStatus.style.color = '#a0a0a0';
                }
            }

            if (monitorToggle) {
                monitorToggle.checked = enabled;
            }


            // Отображаем статистику (улучшенная версия)
            const stats = result.stats || {};
            const likes = stats.incomingLikes || 0;
            const winks = stats.incomingWinks || 0;
            const letters = stats.incomingLetters || 0;
            const readMails = stats.readMails || 0;
            const limitsUpdates = stats.limitsUpdates || 0;

            if (statIncomingLikes) {
                statIncomingLikes.textContent = String(likes);
            }
            if (statIncomingWinks) {
                statIncomingWinks.textContent = String(winks);
            }
            if (statIncomingLetters) {
                statIncomingLetters.textContent = String(letters);
            }
            if (statReadMails) {
                statReadMails.textContent = String(readMails);
            }
            if (statLimitsUpdates) {
                statLimitsUpdates.textContent = String(limitsUpdates);
            }
            
            const successfulChats = stats.successfulChatMessages || 0;
            if (statSuccessfulChatMessages) {
                statSuccessfulChatMessages.textContent = String(successfulChats);
            }
            
            // Обновляем быстрый статус
            if (quickStatus) {
                const ms = result.monitorState || {};
                const enabled = ms.enabled !== false;
                if (ms.running && enabled) {
                    quickStatus.textContent = '🟢 Мониторинг активен';
                    quickStatus.style.color = '#00ff88';
                } else if (enabled) {
                    quickStatus.textContent = '🟡 Мониторинг включен';
                    quickStatus.style.color = '#ffaa00';
                } else {
                    quickStatus.textContent = '🔴 Мониторинг выключен';
                    quickStatus.style.color = '#ff4d4f';
                }
            }

            if (statsUpdatedInfo) {
                if (stats.lastUpdate) {
                    const dt = new Date(stats.lastUpdate);
                    statsUpdatedInfo.textContent =
                        'Обновлено: ' +
                        dt.toLocaleString('ru-RU', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                        });
                } else {
                    statsUpdatedInfo.textContent = 'Статистика пока отсутствует.';
                }
            }

            // Обрабатываем ответ API
            if (result.profilesResponse) {
                const response = result.profilesResponse;
                
                if (response.error) {
                    profilesContainer.innerHTML = `<div class="no-profiles" style="color: #ff4444;">Ошибка: ${response.error}</div>`;
                    profilesCount.style.display = 'none';
                    responseInfo.textContent = '';
                } else if (response.data) {
                    // Пытаемся найти массив анкет в разных возможных структурах ответа
                    let profiles = null;
                    
                    if (Array.isArray(response.data)) {
                        profiles = response.data;
                    } else if (response.data.response && Array.isArray(response.data.response)) {
                        profiles = response.data.response;
                    } else if (response.data.profiles && Array.isArray(response.data.profiles)) {
                        profiles = response.data.profiles;
                    } else if (response.data.data && Array.isArray(response.data.data)) {
                        profiles = response.data.data;
                    } else if (response.data.items && Array.isArray(response.data.items)) {
                        profiles = response.data.items;
                    }

                    if (profiles) {
                        // Восстанавливаем сохранённые тексты рассылки
                        profileBroadcastMessages = result.profileBroadcastMessages || {};

                        // Получаем senderList данные
                        let senderList = [];
                        if (result.senderListResponse && result.senderListResponse.data && !result.senderListResponse.error) {
                            const senderData = result.senderListResponse.data;
                            if (Array.isArray(senderData)) {
                                senderList = senderData;
                            } else if (senderData.response && Array.isArray(senderData.response)) {
                                senderList = senderData.response;
                            } else if (senderData.data && Array.isArray(senderData.data)) {
                                senderList = senderData.data;
                            } else if (senderData.items && Array.isArray(senderData.items)) {
                                senderList = senderData.items;
                            }
                        }

                        await renderProfiles(profiles, senderList);
                    } else {
                        // Если структура неожиданная, показываем JSON для отладки
                        console.log('Неожиданная структура ответа:', response.data);
                        profilesContainer.innerHTML = `
                            <div class="no-profiles" style="color: #ffaa00;">
                                Неожиданная структура ответа. Проверьте консоль.
                            </div>
                            <div class="response-display" style="margin-top: 10px; max-height: 200px;">
                                ${JSON.stringify(response.data, null, 2)}
                            </div>
                        `;
                        profilesCount.style.display = 'none';
                    }
                    
                    const statusInfo = `Status: ${response.status} ${response.statusText}`;
                    const updateInfo = result.lastUpdate ? 
                        `Обновлено: ${new Date(result.lastUpdate).toLocaleString('ru-RU')}` : '';
                    responseInfo.textContent = `${statusInfo} | ${updateInfo}`;
                } else {
                    profilesContainer.innerHTML = '<div class="no-profiles">Данные не найдены в ответе</div>';
                    profilesCount.style.display = 'none';
                    responseInfo.textContent = '';
                }
            } else {
                profilesContainer.innerHTML = '<div class="no-profiles">Данные не найдены. Откройте страницу alpha.date</div>';
                profilesCount.style.display = 'none';
                responseInfo.textContent = '';
            }


            // Обновляем визуальное состояние прогресса рассылки
            applyBroadcastState(result.broadcastState);

            // Во время глобальной рассылки не затираем текст статуса
            if (!isBroadcastingAll) {
                status.textContent = result.lastUpdate ? 
                    `Обновлено: ${new Date(result.lastUpdate).toLocaleString('ru-RU')}` : 
                    'Готово';
            }
        } catch (error) {
            console.error('Ошибка при обновлении данных:', error);
            status.textContent = 'Ошибка загрузки данных';
            profilesContainer.innerHTML = `<div class="no-profiles" style="color: #ff4444;">Ошибка: ${error.message}</div>`;
            profilesCount.style.display = 'none';
        }
    }

    // Кнопка обновления
    refreshBtn.addEventListener('click', async function() {
        // Получаем активную вкладку
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        
        if (tab && tab.url && tab.url.includes('alpha.date')) {
            try {
                status.textContent = 'Перезагрузка страницы...';
                // Перезагружаем страницу
                await chrome.tabs.reload(tab.id);
                
                // Ждём немного и обновляем данные после перезагрузки
                setTimeout(() => {
                    status.textContent = 'Ожидание загрузки страницы...';
                    // Проверяем каждые 500мс, пока страница не загрузится
                    const checkInterval = setInterval(async () => {
                        try {
                            const [updatedTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                            if (updatedTab && updatedTab.status === 'complete') {
                                clearInterval(checkInterval);
                                // Даём время на выполнение content script
                                setTimeout(updateData, 2000);
                            }
                        } catch (e) {
                            clearInterval(checkInterval);
                        }
                    }, 500);
                }, 1000);
            } catch (error) {
                console.error('Ошибка при перезагрузке страницы:', error);
                status.textContent = 'Ошибка: не удалось перезагрузить страницу';
            }
        } else {
            status.textContent = 'Откройте страницу alpha.date для работы расширения';
        }
    });

    // Обновляем данные при открытии popup
    updateData();

    // Сохраняем состояние мониторинга при переключении
    if (monitorToggle) {
        monitorToggle.addEventListener('change', async function() {
            const enabled = monitorToggle.checked;
            try {
                const stored = await chrome.storage.local.get(['monitorState']);
                const prev = stored.monitorState || {};
                await chrome.storage.local.set({
                    monitorState: {
                        ...prev,
                        enabled,
                        running: enabled ? prev.running : false,
                    },
                });
                
                // Уведомляем content script об изменении состояния
                try {
                    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tabs && tabs[0] && tabs[0].url && tabs[0].url.includes('alpha.date')) {
                        chrome.tabs.sendMessage(tabs[0].id, { type: 'monitorStateChanged' }).catch(() => {
                            // Игнорируем ошибки, если content script не загружен
                        });
                    }
                } catch (e) {
                    // Игнорируем ошибки отправки сообщения
                }
            } catch (e) {
                console.error('Не удалось сохранить состояние мониторинга:', e);
            }
        });
    }

    // Проверка зеркала
    if (checkMirrorBtn) {
        // Проверяем доступность кнопки при загрузке
        checkMirrorButtonAvailability();
        
        // Проверяем при переключении вкладок
        chrome.tabs.onActivated.addListener(() => {
            checkMirrorButtonAvailability();
        });
        
        // Проверяем при обновлении URL
        chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
            if (changeInfo.url) {
                checkMirrorButtonAvailability();
            }
        });
        
        checkMirrorBtn.addEventListener('click', async function() {
            try {
                checkMirrorBtn.disabled = true;
                checkMirrorBtn.textContent = 'Проверяем...';
                if (mirrorCheckStatus) {
                    mirrorCheckStatus.style.display = 'none';
                }

                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tabs || !tabs[0] || !tabs[0].url || !tabs[0].url.includes('alpha.date')) {
                    if (mirrorCheckStatus) {
                        mirrorCheckStatus.style.display = 'block';
                        mirrorCheckStatus.textContent = 'Ошибка: откройте страницу alpha.date';
                        mirrorCheckStatus.style.color = '#ff4d4f';
                    }
                    checkMirrorBtn.disabled = true;
                    checkMirrorBtn.textContent = 'Проверить зеркало';
                    checkMirrorButtonAvailability();
                    return;
                }

                // Дополнительная проверка chat_uid в URL
                const url = tabs[0].url;
                const chatMatch = url.match(/\/(chat|chance)\/([^\/\?]+)/);
                if (!chatMatch || !chatMatch[2]) {
                    if (mirrorCheckStatus) {
                        mirrorCheckStatus.style.display = 'block';
                        mirrorCheckStatus.textContent = 'Ошибка: откройте страницу чата (/chat/ или /chance/)';
                        mirrorCheckStatus.style.color = '#ff4d4f';
                    }
                    checkMirrorBtn.disabled = true;
                    checkMirrorBtn.textContent = 'Проверить зеркало';
                    checkMirrorButtonAvailability();
                    return;
                }

                const response = await chrome.tabs.sendMessage(tabs[0].id, { type: 'checkManMirror' });
                if (response && response.ok && response.result) {
                    const result = response.result;
                    if (mirrorCheckStatus) {
                        mirrorCheckStatus.style.display = 'block';
                        mirrorCheckStatus.style.color = '#00ff88';
                        const infoText = [
                            `Мужчина: ${result.name || 'Не указано'}${result.age ? `, ${result.age}` : ''}`,
                            `ID: ${result.manId}`,
                            `Зеркало: ${result.mirror}`,
                            result.registrationDate ? `Дата регистрации: ${result.registrationDate}` : 'Дата регистрации: не указана',
                            result.spendAllCredits !== null && result.spendAllCredits !== undefined ? `Мужчина потратил на анкету: ${result.spendAllCredits}` : 'Мужчина потратил на анкету: не найдено'
                        ].join('\n');
                        mirrorCheckStatus.textContent = infoText;
                        mirrorCheckStatus.style.whiteSpace = 'pre-line';
                    }
                } else {
                    if (mirrorCheckStatus) {
                        mirrorCheckStatus.style.display = 'block';
                        mirrorCheckStatus.style.color = '#ff4d4f';
                        mirrorCheckStatus.textContent = response && response.error ? response.error : 'Ошибка проверки зеркала. Убедитесь, что вы на странице чата (/chat/ или /chance/)';
                    }
                }
            } catch (e) {
                console.error('Ошибка проверки зеркала:', e);
                if (mirrorCheckStatus) {
                    mirrorCheckStatus.style.display = 'block';
                    mirrorCheckStatus.style.color = '#ff4d4f';
                    mirrorCheckStatus.textContent = 'Ошибка: ' + (e.message || 'Не удалось проверить зеркало. Убедитесь, что вы на странице чата.');
                }
            } finally {
                checkMirrorBtn.textContent = 'Проверить зеркало';
                // Обновляем состояние кнопки после проверки
                checkMirrorButtonAvailability();
            }
        });
    }

    // Проверка видео
    if (checkVideoBtn) {
        // Проверяем доступность кнопки при загрузке
        checkVideoButtonAvailability();
        
        // Проверяем при переключении вкладок
        chrome.tabs.onActivated.addListener(() => {
            checkVideoButtonAvailability();
            checkPhotoButtonAvailability();
            checkMirrorButtonAvailability();
        });
        
        // Проверяем при обновлении URL
        chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
            if (changeInfo.url) {
                checkVideoButtonAvailability();
                checkPhotoButtonAvailability();
                checkMirrorButtonAvailability();
            }
        });
        
        checkVideoBtn.addEventListener('click', async function() {
            try {
                checkVideoBtn.disabled = true;
                checkVideoBtn.textContent = 'Проверяем...';
                if (videoCheckStatus) {
                    videoCheckStatus.style.display = 'none';
                }

                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tabs || !tabs[0] || !tabs[0].url || !tabs[0].url.includes('alpha.date')) {
                    if (videoCheckStatus) {
                        videoCheckStatus.style.display = 'block';
                        videoCheckStatus.textContent = 'Ошибка: откройте страницу alpha.date';
                        videoCheckStatus.style.color = '#ff4d4f';
                    }
                    checkVideoBtn.disabled = true;
                    checkVideoBtn.textContent = 'Проверить видео';
                    checkVideoButtonAvailability();
                    return;
                }

                // Дополнительная проверка chat_uid в URL или страница /letter
                const url = tabs[0].url;
                const chatMatch = url.match(/\/(chat|chance)\/([^\/\?]+)/);
                const letterMatch = url.includes('/letter');
                if ((!chatMatch || !chatMatch[2]) && !letterMatch) {
                    if (videoCheckStatus) {
                        videoCheckStatus.style.display = 'block';
                        videoCheckStatus.textContent = 'Ошибка: откройте страницу чата (/chat/, /chance/) или письма (/letter/)';
                        videoCheckStatus.style.color = '#ff4d4f';
                    }
                    checkVideoBtn.disabled = true;
                    checkVideoBtn.textContent = 'Проверить видео';
                    checkVideoButtonAvailability();
                    return;
                }

                const response = await chrome.tabs.sendMessage(tabs[0].id, { type: 'getVideoInfo' });
                if (response && response.ok && response.info) {
                    const info = response.info;
                    if (videoCheckStatus) {
                        videoCheckStatus.style.display = 'block';
                        videoCheckStatus.style.color = '#00ff88';
                        
                        const videosCount = info.videos ? info.videos.length : 0;
                        const sentCount = info.sentLinksCount || 0;
                        const notSentCount = videosCount - sentCount;
                        
                        videoCheckStatus.textContent = `Проверено: ${videosCount} видео в библиотеке, ${sentCount} отправлено, ${notSentCount} не отправлено. Статусы обновлены на странице.`;
                        videoCheckStatus.style.whiteSpace = 'normal';
                    }
                } else {
                    if (videoCheckStatus) {
                        videoCheckStatus.style.display = 'block';
                        videoCheckStatus.style.color = '#ff4d4f';
                        videoCheckStatus.textContent = response && response.error ? response.error : 'Ошибка проверки видео. Убедитесь, что вы на странице чата (/chat/, /chance/) или письма (/letter/)';
                    }
                }
            } catch (e) {
                console.error('Ошибка проверки видео:', e);
                if (videoCheckStatus) {
                    videoCheckStatus.style.display = 'block';
                    videoCheckStatus.style.color = '#ff4d4f';
                    videoCheckStatus.textContent = 'Ошибка: ' + (e.message || 'Не удалось проверить видео. Убедитесь, что вы на странице чата.');
                }
            } finally {
                checkVideoBtn.textContent = 'Проверить видео';
                // Обновляем состояние кнопки после проверки
                checkVideoButtonAvailability();
            }
        });
    }

    // Проверка фото
    if (checkPhotoBtn) {
        // Проверяем доступность кнопки при загрузке
        checkPhotoButtonAvailability();

        // Проверяем при переключении вкладок
        chrome.tabs.onActivated.addListener(() => {
            checkPhotoButtonAvailability();
        });

        // Проверяем при обновлении URL
        chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
            if (changeInfo.url) {
                checkPhotoButtonAvailability();
            }
        });

        checkPhotoBtn.addEventListener('click', async function() {
            try {
                checkPhotoBtn.disabled = true;
                checkPhotoBtn.textContent = 'Проверяем...';
                if (photoCheckStatus) {
                    photoCheckStatus.style.display = 'none';
                }

                const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tabs || !tabs[0] || !tabs[0].url || !tabs[0].url.includes('alpha.date')) {
                    if (photoCheckStatus) {
                        photoCheckStatus.style.display = 'block';
                        photoCheckStatus.textContent = 'Ошибка: откройте страницу alpha.date';
                        photoCheckStatus.style.color = '#ff4d4f';
                    }
                    checkPhotoBtn.disabled = true;
                    checkPhotoBtn.textContent = 'Проверить фото';
                    checkPhotoButtonAvailability();
                    return;
                }

                // Дополнительная проверка chat_uid в URL или страница /letter
                const url = tabs[0].url;
                const chatMatch = url.match(/\/(chat|chance)\/([^\/\?]+)/);
                const letterMatch = url.includes('/letter');
                if ((!chatMatch || !chatMatch[2]) && !letterMatch) {
                    if (photoCheckStatus) {
                        photoCheckStatus.style.display = 'block';
                        photoCheckStatus.textContent = 'Ошибка: откройте страницу чата (/chat/, /chance/) или письма (/letter/)';
                        photoCheckStatus.style.color = '#ff4d4f';
                    }
                    checkPhotoBtn.disabled = true;
                    checkPhotoBtn.textContent = 'Проверить фото';
                    checkPhotoButtonAvailability();
                    return;
                }

                const response = await chrome.tabs.sendMessage(tabs[0].id, { type: 'getPhotoInfo' });
                if (response && response.ok && response.info) {
                    const info = response.info;
                    if (photoCheckStatus) {
                        photoCheckStatus.style.display = 'block';
                        photoCheckStatus.style.color = '#00ff88';

                        const photosCount = info.photos ? info.photos.length : 0;
                        const sentCount = info.sentLinksCount || 0;
                        const notSentCount = photosCount - sentCount;

                        photoCheckStatus.textContent = `Проверено: ${photosCount} фото в библиотеке, ${sentCount} отправлено, ${notSentCount} не отправлено. Статусы обновлены на странице.`;
                        photoCheckStatus.style.whiteSpace = 'normal';
                    }
                } else {
                    if (photoCheckStatus) {
                        photoCheckStatus.style.display = 'block';
                        photoCheckStatus.style.color = '#ff4d4f';
                        photoCheckStatus.textContent = response && response.error ? response.error : 'Ошибка проверки фото. Убедитесь, что вы на странице чата (/chat/, /chance/) или письма (/letter/)';
                    }
                }
            } catch (e) {
                console.error('Ошибка проверки фото:', e);
                if (photoCheckStatus) {
                    photoCheckStatus.style.display = 'block';
                    photoCheckStatus.style.color = '#ff4d4f';
                    photoCheckStatus.textContent = 'Ошибка: ' + (e.message || 'Не удалось проверить фото. Убедитесь, что вы на странице чата.');
                }
            } finally {
                checkPhotoBtn.textContent = 'Проверить фото';
                // Обновляем состояние кнопки после проверки
                checkPhotoButtonAvailability();
            }
        });
    }

    // Сброс статистики
    if (resetStatsBtn) {
        resetStatsBtn.addEventListener('click', async function() {
            try {
                const fresh = {
                    incomingLikes: 0,
                    incomingWinks: 0,
                    incomingLetters: 0,
                    outgoingMessages: 0,
                    successfulChatMessages: 0,
                    readMails: 0,
                    limitsUpdates: 0,
                    lastReset: new Date().toISOString(),
                    lastUpdate: null,
                };
                await chrome.storage.local.set({ stats: fresh });
                // Обновляем отображение
                if (statIncomingLikes) statIncomingLikes.textContent = '0';
                if (statIncomingWinks) statIncomingWinks.textContent = '0';
                if (statIncomingLetters) statIncomingLetters.textContent = '0';
                if (statSuccessfulChatMessages) statSuccessfulChatMessages.textContent = '0';
                if (statReadMails) statReadMails.textContent = '0';
                if (statLimitsUpdates) statLimitsUpdates.textContent = '0';

                // Очищаем массив успешно добавленных профилей
                successfulProfiles = [];
                if (statsUpdatedInfo) {
                    statsUpdatedInfo.textContent = 'Статистика сброшена';
                    setTimeout(() => {
                        if (statsUpdatedInfo) statsUpdatedInfo.textContent = '';
                    }, 2000);
                }
            } catch (e) {
                console.error('Не удалось сбросить статистику:', e);
            }
        });
    }

    // Обработчик для кнопки деталей успешно добавленных профилей
    if (maybeSuccessDetailsBtn) {
        maybeSuccessDetailsBtn.addEventListener('click', function() {
            showSuccessProfilesModal();
        });
    }

    // Обработчик закрытия модального окна
    if (closeSuccessProfilesModal) {
        closeSuccessProfilesModal.addEventListener('click', function() {
            hideSuccessProfilesModal();
        });
    }

    // Закрытие модального окна при клике вне его
    if (successProfilesModal) {
        successProfilesModal.addEventListener('click', function(event) {
            if (event.target === successProfilesModal) {
                hideSuccessProfilesModal();
            }
        });
    }

    // Обработчик очистки списка успешно добавленных профилей
    if (clearSuccessProfilesBtn) {
        clearSuccessProfilesBtn.addEventListener('click', function() {
            clearSuccessfulProfiles();
        });
    }


    // === Управление автоматической рассылкой по расписанию ===
    const scheduledBroadcastToggle = document.getElementById('scheduledBroadcastToggle');
    const broadcastIntervalInput = document.getElementById('broadcastIntervalInput');
    const broadcastTypeSelect = document.getElementById('broadcastTypeSelect');
    const scheduledBroadcastStatus = document.getElementById('scheduledBroadcastStatus');
    const scheduledBroadcastNextRun = document.getElementById('scheduledBroadcastNextRun');
    const scheduledBroadcastCountdown = document.getElementById('scheduledBroadcastCountdown');
    const testScheduledBroadcastBtn = document.getElementById('testScheduledBroadcastBtn');
    const testBroadcastStatus = document.getElementById('testBroadcastStatus');

    // Функция форматирования времени до следующего запуска
    function formatTimeUntilNextRun(nextRunDate) {
        const now = new Date();
        const diffMs = nextRunDate - now;
        
        if (diffMs <= 0) {
            return { text: 'Скоро', countdown: '00:00:00', isSoon: true };
        }
        
        const totalSeconds = Math.floor(diffMs / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        
        const hoursStr = String(hours).padStart(2, '0');
        const minutesStr = String(minutes).padStart(2, '0');
        const secondsStr = String(seconds).padStart(2, '0');
        
        let textStr = '';
        if (hours > 0) {
            textStr = `${hours} ч ${minutes} мин`;
        } else if (minutes > 0) {
            textStr = `${minutes} мин ${seconds} сек`;
        } else {
            textStr = `${seconds} сек`;
        }
        
        return {
            text: textStr,
            countdown: `${hoursStr}:${minutesStr}:${secondsStr}`,
            isSoon: false
        };
    }

    // Функция обновления статуса планировщика
    async function updateScheduledBroadcastStatus() {
        try {
            const data = await chrome.storage.local.get(['scheduledBroadcastSettings']);
            const settings = data.scheduledBroadcastSettings || {};
            
            if (scheduledBroadcastToggle) {
                scheduledBroadcastToggle.checked = settings.enabled || false;
            }
            
            if (broadcastIntervalInput) {
                broadcastIntervalInput.value = settings.interval || 60;
            }
            
            if (broadcastTypeSelect) {
                broadcastTypeSelect.value = settings.broadcastType || 'chat';
            }
            
            if (scheduledBroadcastStatus) {
                if (settings.enabled) {
                    const broadcastTypeText = settings.broadcastType === 'both' 
                        ? 'Сначала чаты, потом письма' 
                        : settings.broadcastType === 'letter' 
                            ? 'Письма' 
                            : 'Чаты (Chance)';
                    
                    scheduledBroadcastStatus.textContent = `✅ Автоматическая рассылка включена (${broadcastTypeText})`;
                    scheduledBroadcastStatus.style.color = '#00ff88';
                    
                    if (settings.nextRun) {
                        const nextRunDate = new Date(settings.nextRun);
                        const timeInfo = formatTimeUntilNextRun(nextRunDate);
                        
                        scheduledBroadcastNextRun.textContent = `Следующий запуск: ${nextRunDate.toLocaleString('ru-RU', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit'
                        })}`;
                        scheduledBroadcastNextRun.style.display = 'block';
                        scheduledBroadcastNextRun.style.color = '#00a6ff';
                        
                        if (scheduledBroadcastCountdown) {
                            scheduledBroadcastCountdown.textContent = `⏱️ До запуска: ${timeInfo.countdown}`;
                            scheduledBroadcastCountdown.style.display = 'block';
                            if (timeInfo.isSoon) {
                                scheduledBroadcastCountdown.style.color = '#ffaa00';
                            } else {
                                scheduledBroadcastCountdown.style.color = '#00ff88';
                            }
                        }
                    } else {
                        scheduledBroadcastNextRun.style.display = 'none';
                        if (scheduledBroadcastCountdown) {
                            scheduledBroadcastCountdown.style.display = 'none';
                        }
                    }
                    
                    if (settings.lastRun) {
                        const lastRunDate = new Date(settings.lastRun);
                        const lastRunText = `Последний запуск: ${lastRunDate.toLocaleString('ru-RU', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit'
                        })}`;
                        scheduledBroadcastStatus.textContent += ` | ${lastRunText}`;
                    }
                } else {
                    scheduledBroadcastStatus.textContent = '❌ Автоматическая рассылка выключена';
                    scheduledBroadcastStatus.style.color = '#a0a0a0';
                    scheduledBroadcastNextRun.style.display = 'none';
                    if (scheduledBroadcastCountdown) {
                        scheduledBroadcastCountdown.style.display = 'none';
                    }
                }
            }
        } catch (e) {
            console.error('Ошибка обновления статуса планировщика:', e);
        }
    }
    
    // Функция запуска обновления таймера в реальном времени
    function startCountdownTimer() {
        if (countdownInterval) {
            clearInterval(countdownInterval);
        }
        
        countdownInterval = setInterval(() => {
            updateScheduledBroadcastStatus();
        }, 1000); // Обновляем каждую секунду
    }
    
    // Остановка таймера
    function stopCountdownTimer() {
        if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
    }

    // Сохранение настроек планировщика
    async function saveScheduledBroadcastSettings() {
        try {
            const enabled = scheduledBroadcastToggle ? scheduledBroadcastToggle.checked : false;
            const interval = broadcastIntervalInput ? parseInt(broadcastIntervalInput.value, 10) : 60;
            const broadcastType = broadcastTypeSelect ? broadcastTypeSelect.value : 'chat';
            
            // Валидация интервала
            if (interval < 1 || interval > 1440) {
                alert('Интервал должен быть от 1 до 1440 минут');
                return;
            }
            
            const settings = {
                enabled,
                interval,
                broadcastType,
                updatedAt: new Date().toISOString()
            };
            
            await chrome.storage.local.set({ scheduledBroadcastSettings: settings });
            
            // Обновляем alarm через background script
            if (enabled) {
                // Удаляем старый alarm
                await chrome.alarms.clear('scheduledBroadcast');
                // Создаем новый с периодическим повторением
                chrome.alarms.create('scheduledBroadcast', {
                    delayInMinutes: interval,
                    periodInMinutes: interval  // Это обеспечивает автоматическое повторение
                });
                
                // Устанавливаем время следующего запуска (через заданный интервал)
                const nextRun = new Date(Date.now() + interval * 60 * 1000);
                settings.nextRun = nextRun.toISOString();
                await chrome.storage.local.set({ scheduledBroadcastSettings: settings });
                
                console.log('[Popup] Планировщик настроен, следующий запуск через', interval, 'минут');
            } else {
                // Удаляем alarm
                await chrome.alarms.clear('scheduledBroadcast');
                // Очищаем nextRun
                settings.nextRun = null;
                await chrome.storage.local.set({ scheduledBroadcastSettings: settings });
            }
            
            await updateScheduledBroadcastStatus();
        } catch (e) {
            console.error('Ошибка сохранения настроек планировщика:', e);
        }
    }

    // Обработчики событий
    if (scheduledBroadcastToggle) {
        scheduledBroadcastToggle.addEventListener('change', saveScheduledBroadcastSettings);
    }
    
    if (broadcastIntervalInput) {
        broadcastIntervalInput.addEventListener('change', saveScheduledBroadcastSettings);
        broadcastIntervalInput.addEventListener('blur', saveScheduledBroadcastSettings);
    }
    
    if (broadcastTypeSelect) {
        broadcastTypeSelect.addEventListener('change', saveScheduledBroadcastSettings);
    }

    // Тестовый запуск рассылки
    if (testScheduledBroadcastBtn) {
        testScheduledBroadcastBtn.addEventListener('click', async function() {
            try {
                testScheduledBroadcastBtn.disabled = true;
                testBroadcastStatus.style.display = 'block';
                testBroadcastStatus.textContent = 'Запуск тестовой рассылки...';
                testBroadcastStatus.style.color = '#00a6ff';
                
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab || !tab.url || !tab.url.includes('alpha.date')) {
                    testBroadcastStatus.textContent = 'Ошибка: откройте вкладку alpha.date';
                    testBroadcastStatus.style.color = '#ff4d4f';
                    testScheduledBroadcastBtn.disabled = false;
                    return;
                }
                
                const data = await chrome.storage.local.get(['scheduledBroadcastSettings']);
                const settings = data.scheduledBroadcastSettings || {};
                const kind = settings.broadcastType || 'chat';
                
                // Запускаем рассылку через content script
                const response = await chrome.tabs.sendMessage(tab.id, {
                    type: 'startScheduledBroadcast',
                    payload: { kind, interval: settings.interval || 60 }
                });
                
                if (response && response.ok) {
                    testBroadcastStatus.textContent = '✅ Тестовая рассылка запущена успешно!';
                    testBroadcastStatus.style.color = '#00ff88';
                } else {
                    testBroadcastStatus.textContent = `Ошибка: ${response?.error || 'Неизвестная ошибка'}`;
                    testBroadcastStatus.style.color = '#ff4d4f';
                }
            } catch (e) {
                console.error('Ошибка тестового запуска:', e);
                testBroadcastStatus.textContent = `Ошибка: ${e.message || 'Не удалось запустить рассылку'}`;
                testBroadcastStatus.style.color = '#ff4d4f';
            } finally {
                testScheduledBroadcastBtn.disabled = false;
                setTimeout(() => {
                    testBroadcastStatus.style.display = 'none';
                }, 5000);
            }
        });
    }


    // Инициализация статуса при загрузке
    updateScheduledBroadcastStatus();
    
    // Запускаем таймер если мы на вкладке рассылки
    if (tabButtons.length > 0) {
        const activeTab = Array.from(tabButtons).find(btn => btn.classList.contains('active'));
        if (activeTab && activeTab.dataset.tab === 'broadcast') {
            startCountdownTimer();
        }
    }

    // === Настройки уведомлений ===
    const saveNotificationSettings = document.getElementById('saveNotificationSettings');
    const notificationSettingsStatus = document.getElementById('notificationSettingsStatus');


    // === Управление именами пользователей ===

    // Загрузка и отображение имен пользователей
    async function loadUserNames() {
        try {
            const data = await chrome.storage.local.get(['userNames']);
            const userNames = data.userNames || {};

            const tbody = userNamesTableBody;
            tbody.innerHTML = '';

            const entries = Object.entries(userNames);
            if (entries.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" style="padding: 40px; text-align: center; color: #a0a0a0;">Нет сохраненных имен</td></tr>';
                return;
            }

            entries.forEach(([userId, name]) => {
                const row = document.createElement('tr');
                row.style.borderBottom = '1px solid rgba(255, 255, 255, 0.05)';

                row.innerHTML = `
                    <td style="padding: 12px; color: #ffffff;">${userId}</td>
                    <td style="padding: 12px; color: #ffffff;" class="editable-name" data-user-id="${userId}" title="Двойной клик для редактирования">${name}</td>
                    <td style="padding: 12px; text-align: center;">
                        <button class="delete-name-btn" data-user-id="${userId}" style="padding: 4px 8px; background: #ff4d4f; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Удалить</button>
                    </td>
                `;

                tbody.appendChild(row);
            });

            // Добавляем обработчики для кнопок удаления
            document.querySelectorAll('.delete-name-btn').forEach(btn => {
                btn.addEventListener('click', async function() {
                    const userId = this.getAttribute('data-user-id');
                    await deleteUserName(userId);
                    await loadUserNames();
                });
            });

            // Добавляем обработчики для редактирования имен (двойной клик)
            document.querySelectorAll('.editable-name').forEach(cell => {
                cell.addEventListener('dblclick', function() {
                    const userId = this.getAttribute('data-user-id');
                    const currentName = this.textContent;
                    enableInlineEditing(this, userId, currentName);
                });
            });

        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка загрузки имен пользователей:', error);
        }
    }

    // Сохранение имени пользователя
    async function saveUserName(userId, name) {
        try {
            const data = await chrome.storage.local.get(['userNames']);
            const userNames = data.userNames || {};
            userNames[userId] = name.trim();
            await chrome.storage.local.set({ userNames: userNames });
            log('Сохранено имя для пользователя:', userId, '=', name);
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка сохранения имени пользователя:', error);
        }
    }

    // Удаление имени пользователя
    async function deleteUserName(userId) {
        try {
            const data = await chrome.storage.local.get(['userNames']);
            const userNames = data.userNames || {};
            delete userNames[userId];
            await chrome.storage.local.set({ userNames: userNames });
            console.log('[Alpha Date Extension] Удалено имя для пользователя:', userId);
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка удаления имени пользователя:', error);
        }
    }

    // Очистка всех имен
    async function clearAllUserNames() {
        try {
            await chrome.storage.local.set({ userNames: {} });
            console.log('[Alpha Date Extension] Очищены все имена пользователей');
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка очистки имен пользователей:', error);
        }
    }

    // Inline редактирование имени
    function enableInlineEditing(cell, userId, currentName) {
        const originalContent = cell.textContent;
        cell.classList.add('editing');

        // Создаем input для редактирования
        const input = document.createElement('input');
        input.type = 'text';
        input.value = currentName;
        input.style.width = '100%';
        input.style.boxSizing = 'border-box';

        // Очищаем ячейку и добавляем input
        cell.textContent = '';
        cell.appendChild(input);
        input.focus();
        input.select();

        // Функция сохранения изменений
        const saveChanges = async () => {
            const newName = input.value.trim();
            cell.classList.remove('editing');
            cell.textContent = newName || originalContent;

            if (newName && newName !== currentName) {
                try {
                    await saveUserName(userId, newName);
                    console.log('[Alpha Date Extension] Имя обновлено:', userId, '=', newName);
                } catch (error) {
                    console.error('[Alpha Date Extension] Ошибка обновления имени:', error);
                    cell.textContent = originalContent; // Возвращаем оригинал при ошибке
                }
            } else if (!newName) {
                // Если имя пустое, возвращаем оригинал
                cell.textContent = originalContent;
            }
        };

        // Функция отмены редактирования
        const cancelEditing = () => {
            cell.classList.remove('editing');
            cell.textContent = originalContent;
        };

        // Обработчики событий
        input.addEventListener('blur', saveChanges);
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveChanges();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelEditing();
            }
        });
    }

    // Загружаем настройки уведомлений
    async function loadNotificationSettings() {
        try {
            const data = await chrome.storage.local.get(['notificationSettings']);
            console.log('[Alpha Date Extension] Загруженные настройки уведомлений в popup:', data);
            const settings = data.notificationSettings || {
                // Общие настройки уведомлений
                notificationsEnabled: true,
                // Настройки Chrome уведомлений
                chromeNewMessages: true,
                chromeLikes: true,
                chromeViews: true,
                chromeLetters: true,
                chromeStats: true,
                chromeBroadcast: true,
                chromeReadMail: true,
                chromeLimits: true,
                // Настройки автообновления
                autoRefreshEnabled: true
            };


            // Chrome настройки
            if (chromeNewMessages) chromeNewMessages.checked = settings.chromeNewMessages !== false;
            if (chromeLikes) chromeLikes.checked = settings.chromeLikes !== false;
            if (chromeViews) chromeViews.checked = settings.chromeViews !== false;
            if (chromeLetters) chromeLetters.checked = settings.chromeLetters !== false;
            if (chromeStats) chromeStats.checked = settings.chromeStats !== false;
            if (chromeBroadcast) chromeBroadcast.checked = settings.chromeBroadcast !== false;
            if (chromeReadMail) chromeReadMail.checked = settings.chromeReadMail !== false;
            if (chromeLimits) chromeLimits.checked = settings.chromeLimits !== false;

            // Общие настройки уведомлений
            if (notificationsEnabled) notificationsEnabled.checked = settings.notificationsEnabled !== false;

            // Настройки автообновления
            if (autoRefreshEnabled) autoRefreshEnabled.checked = settings.autoRefreshEnabled !== false;
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка загрузки настроек уведомлений:', error);
        }
    }

    // Сохраняем настройки уведомлений
    if (saveNotificationSettings) {
        saveNotificationSettings.addEventListener('click', async function() {
            try {
                saveNotificationSettings.disabled = true;
                notificationSettingsStatus.textContent = 'Сохранение...';
                notificationSettingsStatus.style.color = '#00a6ff';

                const settings = {
                    // Общие настройки уведомлений
                    notificationsEnabled: notificationsEnabled.checked,
                    // Chrome настройки
                    chromeNewMessages: chromeNewMessages.checked,
                    chromeLikes: chromeLikes.checked,
                    chromeViews: chromeViews.checked,
                    chromeLetters: chromeLetters.checked,
                    chromeStats: chromeStats.checked,
                    chromeBroadcast: chromeBroadcast.checked,
                    chromeReadMail: chromeReadMail.checked,
                    chromeLimits: chromeLimits.checked,
                    // Настройки автообновления
                    autoRefreshEnabled: autoRefreshEnabled.checked
                };

                console.log('[Alpha Date Extension] Сохраняем настройки уведомлений:', settings);
                await chrome.storage.local.set({ notificationSettings: settings });

                notificationSettingsStatus.textContent = '✅ Настройки сохранены!';
                notificationSettingsStatus.style.color = '#00ff88';

                setTimeout(() => {
                    notificationSettingsStatus.textContent = '';
                }, 3000);
            } catch (error) {
                console.error('[Alpha Date Extension] Ошибка сохранения настроек уведомлений:', error);
                notificationSettingsStatus.textContent = '❌ Ошибка сохранения';
                notificationSettingsStatus.style.color = '#ff4d4f';
            } finally {
                saveNotificationSettings.disabled = false;
            }
        });
    }

    // Обработчик кнопки тестирования уведомлений
    const testNotificationBtn = document.getElementById('testNotificationBtn');
    if (testNotificationBtn) {
        testNotificationBtn.addEventListener('click', async function() {
            try {
                testNotificationBtn.disabled = true;
                testNotificationBtn.textContent = '⏳ Тестируем...';

                // Проверяем разрешение на уведомления
                if (typeof Notification !== 'undefined') {
                    const permission = Notification.permission;
                    if (permission === 'denied') {
                        notificationSettingsStatus.textContent = '❌ Уведомления заблокированы в браузере. Разрешите в настройках сайта.';
                        notificationSettingsStatus.style.color = '#ff4d4f';
                        return;
                    }

                    if (permission === 'default') {
                        notificationSettingsStatus.textContent = '⏳ Запрашиваем разрешение...';
                        notificationSettingsStatus.style.color = '#00a6ff';

                        const result = await Notification.requestPermission();
                        if (result !== 'granted') {
                            notificationSettingsStatus.textContent = '❌ Разрешение не получено';
                            notificationSettingsStatus.style.color = '#ff4d4f';
                            return;
                        }
                    }
                }

                // Отправляем тестовое уведомление (без типа - должно работать всегда)
                console.log('[Alpha Date Extension] Отправка тестового уведомления...');
                await showBrowserNotification(
                    '🔔 Тестовое уведомление',
                    'Если вы видите это сообщение, уведомления работают корректно!',
                    { requireInteraction: true }
                );
                console.log('[Alpha Date Extension] Тестовое уведомление отправлено');

                notificationSettingsStatus.textContent = '✅ Тестовое уведомление отправлено! Проверьте правый нижний угол экрана.';
                notificationSettingsStatus.style.color = '#00ff88';

            } catch (error) {
                console.error('[Alpha Date Extension] Ошибка при тестировании уведомлений:', error);
                notificationSettingsStatus.textContent = '❌ Ошибка тестирования: ' + error.message;
                notificationSettingsStatus.style.color = '#ff4d4f';
            } finally {
                testNotificationBtn.disabled = false;
                testNotificationBtn.textContent = '🔔 Тест уведомления';

                setTimeout(() => {
                    notificationSettingsStatus.textContent = '';
                }, 5000);
            }
        });
    }

    // Обработчик изменения настройки автообновления
    if (autoRefreshEnabled) {
        autoRefreshEnabled.addEventListener('change', async function() {
            // Сохраняем настройку
            const data = await chrome.storage.local.get(['notificationSettings']);
            const settings = data.notificationSettings || {};
            settings.autoRefreshEnabled = autoRefreshEnabled.checked;
            await chrome.storage.local.set({ notificationSettings: settings });

            // Отправляем сигнал в content script
            try {
                const tabs = await chrome.tabs.query({ url: '*://alpha.date/*' });
                for (const tab of tabs) {
                    chrome.tabs.sendMessage(tab.id, {
                        type: 'autoRefreshSettingChanged',
                        enabled: autoRefreshEnabled.checked
                    }).catch(() => {});
                }
            } catch (e) {
                console.warn('[Alpha Date Extension] Не удалось обновить настройку автообновления:', e);
            }
        });
    }

    // Обработчик кнопки сброса настроек уведомлений
    const resetNotificationSettings = document.getElementById('resetNotificationSettings');
    if (resetNotificationSettings) {
        resetNotificationSettings.addEventListener('click', async function() {
            try {
                resetNotificationSettings.disabled = true;
                resetNotificationSettings.textContent = '⏳ Сбрасываем...';

                const defaultSettings = {
                    // Chrome настройки по умолчанию
                    chromeEnabled: true,
                    chromeNewMessages: true,
                    chromeLikes: true,
                    chromeViews: true,
                    chromeLetters: true,
                    chromeStats: true,
                    chromeBroadcast: true,
                    chromeReadMail: true,
                    chromeLimits: true
                };

                console.log('[Alpha Date Extension] Сбрасываем настройки к умолчанию:', defaultSettings);
                await chrome.storage.local.set({ notificationSettings: defaultSettings });

                // Chrome настройки
                if (chromeNewMessages) chromeNewMessages.checked = defaultSettings.chromeNewMessages;
                if (chromeLikes) chromeLikes.checked = defaultSettings.chromeLikes;
                if (chromeViews) chromeViews.checked = defaultSettings.chromeViews;
                if (chromeLetters) chromeLetters.checked = defaultSettings.chromeLetters;
                if (chromeStats) chromeStats.checked = defaultSettings.chromeStats;
                if (chromeBroadcast) chromeBroadcast.checked = defaultSettings.chromeBroadcast;
                if (chromeReadMail) chromeReadMail.checked = defaultSettings.chromeReadMail;
                if (chromeLimits) chromeLimits.checked = defaultSettings.chromeLimits;

                notificationSettingsStatus.textContent = '✅ Настройки сброшены к значениям по умолчанию';
                notificationSettingsStatus.style.color = '#00ff88';

                setTimeout(() => {
                    notificationSettingsStatus.textContent = '';
                }, 3000);

            } catch (error) {
                console.error('[Alpha Date Extension] Ошибка сброса настроек уведомлений:', error);
                notificationSettingsStatus.textContent = '❌ Ошибка сброса';
                notificationSettingsStatus.style.color = '#ff4d4f';
            } finally {
                resetNotificationSettings.disabled = false;
                resetNotificationSettings.textContent = '🔄 Сбросить настройки';
            }
        });
    }

    // Старые обработчики удалены - используются новые ниже


    // Загружаем настройки при инициализации
    loadNotificationSettings();

    // Загружаем уведомления при инициализации
    loadNotifications();

    // Слушаем изменения в storage (на случай обновления из content script)
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') {
            return;
        }

        if (changes.broadcastState) {
            applyBroadcastState(changes.broadcastState.newValue);
        }

        if (changes.scheduledBroadcastSettings) {
            updateScheduledBroadcastStatus();
        }

        // Обновляем статистику сразу при изменении (без перерисовки карточек)
        if (changes.stats) {
            const newStats = changes.stats.newValue || {};
            const likes = newStats.incomingLikes || 0;
            const winks = newStats.incomingWinks || 0;
            const letters = newStats.incomingLetters || 0;
            const successfulChats = newStats.successfulChatMessages || 0;
            
            if (statIncomingLikes) {
                statIncomingLikes.textContent = String(likes);
            }
            if (statIncomingWinks) {
                statIncomingWinks.textContent = String(winks);
            }
            if (statIncomingLetters) {
                statIncomingLetters.textContent = String(letters);
            }
            if (statSuccessfulChatMessages) {
                statSuccessfulChatMessages.textContent = String(successfulChats);
            }
        }

        // Обновляем данные только при изменении важных полей (исключая stats, чтобы не перерисовывать карточки)
        if (
            changes.token ||
            changes.profilesResponse ||
            changes.senderListResponse ||
            changes.monitorState
        ) {
            updateData();
        }
    });

    // === Обработчики для управления именами пользователей ===

    // Добавление имени пользователя
    if (addUserNameBtn) {
        addUserNameBtn.addEventListener('click', async function() {
            const userId = newUserId.value.trim();
            const userName = newUserName.value.trim();

            if (!userId || !userName) {
                alert('Введите ID пользователя и имя');
                return;
            }

            if (!/^\d+$/.test(userId)) {
                alert('ID пользователя должен содержать только цифры');
                return;
            }

            try {
                await saveUserName(userId, userName);
                newUserId.value = '';
                newUserName.value = '';
                await loadUserNames();
                alert('Имя сохранено успешно!');
            } catch (error) {
                console.error('Ошибка сохранения имени:', error);
                alert('Ошибка сохранения имени');
            }
        });

        // Добавление по Enter в поле имени
        if (newUserName) {
            newUserName.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    addUserNameBtn.click();
                }
            });
        }
    }

    // Очистка всех имен
    if (clearAllNamesBtn) {
        clearAllNamesBtn.addEventListener('click', async function() {
            if (confirm('Вы уверены, что хотите удалить все сохраненные имена?')) {
                try {
                    await clearAllUserNames();
                    await loadUserNames();
                    alert('Все имена удалены!');
                } catch (error) {
                    console.error('Ошибка очистки имен:', error);
                    alert('Ошибка очистки имен');
                }
            }
        });
    }

    // === История уведомлений ===

    // Загрузка и отображение уведомлений
    async function loadNotifications() {
        try {
            // Показываем skeleton loaders
            showNotificationSkeletons();

            const data = await chrome.storage.local.get(['notificationsHistory']);
            const notifications = data.notificationsHistory || [];

            // Получаем активные фильтры
            const activeFilters = getActiveFilters();

            // Фильтруем уведомления
            const filteredNotifications = notifications.filter(notification => {
                return activeFilters.includes(notification.notificationType);
            });

            // Обновляем счетчик
            if (notificationsCount) {
                notificationsCount.textContent = `${filteredNotifications.length} уведомлений`;
            }

            // Небольшая задержка для плавности
            await new Promise(resolve => setTimeout(resolve, 200));

            // Отображаем уведомления
            displayNotificationsAsCards(filteredNotifications);

        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка загрузки уведомлений:', error);
        }
    }

    // Показ skeleton loaders
    function showNotificationSkeletons() {
        const container = notificationsList;
        if (!container) return;

        container.innerHTML = '';
        for (let i = 0; i < 3; i++) {
            const skeleton = document.createElement('div');
            skeleton.className = 'notification-skeleton';
            skeleton.innerHTML = `
                <div class="skeleton-icon"></div>
                <div class="skeleton-content">
                    <div class="skeleton-line" style="width: 40%;"></div>
                    <div class="skeleton-line"></div>
                    <div class="skeleton-line"></div>
                </div>
            `;
            container.appendChild(skeleton);
        }
    }

    // Получение активных фильтров
    function getActiveFilters() {
        const filters = [];

        if (filterNewMessages && filterNewMessages.checked) filters.push('showNewMessages');
        if (filterLikes && filterLikes.checked) filters.push('showLikes');
        if (filterViews && filterViews.checked) filters.push('showViews');
        if (filterLetters && filterLetters.checked) filters.push('showLetters');
        if (filterStats && filterStats.checked) filters.push('showStats');
        if (filterBroadcast && filterBroadcast.checked) filters.push('broadcastComplete');
        if (filterReadMail && filterReadMail.checked) filters.push('read_mail');
        if (filterLimits && filterLimits.checked) filters.push('REACTION_LIMITS');

        return filters;
    }

    // Отображение уведомлений в виде карточек
    function displayNotificationsAsCards(notifications) {
        const container = notificationsList;

        if (!notifications || notifications.length === 0) {
            container.innerHTML = '<div class="no-notifications-placeholder">📭 Нет уведомлений</div>';
            return;
        }

        container.innerHTML = '';

        notifications.forEach((notification, index) => {
            const card = document.createElement('div');
            card.className = 'notification-card';
            card.style.animationDelay = `${index * 0.05}s`;

            const timestamp = new Date(notification.timestamp);
            const timeStr = timestamp.toLocaleString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });

            const typeIcons = {
                'showNewMessages': '💬',
                'showLikes': '❤️',
                'showViews': '👁️',
                'showLetters': '✉️',
                'showStats': '📊',
                'showBroadcastComplete': '📤',
                'read_mail': '📧',
                'REACTION_LIMITS': '⚡',
                'showErrors': '⚠️'
            };

            const typeLabels = {
                'showNewMessages': 'Новое сообщение',
                'showLikes': 'Лайк',
                'showViews': 'Просмотр',
                'showLetters': 'Письмо',
                'showStats': 'Статистика',
                'showBroadcastComplete': 'Рассылка завершена',
                'read_mail': 'Прочитано письмо',
                'REACTION_LIMITS': 'Обновление лимитов',
                'showErrors': 'Ошибка'
            };

            const icon = typeIcons[notification.notificationType] || '🔔';
            const typeLabel = typeLabels[notification.notificationType] || notification.notificationType;

            // Показываем более полную информацию из оригинального сообщения
            let message = notification.finalMessage || notification.message || '';

            // Если есть оригинальный текст с подробностями, показываем более полную информацию
            if (notification.originalTitle) {
                // Для уведомлений с информацией о мужчине показываем полные детали
                if (notification.originalTitle.includes('Мужчина:') || notification.originalTitle.includes('ID')) {
                    // Извлекаем ключевую информацию из оригинального текста
                    const cleanText = notification.originalTitle
                        .replace(/<b>/g, '').replace(/<\/b>/g, '')
                        .replace(/<code>/g, '').replace(/<\/code>/g, '')
                        .replace(/\n<a href="[^"]*">[^<]*<\/a>/g, ''); // Убираем HTML и ссылки

                    const lines = cleanText.split('\n').filter(line => line.trim());
                    const userLines = lines.filter(line =>
                        line.includes('Мужчина:') ||
                        line.includes('ID') ||
                        line.includes('sender_external_id') ||
                        line.includes('recipient_external_id')
                    );

                    if (userLines.length > 0) {
                        message = userLines.join(' • ');
                    }
                }
            }

            let actionHtml = '';

            // Собираем все доступные ссылки
            const actionLinks = [];

            // Ссылка на чат (если есть)
            if (notification.chatUrl) {
                actionLinks.push(`<a href="${notification.chatUrl}" target="_blank" class="notification-link">💬 Открыть чат</a>`);
            }

            // Ссылка на профиль мужчины (если есть ID в сообщении)
            if (notification.originalTitle) {
                const manIdMatch = notification.originalTitle.match(/male_external_id[^:]*:\s*<code>(\d+)<\/code>/) ||
                                   notification.originalTitle.match(/sender_external_id[^:]*:\s*<code>(\d+)<\/code>/) ||
                                   notification.originalTitle.match(/ID\s+(\d+)/);

                if (manIdMatch && manIdMatch[1]) {
                    const manId = manIdMatch[1];
                    const profileUrl = `https://alpha.date/profile/${manId}`;
                    actionLinks.push(`<a href="${profileUrl}" target="_blank" class="notification-link">👤 Профиль мужчины</a>`);
                }
            }

            if (actionLinks.length > 0) {
                actionHtml = `<div class="notification-actions">${actionLinks.join(' • ')}</div>`;
            }

            card.innerHTML = `
                <div class="notification-icon type-${notification.notificationType}">
                    ${icon}
                </div>
                <div class="notification-content">
                    <div class="notification-header">
                        <span class="notification-type">${typeLabel}</span>
                        <span class="notification-time">${timeStr}</span>
                    </div>
                    <div class="notification-message">${message}</div>
                    ${actionHtml}
                </div>
            `;

            container.appendChild(card);
        });
    }

    // Очистка всех уведомлений
    async function clearAllNotifications() {
        try {
            await chrome.storage.local.set({ notificationsHistory: [] });
            console.log('[Alpha Date Extension] Очищена история уведомлений');
            await loadNotifications();
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка очистки уведомлений:', error);
        }
    }

    // Обработчики для фильтров уведомлений
    const filterCheckboxes = [filterNewMessages, filterLikes, filterViews, filterLetters, filterStats, filterBroadcast, filterReadMail, filterLimits];
    filterCheckboxes.forEach(checkbox => {
        if (checkbox) {
            checkbox.addEventListener('change', loadNotifications);
        }
    });

    // Обработчики для кнопок уведомлений
    if (refreshNotifications) {
        refreshNotifications.addEventListener('click', loadNotifications);
    }

    if (clearNotifications) {
        clearNotifications.addEventListener('click', async function() {
            if (confirm('Вы уверены, что хотите очистить всю историю уведомлений?')) {
                await clearAllNotifications();
            }
        });
    }

    // Загружаем имена и уведомления при открытии вкладки
    if (tabButtons.length > 0) {
        tabButtons.forEach(button => {
            button.addEventListener('click', function() {
                const tabName = this.getAttribute('data-tab');
                if (tabName === 'names') {
                    loadUserNames();
                }
                if (tabName === 'monitoring') {
                    loadNotifications();
                    loadNotificationSettings();
                }
                if (tabName === 'checks') {
                    checkVideoButtonAvailability();
                    checkPhotoButtonAvailability();
                    checkMirrorButtonAvailability();
                }
                if (tabName === 'maybe') {
                    // Загружаем текущий статус для Maybe
                    updateMaybeStats(0, 0, 0, 0);
                }
            });
        });
    }

    // Обработчик для кнопки массового добавления в Maybe
    if (addToMaybeBtn) {
        addToMaybeBtn.addEventListener('click', startBulkMaybeAdd);
    }

    // Обработчики для модального окна успешно добавленных профилей
    if (maybeSuccessDetailsBtn) {
        console.log('[Alpha Date Extension] Найдена кнопка деталей профилей');
        maybeSuccessDetailsBtn.addEventListener('click', function() {
            console.log('[Alpha Date Extension] Клик по кнопке деталей профилей');
            showSuccessProfilesModal();
        });
    } else {
        console.error('[Alpha Date Extension] Кнопка деталей профилей не найдена');
    }

    // Обработчик закрытия модального окна
    if (closeSuccessProfilesModal) {
        closeSuccessProfilesModal.addEventListener('click', function() {
            hideSuccessProfilesModal();
        });
    }

    // Закрытие модального окна при клике вне его
    if (successProfilesModal) {
        successProfilesModal.addEventListener('click', function(event) {
            if (event.target === successProfilesModal) {
                hideSuccessProfilesModal();
            }
        });
    }

    // Обработчик проверки нулевых действий
    if (checkZeroActionsBtn) {
        checkZeroActionsBtn.addEventListener('click', function() {
            checkZeroActions();
        });
    }

    // Обработчик очистки списка успешно добавленных профилей
    if (clearSuccessProfilesBtn) {
        clearSuccessProfilesBtn.addEventListener('click', function() {
            clearSuccessfulProfiles();
        });
    }

    // ===== ОБРАБОТЧИКИ ДЛЯ ПОИСКА ПО ЧАТУ =====

    // Извлечение chat_uid из текущего URL
    if (extractChatUidBtn) {
        extractChatUidBtn.addEventListener('click', async function() {
            try {
                extractChatUidBtn.disabled = true;
                extractChatUidBtn.textContent = '⏳ Извлечение...';

                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab) {
                    throw new Error('Не удалось получить активную вкладку');
                }

                const response = await chrome.tabs.sendMessage(tab.id, { type: 'extractChatUid' });
                if (response.ok && response.chatUid) {
                    currentChatUid.textContent = `Chat UID: ${response.chatUid}`;
                    currentChatUid.style.color = '#00ff88';
                } else {
                    currentChatUid.textContent = 'Chat UID не найден в URL';
                    currentChatUid.style.color = '#ff6b6b';
                }

            } catch (error) {
                console.error('[Alpha Date Extension] Ошибка извлечения chat_uid:', error);
                currentChatUid.textContent = `Ошибка: ${error.message}`;
                currentChatUid.style.color = '#ff6b6b';
            } finally {
                extractChatUidBtn.disabled = false;
                extractChatUidBtn.textContent = '📋 Извлечь Chat UID';
            }
        });
    }

    // Загрузка истории чата
    if (loadChatHistoryBtn) {
        loadChatHistoryBtn.addEventListener('click', async function() {
            const chatUid = currentChatUid.textContent.replace('Chat UID: ', '');
            if (!chatUid || chatUid === currentChatUid.textContent) {
                alert('Сначала извлеките Chat UID из URL!');
                return;
            }

            try {
                loadChatHistoryBtn.disabled = true;
                loadChatHistoryBtn.textContent = '⏳ Загрузка...';

                // Показываем прогресс
                chatSearchProgress.style.display = 'block';
                chatSearchResults.style.display = 'none';

                // Слушаем прогресс
                const progressHandler = (message) => {
                    if (message.type === 'chatSearchProgress') {
                        updateChatSearchProgress(message.progress);
                    }
                };
                chrome.runtime.onMessage.addListener(progressHandler);

                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab) {
                    throw new Error('Не удалось получить активную вкладку');
                }

                const response = await chrome.tabs.sendMessage(tab.id, {
                    type: 'loadChatHistory',
                    chatUid: chatUid
                });

                chrome.runtime.onMessage.removeListener(progressHandler);

                if (response.ok) {
                    displayChatHistory(response.result);
                } else {
                    throw new Error(response.error);
                }

            } catch (error) {
                console.error('[Alpha Date Extension] Ошибка загрузки истории чата:', error);
                alert(`Ошибка загрузки истории: ${error.message}`);
            } finally {
                loadChatHistoryBtn.disabled = false;
                loadChatHistoryBtn.textContent = '🔍 Загрузить историю чата';
                chatSearchProgress.style.display = 'none';
            }
        });
    }

    // Поиск в загруженной истории чата
    if (searchInChatBtn) {
        searchInChatBtn.addEventListener('click', function() {
            const query = chatSearchQuery.value.trim();
            if (!query) {
                alert('Введите текст для поиска!');
                return;
            }

            performChatSearch(query);
        });
    }

    // Обработчик Enter в поле поиска
    if (chatSearchQuery) {
        chatSearchQuery.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                searchInChatBtn.click();
            }
        });
    }

    // Очистка результатов поиска
    if (clearChatSearchBtn) {
        clearChatSearchBtn.addEventListener('click', function() {
            chatSearchQuery.value = '';
            chatSearchOutput.innerHTML = 'История чата будет отображена здесь...';
            chatSearchOutput.style.color = '#ffffff';
        });
    }

    // Обработчик кнопки выхода
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            if (confirm('Вы уверены, что хотите завершить сессию?')) {
                try {
                    // Сбрасываем авторизацию через background.js
                    await chrome.runtime.sendMessage({ type: 'resetAuth' });

                    // Скрываем информацию о подписке
                    const subscriptionInfo = document.getElementById('subscriptionInfo');
                    if (subscriptionInfo) {
                        subscriptionInfo.style.display = 'none';
                    }

                    window.location.href = 'auth.html';
                } catch (error) {
                    console.error('Ошибка сброса авторизации:', error);
                    // Fallback - принудительно переходим на страницу авторизации
                    window.location.href = 'auth.html';
                }
            }
        });
    }
});

// === ФУНКЦИИ ДЛЯ МАССОВОГО ДОБАВЛЕНИЯ В MAYBE ===

// Функция для получения токена и user_id напрямую из localStorage страницы (fallback)
async function getTokenDirectly(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            function: () => {
                try {
                    const token = localStorage.getItem('token');
                    // Пробуем получить user_id из различных мест в localStorage
                    let userId = null;

                    // Популярные ключи для user_id
                    const possibleKeys = ['user_id', 'userId', 'current_user_id', 'operator_id', 'profile_id'];

                    for (const key of possibleKeys) {
                        const value = localStorage.getItem(key);
                        if (value && /^\d+$/.test(value)) {
                            userId = value;
                            break;
                        }
                    }

                    // Если не нашли в localStorage, пробуем sessionStorage
                    if (!userId) {
                        for (const key of possibleKeys) {
                            const value = sessionStorage.getItem(key);
                            if (value && /^\d+$/.test(value)) {
                                userId = value;
                                break;
                            }
                        }
                    }

                    return {
                        token: token,
                        userId: userId,
                        apiBase: 'https://alpha.date'
                    };
                } catch (e) {
                    console.error('Ошибка получения данных напрямую:', e);
                    return null;
                }
            }
        });

        if (results && results[0] && results[0].result) {
            return results[0].result;
        } else {
            throw new Error('Не удалось получить данные из localStorage');
        }
    } catch (error) {
        console.error('[Alpha Date Extension] Ошибка получения данных напрямую:', error);
        throw new Error('Не удалось получить токен авторизации. Убедитесь, что вы авторизованы на alpha.date.');
    }
}

// Функция для парсинга списка ID из текста
function parseUserIds(text) {
    if (!text || typeof text !== 'string') {
        return [];
    }

    // Разбиваем по строкам и извлекаем только числовые значения
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    const ids = [];
    for (const line of lines) {
        // Ищем числовые последовательности в строке (ID пользователей обычно 9-10 цифр)
        const matches = line.match(/\b\d{9,10}\b/g);
        if (matches) {
            for (const match of matches) {
                const id = parseInt(match, 10);
                if (id && id > 100000000 && id < 9999999999) { // Валидный диапазон ID
                    ids.push(id.toString());
                }
            }
        }
    }

    // Убираем дубликаты
    return [...new Set(ids)];
}

// Функция для поиска чата по мужскому ID
async function findChatByUserId(maleUserId) {
    try {
        // Получаем токен
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || !tabs[0]) {
            throw new Error('Не удалось получить активную вкладку');
        }

        // Проверяем, что находимся на странице alpha.date
        if (!tabs[0].url || !tabs[0].url.includes('alpha.date')) {
            throw new Error('Расширение работает только на страницах alpha.date. Откройте https://alpha.date и авторизуйтесь.');
        }

        let tokenResponse;
        try {
            tokenResponse = await chrome.tabs.sendMessage(tabs[0].id, { type: 'getToken' });
        } catch (connectionError) {
            // Если content script не доступен, пробуем получить токен напрямую
            console.warn('[Alpha Date Extension] Content script не доступен, пробуем получить токен напрямую');
            tokenResponse = await getTokenDirectly(tabs[0].id);
        }

        if (!tokenResponse || !tokenResponse.token) {
            throw new Error('Не удалось получить токен авторизации. Убедитесь, что вы авторизованы на alpha.date.');
        }

        const token = tokenResponse.token;
        const apiBase = tokenResponse.apiBase || 'https://alpha.date';

        // Отправляем параллельные запросы на поиск чата с разными CHAT_TYPE
        const searchUrl = `${apiBase}/api/chatList/chatListByUserID`;

        // Создаем два запроса: DEFAULT и CHANCE
        const createSearchRequest = (chatType) => {
            return fetch(searchUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                credentials: 'include',
                body: JSON.stringify({
                    "user_id": "",
                    "chat_uid": false,
                    "page": 1,
                    "freeze": false,
                    "limits": null,
                    "ONLINE_STATUS": 0,
                    "CHAT_TYPE": chatType,
                    "SEARCH": maleUserId.toString()
                })
            });
        };

        // Выполняем параллельные запросы
        const [defaultResponse, chanceResponse] = await Promise.all([
            createSearchRequest("DEFAULT"),
            createSearchRequest("CHANCE")
        ]);

        // Проверяем ответы
        let data = null;
        let usedChatType = "";

        // Сначала проверяем DEFAULT
        if (defaultResponse.ok) {
            data = await defaultResponse.json();
            usedChatType = "DEFAULT";
        }

        // Если DEFAULT не дал результатов, пробуем CHANCE
        if (!data || !data.response || !Array.isArray(data.response) || data.response.length === 0) {
            if (chanceResponse.ok) {
                data = await chanceResponse.json();
                usedChatType = "CHANCE";
            }
        }

        // Если оба запроса не удались
        if (!data) {
            if (!defaultResponse.ok) {
                throw new Error(`DEFAULT запрос: HTTP ${defaultResponse.status}`);
            }
            if (!chanceResponse.ok) {
                throw new Error(`CHANCE запрос: HTTP ${chanceResponse.status}`);
            }
            throw new Error('Не удалось выполнить поиск чатов');
        }

        console.log(`[Alpha Date Extension] Использован CHAT_TYPE: ${usedChatType} для поиска ${maleUserId}`);

        // Ищем chat_uid в ответе
        let chatUid = null;

        if (data && data.response && Array.isArray(data.response)) {
            // Ищем в массиве response
            for (const item of data.response) {
                if (item && item.chat_uid) {
                    chatUid = item.chat_uid;
                    break;
                }
            }
        } else if (data && Array.isArray(data)) {
            // Ищем в корневом массиве
            for (const item of data) {
                if (item && item.chat_uid) {
                    chatUid = item.chat_uid;
                    break;
                }
            }
        } else if (data && data.chat_uid) {
            chatUid = data.chat_uid;
        }

        return chatUid;

    } catch (error) {
        console.error('[Alpha Date Extension] Ошибка поиска чата:', error);
        throw error;
    }
}

// Функция для добавления чата в Maybe
async function addChatToMaybe(chatUid, maleUserId) {
    try {
        // Получаем токен
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || !tabs[0]) {
            throw new Error('Не удалось получить активную вкладку');
        }

        // Проверяем, что находимся на странице alpha.date
        if (!tabs[0].url || !tabs[0].url.includes('alpha.date')) {
            throw new Error('Расширение работает только на страницах alpha.date. Откройте https://alpha.date и авторизуйтесь.');
        }

        let tokenResponse;
        try {
            tokenResponse = await chrome.tabs.sendMessage(tabs[0].id, { type: 'getToken' });
        } catch (connectionError) {
            // Если content script не доступен, пробуем получить токен напрямую
            console.warn('[Alpha Date Extension] Content script не доступен, пробуем получить токен напрямую');
            tokenResponse = await getTokenDirectly(tabs[0].id);
        }

        if (!tokenResponse || !tokenResponse.token) {
            throw new Error('Не удалось получить токен авторизации. Убедитесь, что вы авторизованы на alpha.date.');
        }

        const token = tokenResponse.token;
        const apiBase = tokenResponse.apiBase || 'https://alpha.date';

        // Отправляем запрос на добавление в Maybe
        const maybeUrl = `${apiBase}/api/chat/setMaybe`;

        console.log('[Alpha Date Extension] Добавление в Maybe чата:', chatUid, 'для мужчины:', maleUserId);

        const response = await fetch(maybeUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify({
                "user_id": maleUserId.toString(),
                "chat_uid": chatUid.toString(),
                "maybe": 1
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        // Проверяем ответ
        if (data && data.status === true && data.message === "success") {
            return true;
        } else {
            throw new Error('Неожиданный ответ сервера: ' + JSON.stringify(data));
        }

    } catch (error) {
        console.error('[Alpha Date Extension] Ошибка добавления в Maybe:', error);
        throw error;
    }
}

// Функция для логирования в Maybe лог
function logMaybeMessage(message, type = 'info') {
    if (!maybeLog) return;

    const timestamp = new Date().toLocaleTimeString('ru-RU');
    const colorClass = {
        'success': 'color: #00ff88;',
        'error': 'color: #ff4d4f;',
        'warning': 'color: #ff9f40;',
        'info': 'color: #a0a0a0;'
    }[type] || 'color: #a0a0a0;';

    const logEntry = document.createElement('div');
    logEntry.style.cssText = `margin-bottom: 4px; font-size: 12px; ${colorClass}`;
    logEntry.innerHTML = `<span style="color: #666;">[${timestamp}]</span> ${message}`;

    maybeLog.appendChild(logEntry);
    maybeLog.scrollTop = maybeLog.scrollHeight;
}

// Функция для обновления статистики Maybe
function updateMaybeStats(total, success, notFound, errors) {
    if (maybeStats) {
        maybeStats.style.display = (total > 0) ? 'grid' : 'none';
    }

    if (maybeTotalCount) maybeTotalCount.textContent = total;
    if (maybeSuccessCount) maybeSuccessCount.textContent = success;
    if (maybeNotFoundCount) maybeNotFoundCount.textContent = notFound;
    if (maybeErrorCount) maybeErrorCount.textContent = errors;

    // Обновляем состояние кнопки деталей (активна только если есть успешно добавленные профили)
    if (maybeSuccessDetailsBtn) {
        maybeSuccessDetailsBtn.style.opacity = success > 0 ? '1' : '0.3';
        maybeSuccessDetailsBtn.style.cursor = success > 0 ? 'pointer' : 'not-allowed';
        maybeSuccessDetailsBtn.disabled = success === 0;
    }
}

// Функция для обновления статуса Maybe
function updateMaybeStatus(message, color = '#a0a0a0') {
    if (maybeStatus) {
        maybeStatus.textContent = message;
        maybeStatus.style.color = color;
    }
}

// Функции для работы с модальным окном успешно добавленных профилей
function showSuccessProfilesModal() {
    if (!successProfilesList || !successProfilesModal) return;

    if (successfulProfiles.length === 0) {
        successProfilesList.innerHTML = '<div style="text-align: center; color: #a0a0a0; padding: 40px;">📭 Нет успешно добавленных профилей</div>';
    } else {
        // Создаем два списка: ID в столбик и UID через запятую
        const idsList = successfulProfiles.map(profile => profile.id).join('\n');
        const uidsList = successfulProfiles.map(profile => profile.uid).join(', ');

        const html = `
            <div style="margin-bottom: 24px;">
                <h4 style="color: #ffffff; margin: 0 0 12px 0; font-size: 16px;">👤 Список ID мужчин (${successfulProfiles.length}):</h4>
                <textarea readonly style="width: 100%; min-height: 120px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 6px; padding: 12px; color: #ffffff; font-family: monospace; font-size: 14px; resize: vertical;" onclick="this.select()">${idsList}</textarea>
            </div>

            <div>
                <h4 style="color: #ffffff; margin: 0 0 12px 0; font-size: 16px;">🔗 Список UID через запятую:</h4>
                <textarea readonly style="width: 100%; min-height: 60px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 6px; padding: 12px; color: #ffffff; font-family: monospace; font-size: 14px; resize: vertical;" onclick="this.select()">${uidsList}</textarea>
            </div>

            <div style="margin-top: 16px; font-size: 12px; color: #a0a0a0; text-align: center;">
                💡 Кликните на поле для выделения всего текста
            </div>
        `;

        successProfilesList.innerHTML = html;
    }

    successProfilesModal.style.display = 'flex';
}

function hideSuccessProfilesModal() {
    if (successProfilesModal) {
        successProfilesModal.style.display = 'none';
    }
}

function clearSuccessfulProfiles() {
    successfulProfiles = [];
    updateMaybeStats(0, 0, 0, 0);
    hideSuccessProfilesModal();
    logMaybeMessage('Список успешно добавленных профилей очищен', 'info');
}

// Функция проверки нулевых действий
async function checkZeroActions() {
    if (successfulProfiles.length === 0) {
        alert('Нет успешно добавленных профилей для проверки');
        return;
    }

    // Изменяем кнопку на состояние загрузки
    checkZeroActionsBtn.disabled = true;
    checkZeroActionsBtn.textContent = '⏳ Проверка...';

    // Добавляем прогресс-бар в модальное окно
    const progressHtml = `
        <div id="zeroActionsProgress" style="margin-top: 16px; padding: 16px; background: rgba(255, 255, 255, 0.05); border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.1);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <span style="color: #ffffff; font-size: 14px;">🔍 Проверка нулевых действий</span>
                <span id="progressText" style="color: #a0a0a0; font-size: 12px;">0/${successfulProfiles.length}</span>
            </div>
            <div style="width: 100%; height: 8px; background: rgba(255, 255, 255, 0.1); border-radius: 4px; overflow: hidden;">
                <div id="progressBar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #ff8c00, #ffa500); border-radius: 4px; transition: width 0.3s ease;"></div>
            </div>
        </div>
    `;

    // Добавляем прогресс-бар в начало списка
    successProfilesList.insertAdjacentHTML('afterbegin', progressHtml);

    try {
        // Получаем токен
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || !tabs[0]) {
            throw new Error('Не удалось получить активную вкладку');
        }

        if (!tabs[0].url || !tabs[0].url.includes('alpha.date')) {
            throw new Error('Расширение работает только на страницах alpha.date');
        }

        let tokenResponse;
        try {
            tokenResponse = await chrome.tabs.sendMessage(tabs[0].id, { type: 'getToken' });
        } catch (connectionError) {
            tokenResponse = await getTokenDirectly(tabs[0].id);
        }

        if (!tokenResponse || !tokenResponse.token) {
            throw new Error('Не удалось получить токен авторизации');
        }

        const token = tokenResponse.token;
        const apiBase = tokenResponse.apiBase || 'https://alpha.date';

        const zeroActionChats = [];
        let checkedCount = 0;

        // Проверяем каждый успешно добавленный профиль
        for (const profile of successfulProfiles) {
            try {
                const searchUrl = `${apiBase}/api/chatList/chatListByUserID`;

                const response = await fetch(searchUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    credentials: 'include',
                    body: JSON.stringify({
                        "user_id": "",
                        "chat_uid": false,
                        "page": 1,
                        "freeze": false,
                        "limits": null,
                        "ONLINE_STATUS": 0,
                        "CHAT_TYPE": "CHANCE",
                        "SEARCH": profile.id.toString()
                    })
                });

                if (response.ok) {
                    const data = await response.json();

                    // Ищем чаты с total_limit = 0
                    if (data && data.response && Array.isArray(data.response)) {
                        for (const chat of data.response) {
                            if (chat.total_limit === 0 && chat.chat_uid) {
                                zeroActionChats.push(chat.chat_uid);
                                console.log(`[Zero Actions] Найден чат с нулевыми действиями: ${chat.chat_uid} (ID: ${profile.id})`);
                            }
                        }
                    }
                }

                checkedCount++;
                // Обновляем прогресс-бар
                const progressPercent = (checkedCount / successfulProfiles.length) * 100;
                const progressBar = document.getElementById('progressBar');
                const progressText = document.getElementById('progressText');

                if (progressBar) {
                    progressBar.style.width = `${progressPercent}%`;
                }
                if (progressText) {
                    progressText.textContent = `${checkedCount}/${successfulProfiles.length}`;
                }

                // Обновляем текст кнопки каждые 5 проверок
                if (checkedCount % 5 === 0) {
                    checkZeroActionsBtn.textContent = `⏳ Проверено ${checkedCount}/${successfulProfiles.length}...`;
                }

                // Небольшая пауза между запросами
                await new Promise(resolve => setTimeout(resolve, 300));

            } catch (error) {
                console.error(`[Zero Actions] Ошибка проверки профиля ${profile.id}:`, error);
            }
        }

        // Показываем результаты
        if (zeroActionChats.length > 0) {
            const chatUidsString = zeroActionChats.join(', ');

            // Добавляем результат в модальное окно
            const resultHtml = `
                <div style="margin-top: 24px; padding: 16px; background: rgba(255, 165, 0, 0.1); border: 1px solid rgba(255, 165, 0, 0.3); border-radius: 8px;">
                    <h4 style="color: #ff8c00; margin: 0 0 12px 0; font-size: 16px;">⚠️ Чаты с нулевыми действиями (${zeroActionChats.length}):</h4>
                    <textarea readonly style="width: 100%; min-height: 80px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 6px; padding: 12px; color: #ffffff; font-family: monospace; font-size: 14px; resize: vertical;" onclick="this.select()">${chatUidsString}</textarea>
                    <div style="margin-top: 8px; font-size: 12px; color: #a0a0a0;">💡 Кликните для выделения всего текста</div>
                </div>
            `;

            successProfilesList.insertAdjacentHTML('beforeend', resultHtml);
            logMaybeMessage(`Найдено ${zeroActionChats.length} чатов с нулевыми действиями`, 'warning');
        } else {
            // Добавляем сообщение об отсутствии чатов с нулевыми действиями
            const noResultsHtml = `
                <div style="margin-top: 24px; padding: 16px; background: rgba(0, 255, 136, 0.1); border: 1px solid rgba(0, 255, 136, 0.3); border-radius: 8px;">
                    <div style="color: #00ff88; text-align: center;">
                        ✅ Все чаты имеют доступные действия
                    </div>
                </div>
            `;

            successProfilesList.insertAdjacentHTML('beforeend', noResultsHtml);
            logMaybeMessage('Все проверенные чаты имеют доступные действия', 'success');
        }

    } catch (error) {
        console.error('[Zero Actions] Ошибка проверки нулевых действий:', error);
        alert(`Ошибка проверки нулевых действий: ${error.message}`);
    } finally {
        // Удаляем прогресс-бар
        const progressElement = document.getElementById('zeroActionsProgress');
        if (progressElement) {
            progressElement.remove();
        }

        // Восстанавливаем кнопку
        checkZeroActionsBtn.disabled = false;
        checkZeroActionsBtn.textContent = '🔍 Проверить нулевые действия';
    }
}

// Основная функция для массового добавления в Maybe
async function startBulkMaybeAdd() {
    if (!maybeIdsInput || !addToMaybeBtn) return;

    const inputText = maybeIdsInput.value.trim();
    if (!inputText) {
        updateMaybeStatus('Введите список ID пользователей', '#ff4d4f');
        return;
    }

    // Парсим ID из текста
    const userIds = parseUserIds(inputText);
    if (userIds.length === 0) {
        updateMaybeStatus('Не найдено валидных ID пользователей', '#ff4d4f');
        return;
    }

    // Очищаем лог и сбрасываем статистику
    if (maybeLog) maybeLog.innerHTML = '';
    updateMaybeStats(userIds.length, 0, 0, 0);

    // Блокируем кнопку и обновляем статус
    addToMaybeBtn.disabled = true;
    addToMaybeBtn.textContent = '⏳ Выполняется...';
    updateMaybeStatus(`Обработка ${userIds.length} ID...`, '#007AFF');

    logMaybeMessage(`🚀 Начало обработки ${userIds.length} ID пользователей`, 'info');

    let successCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;

    // Обрабатываем каждый ID последовательно
    for (let i = 0; i < userIds.length; i++) {
        const maleUserId = userIds[i];
        const currentIndex = i + 1;

        try {
            logMaybeMessage(`🔍 Поиск чата для ID ${maleUserId} (${currentIndex}/${userIds.length})`, 'info');

            // Шаг 1: Поиск чата
            const chatUid = await findChatByUserId(maleUserId);

            if (!chatUid) {
                logMaybeMessage(`❌ Чат для ID ${maleUserId} не найден`, 'warning');
                notFoundCount++;
                updateMaybeStats(userIds.length, successCount, notFoundCount, errorCount);
                continue;
            }

            logMaybeMessage(`✅ Найден чат ${chatUid} для ID ${maleUserId}`, 'success');

            // Шаг 2: Добавление в Maybe
            logMaybeMessage(`⭐ Добавление в Maybe чата ${chatUid}`, 'info');

            await addChatToMaybe(chatUid, maleUserId);

            logMaybeMessage(`🎉 Успешно добавлено в Maybe: ID ${maleUserId}`, 'success');
            successCount++;

            // Сохраняем информацию об успешно добавленном профиле
            successfulProfiles.push({
                uid: chatUid,
                id: maleUserId,
                timestamp: new Date().toISOString(),
                index: successCount
            });

            updateMaybeStats(userIds.length, successCount, notFoundCount, errorCount);

            // Небольшая пауза между запросами, чтобы не перегружать сервер
            await new Promise(resolve => setTimeout(resolve, 500));

        } catch (error) {
            const errorMsg = error.message || 'Неизвестная ошибка';
            logMaybeMessage(`💥 Ошибка с ID ${maleUserId}: ${errorMsg}`, 'error');
            errorCount++;
            updateMaybeStats(userIds.length, successCount, notFoundCount, errorCount);

            // Продолжаем с следующим ID, не останавливаемся
        }
    }

    // Финальный отчет
    const totalProcessed = successCount + notFoundCount + errorCount;
    logMaybeMessage(`📊 Обработка завершена: ${totalProcessed}/${userIds.length} ID`, 'info');
    logMaybeMessage(`✅ Успешно: ${successCount}`, successCount > 0 ? 'success' : 'info');
    logMaybeMessage(`❓ Не найдено: ${notFoundCount}`, notFoundCount > 0 ? 'warning' : 'info');
    logMaybeMessage(`❌ Ошибки: ${errorCount}`, errorCount > 0 ? 'error' : 'info');

    // Обновляем финальный статус
    if (successCount > 0) {
        updateMaybeStatus(`Завершено: ${successCount} добавлено, ${notFoundCount} не найдено, ${errorCount} ошибок`, '#00ff88');
    } else if (errorCount > 0) {
        updateMaybeStatus(`Завершено с ошибками: ${errorCount} ошибок`, '#ff9f40');
    } else {
        updateMaybeStatus('Все ID не найдены или возникли ошибки', '#ff4d4f');
    }

    // Разблокируем кнопку
    addToMaybeBtn.disabled = false;
    addToMaybeBtn.textContent = '⭐ Добавить в Maybe';
}

// ===== ФУНКЦИИ ДЛЯ ПОИСКА ПО ЧАТУ =====

// Глобальная переменная для хранения загруженной истории чата
let currentChatHistory = null;

// Функция для обновления прогресса загрузки истории чата
function updateChatSearchProgress(progress) {
    if (!chatSearchStatus || !chatSearchProgressBar) return;

    let statusText = '';
    let progressPercent = 0;

    switch (progress.stage) {
        case 'loading':
            statusText = `Загрузка страницы ${progress.page}... Найдено ${progress.totalMessages} сообщений`;
            progressPercent = Math.min(progress.page * 10, 80); // Примерный прогресс
            break;
        case 'formatting':
            statusText = `Форматирование ${progress.totalMessages} сообщений...`;
            progressPercent = 90;
            break;
        case 'complete':
            statusText = `Готово! Загружено ${progress.totalMessages} сообщений`;
            progressPercent = 100;
            break;
    }

    chatSearchStatus.textContent = statusText;
    chatSearchProgressBar.style.width = `${progressPercent}%`;
}

// Функция для отображения загруженной истории чата
function displayChatHistory(result) {
    currentChatHistory = result;
    chatSearchResults.style.display = 'block';

    if (chatMessagesCount) {
        chatMessagesCount.textContent = `(${result.totalMessages} сообщений)`;
    }

    // Показываем полный текст истории чата
    const previewText = result.text;

    chatSearchOutput.textContent = previewText;
    chatSearchOutput.style.color = '#ffffff';

    console.log(`[Alpha Date Extension] История чата загружена: ${result.totalMessages} сообщений`);
}

// Функция для выполнения поиска в загруженной истории чата
function performChatSearch(query) {
    if (!currentChatHistory) {
        alert('Сначала загрузите историю чата!');
        return;
    }

    if (!query.trim()) {
        alert('Введите текст для поиска!');
        return;
    }

    const fullText = currentChatHistory.text;
    const lines = fullText.split('\n');
    const results = [];
    const queryLower = query.toLowerCase().trim();

    // Разбиваем запрос на отдельные слова для более гибкого поиска
    const queryWords = queryLower.split(/\s+/).filter(word => word.length > 0);

    // Поиск по строкам
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineLower = line.toLowerCase();

        // Проверяем, содержит ли строка все слова из запроса (ИЛИ логика)
        const matches = queryWords.some(word => lineLower.includes(word));

        if (matches) {
            // Добавляем контекст (предыдущие и следующие строки)
            const startLine = Math.max(0, i - 2);
            const endLine = Math.min(lines.length, i + 3);
            const context = lines.slice(startLine, endLine).join('\n');

            results.push({
                lineNumber: i + 1,
                context: context,
                matchedLine: line,
                score: queryWords.filter(word => lineLower.includes(word)).length // рейтинг совпадения
            });

            // Ограничение результатов (увеличено до 1000 для показа всех)
            if (results.length >= 1000) {
                results.push({ lineNumber: -1, context: '... (найдено более 1000 совпадений, показаны наиболее релевантные)', matchedLine: '', score: 0 });
                break;
            }
        }
    }

    // Сортируем результаты по релевантности (количеству совпадений слов)
    results.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Отображаем результаты
    if (results.length === 0) {
        chatSearchOutput.innerHTML = `<span style="color: #ff6b6b;">Ничего не найдено по запросу "${query}"</span>\n\n<span style="color: #a0a0a0; font-size: 12px;">Попробуйте другие ключевые слова или упростите запрос</span>`;
    } else {
        const actualResults = results.filter(r => r.lineNumber !== -1);
        let output = `<span style="color: #00ff88;">Найдено ${actualResults.length} совпадений по запросу "${query}":</span>\n\n`;

        results.forEach((result, index) => {
            if (result.lineNumber === -1) {
                output += result.context + '\n\n';
                return;
            }

            output += `--- Результат ${index + 1} (строка ${result.lineNumber}) ---\n`;

            // Подсвечиваем все найденные слова
            let highlightedContext = result.context;
            queryWords.forEach(word => {
                const regex = new RegExp(`(${word})`, 'gi');
                highlightedContext = highlightedContext.replace(
                    regex,
                    '<span style="background-color: #ffeb3b; color: #000; padding: 1px 3px; border-radius: 2px; font-weight: bold;">$1</span>'
                );
            });

            output += highlightedContext + '\n\n';
        });

        // Добавляем подсказку
        output += `<span style="color: #a0a0a0; font-size: 12px;">💡 Поиск работает по отдельным словам. Чем больше слов совпадает, тем выше результат в списке.</span>`;

        chatSearchOutput.innerHTML = output;
    }
}

// ===== ФУНКЦИИ ДЛЯ ВКЛАДКИ ЛОРД =====

// Глобальные функции для onclick
window.removeTrackedKey = removeTrackedKey;

// Инициализация вкладки лорда
async function initializeLordTab() {
    console.log('[Lord Tab] Инициализация вкладки лорда');

    // Получаем элементы
    const refreshBtn = document.getElementById('refreshTrackedKeysBtn');
    const addKeyBtn = document.getElementById('addTrackedKeyBtn');

    if (refreshBtn) {
        refreshBtn.addEventListener('click', loadTrackedKeys);
    }

    if (addKeyBtn) {
        addKeyBtn.addEventListener('click', addTrackedKey);
    }

    // Автоматически загружаем ключи при открытии вкладки
    await loadTrackedKeys();
}

// Загрузка отслеживаемых ключей
async function loadTrackedKeys() {
    try {

        // Получаем user_id через расширение
        const authStatus = await chrome.runtime.sendMessage({ type: 'getAuthStatus' });
        const userId = authStatus.user_id;
        if (!userId) {
            updateTrackedKeysUI({
                error: 'Требуется авторизация'
            });
            return;
        }

        const response = await fetch(`${SERVER_URL}/api/lord/tracked-keys`, {
            method: 'GET',
            headers: {
                'X-User-ID': userId.toString(),
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            const data = await response.json();
            updateTrackedKeysUI({
                keys: data.tracked_keys || []
            });
        } else if (response.status === 403) {
            updateTrackedKeysUI({
                error: 'Недостаточно прав доступа'
            });
        } else {
            updateTrackedKeysUI({
                error: 'Ошибка загрузки ключей'
            });
        }

    } catch (error) {
        console.error('[Lord Tab] Ошибка загрузки ключей:', error);
        updateTrackedKeysUI({
            error: 'Ошибка сети'
        });
    }
}

// Добавление ключа для отслеживания
async function addTrackedKey() {
    const keyValue = document.getElementById('trackedKeyValue').value.trim();
    const userName = document.getElementById('trackedUserName').value.trim();

    if (!keyValue) {
        alert('Введите key_value');
        return;
    }

    try {
        // Получаем user_id через расширение
        const authStatus = await chrome.runtime.sendMessage({ type: 'getAuthStatus' });
        const userId = authStatus.user_id;
        if (!userId) {
            alert('Требуется авторизация');
            return;
        }

        const response = await fetch(`${SERVER_URL}/api/lord/add-tracked-key`, {
            method: 'POST',
            headers: {
                'X-User-ID': userId.toString(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                key_value: keyValue,
                user_name: userName || null
            })
        });

        if (response.ok) {
            const result = await response.json();
            alert(result.message);

            // Очищаем форму
            document.getElementById('trackedKeyValue').value = '';
            document.getElementById('trackedUserName').value = '';

            // Перезагружаем список
            await loadTrackedKeys();
        } else {
            const error = await response.json();
            alert(error.detail || 'Ошибка добавления ключа');
        }

    } catch (error) {
        console.error('[Lord Tab] Ошибка добавления ключа:', error);
        alert('Ошибка сети');
    }
}

// Удаление ключа из отслеживаемых
async function removeTrackedKey(keyValue) {
    if (!confirm(`Удалить ключ ${keyValue} из отслеживаемых?`)) {
        return;
    }

    try {
        // Получаем user_id через расширение
        const authStatus = await chrome.runtime.sendMessage({ type: 'getAuthStatus' });
        const userId = authStatus.user_id;
        if (!userId) {
            alert('Требуется авторизация');
            return;
        }

        const response = await fetch(`${SERVER_URL}/api/lord/remove-tracked-key?key_value=${encodeURIComponent(keyValue)}`, {
            method: 'DELETE',
            headers: {
                'X-User-ID': userId.toString(),
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            const result = await response.json();
            alert(result.message);
            await loadTrackedKeys();
        } else {
            const error = await response.json();
            alert(error.detail || 'Ошибка удаления ключа');
        }

    } catch (error) {
        console.error('[Lord Tab] Ошибка удаления ключа:', error);
        alert('Ошибка сети');
    }
}

// Функция для начала inline-редактирования
function startInlineEdit(button, keyId, field, currentValue) {
    const container = button.parentElement;
    const textSpan = container.querySelector('span');
    const originalText = textSpan.textContent;

    // Создаем input для редактирования
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentValue;
    input.style.cssText = `
        background: rgba(0, 0, 0, 0.5);
        border: 1px solid rgba(0, 122, 255, 0.5);
        border-radius: 4px;
        color: #ffffff;
        padding: 4px 8px;
        font-size: ${field === 'user_name' ? '13px' : '11px'};
        width: 150px;
    `;

    // Заменяем span на input
    textSpan.style.display = 'none';
    container.insertBefore(input, button);

    // Меняем кнопку на "Сохранить"
    const originalButtonText = button.textContent;
    button.textContent = '💾';
    button.style.background = 'rgba(0, 255, 0, 0.2)';
    button.style.borderColor = 'rgba(0, 255, 0, 0.5)';
    button.style.color = '#00ff00';

    // Обработчик сохранения
    const saveHandler = async () => {
        const newValue = input.value.trim();
        await finishInlineEdit(keyId, field, newValue, container, textSpan, button, originalButtonText, input);
    };

    // Обработчик отмены (Escape)
    const cancelHandler = (e) => {
        if (e.key === 'Escape') {
            textSpan.style.display = '';
            container.removeChild(input);
            button.textContent = originalButtonText;
            button.style.background = 'rgba(0, 122, 255, 0.2)';
            button.style.borderColor = 'rgba(0, 122, 255, 0.5)';
            button.style.color = '#007AFF';
            input.removeEventListener('keydown', cancelHandler);
            button.removeEventListener('click', saveHandler);
        }
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            saveHandler();
        } else if (e.key === 'Escape') {
            cancelHandler(e);
        }
    });

    button.addEventListener('click', saveHandler);
    input.focus();
    input.select();
}

// Функция для завершения inline-редактирования
async function finishInlineEdit(keyId, field, newValue, container, textSpan, button, originalButtonText, input) {
    try {
        // Получаем key_value для данного keyId
        const keys = JSON.parse(localStorage.getItem('lordTrackedKeys') || '[]');
        const keyData = keys.find(k => k.id == keyId);

        if (!keyData) {
            alert('Ключ не найден');
            return;
        }

        // Отправляем обновление на сервер
        const authStatus = await chrome.runtime.sendMessage({ type: 'getAuthStatus' });
        const userId = authStatus.user_id;

        if (!userId) {
            alert('Требуется авторизация');
            return;
        }

        const response = await fetch(`${SERVER_URL}/api/lord/update-tracked-key`, {
            method: 'PUT',
            headers: {
                'X-User-ID': userId.toString(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                key_value: keyData.key_value,
                [field]: newValue
            })
        });

        if (response.ok) {
            // Обновляем отображение
            const icon = '👤';
            textSpan.textContent = `${icon} ${newValue || 'Не указано'}`;

            // Обновляем данные в localStorage
            keyData[field] = newValue;
            localStorage.setItem('lordTrackedKeys', JSON.stringify(keys));

            alert('Изменения сохранены');
        } else {
            const error = await response.json();
            alert(error.detail || 'Ошибка сохранения');
        }

    } catch (error) {
        console.error('[Lord Tab] Ошибка сохранения:', error);
        alert('Ошибка сети');
    }

    // Восстанавливаем интерфейс
    textSpan.style.display = '';
    container.removeChild(input);
    button.textContent = originalButtonText;
    button.style.background = 'rgba(0, 122, 255, 0.2)';
    button.style.borderColor = 'rgba(0, 122, 255, 0.5)';
    button.style.color = '#007AFF';
}

// Обновление UI отслеживаемых ключей
function updateTrackedKeysUI(data) {
    const listEl = document.getElementById('trackedKeysList');

    if (data.error) {
        listEl.innerHTML = `<div style="padding: 20px; text-align: center; color: #ff6b6b;">❌ ${data.error}</div>`;
        return;
    }

    const keys = data.keys || [];

    // Сохраняем ключи в localStorage для быстрого доступа
    localStorage.setItem('lordTrackedKeys', JSON.stringify(keys));

    if (keys.length === 0) {
        listEl.innerHTML = '<div style="padding: 20px; text-align: center; color: #a0a0a0;">📭 Нет отслеживаемых ключей<br><small>Добавьте ключ выше</small></div>';
        return;
    }

    let html = '<div style="padding: 16px;"><div style="display: grid; gap: 8px;">';

    keys.forEach(key => {
        const expiresAt = key.expires_at ? new Date(key.expires_at) : null;
        const expiresText = expiresAt ? expiresAt.toLocaleString('ru-RU') : 'Бессрочная';
        const isExpired = key.is_expired;
        const daysRemaining = key.days_remaining;

        let statusColor = '#00ff88'; // Зеленый
        let statusText = '✅ Активна';
        let statusIcon = '🟢';

        if (isExpired) {
            statusColor = '#ff6b6b'; // Красный
            statusText = '❌ Истекла';
            statusIcon = '🔴';
        } else if (daysRemaining !== null) {
            if (daysRemaining <= 0) {
                statusColor = '#ff6b6b';
                statusText = '⏰ Истекает сегодня';
                statusIcon = '🟡';
            } else if (daysRemaining <= 3) {
                statusColor = '#ffa500';
                statusText = `⏰ ${daysRemaining} д.`;
                statusIcon = '🟡';
            } else if (daysRemaining <= 7) {
                statusColor = '#ffd700';
                statusText = `⏰ ${daysRemaining} д.`;
                statusIcon = '🟡';
            }
        }

        html += `
            <div style="background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; padding: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: start; gap: 12px;">
                    <div style="flex: 1;">
                        <div style="font-size: 18px; color: #ffffff; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; font-weight: 700;">
                            <span>👤 ${key.user_name || 'Не указано'}</span>
                            <button class="edit-btn edit-name-btn" data-key-id="${key.id}" data-field="user_name" data-current-value="${key.user_name || ''}"
                                    style="background: rgba(0, 122, 255, 0.2); border: 1px solid rgba(0, 122, 255, 0.5); color: #007AFF; padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 10px;">
                                ✏️
                            </button>
                        </div>
                        <div style="font-size: 15px; color: ${statusColor}; font-weight: 500; margin-bottom: 12px;">
                            📅 ${expiresText} ${daysRemaining !== null && daysRemaining > 0 ? `(${daysRemaining} д. осталось)` : daysRemaining === 0 ? '(истекает сегодня)' : ''}
                        </div>
                        <div style="text-align: center; font-size: 11px; color: #a0a0a0; font-weight: 500; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.1);">
                            🔑 ${key.key_value} ${statusIcon}
                        </div>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <button class="edit-btn refresh-single-key" data-key-id="${key.id}"
                                style="background: rgba(0, 122, 255, 0.2); border: 1px solid rgba(0, 122, 255, 0.5); color: #007AFF; padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 10px;">
                            🔄
                        </button>
                        <button class="remove-key-btn" data-key-value="${key.key_value}"
                                style="background: rgba(255, 77, 79, 0.2); border: 1px solid rgba(255, 77, 79, 0.5); color: #ff4d4f; padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;">
                            🗑️
                        </button>
                    </div>
                </div>
            </div>
        `;
    });

    html += '</div></div>';
    listEl.innerHTML = html;

    // Добавляем обработчики событий для кнопок удаления
    const removeButtons = listEl.querySelectorAll('.remove-key-btn');
    removeButtons.forEach(button => {
        button.addEventListener('click', () => {
            const keyValue = button.getAttribute('data-key-value');
            if (keyValue) {
                removeTrackedKey(keyValue);
            }
        });
    });

    // Добавляем обработчики событий для кнопок редактирования имени
    const editNameButtons = listEl.querySelectorAll('.edit-name-btn');
    editNameButtons.forEach(button => {
        button.addEventListener('click', () => {
            const keyId = button.getAttribute('data-key-id');
            const field = button.getAttribute('data-field');
            const currentValue = button.getAttribute('data-current-value');
            if (keyId && field) {
                startInlineEdit(button, keyId, field, currentValue);
            }
        });
    });

    // Добавляем обработчики для кнопок обновления
    const refreshButtons = listEl.querySelectorAll('.refresh-single-key');
    refreshButtons.forEach(button => {
        button.addEventListener('click', async () => {
            const keyId = button.getAttribute('data-key-id');
            if (keyId) {
                // Показываем загрузку
                button.textContent = '⏳';
                button.disabled = true;

                try {
                    // Получаем свежие данные для этого ключа
                    const authStatus = await chrome.runtime.sendMessage({ type: 'getAuthStatus' });
                    const userId = authStatus.user_id;

                    if (!userId) {
                        alert('Требуется авторизация');
                        return;
                    }

                    const response = await fetch(`${SERVER_URL}/api/lord/tracked-keys`, {
                        method: 'GET',
                        headers: {
                            'X-User-ID': userId.toString(),
                            'Content-Type': 'application/json'
                        }
                    });

                    if (response.ok) {
                        const data = await response.json();
                        updateTrackedKeysUI({
                            keys: data.tracked_keys || []
                        });
                    } else {
                        alert('Ошибка обновления данных');
                    }
                } catch (error) {
                    console.error('[Lord Tab] Ошибка обновления:', error);
                    alert('Ошибка сети');
                } finally {
                    // Восстанавливаем кнопку
                    button.textContent = '🔄';
                    button.disabled = false;
                }
            }
        });
    });
}

