// UI для авторизации - только интерфейс, без бизнес-логики

// Элементы DOM
const authForm = document.getElementById('authForm');
const accessKeyInput = document.getElementById('accessKey');
const authButton = document.getElementById('authButton');
const authMessage = document.getElementById('authMessage');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const serverInfo = document.getElementById('serverInfo');
const deviceInfo = document.getElementById('deviceInfo');

// Состояние UI
let isProcessing = false;

// Функция генерации ID устройства (совпадает с background.js)
function generateDeviceId() {
    try {
        const components = [
            chrome.runtime.id,
            navigator.userAgent,
            navigator.language || 'unknown',
            // В popup screen доступен, но для консистентности используем одинаковые компоненты
            typeof screen !== 'undefined' ? screen.width + 'x' + screen.height : 'unknown_screen',
            new Date().getTimezoneOffset().toString(),
            navigator.platform || 'unknown',
            navigator.hardwareConcurrency || 'unknown',
            'extension_v1.0.0',
            navigator.cookieEnabled ? 'cookies_enabled' : 'cookies_disabled',
            navigator.onLine ? 'online' : 'offline'
        ];

        let hash = 0;
        const combined = components.join('|');
        for (let i = 0; i < combined.length; i++) {
            const char = combined.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }

        return Math.abs(hash).toString(16).toUpperCase().substr(0, 16);
    } catch (error) {
        console.error('Ошибка генерации device ID:', error);
        return 'FALLBACK_' + Math.random().toString(36).substr(2, 8).toUpperCase();
    }
}

// Показ информации об устройстве
function showDeviceInfo() {
    const deviceId = generateDeviceId();
    const deviceName = navigator.platform + ' • ' + navigator.language;
    deviceInfo.textContent = `Устройство: ${deviceName} (ID: ${deviceId})`;
    deviceInfo.className = 'device-info success';
}

// Очистка сообщений
function clearMessage() {
    authMessage.classList.remove('show', 'error', 'success', 'info');
    authMessage.textContent = '';
}

// Показ сообщения
function showMessage(type, text) {
    clearMessage();
    authMessage.className = `message ${type}`;
    authMessage.textContent = text;
    authMessage.classList.add('show');
}

// Обновление статуса
function updateStatus(text, color = '#ff4444') {
    statusText.textContent = text;
    statusDot.style.background = color;
}

// Проверка статуса авторизации
async function checkAuthStatus() {
    try {
        const response = await chrome.runtime.sendMessage({ type: 'getAuthStatus' });

        if (response.authorized) {
            updateStatus('Авторизован', '#00ff88');
            showMessage('success', 'Система активирована. Перенаправление...');

            // Переходим к основному интерфейсу через 1.5 секунды
            setTimeout(() => {
                window.location.href = 'popup.html';
            }, 1500);
            return true;
        } else {
            updateStatus('Требуется авторизация', '#ff4444');
            return false;
        }
    } catch (error) {
        console.error('Ошибка проверки статуса:', error);
        updateStatus('Ошибка системы', '#ff6b6b');
        return false;
    }
}

// Отправка access key в background.js
async function submitAccessKey(accessKey) {
    if (isProcessing) return;

    isProcessing = true;
    updateStatus('Проверка...', '#ffff44');
    authButton.classList.add('loading');
    authButton.disabled = true;

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'verifyAccessKey',
            payload: { accessKey: accessKey.trim() }
        });

        if (response.success) {
            updateStatus('Авторизован', '#00ff88');
            showMessage('success', response.message || 'Авторизация успешна');

            // Переходим к основному интерфейсу
            setTimeout(() => {
                window.location.href = 'popup.html';
            }, 1500);
        } else {
            updateStatus('Отклонено', '#ff4444');
            showMessage('error', response.error || 'Неверный ключ доступа');
            authButton.classList.remove('loading');
            authButton.disabled = false;
        }
    } catch (error) {
        console.error('Ошибка авторизации:', error);
        updateStatus('Ошибка', '#ff6b6b');
        showMessage('error', 'Ошибка связи с системой');
        authButton.classList.remove('loading');
        authButton.disabled = false;
    }

    isProcessing = false;
}

// Обработчик формы
authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    clearMessage();

    const accessKey = accessKeyInput.value.trim();

    if (!accessKey) {
        showMessage('error', 'Введите ключ доступа');
        return;
    }

    if (accessKey.length < 10) {
        showMessage('error', 'Ключ доступа слишком короткий');
        return;
    }

    submitAccessKey(accessKey);
});

// Форматирование ввода ключа
accessKeyInput.addEventListener('input', (e) => {
    let value = e.target.value.replace(/[^a-zA-Z0-9\-]/g, '').toUpperCase();

    // Автоматическое добавление дефисов для GUID формата
    if (value.length > 8 && value.charAt(8) !== '-') {
        value = value.slice(0, 8) + '-' + value.slice(8);
    }
    if (value.length > 13 && value.charAt(13) !== '-') {
        value = value.slice(0, 13) + '-' + value.slice(13);
    }
    if (value.length > 18 && value.charAt(18) !== '-') {
        value = value.slice(0, 18) + '-' + value.slice(18);
    }
    if (value.length > 23 && value.charAt(23) !== '-') {
        value = value.slice(0, 23) + '-' + value.slice(23);
    }

    e.target.value = value.slice(0, 36); // Ограничение длины
});

// Инициализация при загрузке
document.addEventListener('DOMContentLoaded', async () => {
    updateStatus('Инициализация...', '#ffff44');

    // Показываем информацию об устройстве
    showDeviceInfo();

    // Проверяем статус авторизации
    const isAuthorized = await checkAuthStatus();

    if (!isAuthorized) {
        // Показываем форму авторизации
        updateStatus('Ожидание ввода', '#ff4444');
        serverInfo.textContent = 'Сервер контроля доступа активен';
        serverInfo.className = 'server-info success';

        // Фокус на поле ввода
        accessKeyInput.focus();
    }
});
