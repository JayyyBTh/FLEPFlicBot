import { KEYWORDS } from "./keywords";

const ALWAYS_MODERATE_USER_IDS = new Set<number>([
  1230480769 // RemoveJoinGrpMsgBot
]);


export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  LOG_CHANNEL_ID: string;
  USER_COUNTER: DurableObjectNamespace;
}

type TgUpdate = any;

export class UserCounter {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname !== "/inc") {
      return new Response("Not found", { status: 404 });
    }

    const current = (await this.state.storage.get<number>("count")) ?? 0;
    const next = current + 1;
    await this.state.storage.put("count", next);

    return Response.json({ count: next });
  }
}

// Common Cyrillic/Greek confusables spammers use to fake Latin words.
// Keep this small + targeted; expand if you see new bypasses.
const CONFUSABLES: Record<string, string> = {
  // Cyrillic (lower)
  "а": "a", // U+0430
  "е": "e", // U+0435
  "о": "o", // U+043E
  "р": "p", // U+0440
  "с": "c", // U+0441
  "х": "x", // U+0445
  "у": "y", // U+0443
  "к": "k", // U+043A
  "м": "m", // U+043C
  "т": "t", // U+0442
  "н": "h", // U+043D (looks like h)
  "і": "i", // U+0456
  "ї": "i", // U+0457 (close enough for spam)
  "ј": "j", // U+0458

  // Cyrillic (upper)
  "А": "a",
  "Е": "e",
  "О": "o",
  "Р": "p",
  "С": "c",
  "Х": "x",
  "У": "y",
  "К": "k",
  "М": "m",
  "Т": "t",
  "Н": "h",
  "І": "i",
  "Ї": "i",
  "Ј": "j",

  // Greek (some common lookalikes)
  "Α": "a",
  "Β": "b",
  "Ε": "e",
  "Ζ": "z",
  "Η": "h",
  "Ι": "i",
  "Κ": "k",
  "Μ": "m",
  "Ν": "n",
  "Ο": "o",
  "Ρ": "p",
  "Τ": "t",
  "Υ": "y",
  "Χ": "x",
  "α": "a",
  "β": "b",
  "ε": "e",
  "ι": "i",
  "κ": "k",
  "μ": "m",
  "ν": "n",
  "ο": "o",
  "ρ": "p",
  "τ": "t",
  "υ": "y",
  "χ": "x",

  // Armenian (common spam confusables)
  "ն": "u", // U+0576 (looks like Latin u)
  "ո": "n", // U+0578 (looks like Latin n)
  "օ": "o", // U+0585 (looks like Latin o)
  "ս": "u", // U+057D (looks like Latin u)
  "հ": "h", // U+0570 (often used as h-ish)

// Latin dotless i (common bypass)
"ı": "i",
"İ": "i",


};

function foldConfusables(s: string): string {
  // Greek: \u0370-\u03FF
  // Cyrillic (+ext): \u0400-\u052F, \u1C80-\u1C8F, \u2DE0-\u2DFF, \uA640-\uA69F
  // Armenian: \u0530-\u058F
  return s.replace(
    /[\u0370-\u03FF\u0400-\u052F\u1C80-\u1C8F\u2DE0-\u2DFF\uA640-\uA69F\u0530-\u058F]/g,
    (ch) => CONFUSABLES[ch] ?? ch
  );
}

/**
 * Strong normalization:
 * - folds common Cyrillic/Greek confusables
 * - strips ALL format/invisible chars (\p{Cf}) including bidi, variation selectors, etc.
 * - strips ALL combining marks (\p{M}) so French accents won't matter (é == e)
 * - keeps Unicode-aware word-boundary matching stable
 */

function normalizeForMatch(s: string): string {
  return foldConfusables(s)
    .normalize("NFKD")
    // remove all format/invisible chars (bidi, variation selectors, etc.)
    .replace(/\p{Cf}/gu, "")
    // remove all diacritics (French accents => base letters)
    .replace(/\p{M}/gu, "")

    // preserve currencies as tokens before stripping punctuation
    .replace(/€/g, " eur ")
    .replace(/\$/g, " usd ")
    .replace(/£/g, " gbp ")
    .replace(/¥/g, " jpy ")

    // IMPORTANT: turn ANY non-letter/number into a space (covers \n, \r, tabs, punctuation, weird separators)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim();
}


function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Unicode-aware "whole word" boundary (instead of ASCII-centric \b)
function makeWholeWordRe(kw: string): RegExp {
  // Match kw as a whole “token/phrase” delimited by non-letters/non-numbers or string ends.
  // No lookbehind => works in more JS runtimes.
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])${escapeRegex(kw)}(?:$|[^\\p{L}\\p{N}_])`,
    "iu"
  );
}

function shouldDelete(text: string): { matched: boolean; keyword?: string } {
  const t = normalizeForMatch(text);

  for (const rawKw of KEYWORDS) {
    const kw = normalizeForMatch(rawKw);

    // Whole-word match on normalized text (Unicode-aware)
    if (makeWholeWordRe(kw).test(t)) return { matched: true, keyword: rawKw };

    // simple plural allowance for single words (crypto -> cryptos)
    if (!kw.includes(" ")) {
      if (makeWholeWordRe(kw + "s").test(t)) {
        return { matched: true, keyword: rawKw + " (plural)" };
      }
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

async function bumpUserSeenCount(env: Env, userId: number): Promise<number> {
  const id = env.USER_COUNTER.idFromName(String(userId));
  const stub = env.USER_COUNTER.get(id);
  const res = await stub.fetch("https://do/inc");
  const data = (await res.json()) as { count: number };
  return data.count;
}

async function sendLog(env: Env, text: string) {
  await tgCall(env, "sendMessage", {
    chat_id: env.LOG_CHANNEL_ID,
    text,
    disable_web_page_preview: true,
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

    const from = msg.from;
if (!from?.id) return new Response("OK", { status: 200 });

const seenCount = await bumpUserSeenCount(env, from.id);

// Only enforce on the first 5 messages we ever see from that user unless always moderated
const alwaysModerate = ALWAYS_MODERATE_USER_IDS.has(from.id);

if (alwaysModerate || seenCount <= 5) {
  const res = shouldDelete(text);

  if (res.matched) {
    await tgCall(env, "deleteMessage", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
    });

    const chatLabel =
      msg.chat?.title ??
      (msg.chat?.username ? `@${msg.chat.username}` : String(msg.chat?.id));

    const userLabel =
      from.username
        ? `@${from.username}`
        : `${from.first_name ?? ""} ${from.last_name ?? ""}`.trim() || String(from.id);

    const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;

    await sendLog(
      env,
      [
        `🧹 Deleted (probation ${seenCount}/5)`,
        `Chat: ${chatLabel}`,
        `User: ${userLabel} (id ${from.id})`,
        `Keyword: ${res.keyword ?? "?"}`,
        `Text: ${preview}`,
      ].join("\n")
    );
  }
}


    return new Response("OK", { status: 200 });
  },
};
