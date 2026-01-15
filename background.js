// Background script - ЕДИНСТВЕННЫЙ ИСТОЧНИК ИСТИНЫ для авторизации

// Режим отладки (включить для диагностики)
const DEBUG_MODE = false;

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

// ===== СИСТЕМА КЕШИРОВАНИЯ =====
// Кеш для авто-ответов (время жизни: 10 минут)
const autoRepliesCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 минут в миллисекундах

// Кеш для фото (время жизни: 30 минут)
const photoCache = new Map();
const PHOTO_CACHE_TTL = 30 * 60 * 1000; // 30 минут в миллисекундах

// Кеш для сообщений (время жизни: 5 минут)
const messageCache = new Map();
const MESSAGE_CACHE_TTL = 5 * 60 * 1000; // 5 минут в миллисекундах

// Функция получения данных из кеша с проверкой TTL
function getFromCache(cache, key) {
    const item = cache.get(key);
    if (!item) return null;

    const now = Date.now();
    if (now - item.timestamp > item.ttl) {
        cache.delete(key);
        return null;
    }

    return item.data;
}

// Функция сохранения данных в кеш
function setCache(cache, key, data, ttl = CACHE_TTL) {
    cache.set(key, {
        data: data,
        timestamp: Date.now(),
        ttl: ttl
    });

    // Очищаем старые записи при превышении размера кеша
    if (cache.size > 100) {
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
    }
}

// Очистка кешей по таймеру
setInterval(() => {
    const now = Date.now();

    // Очистка кеша авто-ответов
    for (const [key, item] of autoRepliesCache.entries()) {
        if (now - item.timestamp > item.ttl) {
            autoRepliesCache.delete(key);
        }
    }

    // Очистка кеша фото
    for (const [key, item] of photoCache.entries()) {
        if (now - item.timestamp > item.ttl) {
            photoCache.delete(key);
        }
    }

    // Очистка кеша сообщений
    for (const [key, item] of messageCache.entries()) {
        if (now - item.timestamp > item.ttl) {
            messageCache.delete(key);
        }
    }

    log('[Cache] Очистка кешей завершена');
}, 5 * 60 * 1000); // Каждые 5 минут

// ===== МОНИТОРИНГ ПРОИЗВОДИТЕЛЬНОСТИ =====
// Мониторинг использования памяти и производительности
setInterval(() => {
    if (typeof performance !== 'undefined' && performance.memory) {
        const memUsage = performance.memory;
        const usedMB = Math.round(memUsage.usedJSHeapSize / 1024 / 1024);
        const totalMB = Math.round(memUsage.totalJSHeapSize / 1024 / 1024);
        const limitMB = Math.round(memUsage.jsHeapSizeLimit / 1024 / 1024);

        // Если использование памяти > 80% от лимита, очищаем кеши
        if (usedMB > limitMB * 0.8) {
            log(`[Performance] Высокое использование памяти: ${usedMB}MB/${limitMB}MB, очистка кешей`);
            autoRepliesCache.clear();
            photoCache.clear();
            messageCache.clear();
        } else {
            log(`[Performance] Использование памяти: ${usedMB}MB/${totalMB}MB (лимит: ${limitMB}MB)`);
        }
    }
}, 10 * 60 * 1000); // Каждые 10 минут

// ===== АВТОРИЗАЦИЯ - ЕДИНСТВЕННЫЙ ИСТОЧНИК ИСТИНЫ =====
// AUTH = false означает полную блокировку всех функций расширения
let AUTH = false;
let AUTH_EXPIRE = null;
let AUTH_USER_ID = null;
let CURRENT_DEVICE_ID = null;
let USER_PRIVILEGE = 'operator'; // Привилегия пользователя: 'operator' или 'lord'

// Инициализация системы блокировки операций
async function initializeOperationLocks() {
    try {
        await loadOperationLocks();
        cleanupStaleLocks();
        log('Система блокировки операций инициализирована');
    } catch (error) {
        logError('Ошибка инициализации системы блокировки:', error);
    }
}

// Конфигурация сервера авторизации
const AUTH_SERVER_URL = 'https://alpha-production-5ab0.up.railway.app';

// Настройки поведения при истечении подписки
const SUBSCRIPTION_SETTINGS = {
    AUTO_LOGOUT_ON_EXPIRY: false, // НЕ выполнять автоматический logout при истечении подписки
    LOGOUT_CHECK_INTERVAL: 2 * 1000 // Проверка каждые 2 секунды
};

// ===== СИСТЕМА БЛОКИРОВКИ ДУБЛИРОВАНИЯ ОПЕРАЦИЙ =====
// Предотвращает выполнение одной операции в нескольких вкладках

// Глобальные флаги блокировки операций
let OPERATION_LOCKS = {
    broadcast: false,    // Глобальная рассылка активна
    autoreply: false,    // Автоответы активны (блокировка на время обработки)
};

// Ключи обработанных сообщений (синхронизированные между вкладками)
const MAX_SEEN_MESSAGES = 500; // Максимальное количество хранимых ключей

// Таймеры для автоматической очистки блокировок
let operationLockTimers = {};

// Функция установки блокировки операции
function setOperationLock(operationType, duration = 30000) {
    if (!OPERATION_LOCKS.hasOwnProperty(operationType)) {
        logError(`Неизвестный тип операции: ${operationType}`);
        return false;
    }

    OPERATION_LOCKS[operationType] = true;
    log(`Установлена блокировка операции: ${operationType} на ${duration}ms`);

    // Сохраняем в storage для синхронизации между вкладками
    chrome.storage.local.set({
        operationLocks: OPERATION_LOCKS
    }).catch(err => logError('Ошибка сохранения блокировок:', err));

    // Автоматическая разблокировка через заданное время
    if (operationLockTimers[operationType]) {
        clearTimeout(operationLockTimers[operationType]);
    }

    operationLockTimers[operationType] = setTimeout(() => {
        clearOperationLock(operationType);
    }, duration);

    return true;
}

// Функция снятия блокировки операции
function clearOperationLock(operationType) {
    if (!OPERATION_LOCKS.hasOwnProperty(operationType)) {
        logError(`Неизвестный тип операции: ${operationType}`);
        return false;
    }

    OPERATION_LOCKS[operationType] = false;
    log(`Снята блокировка операции: ${operationType}`);

    // Очищаем таймер
    if (operationLockTimers[operationType]) {
        clearTimeout(operationLockTimers[operationType]);
        delete operationLockTimers[operationType];
    }

    // Сохраняем в storage для синхронизации
    chrome.storage.local.set({
        operationLocks: OPERATION_LOCKS
    }).catch(err => logError('Ошибка сохранения блокировок:', err));

    return true;
}

