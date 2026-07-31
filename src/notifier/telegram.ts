/**
 * Telegram notifier — one message per decision outcome.
 *
 * SAFETY PROPERTIES
 * - Never throws into the control loop: every network failure (throw or non-2xx)
 *   is caught, logged via logger.warn, and the promise resolves.
 * - Never logs the bot token: warn payloads are redacted before logging.
 * - Unconfigured (capabilities.telegram false) → no-op impl that logger.debug's
 *   the would-send text (demo-visible) and never touches fetch.
 * - HTML parse mode (avoids MarkdownV2 escaping traps); user-influenced strings
 *   (rationale, detail) are HTML-escaped.
 */

import type { AppConfig } from "../config.js";
import type { Chain, DecisionNotification, Notifier } from "../types.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Structurally compatible with pino's log methods; tests inject a recorder. */
export type NotifierLogFn = (obj: unknown, msg?: string, ...rest: unknown[]) => void;

export interface NotifierLogger {
  info: NotifierLogFn;
  warn: NotifierLogFn;
  debug: NotifierLogFn;
}

/** Escape the characters Telegram's HTML parse mode cares about. Ampersand first. */
export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const BASESCAN_HOSTS: Record<Chain, string> = {
  base: "https://basescan.org",
  "base-sepolia": "https://sepolia.basescan.org",
};

export function basescanTxUrl(chain: Chain, txHash: string): string {
  return `${BASESCAN_HOSTS[chain]}/tx/${txHash}`;
}

function fmtHf(hf: number | undefined): string {
  if (hf === undefined || Number.isNaN(hf)) return "?";
  if (!Number.isFinite(hf)) return "∞";
  return hf.toFixed(2);
}

function fmtUsd(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return "$?";
  return `$${usd.toFixed(2)}`;
}

/**
 * Render the outgoing message text; `kind` drives the layout.
 * Note: DecisionNotification carries no asset symbol, so defense lines show only
 * the action + USD amount (see contract note in the module report).
 */
export function renderMessage(n: DecisionNotification): string {
  const header = `🪂 RIPCORD [${n.band}]`;
  switch (n.kind) {
    case "band-change":
      return `${header} HF ${fmtHf(n.hf)} — entering ${n.band} band`;
    case "defense": {
      const lines: string[] = [
        `${header} ${n.action ?? "defense"} ${fmtUsd(n.amountUsd)}`,
        `HF ${fmtHf(n.hf)} → expected ${fmtHf(n.expectedHfAfter)}`,
      ];
      if (n.rationale !== undefined) {
        lines.push(`"${escapeHtml(n.rationale)}"`);
      }
      if (n.txHash !== undefined) {
        lines.push(`tx: ${basescanTxUrl(n.chain, n.txHash)}`);
      }
      lines.push(
        n.runId !== undefined
          ? `decision ${n.decisionId} · run ${n.runId}`
          : `decision ${n.decisionId}`,
      );
      if (n.dryRun) {
        lines.push("⚠️ DRY_RUN — no transaction sent");
      }
      return lines.join("\n");
    }
    case "blocked":
      return `${header} BLOCKED — ${escapeHtml(n.detail ?? "no detail")}\ndecision ${n.decisionId}`;
    case "error":
      return `${header} ERROR — ${escapeHtml(n.detail ?? "no detail")}\ndecision ${n.decisionId}`;
    default: {
      // Exhaustiveness guard — unreachable while the union stays in sync.
      const unreachable: never = n.kind;
      return `${header} ${String(unreachable)}\ndecision ${n.decisionId}`;
    }
  }
}

export function createNotifier(
  cfg: AppConfig,
  logger: NotifierLogger,
  fetchImpl: typeof fetch = fetch,
): Notifier {
  const token = cfg.telegramBotToken;
  const chatId = cfg.telegramChatId;

  if (!cfg.capabilities.telegram || token === undefined || chatId === undefined) {
    return {
      async notify(n: DecisionNotification): Promise<void> {
        logger.debug(
          { kind: n.kind, decisionId: n.decisionId, text: renderMessage(n) },
          "telegram not configured — would send",
        );
      },
    };
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  /** The bot token must never reach a log line, even inside upstream error text. */
  const redact = (s: string): string => s.split(token).join("[redacted]");

  return {
    async notify(n: DecisionNotification): Promise<void> {
      const text = renderMessage(n);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          logger.warn(
            {
              kind: n.kind,
              decisionId: n.decisionId,
              status: res.status,
              body: redact(body).slice(0, 500),
            },
            "telegram sendMessage failed (non-2xx); continuing",
          );
          return;
        }
        logger.debug(
          { kind: n.kind, decisionId: n.decisionId },
          "telegram notification sent",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { kind: n.kind, decisionId: n.decisionId, error: redact(message) },
          "telegram sendMessage threw; continuing",
        );
      }
    },
  };
}
