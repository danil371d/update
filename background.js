// Background script для открытия side panel и планировщика рассылок
chrome.action.onClicked.addListener((tab) => {
    // Открываем side panel вместо popup
    chrome.sidePanel.open({ windowId: tab.windowId });
});

// Обработчик сообщений от content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'showBrowserNotification') {
        const { title, message: notificationMessage, notificationType, options } = message.payload;

        console.log('[Alpha Date Extension] Получено сообщение для уведомления:', { title, message: notificationMessage, notificationType });

        // Показываем уведомление напрямую из background script
        showBrowserNotification(title, notificationMessage, notificationType, options)
            .then(() => {
                sendResponse({ success: true });
            })
            .catch((error) => {
                console.error('[Alpha Date Extension] Ошибка в обработчике уведомлений:', error);
                sendResponse({ success: false, error: error.message });
            });

        return true; // Асинхронный ответ
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

// Инициализация при загрузке расширения
chrome.runtime.onInstalled.addListener(async () => {
    console.log('[Alpha Date Extension] Расширение установлено/обновлено, инициализация...');
    await initializeNotificationSettings();
    await initializeScheduledBroadcast();
});

chrome.runtime.onStartup.addListener(async () => {
    console.log('[Alpha Date Extension] Расширение запущено, инициализация...');
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

