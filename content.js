// Content script для получения токена и выполнения API запроса
(function() {
    'use strict';

    const API_BASE = 'https://alpha.date';
    const SERVER_URL = 'https://alpha-production-5ab0.up.railway.app';

    // Функция для получения JWT токена из localStorage
    function getToken() {
        try {
            return localStorage.getItem('token');
        } catch (e) {
            console.error('Ошибка при получении токена:', e);
            return null;
        }
    }
    
    // Функция для получения email оператора из localStorage сайта alpha.date
    function getOperatorEmail() {
        try {
            // Пробуем разные возможные ключи для email оператора
            const possibleKeys = ['email', 'user_email', 'operator_email', 'userEmail', 'operatorEmail'];
            
            for (const key of possibleKeys) {
                const value = localStorage.getItem(key);
                if (value && value.includes('@')) {
                    console.log('[Alpha Date Extension] Email найден по ключу:', key, '=', value);
                    return value;
                }
            }
            
            // Пробуем найти email в объекте user или profile
            const userKeys = ['user', 'profile', 'currentUser', 'current_user', 'operator'];
            for (const key of userKeys) {
                const rawValue = localStorage.getItem(key);
                if (rawValue) {
                    try {
                        const parsed = JSON.parse(rawValue);
                        if (parsed && parsed.email) {
                            console.log('[Alpha Date Extension] Email найден в объекте:', key, '=', parsed.email);
                            return parsed.email;
                        }
                    } catch (e) {
                        // Не JSON, пропускаем
                    }
                }
            }
            
            // Пробуем найти любой ключ содержащий email в значении
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const value = localStorage.getItem(key);
                if (value && typeof value === 'string') {
                    // Проверяем формат OP*@alpha.date
                    const emailMatch = value.match(/OP\d+@alpha\.date/i);
                    if (emailMatch) {
                        console.log('[Alpha Date Extension] Email найден по паттерну в ключе:', key, '=', emailMatch[0]);
                        return emailMatch[0];
                    }
                    // Или любой email
                    if (value.includes('@alpha.date') && !value.startsWith('{') && !value.startsWith('[')) {
                        console.log('[Alpha Date Extension] Email найден:', key, '=', value);
                        return value;
                    }
                }
            }
            
            console.log('[Alpha Date Extension] Email оператора не найден в localStorage');
            return null;
        } catch (e) {
            console.error('[Alpha Date Extension] Ошибка при получении email:', e);
            return null;
        }
    }
    
    // ===== СИСТЕМА КЕШИРОВАНИЯ =====
    // Кеш для авто-ответов (время жизни: 5 минут)
    const contentCache = new Map();
    const CONTENT_CACHE_TTL = 5 * 60 * 1000; // 5 минут в миллисекундах

    // Кеш для фото (время жизни: 15 минут)
    const photoCache = new Map();
    const PHOTO_CACHE_TTL = 15 * 60 * 1000; // 15 минут в миллисекундах

    // ===== КЕШИРОВАНИЕ DOM ЭЛЕМЕНТОВ =====
    // Кеш для часто используемых DOM элементов (очищается при навигации)
    const domCache = new Map();
    const DOM_CACHE_TTL = 30 * 1000; // 30 секунд для DOM элементов

    // ===== ДЕБАУНСИНГ =====
    // Дебаунсинг для предотвращения частых вызовов тяжелых функций
    const debounceTimers = new Map();

    function debounce(func, key, delay = 500) {
        if (debounceTimers.has(key)) {
            clearTimeout(debounceTimers.get(key));
        }

        return new Promise((resolve) => {
            const timer = setTimeout(async () => {
                debounceTimers.delete(key);
                const result = await func();
                resolve(result);
            }, delay);

            debounceTimers.set(key, timer);
        });
    }

    // Функция получения кешированного DOM элемента
    function getCachedElement(selector, ttl = DOM_CACHE_TTL) {
        const cacheKey = `dom_${selector}`;
        const cached = domCache.get(cacheKey);

        if (cached && (Date.now() - cached.timestamp) < ttl) {
            return cached.element;
        }

        const element = document.querySelector(selector);
        if (element) {
            domCache.set(cacheKey, {
                element: element,
                timestamp: Date.now()
            });
        }

        return element;
    }

    // Функция получения кешированного элемента по ID
    function getCachedElementById(id, ttl = DOM_CACHE_TTL) {
        const cacheKey = `dom_id_${id}`;
        const cached = domCache.get(cacheKey);

        if (cached && (Date.now() - cached.timestamp) < ttl) {
            return cached.element;
        }

        const element = document.getElementById(id);
        if (element) {
            domCache.set(cacheKey, {
                element: element,
                timestamp: Date.now()
            });
        }

        return element;
    }

    // Очистка DOM кеша при навигации
    let lastUrl = window.location.href;
    setInterval(() => {
        if (window.location.href !== lastUrl) {
            domCache.clear();
            lastUrl = window.location.href;
            console.log('[Alpha Date Extension] DOM кеш очищен при навигации');
        }
    }, 1000);

    // Функция получения данных из кеша
    function getFromContentCache(cache, key) {
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
    function setContentCache(cache, key, data, ttl = CONTENT_CACHE_TTL) {
        cache.set(key, {
            data: data,
            timestamp: Date.now(),
            ttl: ttl
        });

        // Очищаем старые записи при превышении размера кеша
        if (cache.size > 50) {
            const oldestKey = cache.keys().next().value;
            cache.delete(oldestKey);
        }
    }

    // ===== СИНХРОНИЗАЦИЯ АВТО-ОТВЕТОВ С СЕРВЕРОМ =====
    let lastSyncedEmail = null; // Запоминаем email для которого уже синхронизировали
    
    /**
     * Загружает авто-ответы с сервера и ПОЛНОСТЬЮ ЗАМЕНЯЕТ локальные
     * Привязка по email оператора (одинаковый для админа и оператора)
     */
    async function syncAutoRepliesFromServer(force = false) {
        // Используем дебаунсинг для предотвращения частых вызовов
        if (!force) {
            return debounce(async () => {
                return await syncAutoRepliesFromServerInternal(force);
            }, 'syncAutoReplies', 2000); // Минимум 2 секунды между вызовами
        }

        return await syncAutoRepliesFromServerInternal(force);
    }

    async function syncAutoRepliesFromServerInternal(force = false) {
        try {
            const operatorEmail = getOperatorEmail();
            if (!operatorEmail) {
                console.log('[Alpha Date Extension] Email оператора не найден, синхронизация пропущена');
                return false;
            }

            // Проверяем кеш авто-ответов
            const cacheKey = `autoreplies_${operatorEmail}`;
            const cachedData = getFromContentCache(contentCache, cacheKey);

            if (!force && cachedData && lastSyncedEmail === operatorEmail) {
                console.log('[Alpha Date Extension] 📋 Используем кешированные авто-ответы для:', operatorEmail);

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
                console.log('[Alpha Date Extension] ✅ Кешированные авто-ответы применены, профилей:', Object.keys(cachedData.auto_replies).length);

                return true;
            }

            console.log('[Alpha Date Extension] 📥 Загрузка авто-ответов с сервера для:', operatorEmail);

            const response = await fetch(`${SERVER_URL}/api/sync-autoreplies`, {
                method: 'GET',
                headers: {
                    'X-Operator-Email': operatorEmail
                }
            });

            if (response.ok) {
                const result = await response.json();

                // Кешируем результат
                setContentCache(contentCache, cacheKey, result);

                if (result.found && result.auto_replies && Object.keys(result.auto_replies).length > 0) {
                    console.log('[Alpha Date Extension] ✅ Авто-ответы загружены с сервера, профилей:', result.profiles_count);

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
                    
                    // Сохраняем данные локально
                    await chrome.storage.local.set({ profileBroadcastMessages: localMessages });
                    
                    console.log('[Alpha Date Extension] ✅ Авто-ответы полностью заменены серверными');
                    lastSyncedEmail = operatorEmail;
                    return true;
                } else {
                    console.log('[Alpha Date Extension] На сервере нет сохраненных авто-ответов для:', operatorEmail);
                    lastSyncedEmail = operatorEmail;
                    return false;
                }
            } else {
                console.warn('[Alpha Date Extension] ❌ Ошибка загрузки авто-ответов:', response.status);
                return false;
            }
        } catch (error) {
            console.warn('[Alpha Date Extension] ❌ Ошибка синхронизации авто-ответов:', error);
            return false;
        }
    }
    
    /**
     * Отправляет текущие авто-ответы на сервер
     * Привязка по email оператора
     */
    async function syncAutoRepliesToServer() {
        try {
            const operatorEmail = getOperatorEmail();
            if (!operatorEmail) {
                console.log('[Alpha Date Extension] Email оператора не найден, синхронизация на сервер пропущена');
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
            
            if (Object.keys(autoRepliesOnly).length === 0) {
                console.log('[Alpha Date Extension] Нет авто-ответов для синхронизации');
                return false;
            }
            
            console.log('[Alpha Date Extension] 📤 Отправка авто-ответов на сервер для:', operatorEmail, ', профилей:', Object.keys(autoRepliesOnly).length);
            
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
                console.log('[Alpha Date Extension] ✅ Авто-ответы отправлены на сервер:', result);
                return true;
            } else {
                console.error('[Alpha Date Extension] ❌ Ошибка отправки авто-ответов:', response.status);
                return false;
            }
        } catch (error) {
            console.error('[Alpha Date Extension] ❌ Ошибка отправки авто-ответов:', error);
            return false;
        }
    }
    
    // Автоматическая синхронизация при загрузке страницы alpha.date
    if (window.location.hostname.includes('alpha.date')) {
        // Ждем пока email появится в localStorage
        const waitForEmail = setInterval(() => {
            const email = getOperatorEmail();
            if (email) {
                clearInterval(waitForEmail);
                console.log('[Alpha Date Extension] 📧 Email найден:', email, ', запускаем синхронизацию авто-ответов...');
                syncAutoRepliesFromServerInternal(true);
            }
        }, 1000);
        
        // Останавливаем проверку через 30 секунд
        setTimeout(() => clearInterval(waitForEmail), 30000);
    }
    // ===== КОНЕЦ БЛОКА СИНХРОНИЗАЦИИ =====

    // Функция для получения user_id оператора из localStorage
    function getUserId() {
        try {
            // Пробуем получить user_id из различных мест в localStorage
            const possibleKeys = ['user_id', 'userId', 'current_user_id', 'operator_id', 'profile_id'];

            for (const key of possibleKeys) {
                const value = localStorage.getItem(key);
                if (value && /^\d+$/.test(value)) {
                    return value;
                }
            }

            // Если не нашли в localStorage, пробуем sessionStorage
            for (const key of possibleKeys) {
                const value = sessionStorage.getItem(key);
                if (value && /^\d+$/.test(value)) {
                    return value;
                }
            }

            return null;
        } catch (e) {
            console.error('Ошибка при получении user_id:', e);
            return null;
        }
    }

    // Функция для отправки браузерных уведомлений
    async function sendBrowserNotification(title, message, type = null, options = {}) {
        try {
            console.log('[Alpha Date Extension] sendBrowserNotification вызвана:', { title, message, type, options });

            // Если передан полный текст (как в Telegram), конвертируем в title/message для Chrome
            let finalTitle = title;
            let finalMessage = message;

            // Если title содержит эмодзи или HTML, это может быть полный текст из Telegram
            if (typeof title === 'string' && (title.includes('<b>') || title.includes('✉️') || title.includes('👁️') || title.includes('❤️') || title.includes('📷'))) {
                // Это полный текст из Telegram, конвертируем в Chrome формат
                const cleanText = title.replace(/<b>/g, '').replace(/<\/b>/g, '').replace(/<code>/g, '').replace(/<\/code>/g, '').replace(/\n<a href="[^"]*">[^<]*<\/a>/g, '');
                const lines = cleanText.split('\n').filter(line => line.trim());

                if (lines.length > 0) {
                    // Берем первую строку как заголовок
                    finalTitle = lines[0].trim();

                    // Ищем строку с именем пользователя для лучшего сообщения
                    let userLine = '';
                    for (const line of lines) {
                        if (line.includes('Мужчина:') || line.includes('sender_external_id')) {
                            userLine = line.trim();
                            break;
                        }
                    }

                    // Если нашли строку с пользователем, используем её, иначе берём вторую строку
                    if (userLine) {
                        finalMessage = userLine;
                    } else if (lines.length > 1) {
                        finalMessage = lines[1].trim();
                    }

                    // Ограничиваем длину сообщения
                    if (finalMessage.length > 100) {
                        finalMessage = finalMessage.substring(0, 97) + '...';
                    }
                }
            }

            console.log('[Alpha Date Extension] Отправка уведомления:', { finalTitle, finalMessage, type });

            // Отправляем сообщение в background script для показа уведомления с повторными попытками
            let retries = 3;
            while (retries > 0) {
                try {
                    const response = await chrome.runtime.sendMessage({
                        type: 'showBrowserNotification',
                        payload: {
                            title: finalTitle,
                            message: finalMessage,
                            notificationType: type,
                            options,
                            // Дополнительные данные для истории
                            chatUrl: options.chatUrl,
                            originalTitle: title,
                            originalMessage: message
                        }
                    });

                    console.log('[Alpha Date Extension] Ответ от background script:', response);
                    return; // Успешно отправлено
                } catch (error) {
                    retries--;
                    console.warn(`[Alpha Date Extension] Попытка отправки уведомления не удалась (${4 - retries}/3):`, error);

                    if (retries > 0) {
                        // Ждем перед следующей попыткой
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }

            console.error('[Alpha Date Extension] Все попытки отправки уведомления провалились');
        } catch (error) {
            console.error('[Alpha Date Extension] Критическая ошибка отправки уведомления:', error);
        }
    }

    // Функция для выполнения запроса к API профилей
    async function fetchProfiles(token) {
        if (!token) {
            return { error: 'Токен не найден' };
        }

        try {
            const response = await fetch('https://alpha.date/api/operator/profiles', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*'
                },
                credentials: 'include'
            });

            const data = await response.json();
            return {
                status: response.status,
                statusText: response.statusText,
                data: data
            };
        } catch (error) {
            return {
                error: error.message
            };
        }
    }

    // Функция для получения списка сообщений (senderList)
    async function fetchSenderList(token, externalIds) {
        if (!token || !externalIds || externalIds.length === 0) {
            return { error: 'Токен или external_id не найдены' };
        }

        try {
            const response = await fetch('https://alpha.date/api/v3/search/senderList', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*'
                },
                credentials: 'include',
                body: JSON.stringify({ external_id: externalIds })
            });

            const data = await response.json();
            return {
                status: response.status,
                statusText: response.statusText,
                data: data
            };
        } catch (error) {
            return {
                error: error.message
            };
        }
    }

    // Функция для получения данных письма через API mailbox/mails
    async function fetchMailData(token, userId, manId, mailId = null) {
        if (!token || !userId || !manId) {
            return { error: 'Токен, user_id или man_id не найдены' };
        }

        try {
            const payload = {
                user_id: parseInt(userId),
                folder: "dialog",
                man_id: parseInt(manId),
                page: 1
            };

            // Если указан mailId, добавляем его в payload для фильтрации
            if (mailId) {
                payload.mail_id = parseInt(mailId);
            }

            console.log('[Alpha Date Extension] fetchMailData - отправляем запрос:', {
                url: 'https://alpha.date/api/mailbox/mails',
                payload: payload
            });

            const response = await fetch('https://alpha.date/api/mailbox/mails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*'
                },
                credentials: 'include',
                body: JSON.stringify(payload)
            });

            console.log('[Alpha Date Extension] fetchMailData - ответ сервера:', {
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries())
            });

            const data = await response.json();
            console.log('[Alpha Date Extension] fetchMailData - данные ответа:', JSON.stringify(data, null, 2));

            return {
                status: response.status,
                statusText: response.statusText,
                data: data
            };
        } catch (error) {
            console.error('[Alpha Date Extension] fetchMailData - ошибка:', error);
            return {
                error: error.message
            };
        }
    }

    // Маппинг site_id в название зеркала
    const SITE_ID_TO_MIRROR = {
        1: "SofiaDate.com",
        2: "MySpecialDates.com",
        5: "LoveForHeart.com",
        6: "AmourMeet.com",
        7: "OkAmour.com",
        8: "Avodate.com",
        9: "DateMpire.com",
        10: "FeelFlame.com",
        11: "LatiDate.com",
        12: "SakuraDate.com",
        13: "LatiDreams.com",
        14: "NaomiDate.com",
        15: "AmorPulse.com",
        16: "NikaDate.com",
        32: "MagnoliaDate.com"
    };

    // Функция для получения информации о пользователе (имя, зеркало, дата регистрации)
    async function getUserInfo(token, userId) {
        if (!token || !userId) {
            return null;
        }

        try {
            const response = await fetch(`https://alpha.date/api/operator/myProfile?user_id=${userId}&activeProfile=false`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json, text/plain, */*'
                },
                credentials: 'include'
            });

            if (!response.ok) {
                return null;
            }

            const data = await response.json();
            if (!data.status || !data.user_info?.user_detail) {
                return null;
            }

            const userDetail = data.user_info.user_detail;
            const siteId = userDetail.site_id;
            const mirror = SITE_ID_TO_MIRROR[siteId] || `site_id: ${siteId}`;
            const registrationDate = userDetail.created_at ? new Date(userDetail.created_at).toLocaleString() : null;

            return {
                name: userDetail.name || null,
                age: userDetail.age || null,
                mirror: mirror,
                registrationDate: registrationDate,
                siteId: siteId
            };
        } catch (error) {
            console.debug('[Alpha Date Extension] Ошибка получения информации о пользователе:', error);
            return null;
        }
    }


    // Функция проверки зеркала и даты регистрации мужчины
    async function checkManMirror() {
        try {
            // Извлекаем chat_uid из URL
            const urlMatch = window.location.href.match(/\/(?:chat|chance)\/([a-z0-9-]+)/i);
            if (!urlMatch || !urlMatch[1]) {
                alert('Откройте страницу чата или шанса для проверки зеркала');
                return null;
            }

            const chatUid = urlMatch[1];
            const token = getToken();
            if (!token) {
                alert('Токен не найден. Перезайдите на сайт.');
                return null;
            }

            // Определяем ID мужчины и ищем spend_all_credits
            let manId = null;
            let spendAllCredits = null;

            // Начинаем с первой страницы
            let page = 1;
            let hasMorePages = true;

            while (hasMorePages) {
                const chatHistoryResponse = await fetch('https://alpha.date/api/chatList/chatHistory', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/plain, */*'
                    },
                    credentials: 'include',
                    body: JSON.stringify({ chat_id: chatUid, page: page })
                });

                if (!chatHistoryResponse.ok) {
                    if (page === 1) {
                        alert('Ошибка при получении истории чата');
                        return null;
                    }
                    // Если ошибка на последующих страницах, прекращаем поиск
                    break;
                }

                const chatHistoryData = await chatHistoryResponse.json();
                let messages = [];
                
                if (Array.isArray(chatHistoryData)) {
                    messages = chatHistoryData;
                } else if (chatHistoryData.status && Array.isArray(chatHistoryData.response)) {
                    messages = chatHistoryData.response;
                } else if (Array.isArray(chatHistoryData.data)) {
                    messages = chatHistoryData.data;
                } else if (Array.isArray(chatHistoryData.items)) {
                    messages = chatHistoryData.items;
                }

                if (!messages || messages.length === 0) {
                    // Нет сообщений на этой странице, прекращаем поиск
                    hasMorePages = false;
                    break;
                }

                // Определяем ID мужчины из первой страницы
                if (page === 1 && !manId) {
                    for (const msg of messages) {
                        if (msg.is_male === 0) {
                            // Женщина отправила -> мужчина = получатель
                            manId = msg.recipient_external_id || msg.recipient_id;
                            break;
                        } else if (msg.is_male === 1) {
                            // Мужчина отправил -> мужчина = отправитель
                            manId = msg.sender_external_id || msg.sender_id;
                            break;
                        }
                    }
                }

                // Ищем сообщения от мужчины (is_male === 1) с полем spend_all_credits на текущей странице
                for (const msg of messages) {
                    // Проверяем, что это сообщение от мужчины (is_male === 1) и есть поле spend_all_credits
                    if (msg.is_male === 1 && msg.spend_all_credits !== undefined && msg.spend_all_credits !== null) {
                        // Сохраняем значение (берем первое найденное на странице, так как страницы идут от новых к старым)
                        spendAllCredits = msg.spend_all_credits;
                    }
                }

                // Если нашли spend_all_credits на любой странице - это последнее (самое новое) значение, прекращаем поиск
                if (spendAllCredits !== null) {
                    hasMorePages = false;
                    break;
                }
                
                // Если не нашли, переходим к следующей странице
                page++;
                
                // Ограничиваем количество страниц до 20
                if (page > 20) {
                    hasMorePages = false;
                }
            }

            if (!manId) {
                alert('Не удалось определить ID мужчины из истории чата');
                return null;
            }

            // Получаем информацию о мужчине
            const userInfo = await getUserInfo(token, manId);
            if (!userInfo) {
                alert('Не удалось получить информацию о мужчине');
                return null;
            }

            // Формируем результат
            const result = {
                manId: manId,
                name: userInfo.name,
                age: userInfo.age,
                mirror: userInfo.mirror,
                registrationDate: userInfo.registrationDate,
                siteId: userInfo.siteId,
                spendAllCredits: spendAllCredits
            };

            // Показываем результат
            const infoText = [
                `Мужчина: ${userInfo.name || 'Не указано'}${userInfo.age ? `, ${userInfo.age}` : ''}`,
                `ID: ${manId}`,
                `Зеркало: ${userInfo.mirror}`,
                userInfo.registrationDate ? `Дата регистрации: ${userInfo.registrationDate}` : 'Дата регистрации: не указана',
                spendAllCredits !== null && spendAllCredits !== undefined ? `Мужчина потратил на анкету: ${spendAllCredits}` : 'Мужчина потратил на анкету: не найдено'
            ].join('\n');

            alert(infoText);
            console.log('[Alpha Date Extension] Информация о мужчине:', result);

            return result;
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка проверки зеркала:', error);
            alert('Ошибка при проверке зеркала: ' + (error.message || error));
            return null;
        }
    }

    // --- Работа с чат-листом и рассылкой ---

    // Запрос /api/chatList/chatListByUserID
    // limits: сколько элементов возвращать за запрос (для чатов = 1, для писем = 2, для мониторинга = null)
    // chatType: 'CHANCE' для Chance, null/undefined для дефолтного списка
    async function fetchChatListByUserID(token, userExternalId, page, limits = 1, chatType = 'CHANCE') {
        if (!token) {
            return { error: 'Токен не найден' };
        }

        const payload = {
            user_id: String(userExternalId),
            chat_uid: false,
            page: page,
            freeze: true,
            ONLINE_STATUS: 1,
            SEARCH: "",
        };
        if (limits !== undefined) {
            payload.limits = limits;
        }
        if (chatType) {
            payload.CHAT_TYPE = chatType;
        }

        try {
            const response = await fetch(`${API_BASE}/api/chatList/chatListByUserID`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*'
                },
                credentials: 'include',
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            return {
                status: response.status,
                statusText: response.statusText,
                data
            };
        } catch (error) {
            const msg = error && error.message ? error.message : String(error);
            // "Failed to fetch" = сеть / сервер временно недоступен, не считаем это критической ошибкой
            if (msg && msg.includes('Failed to fetch')) {
                console.debug('[Alpha Date Extension] chatListByUserID: не удалось выполнить запрос (вероятно, сеть или сервер):', msg);
            } else {
                console.error('[Alpha Date Extension] Ошибка chatListByUserID:', error);
            }
            return { error: msg };
        }
    }

    // Сбор всех chat_uid по страницам для конкретной анкеты
    // limitsPerPage: 1 для чатов, 2 для писем (как ты просил)
    async function collectAllChatUids(token, userExternalId, maxPages = 20, limitsPerPage = 1) {
        const allUids = new Set();
        for (let page = 1; page <= maxPages; page++) {
            const result = await fetchChatListByUserID(token, userExternalId, page, limitsPerPage, 'CHANCE');
            if (result.error || !result.data) {
                break;
            }

            let items = null;
            const data = result.data;
            if (Array.isArray(data)) {
                items = data;
            } else if (Array.isArray(data.response)) {
                items = data.response;
            } else if (Array.isArray(data.data)) {
                items = data.data;
            } else if (Array.isArray(data.items)) {
                items = data.items;
            }

            if (!items || items.length === 0) {
                break;
            }

            for (const item of items) {
                if (item && item.chat_uid) {
                    allUids.add(item.chat_uid);
                }
            }
        }

        return Array.from(allUids);
    }

    // Сбор chat_uid для мониторинга по оператору (user_id = "")
    // Для ускорения нам нужны только самые свежие чаты, поэтому берём ТОЛЬКО первую страницу
    async function collectAllChatUidsForMonitoring(token, chatType = 'CHANCE', maxPages = 1) {
        const allUids = new Set();
        for (let page = 1; page <= maxPages; page++) {
            const result = await fetchChatListByUserID(token, '', page, null, chatType);
            if (result.error || !result.data) {
                break;
            }

            let items = null;
            const data = result.data;
            if (Array.isArray(data)) {
                items = data;
            } else if (Array.isArray(data.response)) {
                items = data.response;
            } else if (Array.isArray(data.data)) {
                items = data.data;
            } else if (Array.isArray(data.items)) {
                items = data.items;
            }

            if (!items || items.length === 0) {
                break;
            }

            for (const item of items) {
                if (item && item.chat_uid) {
                    allUids.add(item.chat_uid);
                }
            }
        }
        return Array.from(allUids);
    }

    // Запрос /api/chatList/lastMessage для пачки chat_uid
    async function fetchLastMessageChunk(token, chatUidsChunk) {
        if (!token || !chatUidsChunk || chatUidsChunk.length === 0) {
            return [];
        }

        const payload = { chat_uid: chatUidsChunk };

        try {
            const response = await fetch(`${API_BASE}/api/chatList/lastMessage`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*'
                },
                credentials: 'include',
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (Array.isArray(data)) {
                return data;
            }
            if (Array.isArray(data.response)) {
                return data.response;
            }
            if (Array.isArray(data.data)) {
                return data.data;
            }
            if (Array.isArray(data.items)) {
                return data.items;
            }

            console.warn('[Alpha Date Extension] Неожиданная структура lastMessage:', data);
            return [];
        } catch (error) {
            const msg = error && error.message ? error.message : String(error);
            // "Failed to fetch" = временная сетевая ошибка / сервер недоступен
            if (msg && msg.includes('Failed to fetch')) {
                console.debug('[Alpha Date Extension] lastMessage: не удалось выполнить запрос (вероятно, сеть или сервер):', msg);
            } else {
                console.error('[Alpha Date Extension] Ошибка lastMessage:', error);
            }
            return [];
        }
    }

    // Получаем lastMessage для всех chat_uid (по частям)
    async function fetchLastMessagesForUids(token, chatUids) {
        const allMessages = [];
        const chunkSize = 50;
        for (let i = 0; i < chatUids.length; i += chunkSize) {
            const chunk = chatUids.slice(i, i + chunkSize);
            const part = await fetchLastMessageChunk(token, chunk);
            allMessages.push(...part);
        }
        return allMessages;
    }

    // --- История чата и медиа для проверки уже отправленных видео ---

    async function fetchChatHistory(token, chatUid, page = 1) {
        if (!token || !chatUid) {
            return [];
        }

        const payload = { chat_id: String(chatUid), page };

        try {
            const response = await fetch(`${API_BASE}/api/chatList/chatHistory`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*',
                },
                credentials: 'include',
                body: JSON.stringify(payload),
            });

            const data = await response.json();

            if (Array.isArray(data)) return data;
            if (Array.isArray(data.response)) return data.response;
            if (Array.isArray(data.data)) return data.data;
            if (Array.isArray(data.items)) return data.items;

            console.warn('[Alpha Date Extension] Неожиданная структура chatHistory:', data);
            return [];
        } catch (error) {
            const msg = error && error.message ? error.message : String(error);
            if (msg && msg.includes('Failed to fetch')) {
                console.debug('[Alpha Date Extension] chatHistory: не удалось выполнить запрос (вероятно, сеть или сервер):', msg);
            } else {
                console.error('[Alpha Date Extension] Ошибка chatHistory:', error);
            }
            return [];
        }
    }

    async function fetchOperatorMedia(token, chatUid) {
        if (!token || !chatUid) {
            return [];
        }

        const payload = { chat_id: String(chatUid) };

        try {
            const response = await fetch(`${API_BASE}/api/chatList/operatorMedia`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*',
                },
                credentials: 'include',
                body: JSON.stringify(payload),
            });

            const data = await response.json();

            if (Array.isArray(data)) return data;
            if (Array.isArray(data.response)) return data.response;
            if (Array.isArray(data.data)) return data.data;
            if (Array.isArray(data.items)) return data.items;

            console.warn('[Alpha Date Extension] Неожиданная структура operatorMedia:', data);
            return [];
        } catch (error) {
            const msg = error && error.message ? error.message : String(error);
            if (msg && msg.includes('Failed to fetch')) {
                console.debug('[Alpha Date Extension] operatorMedia: не удалось выполнить запрос (вероятно, сеть или сервер):', msg);
            } else {
                console.error('[Alpha Date Extension] Ошибка operatorMedia:', error);
            }
            return [];
        }
    }

    async function fetchOperatorMediaLetters(token, chatUid) {
        if (!token || !chatUid) {
            return [];
        }

        const payload = { chat_id: String(chatUid) };

        try {
            const response = await fetch(`${API_BASE}/api/chatList/operatorMediaLetters`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*',
                },
                credentials: 'include',
                body: JSON.stringify(payload),
            });

            const data = await response.json();

            if (Array.isArray(data)) return data;
            if (Array.isArray(data.response)) return data.response;
            if (Array.isArray(data.data)) return data.data;
            if (Array.isArray(data.items)) return data.items;

            console.warn('[Alpha Date Extension] Неожиданная структура operatorMediaLetters:', data);
            return [];
        } catch (error) {
            const msg = error && error.message ? error.message : String(error);
            if (msg && msg.includes('Failed to fetch')) {
                console.debug('[Alpha Date Extension] operatorMediaLetters: не удалось выполнить запрос (вероятно, сеть или сервер):', msg);
            } else {
                console.error('[Alpha Date Extension] Ошибка operatorMediaLetters:', error);
            }
            return [];
        }
    }

    async function fetchVideosLibrary(token, womanExternalId) {
        if (!token || !womanExternalId) {
            return [];
        }

        const url = `${API_BASE}/api/files/videos?external_id=${encodeURIComponent(String(womanExternalId))}`;

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json, text/plain, */*',
                },
                credentials: 'include',
            });

            const data = await response.json();

            // Наиболее типичные варианты
            if (Array.isArray(data)) return data;
            if (Array.isArray(data.response)) return data.response;
            if (Array.isArray(data.data)) return data.data;
            if (Array.isArray(data.items)) return data.items;

            // Если структура неожиданная – попробуем найти массив видео "внутри" объекта
            if (data && typeof data === 'object') {
                const candidateArrays = [];

                Object.keys(data).forEach((k) => {
                    const v = data[k];
                    if (Array.isArray(v)) {
                        candidateArrays.push(v);
                    } else if (v && typeof v === 'object') {
                        Object.keys(v).forEach((k2) => {
                            const v2 = v[k2];
                            if (Array.isArray(v2)) {
                                candidateArrays.push(v2);
                            }
                        });
                    }
                });

                const picked = candidateArrays.find((arr) =>
                    arr.some(
                        (item) =>
                            item &&
                            typeof item === 'object' &&
                            (item.link || item.url || item.content_type || item.filename || item.name)
                    )
                );

                if (picked) {
                    console.debug('[Alpha Date Extension] files/videos: выбран вложенный массив как список видео.');
                    return picked;
                }
            }

            console.warn('[Alpha Date Extension] Неожиданная структура files/videos:', data);
            return [];
        } catch (error) {
            const msg = error && error.message ? error.message : String(error);
            if (msg && msg.includes('Failed to fetch')) {
                console.debug('[Alpha Date Extension] files/videos: не удалось выполнить запрос (вероятно, сеть или сервер):', msg);
            } else {
                console.error('[Alpha Date Extension] Ошибка files/videos:', error);
            }
            return [];
        }
    }

    async function fetchPhotosLibrary(token, womanExternalId) {
        if (!token || !womanExternalId) {
            return [];
        }

        const url = `${API_BASE}/api/files/images?external_id=${encodeURIComponent(String(womanExternalId))}`;

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json, text/plain, */*',
                },
                credentials: 'include',
            });

            const data = await response.json();

            // Наиболее типичные варианты
            if (Array.isArray(data)) return data;
            if (Array.isArray(data.response)) return data.response;
            if (Array.isArray(data.data)) return data.data;
            if (Array.isArray(data.items)) return data.items;

            // Если структура неожиданная – попробуем найти массив фото "внутри" объекта
            if (data && typeof data === 'object') {
                const candidateArrays = [];

                Object.keys(data).forEach((k) => {
                    const v = data[k];
                    if (Array.isArray(v)) {
                        candidateArrays.push(v);
                    } else if (v && typeof v === 'object') {
                        Object.keys(v).forEach((k2) => {
                            const v2 = v[k2];
                            if (Array.isArray(v2)) {
                                candidateArrays.push(v2);
                            }
                        });
                    }
                });

                const picked = candidateArrays.find((arr) =>
                    arr.some(
                        (item) =>
                            item &&
                            typeof item === 'object' &&
                            (item.link || item.url || item.content_type || item.filename || item.name)
                    )
                );

                if (picked) {
                    console.debug('[Alpha Date Extension] files/images: выбран вложенный массив как список фото.');
                    return picked;
                }
            }

            console.warn('[Alpha Date Extension] Неожиданная структура files/images:', data);
            return [];
        } catch (error) {
            const msg = error && error.message ? error.message : String(error);
            if (msg && msg.includes('Failed to fetch')) {
                console.debug('[Alpha Date Extension] files/images: не удалось выполнить запрос (вероятно, сеть или сервер):', msg);
            } else {
                console.error('[Alpha Date Extension] Ошибка files/images:', error);
            }
            return [];
        }
    }

    // Строим список целей рассылки (woman_external_id, man_external_id)
    function buildBroadcastTargets(lastMessages, targetWomanExternalId) {
        const targets = [];
        if (!Array.isArray(lastMessages)) {
            return targets;
        }

        lastMessages.forEach(msg => {
            const chatUid = msg.chat_uid;
            const senderExt = msg.sender_external_id;
            const recipientExt = msg.recipient_external_id;
            const isMale = msg.is_male ?? 0;

            if (!chatUid || senderExt == null || recipientExt == null) {
                return;
            }

            let womanExt;
            let manExt;
            if (isMale === 1) {
                // Мужчина отправил -> женщина = recipient_external_id
                womanExt = recipientExt;
                manExt = senderExt;
            } else {
                // Женщина отправила -> женщина = sender_external_id
                womanExt = senderExt;
                manExt = recipientExt;
            }

            if (targetWomanExternalId && String(womanExt) !== String(targetWomanExternalId)) {
                return;
            }

            targets.push({
                chat_uid: chatUid,
                woman_external_id: womanExt,
                man_external_id: manExt,
                last_message: msg.message_content || ''
            });
        });

        return targets;
    }

    // Отправка сообщения /api/chat/message
    // messageType: 'SENT_TEXT' (по умолчанию), 'SENT_LIKE', 'SENT_WINK' и т.п.
    async function sendMessageToChat(token, senderExternalId, recipientExternalId, text, messageType = 'SENT_TEXT') {
        if (!token) {
            throw new Error('Токен не найден');
        }

        const body = {
            sender_id: Number(senderExternalId),
            recipient_id: Number(recipientExternalId),
            message_content: text,
            message_type: messageType,
            filename: ''
        };

        try {
            const response = await fetch(`${API_BASE}/api/chat/message`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*'
                },
                credentials: 'include',
                body: JSON.stringify(body)
            });

            let data = null;
            try {
                data = await response.json();
            } catch (e) {
                // может быть пустой ответ
            }

            if (!response.ok) {
                const snippet = data ? JSON.stringify(data).slice(0, 200) : response.statusText;
                throw new Error(`API error ${response.status}: ${snippet}`);
            }

            // Проверяем статус в ответе API (status: true/false)
            // Структура ответа:
            // - status: false -> {"status":false,"error":"You are in male block list","message_id":0}
            // - status: true -> {"status":true,"response":{...message_object, chat_list_object...}}
            // Даже если HTTP статус 200, нужно проверить поле status в JSON
            let isSuccess = true;
            if (data && typeof data.status === 'boolean') {
                isSuccess = data.status === true;
            }

            // Возвращаем объект с информацией о статусе (не выбрасываем ошибку при status: false)
            return {
                success: isSuccess,
                data: data, // Полный ответ API (при status: true содержит response с message_object)
                error: isSuccess ? null : (data?.error || data?.message || 'Status is false')
            };
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка отправки сообщения:', error);
            throw error;
        }
    }

    // Загрузка фото на сервер и получение URL
    async function uploadImageToServer(token, imageFile, womanExternalId) {
        if (!token) {
            throw new Error('Токен не найден');
        }

        const formData = new FormData();
        formData.append('file', imageFile);
        formData.append('external_id', String(womanExternalId));

        try {
            // Пробуем разные возможные endpoints для загрузки
            const possibleEndpoints = [
                `${API_BASE}/api/files/upload`,
                `${API_BASE}/api/files/images`,
                `${API_BASE}/api/upload`,
                `${API_BASE}/api/files/upload/image`
            ];

            for (const endpoint of possibleEndpoints) {
                try {
                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Accept': 'application/json, text/plain, */*'
                        },
                        credentials: 'include',
                        body: formData
                    });

                    if (response.ok) {
                        const data = await response.json();
                        // Ищем URL в ответе
                        if (data.url || data.link || data.message_content || data.file_url) {
                            return data.url || data.link || data.message_content || data.file_url;
                        }
                        if (data.response && (data.response.url || data.response.link)) {
                            return data.response.url || data.response.link;
                        }
                    }
                } catch (e) {
                    // Пробуем следующий endpoint
                    continue;
                }
            }

            throw new Error('Не удалось найти рабочий endpoint для загрузки фото');
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка загрузки фото на сервер:', error);
            throw error;
        }
    }

    // Отправка фото (SENT_IMAGE)
    async function sendImageToChat(token, senderExternalId, recipientExternalId, imageUrl, filename, contentId = null) {
        if (!token) {
            throw new Error('Токен не найден');
        }

        const body = {
            sender_id: Number(senderExternalId),
            recipient_id: Number(recipientExternalId),
            message_content: imageUrl,
            message_type: 'SENT_IMAGE',
            filename: filename || 'image.jpg'
        };

        // Добавляем content_id если указан (обязательно для отправки фото)
        console.log('[Alpha Date Extension] sendImageToChat вызвана с contentId:', contentId, 'тип:', typeof contentId);
        if (contentId !== null && contentId !== undefined && contentId !== '' && !isNaN(Number(contentId))) {
            body.content_id = Number(contentId);
            console.log('[Alpha Date Extension] ✅ Добавлен content_id в запрос:', body.content_id);
        } else {
            console.warn('[Alpha Date Extension] ⚠️ content_id не указан или невалиден для отправки фото! contentId:', contentId);
        }
        
        console.log('[Alpha Date Extension] Тело запроса для отправки фото:', JSON.stringify(body, null, 2));

        try {
            const response = await fetch(`${API_BASE}/api/chat/message`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*'
                },
                credentials: 'include',
                body: JSON.stringify(body)
            });

            let data = null;
            try {
                data = await response.json();
            } catch (e) {
                // может быть пустой ответ
            }

            if (!response.ok) {
                const snippet = data ? JSON.stringify(data).slice(0, 200) : response.statusText;
                throw new Error(`API error ${response.status}: ${snippet}`);
            }

            // Успешно отправили фото — увеличиваем счётчик
            await incrementStats({ outgoingMessages: 1 });

            return data;
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка отправки фото:', error);
            throw error;
        }
    }

    // Отправка письма /api/mailbox/mail
    // recipientsOrSingleId: либо один ID мужчины, либо массив ID
    async function sendLetterToMailbox(token, womanExternalId, recipientsOrSingleId, text) {
        if (!token) {
            throw new Error('Токен не найден');
        }

        const recipients = Array.isArray(recipientsOrSingleId)
            ? recipientsOrSingleId.map((id) => Number(id))
            : [Number(recipientsOrSingleId)];

        const body = {
            user_id: Number(womanExternalId),
            recipients,
            message_content: text,
            message_type: 'SENT_TEXT',
            parent_mail_id: null,
            attachments: [],
            is_send_email: false,
        };

        try {
            const response = await fetch(`${API_BASE}/api/mailbox/mail`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*',
                },
                credentials: 'include',
                body: JSON.stringify(body),
            });

            let data = null;
            try {
                data = await response.json();
            } catch (e) {
                // может быть пустой ответ
            }

            if (!response.ok) {
                const snippet = data ? JSON.stringify(data).slice(0, 200) : response.statusText;
                throw new Error(`API error (mail) ${response.status}: ${snippet}`);
            }

            // Письмо успешно отправлено — тоже считаем как отправленное сообщение
            await incrementStats({ outgoingMessages: 1 });

            return data;
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка отправки письма:', error);
            throw error;
        }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // --- Вспомогательные функции для проверки видео в чате ---

    function getCurrentChatUid() {
        try {
            const path = window.location.pathname || '';
            // ожидаем /chat/<uid> или /chance/<uid>
            const parts = path.split('/').filter(Boolean);
            const idx = parts.findIndex(p => p === 'chat' || p === 'chance');
            if (idx !== -1 && parts[idx + 1]) {
                return parts[idx + 1];
            }
        } catch (e) {
            console.warn('[Alpha Date Extension] Не удалось определить chat_uid из URL:', e);
        }
        return null;
    }

    // Проверяем, находимся ли мы на странице /letter
    function isLetterPage() {
        try {
            const path = window.location.pathname || '';
            return path.includes('/letter');
        } catch (e) {
            return false;
        }
    }

    // Извлекаем ID мужчины и женщины из DOM на странице /letter
    function getManAndWomanIdsFromLetterPage() {
        try {
            const manIdElement = document.querySelector('[data-testid="man-external_id"]');
            const womanIdElement = document.querySelector('[data-testid="woman-external_id"]');
            
            if (!manIdElement || !womanIdElement) {
                return null;
            }
            
            // Извлекаем ID из текста, например "ID 1350107844" -> "1350107844"
            const manIdText = manIdElement.textContent || '';
            const womanIdText = womanIdElement.textContent || '';
            
            const manIdMatch = manIdText.match(/\d+/);
            const womanIdMatch = womanIdText.match(/\d+/);
            
            if (!manIdMatch || !womanIdMatch) {
                return null;
            }
            
            return {
                manId: parseInt(manIdMatch[0], 10),
                womanId: parseInt(womanIdMatch[0], 10)
            };
        } catch (e) {
            console.warn('[Alpha Date Extension] Не удалось извлечь ID из страницы letter:', e);
            return null;
        }
    }

    // Получаем chat_uid из /api/mailbox/mails для страницы /letter
    async function getChatUidFromMailbox(token, womanId, manId) {
        if (!token || !womanId || !manId) {
            return null;
        }

        try {
            const response = await fetch(`${API_BASE}/api/mailbox/mails`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/plain, */*',
                },
                credentials: 'include',
                body: JSON.stringify({
                    user_id: womanId,
                    folder: 'dialog',
                    man_id: manId,
                    page: 1
                }),
            });

            if (!response.ok) {
                console.warn('[Alpha Date Extension] Ошибка при получении mails:', response.status);
                return null;
            }

            const data = await response.json();
            
            // Ищем chat_uid в ответе
            // Структура ответа: { status: true, response: { mails: [...], chat: { chat_uid: "..." }, pages: ..., current: ... } }
            let chatUid = null;
            
            // Проверяем data.response.chat.chat_uid (основная структура)
            if (data.response && data.response.chat && data.response.chat.chat_uid) {
                chatUid = data.response.chat.chat_uid;
            }
            // Проверяем data.chat.chat_uid (если ответ напрямую содержит chat)
            else if (data.chat && data.chat.chat_uid) {
                chatUid = data.chat.chat_uid;
            }
            // Проверяем data.response (если это массив объектов с mail и chat)
            else if (data.response && Array.isArray(data.response)) {
                // Ищем первый объект с chat.chat_uid
                for (const item of data.response) {
                    if (item.chat && item.chat.chat_uid) {
                        chatUid = item.chat.chat_uid;
                        break;
                    }
                }
            }
            // Проверяем data.data (если структура другая)
            else if (data.data) {
                if (data.data.response && data.data.response.chat && data.data.response.chat.chat_uid) {
                    chatUid = data.data.response.chat.chat_uid;
                } else if (Array.isArray(data.data)) {
                    for (const item of data.data) {
                        if (item.chat && item.chat.chat_uid) {
                            chatUid = item.chat.chat_uid;
                            break;
                        }
                    }
                } else if (data.data.chat && data.data.chat.chat_uid) {
                    chatUid = data.data.chat.chat_uid;
                }
            }
            // Проверяем напрямую data.chat_uid (на случай другой структуры)
            else if (data.chat_uid) {
                chatUid = data.chat_uid;
            }

            console.log('[Alpha Date Extension] Извлеченный chat_uid из mailbox:', chatUid);
            return chatUid;
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка получения chat_uid из mailbox:', error);
            return null;
        }
    }

    async function buildCurrentChatVideoInfo(forceRefresh = false) {
        const token = getToken();
        if (!token) {
            return null;
        }

        let chatUid = null;
        let womanExt = null;
        let manExt = null;
        const isLetter = isLetterPage();

        if (isLetter) {
            // Логика для страницы /letter
            console.log('[Alpha Date Extension] Проверка видео для страницы /letter');
            
            // Извлекаем ID мужчины и женщины из DOM
            const ids = getManAndWomanIdsFromLetterPage();
            if (!ids) {
                console.warn('[Alpha Date Extension] Не удалось извлечь ID мужчины и женщины из страницы letter');
                return null;
            }
            
            womanExt = ids.womanId;
            manExt = ids.manId;
            
            // Получаем chat_uid из /api/mailbox/mails
            chatUid = await getChatUidFromMailbox(token, womanExt, manExt);
            if (!chatUid) {
                console.warn('[Alpha Date Extension] Не удалось получить chat_uid из mailbox для letter');
                return null;
            }
            
            console.log('[Alpha Date Extension] Получен chat_uid из mailbox:', chatUid);
        } else {
            // Логика для страниц /chat/ и /chance/
            chatUid = getCurrentChatUid();
            if (!chatUid) {
                return null;
            }

            // Если уже есть актуальная информация по этому чату — возвращаем её
            if (!forceRefresh && currentChatVideoInfo && currentChatVideoInfo.chatUid === chatUid) {
                return currentChatVideoInfo;
            }

            console.log('[Alpha Date Extension] Проверка видео для чата', chatUid);

            const history = await fetchChatHistory(token, chatUid, 1);

            for (const msg of history) {
                if (!msg) continue;
                const isMale = msg.is_male;
                const sExt = msg.sender_external_id;
                const rExt = msg.recipient_external_id;
                if (sExt == null || rExt == null) continue;

                if (isMale === 1) {
                    // мужчина отправил → женщина получатель
                    womanExt = rExt;
                    manExt = sExt;
                } else if (isMale === 0) {
                    // женщина отправила → женщина отправитель
                    womanExt = sExt;
                    manExt = rExt;
                }

                if (womanExt && manExt) break;
            }

            if (!womanExt) {
                console.warn('[Alpha Date Extension] Не удалось определить external_id девушки для чата', chatUid);
            }
        }

        // Собираем отправленные видео в чате (SENT_VIDEO от девушки)
        const sentLinksMap = new Map();

        const mediaChat = await fetchOperatorMedia(token, chatUid);
        for (const m of mediaChat) {
            if (!m) continue;
            if (m.message_type !== 'SENT_VIDEO') continue;

            const link = m.message_content || '';
            if (!link) continue;

            // Только исходящие от девушки (is_male = 0)
            if (m.is_male !== 0) continue;

            const prev = sentLinksMap.get(link) || { fromChat: false, fromLetter: false, readStatus: null };
            prev.fromChat = true;
            if (typeof m.read_status === 'number') {
                prev.readStatus = m.read_status;
            }
            sentLinksMap.set(link, prev);
        }

        // Собираем отправленные видео в письмах (SENT_VIDEO_MAIL от оператора)
        const mediaLetters = await fetchOperatorMediaLetters(token, chatUid);
        for (const m of mediaLetters) {
            if (!m) continue;
            if (m.message_type !== 'SENT_VIDEO_MAIL') continue;

            // Только отправленные оператором
            if (m.operator !== 1) continue;

            const link = m.message_content || '';
            if (!link) continue;

            const prev = sentLinksMap.get(link) || { fromChat: false, fromLetter: false, readStatus: null };
            prev.fromLetter = true;
            // Для писем тоже учитываем прочтение, если есть
            if (typeof m.read_status === 'number') {
                prev.readStatus = m.read_status;
            }
            sentLinksMap.set(link, prev);
        }

        // Строим список видео из библиотеки девушки (files/videos)
        let videosLibrary = [];
        if (womanExt) {
            videosLibrary = await fetchVideosLibrary(token, womanExt);
        }

        const videos = [];
        for (const v of videosLibrary) {
            if (!v) continue;
            if (v.content_type && v.content_type !== 'video') continue;
            const link = v.link || v.url || '';
            if (!link) continue;
            videos.push({
                link,
                filename: v.filename || v.name || '',
            });
        }

        currentChatVideoInfo = {
            chatUid,
            womanExternalId: womanExt,
            manExternalId: manExt,
            sentLinks: sentLinksMap,
            videos,
            lastUpdated: new Date().toISOString(),
        };

        return currentChatVideoInfo;
    }

    async function buildCurrentChatPhotoInfo(forceRefresh = false) {
        const token = getToken();
        if (!token) {
            return null;
        }

        let chatUid = null;
        let womanExt = null;
        let manExt = null;
        const isLetter = isLetterPage();

        if (isLetter) {
            // Логика для страницы /letter
            console.log('[Alpha Date Extension] Проверка фото для страницы /letter');

            // Извлекаем ID мужчины и женщины из DOM
            const ids = getManAndWomanIdsFromLetterPage();
            if (!ids) {
                console.warn('[Alpha Date Extension] Не удалось извлечь ID мужчины и женщины из страницы letter');
                return null;
            }

            womanExt = ids.womanId;
            manExt = ids.manId;

            // Получаем chat_uid из /api/mailbox/mails
            chatUid = await getChatUidFromMailbox(token, womanExt, manExt);
            if (!chatUid) {
                console.warn('[Alpha Date Extension] Не удалось получить chat_uid из mailbox для letter');
                return null;
            }

            console.log('[Alpha Date Extension] Получен chat_uid из mailbox:', chatUid);
        } else {
            // Логика для страниц /chat/ и /chance/
            chatUid = getCurrentChatUid();
            if (!chatUid) {
                return null;
            }

            // Если уже есть актуальная информация по этому чату — возвращаем её
            const now = Date.now();
            if (!forceRefresh && currentChatPhotoInfo &&
                currentChatPhotoInfo.chatUid === chatUid &&
                (now - currentChatPhotoTimestamp) < PHOTO_INFO_CACHE_TTL) {
                console.log('[Alpha Date Extension] 📋 Используем кешированную информацию о фото чата');
                return currentChatPhotoInfo;
            }

            console.log('[Alpha Date Extension] Проверка фото для чата', chatUid);

            const history = await fetchChatHistory(token, chatUid, 1);

            for (const msg of history) {
                if (!msg) continue;
                const isMale = msg.is_male;
                const sExt = msg.sender_external_id;
                const rExt = msg.recipient_external_id;
                if (sExt == null || rExt == null) continue;

                if (isMale === 1) {
                    // мужчина отправил → женщина получатель
                    womanExt = rExt;
                    manExt = sExt;
                } else if (isMale === 0) {
                    // женщина отправила → женщина отправитель
                    womanExt = sExt;
                    manExt = rExt;
                }

                if (womanExt && manExt) break;
            }

            if (!womanExt) {
                console.warn('[Alpha Date Extension] Не удалось определить external_id девушки для чата', chatUid);
            }
        }

        // Собираем отправленные фото в чате (SENT_IMAGE от девушки)
        const sentLinksMap = new Map();

        const mediaChat = await fetchOperatorMedia(token, chatUid);
        for (const m of mediaChat) {
            if (!m) continue;
            if (m.message_type !== 'SENT_IMAGE') continue;

            const link = m.message_content || '';
            if (!link) continue;

            // Только исходящие от девушки (is_male = 0)
            if (m.is_male !== 0) continue;

            const prev = sentLinksMap.get(link) || { fromChat: false, fromLetter: false, readStatus: null };
            prev.fromChat = true;
            if (typeof m.read_status === 'number') {
                prev.readStatus = m.read_status;
            }
            sentLinksMap.set(link, prev);
        }

        // Собираем отправленные фото в письмах (SENT_IMAGE_MAIL от оператора)
        const mediaLetters = await fetchOperatorMediaLetters(token, chatUid);
        for (const m of mediaLetters) {
            if (!m) continue;
            if (m.message_type !== 'SENT_IMAGE_MAIL') continue;

            // Только отправленные оператором
            if (m.operator !== 1) continue;

            const link = m.message_content || '';
            if (!link) continue;

            const prev = sentLinksMap.get(link) || { fromChat: false, fromLetter: false, readStatus: null };
            prev.fromLetter = true;
            // Для писем тоже учитываем прочтение, если есть
            if (typeof m.read_status === 'number') {
                prev.readStatus = m.read_status;
            }
            sentLinksMap.set(link, prev);
        }

        // Строим список фото из библиотеки девушки (files/images)
        let photosLibrary = [];
        if (womanExt) {
            photosLibrary = await fetchPhotosLibrary(token, womanExt);
        }

        const photos = [];
        for (const p of photosLibrary) {
            if (!p) continue;
            if (p.content_type && p.content_type !== 'image') continue;
            const link = p.link || p.url || '';
            if (!link) continue;
            photos.push({
                link,
                filename: p.filename || p.name || '',
            });
        }

        currentChatPhotoInfo = {
            chatUid,
            womanExternalId: womanExt,
            manExternalId: manExt,
            sentLinks: sentLinksMap,
            photos,
            lastUpdated: new Date().toISOString(),
        };

        currentChatPhotoTimestamp = Date.now();

        return currentChatPhotoInfo;
    }

    function annotateVideoPopupWithStatuses() {
        try {
            if (!currentChatVideoInfo || !currentChatVideoInfo.videos) {
                return;
            }

            const { videos, sentLinks } = currentChatVideoInfo;
            const items = document.querySelectorAll('.upload_popup_tabs_content_item_bottom');
            if (!items || !items.length) {
                return;
            }

            // Добавляем немного стилей для статуса, если ещё не добавлены
            if (!getCachedElementById('alpha-ext-video-status-style')) {
                const style = document.createElement('style');
                style.id = 'alpha-ext-video-status-style';
                style.textContent = `
                .alpha-ext-video-status {
                    margin-top: 2px;
                    font-size: 11px;
                    font-weight: 500;
                }
                `;
                document.head.appendChild(style);
            }

            items.forEach((item, index) => {
                const video = videos[index];
                if (!video) {
                    return;
                }
                const link = video.link;
                const info = sentLinks.get(link);

                let statusText = 'Не отправлено';
                let color = '#ff4d4f'; // красный

                // Если это видео уже отправлялось (через чат или письмо) — считаем просто "Отправлено"
                if (info) {
                    statusText = 'Отправлено';
                    color = '#00ff88'; // зелёный
                }

                let statusEl = item.querySelector('.alpha-ext-video-status');
                if (!statusEl) {
                    statusEl = document.createElement('div');
                    statusEl.className = 'alpha-ext-video-status';
                    item.appendChild(statusEl);
                }
                statusEl.textContent = statusText;
                statusEl.style.color = color;
            });
        } catch (e) {
            console.error('[Alpha Date Extension] Ошибка при пометке видео статусов:', e);
        }
    }

    function annotatePhotoPopupWithStatuses() {
        try {
            if (!currentChatPhotoInfo || !currentChatPhotoInfo.photos) {
                return;
            }

            const { photos, sentLinks } = currentChatPhotoInfo;
            const items = document.querySelectorAll('.upload_popup_tabs_content_item_bottom');
            if (!items || !items.length) {
                return;
            }

            // Добавляем немного стилей для статуса, если ещё не добавлены
            if (!getCachedElementById('alpha-ext-photo-status-style')) {
                const style = document.createElement('style');
                style.id = 'alpha-ext-photo-status-style';
                style.textContent = `
                .alpha-ext-photo-status {
                    margin-top: 2px;
                    font-size: 11px;
                    font-weight: 500;
                }
                `;
                document.head.appendChild(style);
            }

            items.forEach((item, index) => {
                const photo = photos[index];
                if (!photo) {
                    return;
                }
                const link = photo.link;
                const info = sentLinks.get(link);

                let statusText = 'Не отправлено';
                let color = '#ff4d4f'; // красный

                // Если это фото уже отправлялось (через чат или письмо) — считаем просто "Отправлено"
                if (info) {
                    statusText = 'Отправлено';
                    color = '#00ff88'; // зелёный
                }

                let statusEl = item.querySelector('.alpha-ext-photo-status');
                if (!statusEl) {
                    statusEl = document.createElement('div');
                    statusEl.className = 'alpha-ext-photo-status';
                    item.appendChild(statusEl);
                }
                statusEl.textContent = statusText;
                statusEl.style.color = color;
            });
        } catch (e) {
            console.error('[Alpha Date Extension] Ошибка при пометке фото статусов:', e);
        }
    }

    // --- Большое всплывающее окно с интерфейсом расширения (оверлей) ---

    function ensureOverlayStyles() {
        if (getCachedElementById('alpha-ext-overlay-style')) {
            return;
        }
        const style = document.createElement('style');
        style.id = 'alpha-ext-overlay-style';
        style.textContent = `
        #alpha-ext-fab {
            position: fixed;
            right: 16px;
            bottom: 16px;
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: linear-gradient(135deg, #007AFF, #00a6ff);
            box-shadow: 0 4px 16px rgba(0,0,0,0.35);
            color: #fff;
            font-size: 18px;
            font-weight: 700;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 9999;
            user-select: none;
        }
        #alpha-ext-fab:hover {
            filter: brightness(1.1);
        }

        #alpha-ext-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 999999;
        }
        #alpha-ext-modal {
            position: relative;
            width: 95vw;
            height: 90vh;
            max-width: 1300px;
            max-height: 900px;
            background: #020817;
            border-radius: 16px;
            box-shadow: 0 12px 40px rgba(0,0,0,0.6);
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }
        #alpha-ext-modal iframe {
            border: none;
            flex: 1 1 auto;
            width: 100%;
            height: 100%;
        }
        #alpha-ext-modal-close {
            position: absolute;
            top: 10px;
            right: 14px;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            border: none;
            background: rgba(0,0,0,0.5);
            color: #fff;
            font-size: 18px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 2;
        }
        #alpha-ext-modal-close:hover {
            background: rgba(0,0,0,0.8);
        }
        `;
        document.head.appendChild(style);
    }

    function openBigOverlay() {
        ensureOverlayStyles();

        if (getCachedElementById('alpha-ext-overlay')) {
            return;
        }

        const overlay = document.createElement('div');
        overlay.id = 'alpha-ext-overlay';

        const modal = document.createElement('div');
        modal.id = 'alpha-ext-modal';

        const closeBtn = document.createElement('button');
        closeBtn.id = 'alpha-ext-modal-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => {
            overlay.remove();
        });

        const iframe = document.createElement('iframe');
        
        // Проверяем доступность контекста расширения
        let popupUrl = null;
        try {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
                popupUrl = chrome.runtime.getURL('popup.html');
            }
        } catch (e) {
            console.warn('[Alpha Date Extension] Контекст расширения недоступен, попробуйте перезагрузить страницу:', e);
            // Показываем сообщение пользователю
            const errorMsg = document.createElement('div');
            errorMsg.style.cssText = 'padding: 20px; text-align: center; color: #fff;';
            errorMsg.innerHTML = `
                <p>Контекст расширения недоступен.</p>
                <p>Пожалуйста, перезагрузите страницу.</p>
                <button onclick="window.location.reload()" style="margin-top: 10px; padding: 8px 16px; background: #007AFF; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Перезагрузить страницу</button>
            `;
            modal.appendChild(closeBtn);
            modal.appendChild(errorMsg);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            return;
        }

        if (popupUrl) {
            iframe.src = popupUrl;
            modal.appendChild(closeBtn);
            modal.appendChild(iframe);
        } else {
            // Если не удалось получить URL, показываем сообщение
            const errorMsg = document.createElement('div');
            errorMsg.style.cssText = 'padding: 20px; text-align: center; color: #fff;';
            errorMsg.innerHTML = `
                <p>Не удалось загрузить интерфейс расширения.</p>
                <p>Пожалуйста, перезагрузите страницу.</p>
                <button onclick="window.location.reload()" style="margin-top: 10px; padding: 8px 16px; background: #007AFF; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Перезагрузить страницу</button>
            `;
            modal.appendChild(closeBtn);
            modal.appendChild(errorMsg);
        }
        
        overlay.appendChild(modal);

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                overlay.remove();
            }
        });

        document.body.appendChild(overlay);
    }

    function initBigOverlayFab() {
        // маленькая плавающая кнопка только на alpha.date
        if (getCachedElementById('alpha-ext-fab')) {
            return;
        }

        ensureOverlayStyles();

        const fab = document.createElement('div');
        fab.id = 'alpha-ext-fab';
        fab.textContent = 'AD';
        fab.title = 'Открыть панель Alpha Date Extension';
        fab.addEventListener('click', () => {
            if (getCachedElementById('alpha-ext-overlay')) {
                document.getElementById('alpha-ext-overlay').remove();
            } else {
                openBigOverlay();
            }
        });

        document.body.appendChild(fab);
    }

    // --- Система имен пользователей ---

    // Функция для получения отображаемого имени пользователя
    async function getUserDisplayName(userId) {
        try {
            // Проверяем контекст перед обращением к storage
            if (typeof chrome === 'undefined' ||
                !chrome.runtime ||
                !chrome.runtime.id ||
                !chrome.storage ||
                !chrome.storage.local) {
                console.log('[Alpha Date Extension] Контекст расширения невалиден в getUserDisplayName');
                return `ID ${userId}`;
            }

            const data = await chrome.storage.local.get(['userNames']);
            const userNames = data.userNames || {};
            const name = userNames[userId];
            return name ? `${name} (ID ${userId})` : `ID ${userId}`;
        } catch (e) {
            if (e.message && e.message.includes('Extension context invalidated')) {
                console.warn('[Alpha Date Extension] Контекст расширения недействителен в getUserDisplayName');
            } else {
                console.warn('[Alpha Date Extension] Ошибка получения имени пользователя:', e);
            }
            return `ID ${userId}`;
        }
    }

    // Функция для сохранения имени пользователя
    async function saveUserName(userId, name) {
        try {
            // Проверяем контекст перед обращением к storage
            if (typeof chrome === 'undefined' ||
                !chrome.runtime ||
                !chrome.runtime.id ||
                !chrome.storage ||
                !chrome.storage.local) {
                console.log('[Alpha Date Extension] Контекст расширения невалиден в saveUserName');
                return;
            }

            const data = await chrome.storage.local.get(['userNames']);
            const userNames = data.userNames || {};
            userNames[userId] = name.trim();
            await chrome.storage.local.set({ userNames: userNames });
            console.log('[Alpha Date Extension] Сохранено имя для пользователя:', userId, '=', name);
        } catch (error) {
            if (error.message && error.message.includes('Extension context invalidated')) {
                console.warn('[Alpha Date Extension] Контекст расширения недействителен в saveUserName');
            } else {
                console.error('[Alpha Date Extension] Ошибка сохранения имени пользователя:', error);
            }
        }
    }

    // --- Глобальная обработка ошибок контекста расширения ---

    // Перехватываем необработанные ошибки
    window.addEventListener('error', function(event) {
        if (event.error && event.error.message && event.error.message.includes('Extension context invalidated')) {
            console.warn('[Alpha Date Extension] Обнаружена ошибка контекста расширения, останавливаем все активные процессы');
            disconnectWebSocket();
            // Останавливаем все таймеры и интервалы
            if (wsReconnectTimer) {
                clearTimeout(wsReconnectTimer);
                wsReconnectTimer = null;
            }
            if (wsPingTimer) {
                clearInterval(wsPingTimer);
                wsPingTimer = null;
            }
            if (wsPongCheckTimer) {
                clearInterval(wsPongCheckTimer);
                wsPongCheckTimer = null;
            }
        }
    });

    // Перехватываем необработанные Promise rejection
    window.addEventListener('unhandledrejection', function(event) {
        if (event.reason && event.reason.message && event.reason.message.includes('Extension context invalidated')) {
            console.warn('[Alpha Date Extension] Обнаружен rejected Promise с ошибкой контекста расширения');
            event.preventDefault(); // Предотвращаем вывод в консоль
        }
    });

    // --- Мониторинг входящих сообщений через WebSocket ---

    let wsConnection = null;
    let wsReconnectTimer = null;
    let wsReconnectAttempts = 0;
    let wsInitialized = false; // Флаг инициализации Socket.IO
    let wsPingTimer = null; // Таймер для ping сообщений
    let wsPongCheckTimer = null; // Таймер для проверки получения pong
    let wsConnecting = false; // Флаг, что идет процесс подключения (защита от множественных вызовов)
    let lastPongTime = null; // Время последнего полученного pong
    let pendingPingTime = null; // Время отправки последнего ping (для проверки, что pong приходит)
    const WS_RECONNECT_DELAY_BASE = 2000; // Базовая задержка 2 секунды (быстрое переподключение)
    const MAX_RECONNECT_ATTEMPTS = 10;
    const WS_PING_INTERVAL = 25000; // 25 секунд между ping (уменьшено для более стабильного соединения)
    const WS_PONG_TIMEOUT = 35000; // 35 секунд - если pong не приходит, считаем соединение мертвым
    const WS_RECONNECT_MAX_DELAY = 3000; // Максимальная задержка 3 секунды (чтобы не терять уведомления)
    
    let seenMessageKeys = new Set();
    const MAX_SEEN_MESSAGES = 500;

    // Кэш информации о видео в текущем чате (для проверки уже отправленных видео)
    let currentChatVideoInfo = null;
    let currentChatPhotoInfo = null;
    let currentChatPhotoTimestamp = 0;
    const PHOTO_INFO_CACHE_TTL = 2 * 60 * 1000; // 2 минуты для информации о фото

    // Статистика (лайки/винки/отправленные сообщения)
    function getDefaultStats() {
        return {
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
    }

    async function incrementStats(delta) {
        if (!delta) return;
        try {
            const data = await chrome.storage.local.get(['stats']);
            const stats = data.stats || getDefaultStats();
            if (delta.incomingLikes) {
                stats.incomingLikes = (stats.incomingLikes || 0) + Number(delta.incomingLikes);
            }
            if (delta.incomingWinks) {
                stats.incomingWinks = (stats.incomingWinks || 0) + Number(delta.incomingWinks);
            }
            if (delta.incomingLetters) {
                stats.incomingLetters = (stats.incomingLetters || 0) + Number(delta.incomingLetters);
            }
            if (delta.outgoingMessages) {
                stats.outgoingMessages = (stats.outgoingMessages || 0) + Number(delta.outgoingMessages);
            }
            if (delta.successfulChatMessages) {
                stats.successfulChatMessages = (stats.successfulChatMessages || 0) + Number(delta.successfulChatMessages);
            }
            if (delta.readMails) {
                stats.readMails = (stats.readMails || 0) + Number(delta.readMails);
            }
            if (delta.limitsUpdates) {
                stats.limitsUpdates = (stats.limitsUpdates || 0) + Number(delta.limitsUpdates);
            }
            stats.lastUpdate = new Date().toISOString();
            await chrome.storage.local.set({ stats });

            // Отправляем уведомление об обновлении статистики (если включено)
            try {
                await sendBrowserNotification(
                    'Статистика обновлена',
                    `❤️ ${stats.incomingLikes} | 👀 ${stats.incomingWinks} | 💌 ${stats.incomingLetters} | 📧 ${stats.readMails} | ⚡ ${stats.limitsUpdates} | 📤 ${stats.successfulChatMessages}`,
                    'showStats',
                    { stats }
                );
            } catch (notifError) {
                console.warn('[Alpha Date Extension] Ошибка отправки уведомления статистики:', notifError);
            }
        } catch (e) {
            console.error('[Alpha Date Extension] Не удалось обновить статистику:', e);

            // Отправляем уведомление об ошибке
            try {
                await sendBrowserNotification(
                    'Ошибка обновления статистики',
                    e.message || 'Неизвестная ошибка',
                    'error'
                );
            } catch (notifError) {
                console.warn('[Alpha Date Extension] Ошибка отправки уведомления об ошибке:', notifError);
        }
    }
    }


    // Обработка WebSocket событий
    async function handleWebSocketEvent(eventData) {
        try {
            // Проверяем контекст расширения перед обработкой события
            if (typeof chrome === 'undefined' ||
                !chrome.runtime ||
                !chrome.runtime.id ||
                !chrome.storage ||
                !chrome.storage.local) {
                console.log('[Alpha Date Extension] Контекст расширения невалиден, пропускаем обработку события');
                return;
            }

            const { action, message_object, notification_object, external_id, chat_list_object } = eventData;

                console.log('[Alpha Date Extension] Получено WebSocket событие:', { action, eventData });
            
            // Фильтруем только нужные события
            if (action !== 'viewed' && action !== 'liked' && action !== 'message' && action !== 'mail' && action !== 'read_mail' && action !== 'REACTION_LIMITS') {
                console.log('[Alpha Date Extension] Игнорируем событие:', action);
                return; // Игнорируем другие события (open_chat и т.д.)
            }

            console.log('[Alpha Date Extension] Обрабатываем событие:', action);
            
            // Обработка события "mail" (письмо) - имеет другую структуру данных
            if (action === 'mail') {
                const maleExt = eventData.male_external_id;
                const femaleExt = eventData.female_external_id || eventData.female_id;
                const messageObjectId = eventData.message_object; // ID письма
                const letterLimit = eventData.letter_limit;
                const updatedLimitAt = eventData.updated_limit_at;
                
                if (!maleExt || !femaleExt) {
                    return;
                }
                
                // Защита от дублей для mail
                const mailKey = `mail|${maleExt}|${femaleExt}|${messageObjectId}|${updatedLimitAt}`;
                if (seenMessageKeys.has(mailKey)) {
                    return;
                }
                seenMessageKeys.add(mailKey);
                
                // Обрезаем список увиденных сообщений
                if (seenMessageKeys.size > MAX_SEEN_MESSAGES) {
                    const arr = Array.from(seenMessageKeys);
                    const tail = arr.slice(-MAX_SEEN_MESSAGES);
                    seenMessageKeys = new Set(tail);
                }
                
                // Для события mail имя и возраст могут быть в других полях, но обычно их нет
                // Оставляем manName = null для писем, так как в структуре mail их обычно нет
                let manName = null;

                // Получаем данные письма для формирования ссылки
                let letterUrl = null;
                let chatUid = null;

                try {
                    const token = getToken();
                    if (token && femaleExt && maleExt && messageObjectId) {
                        console.log('[Alpha Date Extension] Запрашиваем данные нового письма для формирования ссылки:', {
                            femaleExt,
                            maleExt,
                            messageObjectId
                        });

                        const mailDataResponse = await fetchMailData(token, femaleExt, maleExt, messageObjectId);

                        if (mailDataResponse.status === 200 && mailDataResponse.data?.status === true) {
                            const chat = mailDataResponse.data?.response?.chat;

                            // Ищем chat_uid в response.chat.chat_uid
                            if (chat?.chat_uid) {
                                chatUid = chat.chat_uid;
                                letterUrl = `https://alpha.date/letter/${chatUid}`;
                                console.log('[Alpha Date Extension] Сформирована ссылка на новое письмо:', letterUrl);
                            } else {
                                console.warn('[Alpha Date Extension] chat_uid не найден для нового письма');
                            }
                        } else {
                            console.warn('[Alpha Date Extension] Не удалось получить данные нового письма:', mailDataResponse);
                        }
                    }
                } catch (mailError) {
                    console.warn('[Alpha Date Extension] Ошибка при получении данных нового письма:', mailError);
                    // Продолжаем без ссылки на письмо
                }

                // Формируем уведомление о письме
                const text = [
                    '✉️ <b>Новое письмо</b>',
                    '',
                    manName ? `Мужчина: <b>${manName}</b>` : '',
                    `sender_external_id (мужчина): <code>${maleExt}</code>`,
                    `recipient_external_id (женщина): <code>${femaleExt}</code>`,
                    '',
                    `ID письма: <code>${messageObjectId || '(не указано)'}</code>`,
                    `Лимит писем: <code>${letterLimit !== undefined ? letterLimit : '(не указано)'}</code>`,
                    updatedLimitAt ? `Обновлено: ${updatedLimitAt}` : '',
                    letterUrl ? `\n<a href="${letterUrl}">Открыть письмо</a>` : '',
                ].filter(Boolean).join('\n');

                // Отправляем уведомления (не блокируем обработку при ошибке)
                try {
                    await sendBrowserNotification(text, '', 'showLetters', letterUrl ? { chatUrl: letterUrl } : {});
                } catch (notifError) {
                    console.warn('[Alpha Date Extension] Ошибка отправки уведомлений (не критично):', notifError);
                }
                await incrementStats({ incomingLetters: 1 });
                
                // Сохраняем seenKeys
                await chrome.storage.local.set({
                    monitorState: {
                        running: true,
                        seenKeys: Array.from(seenMessageKeys),
                    },
                });
                
                return; // Завершаем обработку для mail
            }

            // Обработка события "read_mail" (чтение письма) - обрабатываем ДО извлечения данных сообщения
            if (action === 'read_mail') {
                console.log('[Alpha Date Extension] Обработка read_mail:', eventData);
                const mailIds = eventData.mailIds || [];
                const manExt = eventData.male_external_id;
                const womanExt = eventData.female_external_id || eventData.female_id;

                // Получаем отображаемое имя пользователя
                const manDisplayName = await getUserDisplayName(manExt);

                // Получаем данные письма для формирования ссылки
                let letterUrl = null;
                let chatUid = null;

                try {
                    const token = getToken();
                    console.log('[Alpha Date Extension] DEBUG read_mail - token exists:', !!token, 'womanExt:', womanExt, 'manExt:', manExt, 'mailIds:', mailIds);

                    if (token && womanExt && manExt && mailIds.length > 0) {
                        console.log('[Alpha Date Extension] Запрашиваем данные письма для формирования ссылки:', {
                            womanExt,
                            manExt,
                            mailId: mailIds[0]
                        });

                        const mailDataResponse = await fetchMailData(token, womanExt, manExt, mailIds[0]);
                        console.log('[Alpha Date Extension] DEBUG - mailDataResponse:', JSON.stringify(mailDataResponse, null, 2));

                        if (mailDataResponse.status === 200 && mailDataResponse.data?.status === true) {
                            const mails = mailDataResponse.data?.response?.mails || [];
                            const chat = mailDataResponse.data?.response?.chat;

                            console.log('[Alpha Date Extension] DEBUG - mails array:', mails.length, 'items');
                            console.log('[Alpha Date Extension] DEBUG - chat object:', JSON.stringify(chat, null, 2));

                            // Сначала пробуем найти chat_uid в response.chat.chat_uid
                            if (chat?.chat_uid) {
                                chatUid = chat.chat_uid;
                                letterUrl = `https://alpha.date/letter/${chatUid}`;
                                console.log('[Alpha Date Extension] Сформирована ссылка на письмо из chat.chat_uid:', letterUrl);
                            } else if (mails.length > 0) {
                                // Альтернативно ищем в первом письме
                                const firstMail = mails[0];
                                console.log('[Alpha Date Extension] DEBUG - first mail structure:', JSON.stringify(firstMail, null, 2));
                                console.log('[Alpha Date Extension] DEBUG - mail chat object:', firstMail?.chat);
                                console.log('[Alpha Date Extension] DEBUG - mail chr_id:', firstMail?.chr_id);

                                chatUid = firstMail?.chat?.chat_uid || firstMail?.chr_id;
                                if (chatUid) {
                                    letterUrl = `https://alpha.date/letter/${chatUid}`;
                                    console.log('[Alpha Date Extension] Сформирована ссылка на письмо из mail.chat_uid:', letterUrl);
                                } else {
                                    console.warn('[Alpha Date Extension] chat_uid не найден ни в chat, ни в mails');
                                }
                            } else {
                                console.warn('[Alpha Date Extension] Массив mails пустой и chat_uid не найден в chat');
                            }
                        } else {
                            console.warn('[Alpha Date Extension] API вернул ошибку или неправильный статус:', {
                                status: mailDataResponse.status,
                                statusText: mailDataResponse.statusText,
                                dataStatus: mailDataResponse.data?.status,
                                error: mailDataResponse.error
                            });
                        }
                    } else {
                        console.warn('[Alpha Date Extension] Не хватает данных для запроса:', {
                            hasToken: !!token,
                            womanExt,
                            manExt,
                            mailIdsLength: mailIds.length
                        });
                    }
                } catch (mailError) {
                    console.warn('[Alpha Date Extension] Ошибка при получении данных письма:', mailError);
                    // Продолжаем без ссылки на письмо
                }

                const text = [
                    '📧 <b>Прочитано письмо</b>',
                    '',
                    `Мужчина: <b>${manDisplayName}</b>`,
                    `ID: <code>${manExt}</code>`,
                    `recipient_external_id (женщина): <code>${womanExt}</code>`,
                    '',
                    `ID писем: <code>${mailIds.join(', ')}</code>`,
                    letterUrl ? `\n<a href="${letterUrl}">Открыть письмо</a>` : '',
                ].filter(Boolean).join('\n');

                // Отправляем уведомления (не блокируем обработку при ошибке)
                try {
                    await sendBrowserNotification(text, '', 'read_mail', letterUrl ? { chatUrl: letterUrl } : {});
                } catch (notifError) {
                    console.warn('[Alpha Date Extension] Ошибка отправки уведомлений (не критично):', notifError);
                }

                // Обновляем статистику для прочитанных писем
                await incrementStats({ readMails: 1 });

                return; // Завершаем обработку для read_mail
            }

            // Обработка события "REACTION_LIMITS" (обновление лимитов) - обрабатываем ДО извлечения данных сообщения
            if (action === 'REACTION_LIMITS') {
                console.log('[Alpha Date Extension] Обработка REACTION_LIMITS:', eventData);
                const likeLimit = eventData.like_limit || 0;
                const messageLimit = eventData.message_limit || 0;
                const letterLimit = eventData.letter_limit || 0;
                const updatedLimitAt = eventData.updated_limit_at || '';
                const manExt = eventData.male_external_id;
                const womanExt = eventData.female_external_id || eventData.female_id;

                // Получаем отображаемое имя пользователя
                const manDisplayName = await getUserDisplayName(manExt);

                const text = [
                    '⚡ <b>Обновление лимитов</b>',
                    '',
                    `Мужчина: <b>${manDisplayName}</b>`,
                    `ID: <code>${manExt}</code>`,
                    `recipient_external_id (женщина): <code>${womanExt}</code>`,
                    '',
                    `Лимит лайков: <code>${likeLimit}</code>`,
                    `Лимит сообщений: <code>${messageLimit}</code>`,
                    `Лимит писем: <code>${letterLimit}</code>`,
                    updatedLimitAt ? `Обновлено: ${updatedLimitAt}` : '',
                ].filter(Boolean).join('\n');

                // Отправляем уведомления (не блокируем обработку при ошибке)
                try {
                    await sendBrowserNotification(text, '', 'REACTION_LIMITS');
                } catch (notifError) {
                    console.warn('[Alpha Date Extension] Ошибка отправки уведомлений (не критично):', notifError);
                }

                // Обновляем статистику для обновления лимитов
                await incrementStats({ limitsUpdates: 1 });

                return; // Завершаем обработку для REACTION_LIMITS
            }
            
            // Извлекаем данные сообщения для других событий
            const msg = message_object || notification_object;
            if (!msg) return;

            const isMale = msg.is_male;
            const messageType = msg.message_type || '';
            const messageContent = msg.message_content || '';
            const createdStr = msg.created_at || msg.date_created || msg.date_created_at || msg.updated_at;

            // Нас интересуют только входящие от мужчины
            if (isMale !== 1) return;
            
            // Получаем имя и возраст мужчины из notification_object или message_object
            // В WebSocket данных имя и возраст уже есть в notification_object
            let manName = null;
            const notificationObj = notification_object || {};
            const msgObj = message_object || {};
            
            // Имя и возраст могут быть в notification_object или message_object
            const name = notificationObj.name || msgObj.name || notificationObj.sender_name || msgObj.sender_name;
            const age = notificationObj.age !== undefined ? notificationObj.age : (msgObj.age !== undefined ? msgObj.age : null);
            
            if (name) {
                manName = age !== null && age !== undefined ? `${name}, ${age}` : name;
            }
            
            // Проверяем connect: 0 = новый пользователь (отправляем автоответ), 1 = постоянный (не отправляем)
            const connect = notificationObj.connect !== undefined ? notificationObj.connect : (msgObj.connect !== undefined ? msgObj.connect : null);
            
            // Для action: "message" обрабатываем только SENT_WINK и SENT_TEXT
            if (action === 'message') {
                if (messageType !== 'SENT_WINK' && messageType !== 'SENT_TEXT') {
                    return; // Игнорируем другие типы сообщений
                }
            }

            // Защита от дублей: ключ по id/uid+тексту+времени
            const keyParts = [
                msg.id || '',
                msg.chat_uid || '',
                msg.sender_external_id || '',
                msg.recipient_external_id || '',
                msg.hashed_content || msg.message_content || '',
                createdStr,
            ];
            const key = keyParts.join('|');

            // Проверяем через централизованное хранилище
            const checkResult = await chrome.runtime.sendMessage({
                type: 'checkAndAddSeenMessage',
                payload: { key }
            });

            if (!checkResult.isNew) {
                console.log('[Alpha Date Extension] Сообщение уже обработано:', key);
                return;
            }

            const manExt = msg.sender_external_id || msg.sender_id;
            const womanExt = msg.recipient_external_id || msg.recipient_id;

            if (!womanExt || !manExt) {
                return;
            }

            // Получаем настройки профиля для автоответов
            const data = await chrome.storage.local.get(['profileBroadcastMessages']);
            const profileMessagesCfg = data.profileBroadcastMessages || {};
            const profileKey = String(womanExt);
            const profileCfg = profileMessagesCfg[profileKey] || {};
            
            console.log('[Alpha Date Extension] Настройки автоответов для профиля:', {
                profileKey,
                hasWinkReply: !!profileCfg.winkReply,
                hasLikeReply: !!profileCfg.likeReply,
                hasViewReply: !!profileCfg.viewReply,
                action
            });

            const token = getToken();
            if (!token) return;

            // Определяем источник (CHANCE или DEFAULT)
            // Для событий "viewed" и "liked" из WebSocket всегда есть chat_list_object с last_message_type
            // Если last_message_type = SENT_VIEW/SENT_LIKE/SENT_WINK - это CHANCE
            // Для action="viewed" всегда должен быть SENT_VIEW в chat_list_object
            let source = 'DEFAULT';
            if (chat_list_object) {
                const lastMessageType = chat_list_object.last_message_type || '';
                if (lastMessageType === 'SENT_VIEW' || lastMessageType === 'SENT_LIKE' || lastMessageType === 'SENT_WINK') {
                    source = 'CHANCE';
                } else if (lastMessageType === 'SENT_TEXT') {
                    // Для текстовых сообщений считаем CHANCE, если есть chat_list_object
                    source = 'CHANCE';
                }
            }
            
            // Для action="viewed" и "viewed_photos" всегда считаем CHANCE (так как это событие приходит только из CHANCE списка)
            if (action === 'viewed' || action === 'viewed_photos') {
                source = 'CHANCE';
            }
            
            console.log('[Alpha Date Extension] Определение source:', {
                action,
                hasChatListObject: !!chat_list_object,
                lastMessageType: chat_list_object?.last_message_type,
                source
            });

            // Формируем ссылку на чат в зависимости от источника
            const chatUid = msg.chat_uid || '';
            const chatUrl = chatUid 
                ? (source === 'CHANCE' 
                    ? `https://alpha.date/chance/${chatUid}` 
                    : `https://alpha.date/chat/${chatUid}`)
                : '';

            // Обработка разных типов событий

            if (action === 'viewed') {
                // Просмотр профиля
                const text = [
                    '👁️ <b>Просмотр профиля</b>',
                    '',
                    manName ? `Мужчина: <b>${manName}</b>` : '',
                    `sender_external_id (мужчина): <code>${manExt}</code>`,
                    `recipient_external_id (женщина): <code>${womanExt}</code>`,
                    '',
                    `Текст: ${messageContent || '(без текста)'}`,
                    chatUrl ? `\n<a href="${chatUrl}">Открыть чат</a>` : '',
                ].filter(Boolean).join('\n');

                // Отправляем уведомления (не блокируем автоответ при ошибке)
                try {
                    await sendBrowserNotification(text, '', 'showViews', { chatUrl });
                } catch (notifError) {
                    console.warn('[Alpha Date Extension] Ошибка отправки уведомлений (не критично):', notifError);
                }

                // Автоответ на просмотр профиля (только для новых пользователей, connect === 0)
                const replyText = profileCfg.viewReply || '';
                const viewPhotoUrl = profileCfg.viewPhotoUrl || null;
                const viewPhotoFilename = profileCfg.viewPhotoFilename || null;
                const viewPhotoContentId = profileCfg.viewPhotoContentId || null;

                if (replyText || viewPhotoUrl) {
                    // Проверяем блокировку автоответов
                    const lockCheck = await chrome.runtime.sendMessage({
                        type: 'checkOperationLock',
                        payload: { operationType: 'autoreply' }
                    });

                    if (lockCheck.locked) {
                        console.log('[Alpha Date Extension] Автоответ заблокирован - выполняется в другой вкладке');
                        return;
                    }

                    // Устанавливаем блокировку на короткое время для автоответа
                    await chrome.runtime.sendMessage({
                        type: 'setOperationLock',
                        payload: { operationType: 'autoreply', duration: 10000 } // 10 секунд
                    });
                    // Проверяем connect: отправляем только если connect === 0 (новый пользователь)
                    if (connect === 1) {
                        console.log('[Alpha Date Extension] Автоответ на просмотр профиля пропущен: постоянный пользователь (connect=1)', {
                            womanExt,
                            manExt
                        });
                    } else {
                        console.log('[Alpha Date Extension] Автоответ на просмотр профиля:', {
                            womanExt,
                            manExt,
                            replyText: replyText ? replyText.substring(0, 50) + '...' : '(нет текста)',
                            hasViewPhoto: !!viewPhotoUrl,
                            viewPhotoFilename: viewPhotoFilename,
                            viewPhotoContentId: viewPhotoContentId,
                            source,
                            connect
                        });
                        try {
                            // Если есть текст, отправляем текстовое сообщение
                            if (replyText) {
                                await sendMessageToChat(token, womanExt, manExt, replyText);
                                await sleep(400); // Пауза перед отправкой фото
                            }
                            
                            // Если есть фото, отправляем фото
                            if (viewPhotoUrl) {
                                if (viewPhotoUrl.startsWith('data:')) {
                                    console.warn('[Alpha Date Extension] ⚠️ Data URL не поддерживается для отправки. Используйте URL фото (например, https://chats-images.cdndate.net/...)');
                                } else if (viewPhotoUrl.startsWith('http://') || viewPhotoUrl.startsWith('https://')) {
                                    console.log('[Alpha Date Extension] Отправка фото автоответа на просмотр профиля:', {
                                        womanExt,
                                        manExt,
                                        photoUrl: viewPhotoUrl.substring(0, 50) + '...',
                                        photoFilename: viewPhotoFilename,
                                        photoContentId: viewPhotoContentId,
                                        source
                                    });
                                    await sendImageToChat(token, womanExt, manExt, viewPhotoUrl, viewPhotoFilename, viewPhotoContentId);
                                } else {
                                    console.warn('[Alpha Date Extension] ⚠️ Некорректный формат URL фото:', viewPhotoUrl.substring(0, 50));
                                }
                            }
                            
                            await incrementStats({ outgoingMessages: 1 });
                            console.log('[Alpha Date Extension] Автоответ на просмотр профиля отправлен успешно');
                        } catch (autoErr) {
                            console.error('[Alpha Date Extension] Ошибка автоответа на просмотр:', autoErr);
                        } finally {
                            // Снимаем блокировку автоответов
                            chrome.runtime.sendMessage({
                                type: 'clearOperationLock',
                                payload: { operationType: 'autoreply' }
                            });
                        }
                    }
                } else {
                    console.log('[Alpha Date Extension] Автоответ на просмотр профиля не настроен (viewReply пустой и фото не выбрано)');
                }
            } else if (action === 'viewed_photos') {
                // Просмотр фото
                const text = [
                    '📷 <b>Просмотр фото</b>',
                    '',
                    manName ? `Мужчина: <b>${manName}</b>` : '',
                    `sender_external_id (мужчина): <code>${manExt}</code>`,
                    `recipient_external_id (женщина): <code>${womanExt}</code>`,
                    '',
                    `Текст: ${messageContent || '(без текста)'}`,
                    chatUrl ? `\n<a href="${chatUrl}">Открыть чат</a>` : '',
                ].filter(Boolean).join('\n');

                // Отправляем уведомления (не блокируем автоответ при ошибке)
                try {
                    await sendBrowserNotification(text, '', 'showViews', { chatUrl });
                } catch (notifError) {
                    console.warn('[Alpha Date Extension] Ошибка отправки уведомлений (не критично):', notifError);
                }

                // Автоответ на просмотр фото (только для новых пользователей, connect === 0, используем тот же viewReply)
                const replyText = profileCfg.viewReply || '';
                const viewPhotoUrl = profileCfg.viewPhotoUrl || null;
                const viewPhotoFilename = profileCfg.viewPhotoFilename || null;
                const viewPhotoContentId = profileCfg.viewPhotoContentId || null;
                
                if (replyText || viewPhotoUrl) {
                    // Проверяем connect: отправляем только если connect === 0 (новый пользователь)
                    if (connect === 1) {
                        console.log('[Alpha Date Extension] Автоответ на просмотр фото пропущен: постоянный пользователь (connect=1)', {
                            womanExt,
                            manExt
                        });
                    } else {
                        console.log('[Alpha Date Extension] Автоответ на просмотр фото:', {
                            womanExt,
                            manExt,
                            replyText: replyText ? replyText.substring(0, 50) + '...' : '(нет текста)',
                            hasViewPhoto: !!viewPhotoUrl,
                            viewPhotoFilename: viewPhotoFilename,
                            viewPhotoContentId: viewPhotoContentId,
                            source,
                            connect
                        });
                        try {
                            // Если есть текст, отправляем текстовое сообщение
                            if (replyText) {
                                await sendMessageToChat(token, womanExt, manExt, replyText);
                                await sleep(400); // Пауза перед отправкой фото
                            }
                            
                            // Если есть фото, отправляем фото
                            if (viewPhotoUrl) {
                                if (viewPhotoUrl.startsWith('data:')) {
                                    console.warn('[Alpha Date Extension] ⚠️ Data URL не поддерживается для отправки. Используйте URL фото (например, https://chats-images.cdndate.net/...)');
                                } else if (viewPhotoUrl.startsWith('http://') || viewPhotoUrl.startsWith('https://')) {
                                    console.log('[Alpha Date Extension] Отправка фото автоответа на просмотр фото:', {
                                        womanExt,
                                        manExt,
                                        photoUrl: viewPhotoUrl.substring(0, 50) + '...',
                                        photoFilename: viewPhotoFilename,
                                        photoContentId: viewPhotoContentId,
                                        source
                                    });
                                    await sendImageToChat(token, womanExt, manExt, viewPhotoUrl, viewPhotoFilename, viewPhotoContentId);
                                } else {
                                    console.warn('[Alpha Date Extension] ⚠️ Некорректный формат URL фото:', viewPhotoUrl.substring(0, 50));
                                }
                            }
                            
                            await incrementStats({ outgoingMessages: 1 });
                            console.log('[Alpha Date Extension] Автоответ на просмотр фото отправлен успешно');
                        } catch (autoErr) {
                            console.error('[Alpha Date Extension] Ошибка автоответа на просмотр фото:', autoErr);
                        }
                    }
                } else {
                    console.log('[Alpha Date Extension] Автоответ на просмотр фото не настроен (viewReply пустой и фото не выбрано)');
                }
            } else if (action === 'liked') {
                // Лайк
                const text = [
                    '❤️ <b>Лайк</b>',
                    '',
                    manName ? `Мужчина: <b>${manName}</b>` : '',
                    `sender_external_id (мужчина): <code>${manExt}</code>`,
                    `recipient_external_id (женщина): <code>${womanExt}</code>`,
                    '',
                    `Текст: ${messageContent || '(без текста)'}`,
                    chatUrl ? `\n<a href="${chatUrl}">Открыть чат</a>` : '',
                ].filter(Boolean).join('\n');

                // Отправляем уведомления (не блокируем автоответ при ошибке)
                try {
                    await sendBrowserNotification(text, '', 'showLikes', { chatUrl });
                } catch (notifError) {
                    console.warn('[Alpha Date Extension] Ошибка отправки уведомлений (не критично):', notifError);
                }
                await incrementStats({ incomingLikes: 1 });

                // Автоответ на лайк
                const replyText = profileCfg.likeReply || '';
                const likePhotoUrl = profileCfg.likePhotoUrl || null;
                const likePhotoFilename = profileCfg.likePhotoFilename || null;
                const likePhotoContentId = profileCfg.likePhotoContentId || null;

                if (replyText || likePhotoUrl) {
                    // Проверяем блокировку автоответов
                    const lockCheck = await chrome.runtime.sendMessage({
                        type: 'checkOperationLock',
                        payload: { operationType: 'autoreply' }
                    });

                    if (lockCheck.locked) {
                        console.log('[Alpha Date Extension] Автоответ на лайк заблокирован - выполняется в другой вкладке');
                        return;
                    }

                    // Устанавливаем блокировку на короткое время для автоответа
                    await chrome.runtime.sendMessage({
                        type: 'setOperationLock',
                        payload: { operationType: 'autoreply', duration: 10000 } // 10 секунд
                    });
                    console.log('[Alpha Date Extension] Автоответ на лайк:', {
                        womanExt,
                        manExt,
                        replyText: replyText ? replyText.substring(0, 50) + '...' : '(нет текста)',
                        hasLikePhoto: !!likePhotoUrl,
                        likePhotoFilename: likePhotoFilename,
                        likePhotoContentId: likePhotoContentId,
                        source
                    });
                    try {
                        // Сначала отправляем лайк (если есть текст от пользователя, используем его, иначе пустой)
                        const likeText = messageContent || '';
                        if (likeText) {
                            await sendMessageToChat(token, womanExt, manExt, likeText, 'SENT_LIKE');
                            await sleep(400);
                        } else {
                            // Если нет текста от пользователя, отправляем пустой лайк
                            await sendMessageToChat(token, womanExt, manExt, '', 'SENT_LIKE');
                            await sleep(400);
                        }
                        
                        // Если есть текст автоответа, отправляем текстовое сообщение
                        if (replyText) {
                            await sendMessageToChat(token, womanExt, manExt, replyText);
                            await sleep(400); // Пауза перед отправкой фото
                        }
                        
                        // Если есть фото, отправляем фото
                        if (likePhotoUrl) {
                            if (likePhotoUrl.startsWith('data:')) {
                                console.warn('[Alpha Date Extension] ⚠️ Data URL не поддерживается для отправки. Используйте URL фото (например, https://chats-images.cdndate.net/...)');
                            } else if (likePhotoUrl.startsWith('http://') || likePhotoUrl.startsWith('https://')) {
                                console.log('[Alpha Date Extension] Отправка фото автоответа на лайк:', {
                                    womanExt,
                                    manExt,
                                    photoUrl: likePhotoUrl.substring(0, 50) + '...',
                                    photoFilename: likePhotoFilename,
                                    photoContentId: likePhotoContentId,
                                    source
                                });
                                await sendImageToChat(token, womanExt, manExt, likePhotoUrl, likePhotoFilename, likePhotoContentId);
                            } else {
                                console.warn('[Alpha Date Extension] ⚠️ Некорректный формат URL фото:', likePhotoUrl.substring(0, 50));
                            }
                        }
                        
                        await incrementStats({ outgoingMessages: 1 });
                        console.log('[Alpha Date Extension] Автоответ на лайк отправлен успешно');
                    } catch (autoErr) {
                        console.error('[Alpha Date Extension] Ошибка автоответа на лайк:', autoErr);
                    } finally {
                        // Снимаем блокировку автоответов
                        chrome.runtime.sendMessage({
                            type: 'clearOperationLock',
                            payload: { operationType: 'autoreply' }
                        });
                    }
                } else {
                    console.log('[Alpha Date Extension] Автоответ на лайк не настроен (likeReply пустой и фото не выбрано)');
                }
            } else if (action === 'message') {
                // Сообщение (может быть SENT_WINK, SENT_TEXT, SENT_AUDIO, SENT_VIDEO и т.д.)
                let messageIcon = '📩';
                let messageTypeLabel = messageType;
                
                if (messageType === 'SENT_AUDIO') {
                    messageIcon = '🎵';
                    messageTypeLabel = 'Аудио сообщение';
                } else if (messageType === 'SENT_VIDEO') {
                    messageIcon = '🎥';
                    messageTypeLabel = 'Видео сообщение';
                } else if (messageType === 'SENT_IMAGE') {
                    messageIcon = '🖼️';
                    messageTypeLabel = 'Фото';
                } else if (messageType === 'SENT_WINK') {
                    messageIcon = '👁️';
                    messageTypeLabel = 'Винк';
                }
                
                const text = [
                    `${messageIcon} <b>Новое входящее сообщение</b>`,
                    '',
                    manName ? `Мужчина: <b>${manName}</b>${msg.age ? ` (${msg.age} лет)` : ''}` : '',
                    `sender_external_id (мужчина): <code>${manExt}</code>`,
                    `recipient_external_id (женщина): <code>${womanExt}</code>`,
                    '',
                    `Тип: <code>${messageTypeLabel}</code>`,
                    messageType === 'SENT_AUDIO' || messageType === 'SENT_VIDEO' || messageType === 'SENT_IMAGE' 
                        ? `Ссылка: <code>${messageContent || '(нет)'}</code>`
                        : `Текст: ${messageContent || '(без текста)'}`,
                    msg.filename ? `Файл: <code>${msg.filename}</code>` : '',
                    chatUrl ? `\n<a href="${chatUrl}">Открыть чат</a>` : '',
                ].filter(Boolean).join('\n');

                // Отправляем уведомления (не блокируем автоответ при ошибке)
                try {
                    await sendBrowserNotification(text, '', 'showNewMessages', {
                        chatUrl
                    });
                } catch (notifError) {
                    console.warn('[Alpha Date Extension] Ошибка отправки уведомлений (не критично):', notifError);
                }

                // Автоответ на винк
                if (messageType === 'SENT_WINK') {
                    await incrementStats({ incomingWinks: 1 });
                    const replyText = profileCfg.winkReply || '';
                    const winkPhotoUrl = profileCfg.winkPhotoUrl || null;
                    const winkPhotoFilename = profileCfg.winkPhotoFilename || null;
                    const winkPhotoContentId = profileCfg.winkPhotoContentId || null;
                    
                    console.log('[Alpha Date Extension] Обработка SENT_WINK:', {
                        womanExt,
                        manExt,
                        hasWinkReply: !!replyText,
                        winkReplyLength: replyText.length,
                        hasWinkPhoto: !!winkPhotoUrl,
                        winkPhotoFilename: winkPhotoFilename,
                        winkPhotoContentId: winkPhotoContentId,
                        profileKey,
                        source
                    });
                    
                    if (replyText || winkPhotoUrl) {
                        // Проверяем блокировку автоответов
                        const lockCheck = await chrome.runtime.sendMessage({
                            type: 'checkOperationLock',
                            payload: { operationType: 'autoreply' }
                        });

                        if (lockCheck.locked) {
                            console.log('[Alpha Date Extension] Автоответ на винк заблокирован - выполняется в другой вкладке');
                            return;
                        }

                        // Устанавливаем блокировку на короткое время для автоответа
                        await chrome.runtime.sendMessage({
                            type: 'setOperationLock',
                            payload: { operationType: 'autoreply', duration: 10000 } // 10 секунд
                        });

                        try {
                            // Если есть текст, отправляем текстовое сообщение
                            if (replyText) {
                                console.log('[Alpha Date Extension] Отправка текстового автоответа на винк:', {
                                    womanExt,
                                    manExt,
                                    replyText: replyText.substring(0, 50) + (replyText.length > 50 ? '...' : ''),
                                    source
                                });
                                await sendMessageToChat(token, womanExt, manExt, replyText);
                                await sleep(400); // Пауза перед отправкой фото
                            }
                            
                            // Если есть фото, отправляем фото
                            if (winkPhotoUrl) {
                                // Проверяем, что это URL, а не Data URL (Data URL слишком большой)
                                if (winkPhotoUrl.startsWith('data:')) {
                                    console.warn('[Alpha Date Extension] ⚠️ Data URL не поддерживается для отправки. Используйте URL фото (например, https://chats-images.cdndate.net/...)');
                                } else if (winkPhotoUrl.startsWith('http://') || winkPhotoUrl.startsWith('https://')) {
                                    console.log('[Alpha Date Extension] Отправка фото автоответа на винк:', {
                                        womanExt,
                                        manExt,
                                        photoUrl: winkPhotoUrl.substring(0, 50) + '...',
                                        photoFilename: winkPhotoFilename,
                                        photoContentId: winkPhotoContentId,
                                        source
                                    });
                                    await sendImageToChat(token, womanExt, manExt, winkPhotoUrl, winkPhotoFilename, winkPhotoContentId);
                                } else {
                                    console.warn('[Alpha Date Extension] ⚠️ Некорректный формат URL фото:', winkPhotoUrl.substring(0, 50));
                                }
                            }
                            
                            console.log('[Alpha Date Extension] ✅ Автоответ на винк отправлен успешно');
                        } catch (autoErr) {
                            console.error('[Alpha Date Extension] ❌ Ошибка автоответа на винк:', autoErr);
                            console.error('[Alpha Date Extension] Детали ошибки:', {
                                error: String(autoErr),
                                message: autoErr.message,
                                stack: autoErr.stack
                            });
                        } finally {
                            // Снимаем блокировку автоответов
                            chrome.runtime.sendMessage({
                                type: 'clearOperationLock',
                                payload: { operationType: 'autoreply' }
                            });
                        }
                    } else {
                        console.warn('[Alpha Date Extension] ⚠️ Автоответ на винк не настроен (нет ни текста, ни фото) для профиля:', profileKey);
                    }
                } else {
                    console.log('[Alpha Date Extension] Сообщение не является SENT_WINK, тип:', messageType);
                }
            }

            // Сохраняем seenKeys
            await chrome.storage.local.set({
                monitorState: {
                    running: true,
                    seenKeys: Array.from(seenMessageKeys),
                },
            });
        } catch (e) {
            // Обрабатываем ошибку "Extension context invalidated" (возникает при перезагрузке расширения)
            if (e && e.message && e.message.includes('Extension context invalidated')) {
                console.warn('[Alpha Date Extension] Контекст расширения недействителен (вероятно, расширение было перезагружено). Пропускаем обработку события.');
                return;
            }
            console.error('[Alpha Date Extension] Ошибка обработки WebSocket события:', e);
        }
    }

    // Парсинг Socket.IO сообщений
    function parseSocketIOMessage(rawMessage) {
        try {
            // Socket.IO сообщения имеют формат: 42["event_name", data]
            // или просто JSON массив
            if (typeof rawMessage === 'string') {
                // Убираем префикс "42" если есть
                let jsonStr = rawMessage;
                if (jsonStr.startsWith('42')) {
                    jsonStr = jsonStr.substring(2);
                }
                const parsed = JSON.parse(jsonStr);
                if (Array.isArray(parsed) && parsed.length >= 2) {
                    const channel = parsed[0];
                    const data = parsed[1];
                    // Проверяем, что это канал counters_profile_*
                    if (typeof channel === 'string' && channel.startsWith('counters_profile_')) {
                        console.log('[Alpha Date Extension] Парсинг WebSocket:', { channel, action: data.action, data });
                        return { channel, data };
                    }
                    // Молча игнорируем другие каналы (user_online, woman_info_channel и т.д.)
                }
            }
        } catch (e) {
            // Игнорируем ошибки парсинга
        }
        return null;
    }

    // Подключение к WebSocket
    async function connectWebSocket() {
        // Проверяем контекст расширения перед подключением
        try {
            if (typeof chrome === 'undefined' ||
                !chrome.runtime ||
                !chrome.runtime.id ||
                !chrome.storage ||
                !chrome.storage.local) {
                console.log('[Alpha Date Extension] Контекст расширения невалиден, подключение невозможно');
                return;
            }
        } catch (e) {
            if (e.message && e.message.includes('Extension context invalidated')) {
                console.warn('[Alpha Date Extension] Контекст расширения недействителен, пропускаем подключение');
                return;
            }
            console.error('[Alpha Date Extension] Ошибка при проверке контекста перед подключением:', e);
            return;
        }

        // ПРОВЕРКА ПОДПИСКИ - мониторинг сообщений требует активной подписки
        try {
            const subscriptionStatus = await chrome.runtime.sendMessage({ type: 'getSubscriptionStatus' });
            if (!subscriptionStatus.hasActiveSubscription) {
                console.log('[Alpha Date Extension] Мониторинг сообщений заблокирован: подписка истекла');
                return;
            }
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка проверки подписки для WebSocket:', error);
            return;
        }

        // ПРОВЕРКА СТАТУСА WEBSOCKET - простая логика с флагом в localStorage
        try {
            // Проверяем, запущен ли уже WebSocket в другой вкладке
            const websocketStatus = await chrome.storage.local.get(['websocketActive']);
            if (websocketStatus.websocketActive) {
                console.log('[Alpha Date Extension] WebSocket уже активен в другой вкладке, пропускаем подключение');
                return;
            }

            console.log('[Alpha Date Extension] WebSocket свободен, запускаем в этой вкладке');

            // Настраиваем сброс флага при закрытии вкладки
            window.addEventListener('beforeunload', async () => {
                try {
                    // Сбрасываем флаг WebSocket при закрытии вкладки
                    await chrome.storage.local.set({ websocketActive: false });
                    console.log('[Alpha Date Extension] Флаг WebSocket сброшен при закрытии вкладки');
                } catch (error) {
                    console.error('[Alpha Date Extension] Ошибка сброса флага WebSocket при закрытии:', error);
                }
            });

        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка проверки статуса WebSocket:', error);
            return;
        }

        // Защита от множественных одновременных вызовов
        if (wsConnecting) {
            console.log('[Alpha Date Extension] Подключение уже в процессе, пропускаем...');
            return;
        }

        const token = getToken();
        if (!token) {
            console.log('[Alpha Date Extension] Токен не найден, WebSocket не подключён');
            return;
        }
        
        // Синхронизируем авто-ответы с сервером при подключении
        await syncAutoRepliesFromServerInternal();

        // Проверяем, включён ли мониторинг
        const data = await chrome.storage.local.get(['monitorState']);
        const monitorState = data.monitorState || {};
        if (monitorState.enabled === false) {
            // Мониторинг выключен, закрываем соединение если открыто
            if (wsConnection) {
                wsConnection.close();
                wsConnection = null;
            }
            await chrome.storage.local.set({
                monitorState: {
                    ...monitorState,
                    running: false,
                },
            });
            return;
        }

        // Если уже подключены, не переподключаемся
        if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
            return;
        }

        // Закрываем старое соединение если есть (но только если оно не в процессе закрытия)
        if (wsConnection) {
            const currentState = wsConnection.readyState;
            if (currentState === WebSocket.CONNECTING || currentState === WebSocket.OPEN) {
                try {
                    wsConnection.close();
                } catch (e) {
                    console.debug('[Alpha Date Extension] Ошибка при закрытии старого соединения:', e);
                }
            }
            wsConnection = null;
        }

        // Устанавливаем флаг подключения
        wsConnecting = true;

        try {
            const wsUrl = `wss://alpha.date/api/v3/socket/ws/?token=${encodeURIComponent(token)}&EIO=3&transport=websocket`;
            console.log('[Alpha Date Extension] Подключение к WebSocket...');
            
            wsInitialized = false;
            wsConnection = new WebSocket(wsUrl);

            wsConnection.onopen = () => {
                console.log('[Alpha Date Extension] WebSocket подключён');

                // Устанавливаем флаг, что WebSocket активен в этой вкладке
                chrome.storage.local.set({ websocketActive: true }).catch(error => {
                    console.error('[Alpha Date Extension] Ошибка установки флага WebSocket:', error);
                });

                wsReconnectAttempts = 0;
                wsConnecting = false; // Сбрасываем флаг после успешного подключения
                lastPongTime = Date.now(); // Инициализируем время последнего pong
                pendingPingTime = null;
                
                // Загружаем seenKeys из storage
                chrome.storage.local.get(['monitorState']).then((data) => {
                    const stored = data.monitorState || {};
                    if (Array.isArray(stored.seenKeys)) {
                        seenMessageKeys = new Set(stored.seenKeys);
                    }
                });

                // Обновляем статус
                chrome.storage.local.set({
                    monitorState: {
                        ...monitorState,
                        running: true,
                    },
                });
            };

            wsConnection.onmessage = (event) => {
                try {
                    const rawData = event.data;
                    
                    // Engine.IO протокол: первое сообщение "0" означает открытие соединения
                    if (rawData === '0') {
                        console.log('[Alpha Date Extension] Engine.IO открытие получено, отправляем подключение к namespace...');
                        // Отправляем "40" для подключения к namespace по умолчанию
                        wsConnection.send('40');
                        return;
                    }
                    
                    // "40" означает подтверждение подключения к namespace
                    if (rawData === '40') {
                        console.log('[Alpha Date Extension] Socket.IO подключение подтверждено');
                        wsInitialized = true;
                        // Запускаем ping для поддержания соединения
                        startWebSocketPing();
                        return;
                    }
                    
                    // "3" означает pong (ответ на ping)
                    if (rawData === '3') {
                        lastPongTime = Date.now();
                        pendingPingTime = null; // Сбрасываем ожидание pong
                        // Убираем логирование pong для снижения шума в консоли
                        return;
                    }
                    
                    // Парсим Socket.IO сообщения (формат: 42["event", data])
                    // parseSocketIOMessage уже фильтрует только каналы counters_profile_*
                    const parsed = parseSocketIOMessage(rawData);
                    if (parsed && parsed.data) {
                        // Логируем только важные события (viewed, viewed_photos, liked, message, mail, read_mail, REACTION_LIMITS), не все подряд
                        const action = parsed.data.action;
                        if (action === 'viewed' || action === 'viewed_photos' || action === 'liked' || action === 'message' || action === 'mail' || action === 'read_mail' || action === 'REACTION_LIMITS') {
                            console.log('[Alpha Date Extension] Обработка события:', parsed.channel, action, parsed.data);
                        }
                        handleWebSocketEvent(parsed.data);
                    }
                    // Игнорируем все остальные сообщения (user_online, woman_info_channel_0 и т.д.)
                } catch (e) {
                    // Обрабатываем ошибку "Extension context invalidated" (возникает при перезагрузке расширения)
                    if (e && e.message && e.message.includes('Extension context invalidated')) {
                        console.warn('[Alpha Date Extension] Контекст расширения недействителен (вероятно, расширение было перезагружено). Пропускаем обработку сообщения.');
                        return;
                    }
                    console.debug('[Alpha Date Extension] Ошибка обработки WebSocket сообщения:', e);
                }
            };

            wsConnection.onerror = (error) => {
                console.error('[Alpha Date Extension] WebSocket ошибка:', {
                    type: error.type,
                    target: error.target ? error.target.url : 'unknown',
                    message: error.message || 'No message',
                    error: error
                });

                // Сбрасываем флаг WebSocket активности при ошибке
                chrome.storage.local.set({ websocketActive: false }).catch(error => {
                    console.error('[Alpha Date Extension] Ошибка сброса флага WebSocket:', error);
                });

                wsConnecting = false; // Сбрасываем флаг при ошибке
            };

            wsConnection.onclose = (event) => {
                console.log('[Alpha Date Extension] WebSocket закрыт', {
                    code: event.code,
                    reason: event.reason,
                    wasClean: event.wasClean
                });

                // Сбрасываем флаг WebSocket активности
                chrome.storage.local.set({ websocketActive: false }).catch(error => {
                    console.error('[Alpha Date Extension] Ошибка сброса флага WebSocket:', error);
                });

                stopWebSocketPing();
                wsConnection = null;
                wsInitialized = false;
                wsConnecting = false; // Сбрасываем флаг при закрытии

                // Пытаемся переподключиться, если мониторинг включён
                // Проверяем, что контекст расширения еще валиден
                try {
                // Проверяем наличие chrome API и его компонентов
                if (typeof chrome === 'undefined' ||
                    !chrome.runtime ||
                    !chrome.runtime.id ||
                    !chrome.storage ||
                    !chrome.storage.local) {
                    console.log('[Alpha Date Extension] Контекст расширения невалиден (chrome API недоступен), переподключение невозможно');
                        return;
                    }

                // Проверяем, что мы можем выполнить операции с chrome.storage
                    chrome.storage.local.get(['monitorState']).then((data) => {
                        // Проверяем контекст еще раз после асинхронной операции
                        try {
                        if (typeof chrome === 'undefined' ||
                            !chrome.runtime ||
                            !chrome.runtime.id ||
                            !chrome.storage ||
                            !chrome.storage.local) {
                            console.log('[Alpha Date Extension] Контекст расширения стал невалидным во время асинхронной операции, пропускаем переподключение');
                                return;
                            }

                            const monitorState = data.monitorState || {};
                            if (monitorState.enabled !== false && wsReconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                                // Отменяем предыдущий таймер переподключения, если он есть
                                if (wsReconnectTimer) {
                                    clearTimeout(wsReconnectTimer);
                                    wsReconnectTimer = null;
                                }
                                
                                wsReconnectAttempts++;
                                // Экспоненциальная задержка: 2s, затем максимум 3s - быстрое переподключение
                                const delay = Math.min(WS_RECONNECT_DELAY_BASE * Math.pow(2, wsReconnectAttempts - 1), WS_RECONNECT_MAX_DELAY);
                                console.log(`[Alpha Date Extension] Переподключение через ${delay}ms (${delay/1000}с, попытка ${wsReconnectAttempts})`);
                                wsReconnectTimer = setTimeout(() => {
                                // Финальная проверка контекста перед переподключением
                                    try {
                                    if (typeof chrome !== 'undefined' &&
                                        chrome.runtime &&
                                        chrome.runtime.id &&
                                        chrome.storage &&
                                        chrome.storage.local) {
                                            connectWebSocket();
                                    } else {
                                        console.log('[Alpha Date Extension] Контекст расширения стал невалидным перед переподключением');
                                        }
                                    } catch (e) {
                                    if (e.message && e.message.includes('Extension context invalidated')) {
                                        console.warn('[Alpha Date Extension] Контекст расширения недействителен при переподключении, пропускаем');
                                    } else {
                                        console.debug('[Alpha Date Extension] Ошибка при переподключении:', e);
                                    }
                                    }
                                }, delay);
                            } else {
                            // Обновляем статус мониторинга только если контекст валиден
                            if (typeof chrome !== 'undefined' &&
                                chrome.runtime &&
                                chrome.runtime.id &&
                                chrome.storage &&
                                chrome.storage.local) {
                                    chrome.storage.local.set({
                                        monitorState: {
                                            ...monitorState,
                                            running: false,
                                        },
                                    });
                                }
                            }
                        } catch (e) {
                        if (e.message && e.message.includes('Extension context invalidated')) {
                            console.warn('[Alpha Date Extension] Контекст расширения недействителен в обработчике переподключения');
                        } else {
                            console.debug('[Alpha Date Extension] Ошибка в обработчике переподключения:', e);
                        }
                        }
                    }).catch((err) => {
                    if (err.message && err.message.includes('Extension context invalidated')) {
                        console.warn('[Alpha Date Extension] Контекст расширения недействителен при получении состояния мониторинга');
                    } else {
                        console.debug('[Alpha Date Extension] Ошибка при получении состояния мониторинга для переподключения:', err);
                    }
                    });
                } catch (e) {
                if (e.message && e.message.includes('Extension context invalidated')) {
                    console.warn('[Alpha Date Extension] Контекст расширения недействителен при проверке контекста');
                } else {
                    console.debug('[Alpha Date Extension] Ошибка при проверке контекста расширения:', e);
                }
                }
            };
        } catch (e) {
            console.error('[Alpha Date Extension] Ошибка создания WebSocket:', e);
            wsConnection = null;
            wsConnecting = false; // Сбрасываем флаг при ошибке создания
        }
    }

    // Запуск ping для поддержания соединения
    function startWebSocketPing() {
        stopWebSocketPing();
        lastPongTime = Date.now(); // Инициализируем время последнего pong
        pendingPingTime = null;
        
        // Проверяем, что pong приходит регулярно
        wsPongCheckTimer = setInterval(() => {
            if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !wsInitialized) {
                stopWebSocketPing();
                return;
            }
            
            const now = Date.now();
            // Если был отправлен ping, но pong не пришел в течение таймаута
            if (pendingPingTime && (now - pendingPingTime) > WS_PONG_TIMEOUT) {
                console.warn('[Alpha Date Extension] Pong не получен в течение таймаута, переподключаемся...');
                stopWebSocketPing();
                // Закрываем соединение и переподключаемся
                if (wsConnection) {
                    wsConnection.close();
                }
                return;
            }
            
            // Если последний pong был слишком давно (больше чем интервал ping + таймаут)
            if (lastPongTime && (now - lastPongTime) > (WS_PING_INTERVAL + WS_PONG_TIMEOUT)) {
                console.warn('[Alpha Date Extension] Слишком долго нет pong, переподключаемся...');
                stopWebSocketPing();
                if (wsConnection) {
                    wsConnection.close();
                }
                return;
            }
        }, 10000); // Проверяем каждые 10 секунд
        
        // Отправляем ping регулярно
        wsPingTimer = setInterval(() => {
            if (wsConnection && wsConnection.readyState === WebSocket.OPEN && wsInitialized) {
                try {
                    wsConnection.send('2'); // Engine.IO ping
                    pendingPingTime = Date.now(); // Запоминаем время отправки ping
                    // Убираем логирование ping для снижения шума в консоли
                } catch (e) {
                    console.error('[Alpha Date Extension] Ошибка отправки ping:', e);
                    pendingPingTime = null;
                }
            }
        }, WS_PING_INTERVAL);
    }

    // Остановка ping
    function stopWebSocketPing() {
        if (wsPingTimer) {
            clearInterval(wsPingTimer);
            wsPingTimer = null;
        }
        if (wsPongCheckTimer) {
            clearInterval(wsPongCheckTimer);
            wsPongCheckTimer = null;
        }
        lastPongTime = null;
        pendingPingTime = null;
    }

    // Отключение WebSocket
    function disconnectWebSocket() {
        stopWebSocketPing();
        if (wsReconnectTimer) {
            clearTimeout(wsReconnectTimer);
            wsReconnectTimer = null;
        }
        if (wsConnection) {
            try {
                wsConnection.close();
            } catch (e) {
                console.debug('[Alpha Date Extension] Ошибка при закрытии соединения:', e);
            }
            wsConnection = null;
        }
        wsInitialized = false;
        wsConnecting = false; // Сбрасываем флаг подключения
        wsReconnectAttempts = 0; // Сбрасываем счетчик попыток
    }

    // Основная функция рассылки для одной анкеты (по external_id)
    // kind: 'chat' | 'letter' (по умолчанию 'chat')
    async function runBroadcastForProfile(payload) {
        const { externalId, profileName, message, kind } = payload || {};
        const channel = kind || 'chat';
        const token = getToken();

        if (!token) {
            throw new Error('JWT токен не найден');
        }
        if (!externalId) {
            throw new Error('external_id профиля не указан');
        }
        if (!message) {
            throw new Error('Текст сообщения пустой');
        }

        console.log('[Alpha Date Extension] Рассылка старт', channel, externalId, profileName);

        // Для писем нужен limits = 2, для чатов остаётся 1
        const limitsPerPage = channel === 'letter' ? 2 : 1;
        const chatUids = await collectAllChatUids(token, externalId, 20, limitsPerPage);
        console.log('[Alpha Date Extension] Найдено chat_uid:', chatUids.length);

        if (!chatUids.length) {
            const emptyStats = {
                profileExternalId: externalId,
                profileName: profileName || '',
                chatsFound: 0,
                targets: 0,
                sent: 0,
                failed: 0,
                lastRun: new Date().toISOString(),
                message
            };
            chrome.storage.local.set({ lastBroadcastStats: emptyStats });
            return emptyStats;
        }

        const lastMessages = await fetchLastMessagesForUids(token, chatUids);
        console.log('[Alpha Date Extension] lastMessage записей:', lastMessages.length);

        const targets = buildBroadcastTargets(lastMessages, externalId);
        console.log('[Alpha Date Extension] Целей для рассылки:', targets.length);

        let sent = 0;
        let failed = 0;

        if (channel === 'letter') {
            // Для писем отправляем ОДНО письмо с массивом recipients (все мужчины)
            const recipients = Array.from(
                new Set(
                    targets
                        .map((t) => t.man_external_id)
                        .filter((id) => id !== undefined && id !== null)
                )
            );

            if (!recipients.length) {
                console.log('[Alpha Date Extension] Для писем не найдено получателей (recipients пустой).');
            } else {
                try {
                    await sendLetterToMailbox(token, externalId, recipients, message);
                    sent = recipients.length;
                } catch (error) {
                    console.error('[Alpha Date Extension] Ошибка при рассылке писем:', error);
                    failed = recipients.length;
                }
            }
        } else {
            // Для чатов отправляем все сообщения параллельно через Promise.all
            console.log('[Alpha Date Extension] Запуск параллельной рассылки чатов:', targets.length, 'сообщений');

            const messagePromises = targets.map(async (t, index) => {
                try {
                    const result = await sendMessageToChat(token, t.woman_external_id, t.man_external_id, message);
                    if (result && result.success) {
                        console.log(`[Alpha Date Extension] Сообщение ${index + 1}/${targets.length} отправлено успешно`);
                        return { success: true, target: t };
                    } else {
                        console.log(`[Alpha Date Extension] Сообщение ${index + 1}/${targets.length} не отправлено:`, result?.error);
                        return { success: false, target: t, error: result?.error };
                    }
                } catch (error) {
                    console.error(`[Alpha Date Extension] Ошибка отправки сообщения ${index + 1}/${targets.length}:`, error);
                    return { success: false, target: t, error: error.message };
                }
            });

            // Ждем завершения всех отправок
            const results = await Promise.all(messagePromises);

            // Подсчитываем результаты
            let successfulChats = 0;
            for (const result of results) {
                if (result.success) {
                    sent += 1;
                    successfulChats += 1;
                    // Увеличиваем счетчик успешных отправок чатов
                    await incrementStats({ successfulChatMessages: 1 });
                } else {
                    failed += 1;
                }
            }

            console.log('[Alpha Date Extension] Параллельная рассылка завершена:', {
                total: targets.length,
                sent,
                failed,
                successRate: `${((sent / targets.length) * 100).toFixed(1)}%`
            });
        }

        const stats = {
            profileExternalId: externalId,
            profileName: profileName || '',
            kind: channel,
            chatsFound: chatUids.length,
            targets: targets.length,
            sent,
            failed,
            lastRun: new Date().toISOString(),
            message
        };

        chrome.storage.local.set({ lastBroadcastStats: stats });
        console.log('[Alpha Date Extension] Рассылка завершена', stats);

        return stats;
    }

    // --- Очередь рассылки по всем анкетам (с сохранением состояния) ---

    let broadcastQueue = [];
    let broadcastIndex = 0;
    let broadcastRunning = false;

    async function saveBroadcastState(status, extra = {}) {
        try {
            const state = {
                status,
                index: broadcastIndex,
                total: broadcastQueue.length,
                queue: broadcastQueue,
                updatedAt: new Date().toISOString(),
                ...extra,
            };
            await chrome.storage.local.set({ broadcastState: state });
        } catch (e) {
            console.error('[Alpha Date Extension] Не удалось сохранить состояние рассылки:', e);
        }
    }

    async function processBroadcastQueue() {
        if (broadcastRunning) {
            return;
        }
        if (!broadcastQueue || !broadcastQueue.length) {
            return;
        }

        broadcastRunning = true;
        try {
            while (broadcastIndex < broadcastQueue.length) {
                const item = broadcastQueue[broadcastIndex];
                await saveBroadcastState('running', {
                    currentProfileExternalId: item.externalId,
                    currentProfileName: item.profileName || '',
                });

                try {
                    await runBroadcastForProfile(item);
                } catch (err) {
                    console.error('[Alpha Date Extension] Ошибка при рассылке для анкеты', item.externalId, err);
                }

                broadcastIndex += 1;

                const status = broadcastIndex < broadcastQueue.length ? 'running' : 'finished';
                await saveBroadcastState(status, {
                    lastProfileExternalId: item.externalId,
                    lastProfileName: item.profileName || '',
                });
            }
            
            // После завершения всех рассылок очищаем состояние через небольшую задержку
            setTimeout(() => {
                saveBroadcastState(null);
            }, 2000);
        } finally {
            broadcastRunning = false;
        }
    }

    async function startBroadcastQueue(queue) {
        if (!queue || !queue.length) {
            throw new Error('Очередь рассылки пуста');
        }
        broadcastQueue = queue;
        broadcastIndex = 0;
        await saveBroadcastState('running', {
            startedAt: new Date().toISOString(),
        });
        
        // Возвращаем Promise, который резолвится после завершения рассылки
        return new Promise((resolve, reject) => {
            processBroadcastQueue()
                .then(async () => {
                    // Рассылка завершена, сохраняем финальное состояние
                    await saveBroadcastState('finished', {
                        completedAt: new Date().toISOString(),
                    });

                    // Отправляем уведомление о завершении рассылки
                    try {
                        const data = await chrome.storage.local.get(['lastBroadcastStats']);
                        const stats = data.lastBroadcastStats;
                        if (stats) {
                            await sendBrowserNotification(
                                'Рассылка завершена',
                                `Отправлено: ${stats.sent}/${stats.targets}${stats.failed > 0 ? `, ошибок: ${stats.failed}` : ''}`,
                                'showBroadcastComplete',
                                {
                                    successCount: stats.sent,
                                    errorCount: stats.failed,
                                    totalCount: stats.targets
                                }
                            );
                        }
                    } catch (notifError) {
                        console.warn('[Alpha Date Extension] Ошибка отправки уведомления о завершении рассылки:', notifError);
                    }

                        resolve();
                })
                .catch((e) => {
                    console.error('[Alpha Date Extension] Ошибка при обработке очереди рассылки:', e);
                    // Даже при ошибке сохраняем состояние
                    saveBroadcastState('finished', {
                        completedAt: new Date().toISOString(),
                        error: e.message || String(e),
                    }).then(() => {
                        reject(e);
                    }).catch(reject);
                });
        });
    }

    async function resumeBroadcastQueueIfNeeded() {
        try {
            const data = await chrome.storage.local.get(['broadcastState']);
            const state = data.broadcastState;
            if (!state || state.status !== 'running') {
                return;
            }
            if (!Array.isArray(state.queue) || !state.queue.length) {
                return;
            }

            broadcastQueue = state.queue;
            broadcastIndex = state.index || 0;
            console.log('[Alpha Date Extension] Обнаружена незавершенная рассылка, продолжаем с индекса', broadcastIndex);
            processBroadcastQueue().catch((e) => {
                console.error('[Alpha Date Extension] Ошибка при возобновлении очереди рассылки:', e);
            });
        } catch (e) {
            console.error('[Alpha Date Extension] Ошибка при проверке состояния рассылки:', e);
        }
    }

    // Обработка изменения видимости страницы
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
            console.log('[Alpha Date Extension] Страница стала активной, проверка WebSocket...');

            // Проверяем соединение WebSocket при возвращении на страницу
            if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
                console.log('[Alpha Date Extension] Переподключение WebSocket...');
                try {
                    // Проверяем контекст перед переподключением
                    if (typeof chrome === 'undefined' ||
                        !chrome.runtime ||
                        !chrome.runtime.id ||
                        !chrome.storage ||
                        !chrome.storage.local) {
                        console.log('[Alpha Date Extension] Контекст расширения невалиден, переподключение невозможно');
                        return;
                    }
                    await connectWebSocket();
                } catch (error) {
                    if (error.message && error.message.includes('Extension context invalidated')) {
                        console.warn('[Alpha Date Extension] Контекст расширения недействителен при переподключении, пропускаем');
                    } else {
                        console.error('[Alpha Date Extension] Ошибка переподключения WebSocket:', error);
                    }
                }
            }
        }
    });

    // Обработка потери/восстановления соединения
    window.addEventListener('online', () => {
        console.log('[Alpha Date Extension] Интернет соединение восстановлено');
        if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
            connectWebSocket();
        }
    });

    window.addEventListener('offline', () => {
        console.log('[Alpha Date Extension] Интернет соединение потеряно');
    });

    // Основная функция инициализации
    async function init() {
        console.log('[Alpha Date Extension] Инициализация...');
        
        // Получаем токен
        const token = getToken();
        console.log('[Alpha Date Extension] Токен:', token ? `${token.substring(0, 20)}...` : 'не найден');
        
        // Сохраняем токен в storage для popup
        if (token) {
            chrome.storage.local.set({ token: token });
        }

        // Выполняем запрос к API
        if (token) {
            const result = await fetchProfiles(token);
            console.log('[Alpha Date Extension] Результат запроса profiles:', result);
            
            // Сохраняем результат в storage для popup
            chrome.storage.local.set({ 
                profilesResponse: result,
                lastUpdate: new Date().toISOString()
            });

            // Если получили анкеты, делаем запрос к senderList
            if (result.data && !result.error) {
                // Извлекаем external_id из анкет
                let profiles = null;
                if (Array.isArray(result.data)) {
                    profiles = result.data;
                } else if (result.data.response && Array.isArray(result.data.response)) {
                    profiles = result.data.response;
                } else if (result.data.profiles && Array.isArray(result.data.profiles)) {
                    profiles = result.data.profiles;
                } else if (result.data.data && Array.isArray(result.data.data)) {
                    profiles = result.data.data;
                } else if (result.data.items && Array.isArray(result.data.items)) {
                    profiles = result.data.items;
                }

                if (profiles && profiles.length > 0) {
                    // Собираем все external_id
                    const externalIds = profiles
                        .map(p => p.external_id || p.externalId)
                        .filter(id => id !== undefined && id !== null);

                    if (externalIds.length > 0) {
                        console.log('[Alpha Date Extension] Запрашиваем senderList для', externalIds.length, 'анкет');
                        const senderListResult = await fetchSenderList(token, externalIds);
                        console.log('[Alpha Date Extension] Результат запроса senderList:', senderListResult);
                        
                        // Сохраняем результат senderList
                        chrome.storage.local.set({ 
                            senderListResponse: senderListResult
                        });
                    }
                }
            }
        } else {
            chrome.storage.local.set({ 
                profilesResponse: { error: 'Токен не найден' },
                lastUpdate: new Date().toISOString()
            });
        }

        // Проверяем, нет ли незавершённой рассылки, и продолжаем её при необходимости
        await resumeBroadcastQueueIfNeeded();

        // Запускаем мониторинг входящих сообщений через WebSocket
        connectWebSocket();

        // Инициализируем большую плавающую панель с нашим интерфейсом
        try {
            initBigOverlayFab();
        } catch (e) {
            console.error('[Alpha Date Extension] Ошибка инициализации большой панели:', e);
        }

        // Инициализируем подсветку видео в попапе (если открыт)
        try {
            initVideoStatusHighlight();
        } catch (e) {
            console.error('[Alpha Date Extension] Ошибка инициализации подсветки видео:', e);
        }

        // Запускаем автообновление страницы при бездействии (если включено)
        try {
            const data = await chrome.storage.local.get(['notificationSettings']);
            const settings = data.notificationSettings || {};
            if (settings.autoRefreshEnabled !== false) {
                initAutoRefresh();
            } else {
                console.log('[Alpha Date Extension] Автообновление отключено в настройках');
                // Скрываем таймер если он был показан
                if (countdownElement) {
                    countdownElement.style.display = 'none';
                }
            }
        } catch (e) {
            console.error('[Alpha Date Extension] Ошибка инициализации автообновления:', e);
        }
    }

    // Функция для пометки видео в попапе (вызывается только вручную через кнопку)
    async function markVideosInPopup() {
        try {
            // Всегда обновляем данные перед пометкой
            await buildCurrentChatVideoInfo(true);
            
            // Пытаемся пометить видео несколько раз (попап может открываться асинхронно)
            let attempts = 0;
            const maxAttempts = 10;
            const attemptInterval = 200;
            
            const tryAnnotate = () => {
                const items = document.querySelectorAll('.upload_popup_tabs_content_item_bottom');
                if (items && items.length > 0) {
                    annotateVideoPopupWithStatuses();
                    return true;
                }
                return false;
            };
            
            // Пробуем сразу
            if (!tryAnnotate()) {
                // Если не получилось, пробуем через интервалы
                const intervalId = setInterval(() => {
                    attempts++;
                    if (tryAnnotate() || attempts >= maxAttempts) {
                        clearInterval(intervalId);
                    }
                }, attemptInterval);
            }
        } catch (e) {
            console.error('[Alpha Date Extension] Ошибка при обработке видео-попапа:', e);
        }
    }

    async function markPhotosInPopup() {
        try {
            // Всегда обновляем данные перед пометкой
            await buildCurrentChatPhotoInfo(true);

            // Пытаемся пометить фото несколько раз (попап может открываться асинхронно)
            let attempts = 0;
            const maxAttempts = 10;
            const attemptInterval = 200;

            const tryAnnotate = () => {
                const items = document.querySelectorAll('.upload_popup_tabs_content_item_bottom');
                if (items && items.length > 0) {
                    annotatePhotoPopupWithStatuses();
                    return true;
                }
                return false;
            };

            // Пробуем сразу
            if (!tryAnnotate()) {
                // Если не получилось, пробуем через интервалы
                const intervalId = setInterval(() => {
                    attempts++;
                    if (tryAnnotate() || attempts >= maxAttempts) {
                        clearInterval(intervalId);
                    }
                }, attemptInterval);
            }
        } catch (e) {
            console.error('[Alpha Date Extension] Ошибка при обработке фото-попапа:', e);
        }
    }
    
    function initVideoStatusHighlight() {
        // Инициализация больше не нужна - статусы обновляются только по кнопке
        // Функция оставлена для совместимости, но ничего не делает
    }

    // Принимаем команды из popup для запуска рассылки
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (!message || !message.type) {
                return;
            }

            if (message.type === 'startBroadcast') {
                runBroadcastForProfile(message.payload)
                    .then(stats => sendResponse({ ok: true, stats }))
                    .catch(error => {
                        console.error('[Alpha Date Extension] Ошибка рассылки:', error);
                        sendResponse({ ok: false, error: error.message || String(error) });
                    });

                return true; // оставляем порт открытым для async ответа
            }

            if (message.type === 'startBroadcastAll') {
                // Проверяем блокировку операции перед запуском рассылки
                chrome.runtime.sendMessage({ type: 'checkOperationLock', payload: { operationType: 'broadcast' } })
                    .then(lockCheck => {
                        if (lockCheck.locked) {
                            console.log('[Alpha Date Extension] Рассылка заблокирована - выполняется в другой вкладке');
                            sendResponse({ ok: false, error: 'Рассылка уже выполняется в другой вкладке' });
                            return;
                        }

                        const queue = (message.payload && message.payload.queue) || [];
                        startBroadcastQueue(queue)
                            .then(() => {
                                // Снимаем блокировку после успешного завершения
                                chrome.runtime.sendMessage({
                                    type: 'clearOperationLock',
                                    payload: { operationType: 'broadcast' }
                                });
                                sendResponse({ ok: true });
                            })
                            .catch(error => {
                                console.error('[Alpha Date Extension] Ошибка запуска глобальной рассылки:', error);
                                // Снимаем блокировку при ошибке
                                chrome.runtime.sendMessage({
                                    type: 'clearOperationLock',
                                    payload: { operationType: 'broadcast' }
                                });
                                sendResponse({ ok: false, error: error.message || String(error) });
                            });
                    })
                    .catch(error => {
                        console.error('[Alpha Date Extension] Ошибка проверки блокировки:', error);
                        sendResponse({ ok: false, error: 'Ошибка проверки блокировки' });
                    });

                return true;
            }

            if (message.type === 'monitorStateChanged') {
                // Переподключаем WebSocket при изменении состояния мониторинга
                disconnectWebSocket();
                setTimeout(() => {
                    connectWebSocket();
                }, 500);
                sendResponse({ ok: true });
                return true;
            }
            
            // Синхронизация авто-ответов с сервером
            if (message.type === 'syncAutoReplies') {
                const direction = message.direction || 'download'; // 'download' или 'upload'
                if (direction === 'download') {
                    syncAutoRepliesFromServer(true)
                        .then(result => sendResponse({ ok: true, synced: result }))
                        .catch(error => sendResponse({ ok: false, error: error.message }));
                } else {
                    syncAutoRepliesToServer()
                        .then(result => sendResponse({ ok: true, synced: result }))
                        .catch(error => sendResponse({ ok: false, error: error.message }));
                }
                return true;
            }

            if (message.type === 'checkManMirror') {
                checkManMirror()
                    .then(result => {
                        sendResponse({ ok: true, result });
                    })
                    .catch(error => {
                        console.error('[Alpha Date Extension] Ошибка проверки зеркала:', error);
                        sendResponse({ ok: false, error: error.message || String(error) });
                    });
                return true; // оставляем порт открытым для async ответа
            }

            if (message.type === 'getImagesList') {
                const token = getToken();
                if (!token) {
                    sendResponse({ ok: false, error: 'Токен не найден' });
                    return true;
                }

                const { externalId } = message;
                if (!externalId) {
                    sendResponse({ ok: false, error: 'Не указан external_id' });
                    return true;
                }

                // Загружаем список фото
                fetch(`${API_BASE}/api/files/images?external_id=${encodeURIComponent(String(externalId))}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/plain, */*'
                    },
                    credentials: 'include'
                })
                    .then(response => {
                        if (!response.ok) {
                            throw new Error(`HTTP ${response.status}`);
                        }
                        return response.json();
                    })
                    .then(data => {
                        console.log('[Alpha Date Extension] Ответ API images:', data);
                        
                        // Обрабатываем ответ - может быть массив или объект с response
                        let images = [];
                        if (Array.isArray(data)) {
                            images = data;
                        } else if (data.response && Array.isArray(data.response)) {
                            images = data.response;
                        } else if (data.data && Array.isArray(data.data)) {
                            images = data.data;
                        } else if (data.images && Array.isArray(data.images)) {
                            images = data.images;
                        } else if (data.files && Array.isArray(data.files)) {
                            images = data.files;
                        }
                        
                        console.log('[Alpha Date Extension] Извлечено изображений:', images.length);
                        sendResponse({ ok: true, images });
                    })
                    .catch(error => {
                        console.error('[Alpha Date Extension] Ошибка загрузки списка фото:', error);
                        sendResponse({ ok: false, error: error.message || String(error) });
                    });
                return true;
            }

            if (message.type === 'getVideoInfo') {
                buildCurrentChatVideoInfo(true) // Всегда обновляем данные по кнопке
                    .then(info => {
                        if (!info) {
                            sendResponse({ ok: false, error: 'Не удалось получить информацию о видео. Убедитесь, что вы на странице чата.' });
                            return;
                        }
                        
                        // Обновляем статусы на странице (только по кнопке, не автоматически)
                        markVideosInPopup();
                        
                        // Преобразуем Map в объект для сериализации
                        const sentLinksObj = {};
                        if (info.sentLinks && info.sentLinks instanceof Map) {
                            info.sentLinks.forEach((value, key) => {
                                sentLinksObj[key] = value;
                            });
                        }
                        sendResponse({ 
                            ok: true, 
                            info: {
                                chatUid: info.chatUid,
                                womanExternalId: info.womanExternalId,
                                manExternalId: info.manExternalId,
                                videos: info.videos || [],
                                sentLinks: sentLinksObj,
                                sentLinksCount: info.sentLinks ? info.sentLinks.size : 0,
                                lastUpdated: info.lastUpdated
                            }
                        });
                    })
                    .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
                return true;
            }

            if (message.type === 'getPhotoInfo') {
                buildCurrentChatPhotoInfo(true) // Всегда обновляем данные по кнопке
                    .then(info => {
                        if (!info) {
                            sendResponse({ ok: false, error: 'Не удалось получить информацию о фото. Убедитесь, что вы на странице чата.' });
                            return;
                        }

                        // Обновляем статусы на странице (только по кнопке, не автоматически)
                        markPhotosInPopup();

                        // Преобразуем Map в объект для сериализации
                        const sentLinksObj = {};
                        if (info.sentLinks && info.sentLinks instanceof Map) {
                            info.sentLinks.forEach((value, key) => {
                                sentLinksObj[key] = value;
                            });
                        }
                        sendResponse({
                            ok: true,
                            info: {
                                chatUid: info.chatUid,
                                womanExternalId: info.womanExternalId,
                                manExternalId: info.manExternalId,
                                photos: info.photos || [],
                                sentLinks: sentLinksObj,
                                sentLinksCount: info.sentLinks ? info.sentLinks.size : 0,
                                lastUpdated: info.lastUpdated
                            }
                        });
                    })
                    .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
                return true;
            }

            if (message.type === 'getToken') {
                // Возвращаем токен, userId и API_BASE для использования в popup
                const token = getToken();
                const userId = getUserId();
                sendResponse({
                    token: token,
                    userId: userId,
                    apiBase: API_BASE
                });
                return true;
            }
            
            if (message.type === 'getOperatorEmail') {
                // Возвращаем email оператора для синхронизации авто-ответов
                const email = getOperatorEmail();
                sendResponse({
                    email: email
                });
                return true;
            }

            if (message.type === 'startScheduledBroadcast') {
                // Автоматический запуск рассылки по расписанию
                const { kind, interval } = message.payload || {};
                const broadcastType = kind || 'chat';
                
                console.log('[Alpha Date Extension] Запуск автоматической рассылки, тип:', broadcastType);
                
                // Если выбран режим "both", запускаем сначала чаты, потом письма
                if (broadcastType === 'both') {
                    console.log('[Alpha Date Extension] Режим "both": сначала чаты, потом письма');
                    
                    // Создаем асинхронную функцию для последовательного запуска
                    (async () => {
                        try {
                            // Сначала запускаем рассылку по чатам
                            const chatResult = await startScheduledBroadcastForType('chat', interval);
                            console.log('[Alpha Date Extension] Рассылка по чатам завершена:', chatResult);
                            
                            // Небольшая пауза между рассылками
                            await sleep(2000);
                            
                            // Затем запускаем рассылку по письмам
                            const letterResult = await startScheduledBroadcastForType('letter', interval);
                            console.log('[Alpha Date Extension] Рассылка по письмам завершена:', letterResult);
                            
                            sendResponse({ ok: true, message: 'Обе рассылки завершены', chatResult, letterResult });
                        } catch (error) {
                            console.error('[Alpha Date Extension] Ошибка последовательной рассылки:', error);
                            sendResponse({ ok: false, error: error.message || String(error) });
                        }
                    })();
                    
                    return true; // оставляем порт открытым для async ответа
                }
                
                // Для одного типа рассылки используем общую функцию
                startScheduledBroadcastForType(broadcastType, interval)
                    .then(result => sendResponse({ ok: true, ...result }))
                    .catch(error => {
                        console.error('[Alpha Date Extension] Ошибка автоматической рассылки:', error);
                        sendResponse({ ok: false, error: error.message || String(error) });
                    });
                
                return true; // оставляем порт открытым для async ответа
            }

            // ===== НОВЫЕ ОБРАБОТЧИКИ СООБЩЕНИЙ =====

            // Обработчик для загрузки истории чата и поиска
            if (message.type === 'loadChatHistory') {
                (async () => {
                    try {
                        const { chatUid } = message;

                        if (!chatUid) {
                            sendResponse({ ok: false, error: 'Не указан chat_uid' });
                            return;
                        }

                        const result = await searchInChat(chatUid, (progress) => {
                            // Отправляем прогресс в popup.js
                            chrome.runtime.sendMessage({
                                type: 'chatSearchProgress',
                                progress: progress
                            });
                        });

                        sendResponse({ ok: true, result });

                    } catch (error) {
                        console.error('[Alpha Date Extension] Ошибка загрузки истории чата:', error);
                        sendResponse({ ok: false, error: error.message || String(error) });
                    }
                })();

                return true; // async response
            }

            // Обработчик для извлечения chat_uid из текущего URL
            if (message.type === 'extractChatUid') {
                const currentUrl = window.location.href;
                const chatUid = extractChatUidFromUrl(currentUrl);

                sendResponse({
                    ok: true,
                    chatUid: chatUid,
                    url: currentUrl
                });

                return true;
            }

            // Обработчик изменения настройки автообновления
            if (message.type === 'autoRefreshSettingChanged') {
                const enabled = message.enabled;
                console.log('[Alpha Date Extension] Изменение настройки автообновления:', enabled);

                if (enabled) {
                    // Включаем автообновление
                    resetInactivityTimer();
                } else {
                    // Отключаем автообновление
                    if (inactivityTimer) {
                        clearTimeout(inactivityTimer);
                    }
                    if (countdownInterval) {
                        clearTimeout(countdownInterval);
                    }
                    // Скрываем таймер
                    if (countdownElement) {
                        countdownElement.style.display = 'none';
                    }
                    console.log('[Alpha Date Extension] Автообновление отключено');
                }

                sendResponse({ ok: true });
                return true;
            }
        });
    }

    // Вспомогательная функция для запуска рассылки по типу
    async function startScheduledBroadcastForType(broadcastType, interval) {
        try {
            // Получаем список анкет и их тексты из storage
            const data = await chrome.storage.local.get(['profilesResponse', 'profileBroadcastMessages', 'senderListResponse']);
            
            const profilesResponse = data.profilesResponse || {};
            const profileBroadcastMessages = data.profileBroadcastMessages || {};
            const senderListResponse = data.senderListResponse || {};
            
            // Извлекаем анкеты
            let profiles = null;
            const responseData = profilesResponse.data || {};
            
            if (Array.isArray(responseData)) {
                profiles = responseData;
            } else if (Array.isArray(responseData.response)) {
                profiles = responseData.response;
            } else if (Array.isArray(responseData.profiles)) {
                profiles = responseData.profiles;
            } else if (Array.isArray(responseData.data)) {
                profiles = responseData.data;
            } else if (Array.isArray(responseData.items)) {
                profiles = responseData.items;
            }
            
            if (!profiles || profiles.length === 0) {
                console.warn('[Alpha Date Extension] Нет анкет для автоматической рассылки');
                throw new Error('Нет анкет для рассылки');
            }
            
            // Извлекаем дефолтные тексты из senderList
            const profileDefaultChatTexts = {};
            const profileDefaultLetterTexts = {};
            
            const senderListData = senderListResponse.data || {};
            let senderList = [];
            if (Array.isArray(senderListData)) {
                senderList = senderListData;
            } else if (Array.isArray(senderListData.response)) {
                senderList = senderListData.response;
            } else if (Array.isArray(senderListData.data)) {
                senderList = senderListData.data;
            }
            
            // Группируем сообщения по woman_external_id
            const messagesByProfile = {};
            senderList.forEach(message => {
                const profileId = message.woman_external_id;
                if (profileId) {
                    if (!messagesByProfile[profileId]) {
                        messagesByProfile[profileId] = [];
                    }
                    messagesByProfile[profileId].push(message);
                }
            });
            
            // Сохраняем дефолтные тексты
            profiles.forEach(profile => {
                const externalId = profile.external_id || profile.externalId;
                if (externalId) {
                    const profileMessages = messagesByProfile[externalId] || [];
                    const chatMessages = profileMessages.filter(m => m.sender_type === 'Chat');
                    const letterMessages = profileMessages.filter(m => m.sender_type === 'Letter');
                    
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
                }
            });
            
            // Формируем очередь рассылки
            const queue = [];
            profiles.forEach(profile => {
                const externalId = profile.external_id || profile.externalId;
                const profileName = profile.name || profile.first_name || profile.full_name || externalId || 'профиль';
                
                if (!externalId) return;
                
                const profileCfg = profileBroadcastMessages[externalId] || {};
                let text = '';
                
                if (broadcastType === 'chat') {
                    text = profileCfg.chat || profileDefaultChatTexts[externalId] || '';
                } else {
                    text = profileCfg.letter || profileDefaultLetterTexts[externalId] || '';
                }
                
                if (!text) {
                    return; // пропускаем анкету без текста
                }
                
                if (broadcastType === 'letter' && text.length < 300) {
                    return; // пропускаем письма меньше 300 символов
                }
                
                queue.push({
                    externalId,
                    profileName,
                    message: text,
                    kind: broadcastType
                });
            });
            
            if (queue.length === 0) {
                console.warn('[Alpha Date Extension] Нет анкет с текстом для автоматической рассылки');
                throw new Error('Нет анкет с текстом для рассылки');
            }
            
            console.log('[Alpha Date Extension] Запуск автоматической рассылки по', queue.length, 'анкетам, тип:', broadcastType);
            
            // Запускаем рассылку
            await startBroadcastQueue(queue);
            
            return { queueLength: queue.length, type: broadcastType };
        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка автоматической рассылки:', error);
            throw error;
        }
    }

    // Слушаем изменения в storage для автоматического переподключения WebSocket
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === 'local' && changes.monitorState) {
                const newState = changes.monitorState.newValue;
                const oldState = changes.monitorState.oldValue;
                // Если изменилось состояние enabled, переподключаемся
                if (newState && oldState && newState.enabled !== oldState.enabled) {
                    console.log('[Alpha Date Extension] Состояние мониторинга изменилось, переподключаем WebSocket...');
                    disconnectWebSocket();
                    setTimeout(() => {
                        connectWebSocket();
                    }, 500);
                }
            }
        });
    }

    // Запускаем при загрузке страницы
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Также слушаем изменения в localStorage (на случай, если токен обновится)
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
        originalSetItem.apply(this, arguments);
        if (key === 'token' && window.location.hostname === 'alpha.date') {
            console.log('[Alpha Date Extension] Токен обновлён, обновляем данные...');
            setTimeout(init, 1000);
        }
    };

    // ===== АВТООБНОВЛЕНИЕ СТРАНИЦЫ =====

    let inactivityTimer;
    let countdownInterval;
    let countdownElement;
    const INACTIVITY_TIMEOUT = 2 * 60 * 1000; // 2 минуты

    // Функция создания видимого таймера
    function createCountdownTimer() {
        if (countdownElement) return;

        countdownElement = document.createElement('div');
        countdownElement.id = 'alpha-date-inactivity-timer';
        countdownElement.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            background: rgba(255, 165, 0, 0.9);
            color: white;
            padding: 10px 15px;
            border-radius: 8px;
            font-family: Arial, sans-serif;
            font-size: 14px;
            font-weight: bold;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            border: 2px solid rgba(255, 255, 255, 0.3);
            display: none;
        `;

        countdownElement.innerHTML = '⏰ Автообновление через: <span id="countdown-text">2:00</span>';
        document.body.appendChild(countdownElement);
    }

    // Функция обновления таймера
    function updateCountdownDisplay(secondsLeft) {
        if (!countdownElement) return;

        const minutes = Math.floor(secondsLeft / 60);
        const seconds = secondsLeft % 60;
        const timeText = `${minutes}:${seconds.toString().padStart(2, '0')}`;

        const countdownText = countdownElement.querySelector('#countdown-text');
        if (countdownText) {
            countdownText.textContent = timeText;
        }

        // Меняем цвет в последние 30 секунд
        if (secondsLeft <= 30) {
            countdownElement.style.background = 'rgba(255, 59, 48, 0.9)';
            countdownElement.style.borderColor = 'rgba(255, 255, 255, 0.5)';
        } else if (secondsLeft <= 60) {
            countdownElement.style.background = 'rgba(255, 204, 0, 0.9)';
        }
    }

    // Функция сброса таймера бездействия
    function resetInactivityTimer() {
        // Очищаем существующий таймер
        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
        }
        if (countdownInterval) {
            clearInterval(countdownInterval);
        }

        // Запускаем новый таймер на обновление
        inactivityTimer = setTimeout(() => {
            console.log('[Alpha Date Extension] Бездействие 2 минуты - обновляем страницу');
            location.reload();
        }, INACTIVITY_TIMEOUT);

        // Запускаем отображение таймера
        startFullCountdown();

        console.log('[Alpha Date Extension] Таймер бездействия сброшен');
    }

    // Функция запуска полного отсчёта (показывает таймер весь период бездействия)
    function startFullCountdown() {
        if (!countdownElement) createCountdownTimer();

        countdownElement.style.display = 'block';
        const startTime = Date.now();
        const endTime = startTime + INACTIVITY_TIMEOUT;

        // Функция обновления таймера
        const updateTimer = () => {
            const now = Date.now();
            const timeLeft = Math.max(0, Math.ceil((endTime - now) / 1000));

            updateCountdownDisplay(timeLeft);

            // Меняем цвет за 30 секунд до конца
            if (timeLeft <= 30 && countdownElement.style.background !== 'rgba(255, 59, 48, 0.9)') {
                countdownElement.style.background = 'rgba(255, 59, 48, 0.9)';
                countdownElement.style.borderColor = 'rgba(255, 255, 255, 0.5)';
            } else if (timeLeft <= 60 && countdownElement.style.background !== 'rgba(255, 204, 0, 0.9)') {
                countdownElement.style.background = 'rgba(255, 204, 0, 0.9)';
            }

            if (timeLeft > 0) {
                // Запускаем следующее обновление
                countdownInterval = setTimeout(updateTimer, 100);
            } else {
                clearTimeout(countdownInterval);
                // Обновление страницы произойдет через setTimeout в resetInactivityTimer
            }
        };

        // Запускаем первое обновление
        updateTimer();
    }

    // Запуск системы автообновления
    function initAutoRefresh() {
        console.log('[Alpha Date Extension] Запуск автообновления страницы при бездействии');

        // ПРОВЕРКА ПОДПИСКИ - автообновление требует активной подписки
        chrome.runtime.sendMessage({ type: 'getSubscriptionStatus' }, (response) => {
            if (!response || !response.hasActiveSubscription) {
                console.log('[Alpha Date Extension] Автообновление заблокировано: подписка истекла');
                // Скрываем таймер если он был показан
                if (countdownElement) {
                    countdownElement.style.display = 'none';
                }
                return;
            }

            // Подписка активна, продолжаем инициализацию
            console.log('[Alpha Date Extension] Автообновление разрешено: подписка активна');
        });

        // Создаём элемент таймера
        createCountdownTimer();

        // Запускаем отслеживание движения мыши
        document.addEventListener('mousemove', resetInactivityTimer, { passive: true });
        document.addEventListener('mousedown', resetInactivityTimer, { passive: true });

        // Также отслеживаем другие активности
        document.addEventListener('keydown', resetInactivityTimer, { passive: true });
        document.addEventListener('scroll', resetInactivityTimer, { passive: true });
        document.addEventListener('touchstart', resetInactivityTimer, { passive: true });

        // Visibility API - сброс при возвращении на страницу
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                resetInactivityTimer();
            }
        });

        // Запускаем начальный таймер с отображением
        resetInactivityTimer();
        startFullCountdown();
    }

    // ===== ФУНКЦИИ ПОИСКА ПО ЧАТУ =====

    // Функция для извлечения chat_uid из URL
    function extractChatUidFromUrl(url) {
        try {
            // URL типа: https://alpha.date/chat/pn33tzxq-gw8i3o2l-8dyn0emn-reznv7vk
            // или https://alpha.date/chance/sf9h3n4g-ygmfm4zz-xtxb9y4q-h6sbzfpe
            const match = url.match(/\/(chat|chance)\/([a-z0-9\-]+)/i);
            if (match && match[2]) {
                return match[2];
            }
            return null;
        } catch (e) {
            console.error('[Alpha Date Extension] Ошибка извлечения chat_uid из URL:', e);
            return null;
        }
    }

    // Функция для загрузки одной страницы истории чата
    async function loadChatHistoryPage(chatUid, page) {
        const token = getToken();
        if (!token) {
            throw new Error('Не удалось получить токен авторизации');
        }

        console.log(`[Alpha Date Extension] Отправка запроса: chat_id=${chatUid}, page=${page}`);

        const response = await fetch(`${API_BASE}/api/chatList/chatHistory`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify({
                chat_id: chatUid,
                page: page
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log(`[Alpha Date Extension] Ответ API для page ${page}:`, data);

        // API возвращает {status: true, response: [messages]}
        // Извлекаем массив сообщений из поля response
        if (data.response && Array.isArray(data.response)) {
            console.log(`[Alpha Date Extension] Извлечено ${data.response.length} сообщений из data.response`);
            return data.response;
        }

        // Fallback для других форматов ответа
        if (Array.isArray(data)) {
            console.log(`[Alpha Date Extension] Извлечено ${data.length} сообщений из data (массив)`);
            return data;
        }

        console.warn('[Alpha Date Extension] Неожиданный формат ответа API:', data);
        return [];
    }

    // Функция для загрузки всей истории чата постранично
    async function loadFullChatHistory(chatUid, onProgress = null) {
        const allMessages = [];
        let page = 1;
        const maxPages = 500; // Максимум 500 страниц, чтобы не зациклиться

        while (page <= maxPages) {
            try {
                console.log(`[Alpha Date Extension] Загрузка страницы ${page} истории чата ${chatUid}`);

                const messages = await loadChatHistoryPage(chatUid, page);
                console.log(`[Alpha Date Extension] Страница ${page}: получено ${messages.length} сообщений`);

                // Если нет сообщений или не массив - завершаем
                if (!Array.isArray(messages) || messages.length === 0) {
                    console.log(`[Alpha Date Extension] Страница ${page}: пустой ответ, завершаем`);
                    break;
                }

                allMessages.push(...messages);
                console.log(`[Alpha Date Extension] Всего сообщений: ${allMessages.length}`);

                // Вызываем callback прогресса
                if (onProgress) {
                    onProgress({
                        page: page,
                        totalMessages: allMessages.length,
                        hasMore: true
                    });
                }

                // Если сообщений меньше 3, это последняя страница
                if (messages.length < 3) {
                    console.log(`[Alpha Date Extension] Страница ${page}: ${messages.length} < 3, это последняя страница`);
                    break;
                }

                page++;

                // Небольшая пауза чтобы не перегружать API
                await new Promise(resolve => setTimeout(resolve, 200));

            } catch (error) {
                console.error(`[Alpha Date Extension] Ошибка загрузки страницы ${page}:`, error);
                break;
            }
        }

        console.log(`[Alpha Date Extension] Загрузка завершена: ${allMessages.length} сообщений из ${page} страниц`);
        return allMessages;
    }

    // Функция для объединения сообщений в текстовый формат
    function formatChatMessagesToText(messages) {
        // Сортируем сообщения по дате создания
        const sortedMessages = messages.sort((a, b) =>
            new Date(a.date_created || a.created_at) - new Date(b.date_created || b.created_at)
        );

        let chatText = '';
        let messageCount = 0;

        for (const msg of sortedMessages) {
            const sender = msg.is_male === 1 ? 'Мужчина' : 'Женщина';
            const senderId = msg.sender_external_id;
            const date = new Date(msg.date_created || msg.created_at).toLocaleString('ru-RU');
            const content = msg.message_content || '[Вложение]';

            chatText += `[${date}] ${sender} (ID: ${senderId}):\n${content}\n\n`;

            messageCount++;

            // Для отладки: выводим прогресс каждые 100 сообщений
            if (messageCount % 100 === 0) {
                console.log(`[Alpha Date Extension] Обработано ${messageCount} сообщений`);
            }
        }

        return {
            text: chatText,
            totalMessages: messageCount,
            chatUid: messages[0]?.chat_uid || 'unknown'
        };
    }

    // Функция для выполнения поиска по чату
    async function searchInChat(chatUid, onProgress = null) {
        try {
            console.log(`[Alpha Date Extension] Начинаем загрузку истории чата: ${chatUid}`);

            const messages = await loadFullChatHistory(chatUid, (progress) => {
                if (onProgress) {
                    onProgress({
                        stage: 'loading',
                        ...progress
                    });
                }
            });

            console.log(`[Alpha Date Extension] Загружено ${messages.length} сообщений`);

            if (onProgress) {
                onProgress({
                    stage: 'formatting',
                    totalMessages: messages.length
                });
            }

            const result = formatChatMessagesToText(messages);

            if (onProgress) {
                onProgress({
                    stage: 'complete',
                    totalMessages: result.totalMessages
                });
            }

            return result;

        } catch (error) {
            console.error('[Alpha Date Extension] Ошибка поиска по чату:', error);
            throw error;
        }
    }


})();

