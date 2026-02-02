import { KEYWORDS } from "./keywords";

export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
}

type TgUpdate = any;

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldDelete(text: string): boolean {
  const t = text.toLowerCase();

  return KEYWORDS.some((k) => {
    const kw = k.toLowerCase();
    const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
    return re.test(t);
  });
}

async function tgCall(env: Env, method: string, payload: Record<string, unknown>) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return new Response("OK", { status: 200 });

    const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!secret || secret !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    const update = (await req.json().catch(() => null)) as TgUpdate | null;
    if (!update) return new Response("Bad Request", { status: 400 });

    const msg = update.message ?? update.edited_message;
    if (!msg) return new Response("OK", { status: 200 });

    const text: string = msg.text ?? msg.caption ?? "";
    if (!text) return new Response("OK", { status: 200 });

    if (shouldDelete(text)) {
      await tgCall(env, "deleteMessage", {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
      });
    }

    return new Response("OK", { status: 200 });
  },
};

