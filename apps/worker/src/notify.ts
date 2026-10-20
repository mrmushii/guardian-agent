// Optional phone alert when a trade needs the owner's signature. Off unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
// The message carries no addresses, keys or links other than the owner's own dashboard URL.
const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
const appUrl = process.env.GUARDIAN_APP_URL ?? "http://localhost:3000";

export const telegramEnabled = !!(token && chat);

export async function notifyOwner(text: string): Promise<void> {
  if (!telegramEnabled) return;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ chat_id: chat, text: `${text}\n\nOpen Guardian: ${appUrl}/#overview`, disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}`);
}
