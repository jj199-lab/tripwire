export {};
// Points Telegram at the hosted bot (or back to local polling). Never prints the token.
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.WEBHOOK_SECRET;
const arg = process.argv[2];

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}
if (!token) die("Missing TELEGRAM_BOT_TOKEN in .env");

async function call(method: string, body: Record<string, unknown> = {}): Promise<{ ok: boolean; description?: string; result?: unknown }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; description?: string; result?: unknown };
}

if (arg === "--clear") {
  const r = await call("deleteWebhook", { drop_pending_updates: true });
  console.log(r.ok ? "Webhook removed. You can run the bot locally again with: npm run bot" : `Failed: ${r.description}`);
} else if (arg === "--info") {
  const r = await call("getWebhookInfo");
  const info = (r.result ?? {}) as { url?: string; pending_update_count?: number; last_error_message?: string; last_error_date?: number };
  console.log("Webhook URL:", info.url || "(none set)");
  console.log("Pending updates:", info.pending_update_count ?? 0);
  console.log("Last error:", info.last_error_message ?? "none");
} else {
  if (!arg || !/^https:\/\//.test(arg)) die("Usage: npm run set-webhook -- https://your-worker.your-name.workers.dev");
  if (!secret || !/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
    die("WEBHOOK_SECRET in .env must be 16 to 256 letters, digits, _ or -. See the deploy steps for how to generate one.");
  }
  const url = new URL("/webhook", arg).toString();
  const r = await call("setWebhook", { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true });
  console.log(r.ok ? `Webhook set to ${url}` : `Failed: ${r.description}`);
}