// Функция проверки блокировки операции
function isOperationLocked(operationType) {
    return OPERATION_LOCKS[operationType] === true;
}

// Функция загрузки состояния блокировок из storage
async function loadOperationLocks() {
    try {
        const data = await chrome.storage.local.get(['operationLocks']);
        if (data.operationLocks) {
            OPERATION_LOCKS = { ...OPERATION_LOCKS, ...data.operationLocks };
            log('Загружены блокировки операций:', OPERATION_LOCKS);
        }
    } catch (error) {
        logError('Ошибка загрузки блокировок операций:', error);
    }
}

// Функция проверки и добавления ключа обработанного сообщения
async function checkAndAddSeenMessage(key) {
    try {
        const data = await chrome.storage.local.get(['seenMessageKeys']);
        const seenKeys = new Set(data.seenMessageKeys || []);

        if (seenKeys.has(key)) {
            return false; // Уже обработано
        }

        // Добавляем новый ключ
        seenKeys.add(key);

        // Ограничиваем размер множества
        if (seenKeys.size > MAX_SEEN_MESSAGES) {
            const arr = Array.from(seenKeys);
            const tail = arr.slice(-MAX_SEEN_MESSAGES);
            seenKeys.clear();
            tail.forEach(k => seenKeys.add(k));
        }

        // Сохраняем обновленный набор
        await chrome.storage.local.set({
            seenMessageKeys: Array.from(seenKeys)
        });

        return true; // Новое сообщение
    } catch (error) {
        logError('Ошибка проверки seen message:', error);
        return true; // В случае ошибки разрешаем обработку
    }
}

// Функция очистки устаревших блокировок при запуске
function cleanupStaleLocks() {
    // Сбрасываем все блокировки при запуске расширения
    // (предполагаем, что после перезагрузки все операции должны быть доступны)
    OPERATION_LOCKS = {
        broadcast: false,
        autoreply: false,
    };

    chrome.storage.local.set({
        operationLocks: OPERATION_LOCKS,
        seenMessageKeys: [] // Очищаем и seen keys при запуске
    }).catch(err => logError('Ошибка очистки блокировок:', err));

    log('Очищены устаревшие блокировки при запуске расширения');
}

// Функция проверки авторизации
// Асинхронная версия проверки авторизации с перепроверкой на сервере
async function isAuthorizedAsync() {
    if (!AUTH) return false;

    // Если подписка активна локально - сразу возвращаем true
    if (hasActiveSubscription()) {
        log('Локальная подписка активна - продолжаем работу');
        return true;
    }

    log('Локальная подписка истекла - перепроверяем на сервере...');

    // Если истекла - перепроверяем на сервере
    const serverCheck = await checkSubscriptionOnServer();

    if (!serverCheck) {
        log('Сервер недоступен или подписка истекла - продолжаем работу с локальной проверкой');
        // НЕ выполняем logout - даем пользователю продолжить работу
        // resetAuth(); // ЗАКОММЕНТИРОВАНО - не выкидываем на авторизацию
        return hasActiveSubscription(); // Возвращаем результат локальной проверки
    }

    log('Подписка активна на сервере - продолжаем работу');
    return true;
}

// Синхронная версия для обратной совместимости (использует только локальную проверку)
function isAuthorized() {
    if (!AUTH) {
        log('isAuthorized: Нет авторизации');
        return false;
    }

    // ПРОВЕРКА ПОДПИСКИ - если подписка истекла, НЕ выполняем автоматический logout
    if (!hasActiveSubscription()) {
        log('isAuthorized: Подписка истекла локально - продолжаем работу');
        log(`isAuthorized: AUTH_EXPIRE = ${AUTH_EXPIRE} (${AUTH_EXPIRE ? new Date(AUTH_EXPIRE).toISOString() : 'null'})`);
        // resetAuth(); // ЗАКОММЕНТИРОВАНО - не выкидываем на авторизацию
        return false; // Но возвращаем false для ограничения функций
    }

    log('isAuthorized: Авторизация и подписка активны');
    return true;
}

// Функция проверки активной подписки (для ограничения функций)
function hasActiveSubscription() {
    if (!AUTH) {
        log('hasActiveSubscription: Нет авторизации');
        return false;
    }

    if (!AUTH_EXPIRE) {
        log('hasActiveSubscription: Нет времени истечения');
        return false;
    }

    const now = Date.now();
    const isActive = now <= AUTH_EXPIRE;

    log(`hasActiveSubscription: ${now} <= ${AUTH_EXPIRE} = ${isActive} (${new Date(AUTH_EXPIRE).toISOString()})`);

    return isActive;
}

