// =================================================================
// CANARY — ловушка на случай реверс-инжиниринга приложения
// =================================================================
// Идея: приманка (фейковый ключ в коде приложения) и приманка-эндпоинт
// не дают НИКАКОЙ реальной пользы тому, кто их найдёт — но сам факт
// попытки их использовать это стопроцентный, без ложных срабатываний
// сигнал, что кто-то целенаправленно ковыряется в приложении/бэкенде
// (реверсит APK, перебирает пути после того как нашёл домен).
//
// Легитимный трафик приложения НИКОГДА не задевает ни одну из ловушек —
// значит, любое срабатывание достойно немедленного внимания.
// =================================================================

const CANARY_TOKEN = process.env.CANARY_TOKEN || '';
const TELEGRAM_BOT_TOKEN = process.env.ALERT_TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.ALERT_TELEGRAM_CHAT_ID || '';

if (!CANARY_TOKEN) {
  console.warn('⚠️  CANARY_TOKEN не задан — ловушка неактивна (приманка-ключ в приложении будет ничему не соответствовать).');
}
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn('⚠️  Telegram-оповещение не настроено — срабатывания ловушки будут видны только в логах Railway.');
}

async function sendTelegramAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
  } catch (e) {
    console.error('🚨 Не удалось отправить оповещение в Telegram:', e.message);
  }
}

// Бесплатная геолокация по IP, без ключа (ip-api.com, лимит 45 запросов
// в минуту — с нашим трафиком ловушки такого объёма никогда не будет).
// Только для контекста при срабатывании — не для слежки за обычным
// трафиком приложения, эта функция вызывается ИСКЛЮЧИТЕЛЬНО из
// triggerCanaryAlert.
async function lookupIp(ip) {
  try {
    const res = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,country,city,isp,proxy,hosting`
    );
    const data = await res.json();
    if (data.status !== 'success') return 'геолокация недоступна';
    const flags = [data.proxy && 'VPN/прокси', data.hosting && 'дата-центр'].filter(Boolean);
    return `${data.country || '?'}, ${data.city || '?'} · ${data.isp || '?'}` +
      (flags.length ? ` · ⚠️ ${flags.join(', ')}` : '');
  } catch {
    return 'геолокация недоступна';
  }
}

async function triggerCanaryAlert(req, reason) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'неизвестен';
  const geo = ip !== 'неизвестен' ? await lookupIp(ip) : '—';
  const msg =
    `🚨 CANARY СРАБОТАЛ 🚨\n` +
    `Причина: ${reason}\n` +
    `Путь: ${req.method} ${req.originalUrl}\n` +
    `IP: ${ip}\n` +
    `Гео: ${geo}\n` +
    `User-Agent: ${req.headers['user-agent'] || '—'}\n` +
    `Время: ${new Date().toISOString()}`;

  console.error(msg);
  sendTelegramAlert(msg);
}

// Проверка приманки-ключа — вешать ПЕРВЫМ middleware, до auth,
// чтобы сработать даже если остальной запрос кривой/неполный.
function canaryHeaderCheck(req, res, next) {
  if (CANARY_TOKEN) {
    const suspect = req.header('X-Debug-Bypass');
    if (suspect && suspect === CANARY_TOKEN) {
      triggerCanaryAlert(req, 'Использован приманка-ключ из приложения (X-Debug-Bypass)');
      // Отвечаем максимально скучно — не подтверждаем, что это ловушка.
      return res.status(404).json({ error: 'not_found' });
    }
  }
  next();
}

// Приманка-эндпоинт — регистрировать ДО обычных роутов.
// Отвечает скучным 404, но каждый хит — уже само по себе тревога:
// ни один легитимный экран приложения сюда никогда не ходит.
function registerCanaryRoute(app) {
  app.all('/api/admin/config', (req, res) => {
    triggerCanaryAlert(req, 'Обращение к приманке-эндпоинту /api/admin/config');
    res.status(404).json({ error: 'not_found' });
  });
}

module.exports = { canaryHeaderCheck, registerCanaryRoute, triggerCanaryAlert };
