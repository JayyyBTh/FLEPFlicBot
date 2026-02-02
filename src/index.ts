import { KEYWORDS } from "./keywords";

export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
}

type TgUpdate = any;

function normalizeForMatch(s: string): string {
  return s
    // Normalize compatibility forms (full-width, weird forms, etc.)
    .normalize("NFKC")
    // Remove common invisible / bidi / formatting chars spammers use
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
    // Remove control characters (except newline/tab if you want)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    // Normalize accents away (é -> e). Optional but recommended for French.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Lowercase
    .toLowerCase()
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldDelete(text: string): { matched: boolean; keyword?: string } {
  const t = normalizeForMatch(text);

  for (const rawKw of KEYWORDS) {
    const kw = normalizeForMatch(rawKw);

    // whole-word match on normalized text
    const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
    if (re.test(t)) return { matched: true, keyword: rawKw };

    // simple plural allowance for single words (crypto -> cryptos)
    if (!kw.includes(" ")) {
      const rePlural = new RegExp(`\\b${escapeRegex(kw)}s\\b`, "i");
      if (rePlural.test(t)) return { matched: true, keyword: rawKw + " (plural)" };
    }
  }

  return { matched: false };
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

    const res = shouldDelete(text);
    if (res.matched) {
        await tgCall(env, "deleteMessage", {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
      });
    }

    return new Response("OK", { status: 200 });
  },
};