// Функция перепроверки подписки на сервере (асинхронная)
async function checkSubscriptionOnServer() {
    if (!AUTH || !AUTH_USER_ID) {
        log('Невозможно проверить подписку - нет авторизации');
        return false;
    }

    try {
        log('Перепроверяем подписку на сервере...');

        // Сначала проверим, работает ли сервер вообще
        try {
            log('Тестируем подключение к серверу...');
            const testResponse = await fetch(`${AUTH_SERVER_URL}/api/test`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Extension-Version': '1.0.0'
                },
                signal: AbortSignal.timeout(3000) // 3 секунды на тест
            });

            if (!testResponse.ok) {
                logError('Тестовый эндпоинт сервера вернул ошибку:', testResponse.status);
                return hasActiveSubscription();
            }

            const testData = await testResponse.json();
            log('Тест сервера прошел успешно:', testData.status);

        } catch (testError) {
            logError('Не удалось протестировать сервер:', testError.message);
            return hasActiveSubscription();
        }

        log(`Отправляем запрос: ${AUTH_SERVER_URL}/api/check-subscription с X-User-ID: ${AUTH_USER_ID}, X-Device-ID: ${CURRENT_DEVICE_ID}`);

        const response = await fetch(`${AUTH_SERVER_URL}/api/check-subscription`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-User-ID': AUTH_USER_ID.toString(),
                'X-Device-ID': CURRENT_DEVICE_ID, // ← ПРОВЕРКА ПРИВЯЗКИ К УСТРОЙСТВУ
                'X-Extension-Version': '1.0.0'
            },
            signal: AbortSignal.timeout(8000) // 8 секунд таймаут
        });
        log(`Получен ответ от сервера: ${response.status} ${response.statusText}`);

        if (!response.ok) {
            logError('Ошибка при проверке подписки на сервере:', response.status, response.statusText);
            // Пробуем прочитать тело ошибки
            try {
                const errorText = await response.text();
                logError('Тело ответа ошибки:', errorText);
            } catch (e) {
                logError('Не удалось прочитать тело ошибки:', e);
            }
            return hasActiveSubscription(); // Возвращаем локальную проверку при ошибке
        }

        const data = await response.json();
        log('Ответ сервера о подписке:', data);

        // Анализируем ответ сервера
        if (data.has_subscription === true && data.is_expired === false) {
            // Подписка активна на сервере
            if (data.expires_at) {
                const serverExpireTime = new Date(data.expires_at).getTime();
                const currentExpireTime = AUTH_EXPIRE || 0;

                log(`Сервер подтвердил активную подписку до: ${new Date(serverExpireTime).toISOString()}`);
                log(`Текущее локальное время истечения: ${new Date(currentExpireTime).toISOString()}`);

                // Всегда обновляем время с сервера (источник истины)
                AUTH_EXPIRE = serverExpireTime;
                log(`Устанавливаем новое время истечения: ${new Date(AUTH_EXPIRE).toISOString()}`);

                // Сохраняем privilege
                USER_PRIVILEGE = data.privilege || 'operator';
                log(`Привилегия пользователя: ${USER_PRIVILEGE}`);

                // Сохраняем в storage
                await chrome.storage.local.set({
                    authExpire: AUTH_EXPIRE,
                    userPrivilege: USER_PRIVILEGE,
                    lastServerCheck: Date.now(),
                    serverResponse: data
                });

                log('✅ Подписка активна, время синхронизировано с сервером');
                return true;
            } else {
                // Бессрочная подписка
                log('✅ Бессрочная подписка активна');
                AUTH_EXPIRE = Date.now() + (365 * 24 * 60 * 60 * 1000); // +1 год для бессрочных
                USER_PRIVILEGE = data.privilege || 'operator';
                log(`Привилегия пользователя: ${USER_PRIVILEGE}`);
                await chrome.storage.local.set({
                    authExpire: AUTH_EXPIRE,
                    userPrivilege: USER_PRIVILEGE,
                    lastServerCheck: Date.now(),
                    serverResponse: data
                });
                return true;
            }
        } else {
            // Подписка неактивна или истекла
            log(`❌ Подписка неактивна: has_subscription=${data.has_subscription}, is_expired=${data.is_expired}`);

            // Сбрасываем авторизацию
            AUTH_EXPIRE = null;
            await chrome.storage.local.set({
                authExpire: null,
                lastServerCheck: Date.now(),
                serverResponse: data
            });

            return false;
        }

    } catch (error) {
        // Специальная обработка разных типов ошибок
        if (error.name === 'AbortError') {
            logError('Запрос был отменен по таймауту (AbortError)');
        } else if (error.message && error.message.includes('NetworkError')) {
            logError('Ошибка сети при проверке подписки:', error.message);
        } else if (error.message && error.message.includes('Failed to fetch')) {
            logError('Не удалось подключиться к серверу:', error.message);
        } else {
            logError('Ошибка перепроверки подписки на сервере:', error.message || error);
        }

        // При ошибке возвращаем локальную проверку
        log('Возвращаемся к локальной проверке подписки');
        return hasActiveSubscription();
    }
}

// Функция серверной верификации access key с привязкой к устройству
async function verifyAccessKey(accessKey) {
    try {
        // Генерируем device ID для этого устройства
        const deviceId = generateDeviceId();
        log(`Верификация ключа на устройстве: ${deviceId}`);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд таймаут

        const response = await fetch(`${AUTH_SERVER_URL}/api/verify-access-key`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Extension-Version': '1.0.0'
            },
            body: JSON.stringify({
                access_key: accessKey.trim().toUpperCase(),
                device_id: deviceId, // ← ПРИВЯЗКА К УСТРОЙСТВУ
                device_fingerprint: {
                    user_agent: navigator.userAgent,
                    timezone: new Date().getTimezoneOffset(),
                    language: navigator.language,
                    platform: navigator.platform,
                    cookie_enabled: navigator.cookieEnabled,
                    online_status: navigator.onLine
                },
                timestamp: Date.now()
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            if (response.status === 401) {
                throw new Error('Неверный ключ доступа');
            } else if (response.status === 403) {
                throw new Error('Доступ запрещен');
            } else if (response.status === 429) {
                throw new Error('Слишком много попыток. Попробуйте позже');
            } else {
                throw new Error('Ошибка сервера авторизации');
            }
        }

        const data = await response.json();
        log(`Ответ сервера о верификации:`, data);

        if (!data.valid) {
            if (data.error === 'DEVICE_LIMIT_EXCEEDED') {
                throw new Error('Этот ключ уже используется на другом устройстве. Освободите ключ на предыдущем устройстве.');
            }
            if (data.error === 'DEVICE_MISMATCH') {
                throw new Error('Ключ привязан к другому устройству. Используйте другой ключ.');
            }
            throw new Error(data.message || 'Неверный ключ доступа');
        }

        if (!data.expires_at) {
            throw new Error('Некорректный ответ сервера');
        }

        // Устанавливаем авторизацию с привязкой к устройству
        AUTH = true;
        AUTH_EXPIRE = new Date(data.expires_at).getTime();
        AUTH_USER_ID = data.user_id;
        CURRENT_DEVICE_ID = deviceId; // ← СОХРАНЯЕМ DEVICE ID

        log(`Авторизация успешна. Пользователь: ${AUTH_USER_ID}, устройство: ${CURRENT_DEVICE_ID}, истекает: ${new Date(AUTH_EXPIRE).toISOString()}`);

        return {
            success: true,
            user_id: data.user_id,
            device_id: deviceId,
            expires_at: data.expires_at,
            message: data.message || 'Авторизация успешна'
        };

    } catch (error) {
        logError('Ошибка верификации access key:', error.message);
        AUTH = false;
        AUTH_EXPIRE = null;
        AUTH_USER_ID = null;
        throw error;
    }
}

// Функция генерации уникального ID устройства
function generateDeviceId() {
    try {
        // Собираем уникальные характеристики устройства
        // В background script screen недоступен, используем доступные данные
        const components = [
            chrome.runtime.id, // Уникальный ID расширения
            navigator.userAgent,
            navigator.language || 'unknown',
            new Date().getTimezoneOffset().toString(), // Часовой пояс
            navigator.platform || 'unknown', // ОС
            navigator.hardwareConcurrency || 'unknown', // Количество ядер CPU
            'extension_v1.0.0', // Версия расширения
            navigator.cookieEnabled ? 'cookies_enabled' : 'cookies_disabled',
            navigator.onLine ? 'online' : 'offline'
        ];

        // Создаем hash из компонентов
        let hash = 0;
        const combined = components.join('|');
        for (let i = 0; i < combined.length; i++) {
            const char = combined.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 32-bit integer
        }

        // Возвращаем hex строку
        return Math.abs(hash).toString(16).toUpperCase().substr(0, 16);
    } catch (error) {
        logError('Ошибка генерации device ID:', error);
        // Fallback на случайный ID
        return 'FALLBACK_' + Math.random().toString(36).substr(2, 8).toUpperCase();
    }
}

// Функция сброса авторизации
function resetAuth() {
    AUTH = false;
    AUTH_EXPIRE = null;
    AUTH_USER_ID = null;
    CURRENT_DEVICE_ID = null;
    USER_PRIVILEGE = 'operator';
    log('Авторизация сброшена');
}

chrome.action.onClicked.addListener((tab) => {
    // Настраиваем side panel для текущей вкладки
    chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: 'popup.html',
        enabled: true
    }, () => {
        if (chrome.runtime.lastError) {
            console.error('Ошибка настройки side panel:', chrome.runtime.lastError);
            // Fallback - создаем отдельное окно
            chrome.windows.create({
                url: chrome.runtime.getURL('popup.html'),
                type: 'normal',
                width: 400,
                height: 600,
                left: 1000, // Фиксированная позиция справа
                top: 100
            });
            return;
        }

        // Открываем side panel
        chrome.sidePanel.open({ tabId: tab.id });
    });
});

// ===== ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ - СТРОГИЙ КОНТРОЛЬ ДОСТУПА =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // РАЗРЕШЕННЫЕ ЗАПРОСЫ - работают без авторизации
    const alwaysAllowed = [
        'verifyAccessKey',
        'getAuthStatus',
        'showBrowserNotification'  // Системные уведомления должны работать всегда
    ];

    // ПРОВЕРКА АВТОРИЗАЦИИ - пользователь должен быть авторизован для большинства функций
    if (!alwaysAllowed.includes(message.type)) {
        if (!isAuthorized()) {
            logError(`Блокировка неавторизованного запроса: ${message.type}`);
            sendResponse({
                success: false,
                error: 'Требуется авторизация',
                code: 'AUTH_REQUIRED'
            });
            return true;
        }

        // ПРОВЕРКА АКТИВНОЙ ПОДПИСКИ - для некоторых функций
        // При истекшей подписке ограничиваем функционал, но не блокируем полностью
        const subscriptionRequired = [
            'startBroadcast', 'startBroadcastAll', 'getImagesList',
            'getVideoInfo', 'getPhotoInfo', 'checkManMirror',
            'startScheduledBroadcast', // Автоматическая рассылка
            'showBrowserNotification', // Уведомления Chrome
            'testNotification', // Тестовые уведомления
            'connectWebSocket', // Мониторинг сообщений
            'initAutoRefresh' // Автообновление страницы
        ];

        if (subscriptionRequired.includes(message.type) && !hasActiveSubscription()) {
            logError(`Блокировка функции при истекшей подписке: ${message.type}`);
            sendResponse({
                success: false,
                error: 'Требуется активная подписка для выполнения этой функции',
                code: 'SUBSCRIPTION_EXPIRED'
            });
            return true;
        }
    }

    // Обработка верификации access key
    if (message.type === 'verifyAccessKey') {
        const { accessKey } = message.payload || {};

        if (!accessKey || typeof accessKey !== 'string' || accessKey.length < 10) {
            sendResponse({
                success: false,
                error: 'Некорректный ключ доступа',
                code: 'INVALID_KEY'
            });
            return true;
        }

        verifyAccessKey(accessKey)
            .then(result => {
                sendResponse(result);
            })
            .catch(error => {
                sendResponse({
                    success: false,
                    error: error.message,
                    code: 'VERIFICATION_FAILED'
                });
            });

        return true; // Асинхронный ответ
    }

    // ===== ОБРАБОТЧИКИ БЛОКИРОВКИ ОПЕРАЦИЙ =====

    // Проверка блокировки операции
    if (message.type === 'checkOperationLock') {
        const { operationType } = message.payload || {};
        sendResponse({
            locked: isOperationLocked(operationType),
            operationType
        });
        return true;
    }

    // Установка блокировки операции
    if (message.type === 'setOperationLock') {
        const { operationType, duration } = message.payload || {};
        const success = setOperationLock(operationType, duration);
        sendResponse({ success, operationType });
        return true;
    }

    // Снятие блокировки операции
    if (message.type === 'clearOperationLock') {
        const { operationType } = message.payload || {};
        const success = clearOperationLock(operationType);
        sendResponse({ success, operationType });
        return true;
    }

    // Проверка и добавление обработанного сообщения
    if (message.type === 'checkAndAddSeenMessage') {
        const { key } = message.payload || {};
        checkAndAddSeenMessage(key).then(isNew => {
            sendResponse({ isNew, key });
        }).catch(error => {
            logError('Ошибка проверки seen message:', error);
            sendResponse({ isNew: true, key, error: error.message });
        });
        return true; // Асинхронный ответ
    }

    // Проверка статуса авторизации
    if (message.type === 'getAuthStatus') {
        sendResponse({
            authorized: isAuthorized(),
            user_id: AUTH_USER_ID,
            privilege: USER_PRIVILEGE,
            expires_at: AUTH_EXPIRE ? new Date(AUTH_EXPIRE).toISOString() : null
        });
        return true;
    }

    // Проверка статуса подписки
    if (message.type === 'getSubscriptionStatus') {
        sendResponse({
            hasActiveSubscription: hasActiveSubscription(),
            expires_at: AUTH_EXPIRE ? new Date(AUTH_EXPIRE).toISOString() : null
        });
        return true;
    }

    // Принудительный logout (по запросу пользователя)
    if (message.type === 'forceLogout') {
        log('Принудительный logout по запросу пользователя');
        resetAuth();
        sendResponse({ success: true, message: 'Выполнен выход из системы' });
        return true;
    }

    // Сброс авторизации
    if (message.type === 'resetAuth') {
        resetAuth();
        sendResponse({ success: true, message: 'Авторизация сброшена' });
        return true;
    }


    // ОБНОВЛЕНИЕ SIDE PANEL - доступно только для авторизованных
    if (message.type === 'updateSidePanel') {
        chrome.sidePanel.setOptions({
            path: message.path,
            enabled: true
        });
            sendResponse({ success: true });
        return true;
    }

    // УВЕДОМЛЕНИЯ - работают без авторизации
    if (message.type === 'showBrowserNotification') {
        const { title, message: notificationMessage, notificationType, options } = message.payload;

        console.log('[Alpha Date Extension] Получено сообщение для уведомления:', { title, message: notificationMessage, notificationType });

        // Показываем уведомление напрямую из background script
        showBrowserNotification(title, notificationMessage, notificationType, options)
            .then(() => {
                console.log('[Alpha Date Extension] Уведомление показано успешно');
                sendResponse({ success: true });
            })
            .catch((error) => {
                console.error('[Alpha Date Extension] Ошибка показа уведомления:', error);
                sendResponse({ success: false, error: error.message });
            });

        return true; // Асинхронный ответ обязателен
    }

    // ТЕСТ УВЕДОМЛЕНИЙ - требует активной подписки
    if (message.type === 'testNotification') {
        console.log('[Alpha Date Extension] Запрос тестового уведомления');

        // ПРОВЕРКА ПОДПИСКИ - тестовые уведомления требуют активной подписки
        if (!hasActiveSubscription()) {
            logError('Тестовые уведомления заблокированы: подписка истекла');
            sendResponse({
                success: false,
                error: 'Тестовые уведомления требуют активной подписки',
                code: 'SUBSCRIPTION_EXPIRED'
            });
            return true;
        }

        chrome.notifications.create('test-notification', {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon128.png'),
            title: 'Тестовое уведомление',
            message: `Текущее время: ${new Date().toLocaleTimeString()}\nУведомления работают корректно!`,
            priority: 1,
            requireInteraction: false
        }).then((notificationId) => {
            console.log('[Alpha Date Extension] Тестовое уведомление создано:', notificationId);
            sendResponse({ success: true, notificationId });
        }).catch((error) => {
            console.error('[Alpha Date Extension] Ошибка тестового уведомления:', error);
            sendResponse({ success: false, error: error.message });
        });

        return true;
    }
    return false;
});

// Инициализация настроек при установке расширения
chrome.runtime.onInstalled.addListener(async () => {
    console.log('[Alpha Date Extension] Расширение установлено/обновлено, инициализация настроек уведомлений');

    try {
        const data = await chrome.storage.local.get(['notificationSettings']);
        if (!data.notificationSettings) {
            const defaultSettings = {
                enabled: true,
                showNewMessages: true,
                showBroadcastComplete: true,
                showErrors: true,
                showStats: true
            };

            await chrome.storage.local.set({ notificationSettings: defaultSettings });
            console.log('[Alpha Date Extension] Установлены настройки уведомлений по умолчанию:', defaultSettings);
        }
    } catch (error) {
        console.error('[Alpha Date Extension] Ошибка инициализации настроек:', error);
    }
});

// Функция для показа браузерных уведомлений
async function showBrowserNotification(title, message, type = null, options = {}) {
    try {
        console.log('[Alpha Date Extension] Попытка показать уведомление:', { title, message, type });
        console.log('[Alpha Date Extension] Текущее время:', new Date().toISOString());

        // ПРОВЕРКА ПОДПИСКИ - уведомления требуют активной подписки
        if (!hasActiveSubscription()) {
            console.log('[Alpha Date Extension] Уведомления заблокированы: подписка истекла');
            return;
        }

        // Проверяем, включены ли уведомления
        const settings = await chrome.storage.local.get(['notificationSettings']);
        console.log('[Alpha Date Extension] Загруженные настройки в background:', settings);
        const notificationSettings = settings.notificationSettings || {
            notificationsEnabled: true,
            chromeNewMessages: true,
            chromeLikes: true,
            chromeViews: true,
            chromeLetters: true,
            chromeStats: true,
            chromeBroadcast: true,
            chromeReadMail: true,
            chromeLimits: true,
            autoRefreshEnabled: true
        };

        console.log('[Alpha Date Extension] ⚙️ Проверенные настройки уведомлений:', {
            notificationsEnabled: notificationSettings.notificationsEnabled,
            chromeNewMessages: notificationSettings.chromeNewMessages,
            chromeStats: notificationSettings.chromeStats,
            requestedType: type,
            rawSettings: settings
        });

        // Проверяем основной флаг уведомлений
        if (notificationSettings.notificationsEnabled === false) {
            console.log('[Alpha Date Extension] ❌ Уведомления отключены в настройках');
            return;
        }

        // Проверяем тип уведомления
        if (type) {
            console.log('[Alpha Date Extension] Проверяем тип уведомления:', type, 'в настройках:', notificationSettings);
            let typeEnabled = false;
            switch (type) {
                case 'showNewMessages':
                    typeEnabled = notificationSettings.chromeNewMessages !== false;
                    console.log('[Alpha Date Extension] 🔍 Проверка типа showNewMessages:', typeEnabled);
                    break;
                case 'showLetters':
                    typeEnabled = notificationSettings.chromeLetters !== false;
                    console.log('[Alpha Date Extension] 🔍 Проверка типа showLetters:', typeEnabled);
                    break;
                case 'showViews':
                    typeEnabled = notificationSettings.chromeViews !== false;
                    console.log('[Alpha Date Extension] 🔍 Проверка типа showViews:', typeEnabled);
                    break;
                case 'showLikes':
                    typeEnabled = notificationSettings.chromeLikes !== false;
                    console.log('[Alpha Date Extension] 🔍 Проверка типа showLikes:', typeEnabled);
                    break;
                case 'showErrors':
                    typeEnabled = true; // Ошибки всегда показываем
                    console.log('[Alpha Date Extension] 🔍 Ошибки всегда разрешены');
                    break;
                case 'showStats':
                    typeEnabled = notificationSettings.chromeStats !== false;
                    console.log('[Alpha Date Extension] 🔍 Проверка типа showStats:', typeEnabled);
                    break;
                case 'showBroadcastComplete':
                    typeEnabled = notificationSettings.chromeBroadcast !== false;
                    console.log('[Alpha Date Extension] 🔍 Проверка типа showBroadcastComplete:', typeEnabled);
                    break;
                case 'REACTION_LIMITS':
                case 'read_mail':
                    typeEnabled = notificationSettings.chromeReadMail !== false;
                    console.log('[Alpha Date Extension] 🔍 Проверка типа read_mail/REACTION_LIMITS:', typeEnabled);
                    break;
                case 'showLimits':
                    typeEnabled = notificationSettings.chromeLimits !== false;
                    console.log('[Alpha Date Extension] 🔍 Проверка типа showLimits:', typeEnabled);
                    break;
                default:
                    typeEnabled = true; // Для неизвестных типов разрешаем
                    console.log('[Alpha Date Extension] 🔍 Неизвестный тип уведомления:', type, '- разрешен по умолчанию');
            }

            if (!typeEnabled) {
                console.log('[Alpha Date Extension] ❌ Уведомления типа', type, 'отключены');
                return;
            }
        }

        console.log('[Alpha Date Extension] ✅ Проверка Chrome типа пройдена, продолжаем создание уведомления');

        // Проверяем разрешение на уведомления через chrome.permissions API
        let hasPermission = false;
        try {
            const result = await chrome.permissions.contains({ permissions: ['notifications'] });
            hasPermission = result;
            console.log('[Alpha Date Extension] Проверка разрешения через permissions API:', hasPermission);
        } catch (permError) {
            console.warn('[Alpha Date Extension] Ошибка проверки разрешения через permissions API:', permError);
            // В некоторых версиях Chrome permissions.contains может не работать для notifications
            // Попробуем альтернативный способ
            hasPermission = true; // Предполагаем, что разрешение есть
        }

        // В background script контексте полагаемся на chrome.permissions API
        // Notification API может быть недоступен или работать по-другому
        if (!hasPermission) {
            console.warn('[Alpha Date Extension] ❌ Нет разрешения на уведомления через chrome.permissions');
            return;
        }

        console.log('[Alpha Date Extension] ✅ Разрешение на уведомления подтверждено');

        const notificationId = `alpha_date_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const notificationOptions = {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon128.png'),
            title: title,
            message: message,
            priority: options.priority || 0,
            requireInteraction: options.requireInteraction || false,
            silent: options.silent || false
            // Убираем ...options чтобы избежать передачи неподдерживаемых свойств
        };

        console.log('[Alpha Date Extension] Создание уведомления с опциями:', notificationOptions);

        const result = await chrome.notifications.create(notificationId, notificationOptions);
        console.log('[Alpha Date Extension] Результат создания уведомления:', result);

        // Дополнительная проверка - попробуем получить уведомление
        setTimeout(async () => {
            try {
                const notifications = await chrome.notifications.getAll();
                console.log('[Alpha Date Extension] Все активные уведомления:', Object.keys(notifications));
                if (!notifications[notificationId]) {
                    console.warn('[Alpha Date Extension] ⚠️ Уведомление не найдено в списке активных:', notificationId);
                } else {
                    console.log('[Alpha Date Extension] ✅ Уведомление активно:', notificationId);
                }
            } catch (checkError) {
                console.warn('[Alpha Date Extension] Ошибка проверки уведомлений:', checkError);
            }
        }, 100);

        // Автоматически закрываем уведомление через 5 секунд (если не requireInteraction)
        if (!options.requireInteraction) {
            setTimeout(() => {
                chrome.notifications.clear(notificationId);
                console.log('[Alpha Date Extension] Уведомление автоматически закрыто:', notificationId);
            }, 5000);
        }

        console.log('[Alpha Date Extension] ✅ Уведомление успешно создано:', title, message);

        // Сохраняем уведомление в историю
        try {
            const data = await chrome.storage.local.get(['notificationsHistory']);
            const history = data.notificationsHistory || [];

            // Добавляем новое уведомление в начало массива
            const notificationWithId = {
                id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                timestamp: new Date().toISOString(),
                title,
                message,
                finalTitle: title,
                finalMessage: message,
                notificationType: type,
                chatUrl: options.chatUrl,
                originalTitle: options.originalTitle,
                originalMessage: options.originalMessage
            };

            history.unshift(notificationWithId);

            // Ограничиваем историю до 100 уведомлений
            if (history.length > 100) {
                history.splice(100);
            }

            await chrome.storage.local.set({ notificationsHistory: history });
            console.log('[Alpha Date Extension] Уведомление сохранено в историю');
        } catch (historyError) {
            console.error('[Alpha Date Extension] Ошибка сохранения уведомления в историю:', historyError);
        }
    } catch (error) {
        console.error('[Alpha Date Extension] ❌ Ошибка при показе уведомления:', error);
        console.error('[Alpha Date Extension] Детали ошибки:', error.stack);
    }
}

// Планировщик автоматической рассылки
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'scheduledBroadcast') {
        console.log('[Alpha Date Extension] Сработал таймер автоматической рассылки');

        try {
            // ПРОВЕРКА ПОДПИСКИ - автоматическая рассылка требует активной подписки
            if (!hasActiveSubscription()) {
                logError('[Alpha Date Extension] Автоматическая рассылка заблокирована: подписка истекла');
                return;
            }

            // Проверяем, включена ли автоматическая рассылка
            const data = await chrome.storage.local.get(['scheduledBroadcastSettings']);
            const settings = data.scheduledBroadcastSettings || {};

            if (!settings.enabled) {
                console.log('[Alpha Date Extension] Автоматическая рассылка отключена, пропускаем');
                return;
            }
            
            // Ищем открытую вкладку alpha.date
            const tabs = await chrome.tabs.query({ url: 'https://alpha.date/*' });
            if (!tabs || tabs.length === 0) {
                console.log('[Alpha Date Extension] Нет открытых вкладок alpha.date, пропускаем рассылку');
                return;
            }
            
            // Используем первую найденную вкладку
            const tab = tabs[0];
            
            // Отправляем сообщение в content script для запуска рассылки
            try {
                const response = await chrome.tabs.sendMessage(tab.id, {
                    type: 'startScheduledBroadcast',
                    payload: {
                        kind: settings.broadcastType || 'chat',
                        interval: settings.interval || 60
                    }
                });
                
                // Ждем ответа от content script
                if (response && response.ok) {
                    console.log('[Alpha Date Extension] Автоматическая рассылка запущена успешно');

                    // Обновляем статистику оператора
                    try {
                        const kind = settings.broadcastType || 'chat';
                        const statType = kind === 'chat' ? 'chat_broadcast' : 'letter_broadcast';

                        // Отправляем сообщение в popup для обновления статистики
                        chrome.runtime.sendMessage({
                            type: 'updateOperatorStats',
                            payload: { type: statType, value: 1 }
                        }).catch(err => {
                            // Игнорируем ошибки - popup может быть закрыт
                        });
                    } catch (statError) {
                        console.log('[Alpha Date Extension] Не удалось обновить статистику:', statError.message);
                    }
                    
                    // Обновляем lastRun и nextRun (следующий запуск через заданный интервал)
                    const nextRun = new Date(Date.now() + (settings.interval || 60) * 60 * 1000);
                    await chrome.storage.local.set({
                        scheduledBroadcastSettings: {
                            ...settings,
                            lastRun: new Date().toISOString(),
                            nextRun: nextRun.toISOString()
                        }
                    });
                    
                    console.log('[Alpha Date Extension] Следующий запуск запланирован на:', nextRun.toISOString());
                } else {
                    console.error('[Alpha Date Extension] Ошибка запуска автоматической рассылки:', response?.error);
                    // При ошибке все равно обновляем lastRun и nextRun
                    const nextRun = new Date(Date.now() + (settings.interval || 60) * 60 * 1000);
                    await chrome.storage.local.set({
                        scheduledBroadcastSettings: {
                            ...settings,
                            lastRun: new Date().toISOString(),
                            nextRun: nextRun.toISOString()
                        }
                    });
                }
            } catch (error) {
                console.error('[Alpha Date Extension] Ошибка отправки сообщения в content script:', error);
                // При ошибке обновляем lastRun и nextRun
                const nextRun = new Date(Date.now() + (settings.interval || 60) * 60 * 1000);
                await chrome.storage.local.set({
                    scheduledBroadcastSettings: {
                        ...settings,
                        lastRun: new Date().toISOString(),
                        nextRun: nextRun.toISOString()
                    }
                });
            }
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка в планировщике рассылки:', error);
        }
    }
});

// ===== ИНИЦИАЛИЗАЦИЯ АВТОРИЗАЦИИ =====
// Восстановление состояния авторизации из хранилища с проверкой device_id
async function initializeAuth() {
    try {
        // Загружаем privilege отдельно (может обновляться независимо)
        const privilegeData = await chrome.storage.local.get(['userPrivilege']);
        USER_PRIVILEGE = privilegeData.userPrivilege || 'operator';
        log(`Загружена привилегия: ${USER_PRIVILEGE}`);

        const data = await chrome.storage.local.get(['authState']);
        const authState = data.authState;

        if (authState && authState.authorized && authState.expires_at && authState.device_id) {
            const currentDeviceId = generateDeviceId();

            // Проверяем, что device_id совпадает с текущим устройством
            if (authState.device_id !== currentDeviceId) {
                log(`Device ID изменился: сохранен ${authState.device_id}, текущий ${currentDeviceId} - сбрасываем авторизацию`);
                await chrome.storage.local.remove(['authState']);
                resetAuth();
                return;
            }

            const expireTime = new Date(authState.expires_at).getTime();

            if (Date.now() < expireTime) {
                // Авторизация еще действительна локально
                AUTH = true;
                AUTH_EXPIRE = expireTime;
                AUTH_USER_ID = authState.user_id;
                CURRENT_DEVICE_ID = authState.device_id;
                USER_PRIVILEGE = authState.privilege || 'operator';
                log(`Восстановлена авторизация. Пользователь: ${AUTH_USER_ID}, устройство: ${CURRENT_DEVICE_ID}, привилегия: ${USER_PRIVILEGE}`);

                // Дополнительно перепроверяем на сервере (асинхронно, не блокируем)
                setTimeout(async () => {
                    try {
                        log('Перепроверка подписки на сервере при запуске...');
                        await checkSubscriptionOnServer();
                    } catch (serverError) {
                        logError('Ошибка перепроверки при запуске:', serverError);
                    }
                }, 2000); // Через 2 секунды после запуска

            } else {
                // Локальная авторизация истекла - перепроверяем на сервере
                log('Сохраненная авторизация истекла локально, перепроверяем на сервере...');

                // Пытаемся временно восстановить авторизацию для перепроверки
                AUTH = true;
                AUTH_EXPIRE = expireTime;
                AUTH_USER_ID = authState.user_id;
                CURRENT_DEVICE_ID = authState.device_id;
                USER_PRIVILEGE = authState.privilege || 'operator';

                const serverCheck = await checkSubscriptionOnServer();

                if (serverCheck) {
                    log('Подписка активна на сервере - авторизация восстановлена');
                    // Сохраняем обновленное состояние
                    await saveAuthState();
                } else {
                    log('Подписка истекла и на сервере - полный сброс авторизации');
                    await chrome.storage.local.remove(['authState']);
                    resetAuth();
                }
            }
        }
    } catch (error) {
        logError('Ошибка восстановления авторизации:', error);
        resetAuth();
    }
}

// Сохранение состояния авторизации с device_id
async function saveAuthState() {
    try {
        if (AUTH && AUTH_EXPIRE && AUTH_USER_ID && CURRENT_DEVICE_ID) {
            await chrome.storage.local.set({
                authState: {
                    authorized: true,
                    user_id: AUTH_USER_ID,
                    device_id: CURRENT_DEVICE_ID, // ← СОХРАНЯЕМ DEVICE ID
                    privilege: USER_PRIVILEGE,
                    expires_at: new Date(AUTH_EXPIRE).toISOString(),
                    saved_at: new Date().toISOString()
                }
            });
        } else {
            await chrome.storage.local.remove(['authState']);
        }
    } catch (error) {
        logError('Ошибка сохранения состояния авторизации:', error);
    }
}

// Переопределение функций авторизации для автоматического сохранения
const originalVerifyAccessKey = verifyAccessKey;
verifyAccessKey = async function(accessKey) {
    const result = await originalVerifyAccessKey.call(this, accessKey);
    if (result.success) {
        await saveAuthState();
    }
    return result;
};

const originalResetAuth = resetAuth;
resetAuth = function() {
    originalResetAuth.call(this);
    saveAuthState(); // Асинхронно, но не ждем
};

// Инициализация при загрузке расширения
chrome.runtime.onInstalled.addListener(async () => {
    console.log('[Alpha Date Extension] Расширение установлено/обновлено, инициализация...');
    await initializeAuth();
    await initializeOperationLocks(); // Инициализация системы блокировки операций
    await initializeNotificationSettings();
    await initializeScheduledBroadcast();
});

chrome.runtime.onStartup.addListener(async () => {
    console.log('[Alpha Date Extension] Расширение запущено, инициализация...');
    await initializeAuth();
    await initializeOperationLocks(); // Инициализация системы блокировки операций
    await initializeNotificationSettings();
    await initializeScheduledBroadcast();
});

// Функция инициализации настроек уведомлений
async function initializeNotificationSettings() {
    try {
        const data = await chrome.storage.local.get(['notificationSettings']);
        if (!data.notificationSettings) {
            const defaultSettings = {
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

            console.log('[Alpha Date Extension] Инициализируем настройки по умолчанию:', defaultSettings);

            await chrome.storage.local.set({ notificationSettings: defaultSettings });
            console.log('[Alpha Date Extension] Установлены настройки уведомлений по умолчанию:', defaultSettings);
        } else {
            console.log('[Alpha Date Extension] Настройки уведомлений уже существуют:', data.notificationSettings);
        }
    } catch (error) {
        console.error('[Alpha Date Extension] Ошибка инициализации настроек уведомлений:', error);
    }
}

// Функция инициализации планировщика
async function initializeScheduledBroadcast() {
    try {
        const data = await chrome.storage.local.get(['scheduledBroadcastSettings']);
        const settings = data.scheduledBroadcastSettings || {};
        
        if (settings.enabled) {
            // Удаляем старый alarm если есть
            await chrome.alarms.clear('scheduledBroadcast');
            
            // Создаем новый alarm с заданным интервалом
            const intervalInMinutes = settings.interval || 60;
            
            // Если есть nextRun и оно в будущем, используем его для delayInMinutes
            let delayInMinutes = intervalInMinutes;
            if (settings.nextRun) {
                const nextRunDate = new Date(settings.nextRun);
                const now = new Date();
                const diffMs = nextRunDate - now;
                if (diffMs > 0) {
                    // Если nextRun в будущем, используем его
                    delayInMinutes = Math.max(1, Math.ceil(diffMs / 60000)); // Минимум 1 минута
                    console.log('[Alpha Date Extension] Используем сохраненное время следующего запуска:', nextRunDate.toISOString());
                } else {
                    // nextRun в прошлом, используем стандартный интервал
                    const nextRun = new Date(Date.now() + intervalInMinutes * 60 * 1000);
                    await chrome.storage.local.set({
                        scheduledBroadcastSettings: {
                            ...settings,
                            nextRun: nextRun.toISOString()
                        }
                    });
                }
            } else {
                // nextRun не установлен, создаем его
                const nextRun = new Date(Date.now() + intervalInMinutes * 60 * 1000);
                await chrome.storage.local.set({
                    scheduledBroadcastSettings: {
                        ...settings,
                        nextRun: nextRun.toISOString()
                    }
                });
            }
            
            chrome.alarms.create('scheduledBroadcast', {
                delayInMinutes: delayInMinutes,
                periodInMinutes: intervalInMinutes  // Периодическое повторение - это обеспечивает автоматический повтор
            });
            
            console.log('[Alpha Date Extension] Планировщик рассылки инициализирован, интервал:', intervalInMinutes, 'минут, первый запуск через:', delayInMinutes, 'минут');
        }
    } catch (error) {
        console.error('[Alpha Date Extension] Ошибка инициализации планировщика:', error);
    }
}

// Слушаем изменения настроек планировщика
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.scheduledBroadcastSettings) {
        const newSettings = changes.scheduledBroadcastSettings.newValue || {};
        const oldSettings = changes.scheduledBroadcastSettings.oldValue || {};
        
        // Если изменилось состояние или интервал, переинициализируем
        if (newSettings.enabled !== oldSettings.enabled || 
            newSettings.interval !== oldSettings.interval) {
            initializeScheduledBroadcast();
        }
    }
});

// При установке расширения настраиваем side panel
chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setOptions({
        path: 'auth.html',
        enabled: true
    });
});

// ===== ПРОСТАЯ СИСТЕМА УПРАВЛЕНИЯ WEBSOCKET =====
// Использует простой флаг websocketActive в localStorage

// ===== АВТОМАТИЧЕСКАЯ ПРОВЕРКА ПОДПИСКИ НА СЕРВЕРЕ =====
    setInterval(async () => {
    log('Периодическая проверка подписки на сервере...');

                const serverCheck = await checkSubscriptionOnServer();

    if (AUTH && !serverCheck) {
        log('Подписка истекла на сервере - выполняем автоматический logout');
                    resetAuth();

                    // Отправляем уведомление пользователю
                    chrome.notifications.create('subscription-expired', {
                        type: 'basic',
                        iconUrl: chrome.runtime.getURL('icon128.png'),
                        title: 'Подписка истекла',
                        message: 'Вы были автоматически разлогинены. Для продолжения работы приобретите подписку.',
                        priority: 2,
                        requireInteraction: true
                    }).then((notificationId) => {
                        console.log('[Alpha Date Extension] Уведомление об истечении подписки создано:', notificationId);
                    }).catch((error) => {
                        console.error('[Alpha Date Extension] Ошибка создания уведомления об истечении:', error);
                    });
        }
    }, SUBSCRIPTION_SETTINGS.LOGOUT_CHECK_INTERVAL);

log('Автоматическая проверка подписки на сервере каждые', SUBSCRIPTION_SETTINGS.LOGOUT_CHECK_INTERVAL / 1000, 'секунд');

// ===== ТЕСТОВОЕ УВЕДОМЛЕНИЕ =====
// Создаем тестовое уведомление при запуске расширения
setTimeout(() => {
    console.log('[Alpha Date Extension] Тестовое уведомление при запуске...');
    chrome.notifications.create('test-startup', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon128.png'),
        title: 'Alpha Date Extension',
        message: 'Расширение запущено и готово к работе!',
        priority: 0
    }).then((notificationId) => {
        console.log('[Alpha Date Extension] Тестовое уведомление создано:', notificationId);
    }).catch((error) => {
        console.error('[Alpha Date Extension] Ошибка тестового уведомления:', error);
    });
}, 3000);
