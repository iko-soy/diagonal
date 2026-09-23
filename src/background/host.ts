import type { HostError, HostErrorCode } from "./state";

/** Section 8's wire protocol, from the extension's side. One `sendNativeMessage` per request. */
export const HOST_NAME = "io.diagonal.host";
export const HOST_MANIFEST_DIR = "~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/";
export const HOST_MANIFEST_PATH = `${HOST_MANIFEST_DIR}${HOST_NAME}.json`;

export type Op = "ping" | "name" | "organize";

export interface HostOpts {
  model: "system" | "pcc";
  timeoutMs: number;
  emoji: boolean;
  strict?: boolean; // append "reply with only the object" (BAD_MODEL_OUTPUT retry)
  debug?: boolean;
}

export interface ReplyMeta {
  ms: number;
  model: string;
  promptChars: number;
  path?: string;
}

export type HostReply<T> = { ok: true; result: T; meta?: ReplyMeta } | { ok: false; error: HostError };

export type NativeSender = (host: string, message: object) => Promise<unknown>;

export const chromeSender: NativeSender = (host, message) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(host, message, (reply) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message ?? String(err)));
      else resolve(reply);
    });
  });

/** Browser-side failures arrive as `runtime.lastError` strings, not host replies. */
export function mapLastError(message: string): HostError {
  const m = message.toLowerCase();
  let code: HostErrorCode = "HOST_CRASHED";
  if (m.includes("not found")) code = "HOST_NOT_FOUND";
  else if (m.includes("forbidden")) code = "HOST_FORBIDDEN";
  return { code, message, retryable: code === "HOST_CRASHED" };
}

const KNOWN_CODES = new Set<HostErrorCode>([
  "HOST_NOT_FOUND", "HOST_FORBIDDEN", "HOST_CRASHED", "FORBIDDEN_ORIGIN", "BAD_REQUEST", "SCHEMA_MISSING",
  "MODEL_UNAVAILABLE", "RATE_LIMITED", "OVER_BUDGET", "GUARDRAIL", "TIMEOUT", "BAD_MODEL_OUTPUT", "FM_ERROR",
]);

export async function callHost<T>(
  send: NativeSender,
  op: Op,
  payload: object,
  opts: HostOpts,
  now: () => number = Date.now,
): Promise<HostReply<T>> {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(now());
  const request = { v: 1, id, op, payload, opts };
  // The host enforces timeoutMs on `fm`; this guard only catches a host that never answers.
  const guardMs = opts.timeoutMs + 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      send(HOST_NAME, request),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("__diagonal_timeout__")), guardMs);
      }),
    ]);
    return normalizeReply<T>(reply, now());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === "__diagonal_timeout__") {
      return { ok: false, error: { code: "TIMEOUT", message: `no reply from host in ${guardMs} ms`, retryable: true, at: now() } };
    }
    return { ok: false, error: { ...mapLastError(message), at: now() } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function normalizeReply<T>(reply: unknown, at: number): HostReply<T> {
  if (!reply || typeof reply !== "object") {
    return { ok: false, error: { code: "HOST_CRASHED", message: "host closed without a reply", retryable: true, at } };
  }
  const r = reply as { ok?: boolean; result?: T; meta?: ReplyMeta; error?: Partial<HostError> };
  if (r.ok === true && r.result !== undefined) return { ok: true, result: r.result, meta: r.meta };
  const e = r.error ?? {};
  const code = KNOWN_CODES.has(e.code as HostErrorCode) ? (e.code as HostErrorCode) : "FM_ERROR";
  return {
    ok: false,
    error: {
      code,
      message: typeof e.message === "string" ? e.message : "host reported an error",
      retryable: !!e.retryable,
      raw: typeof e.raw === "string" ? e.raw.slice(0, 2000) : undefined,
      allowedItems: typeof e.allowedItems === "number" ? e.allowedItems : undefined,
      at,
    },
  };
}

/** Errors that mean "fix the setup", not "try this group again later". */
export const SETUP_ERRORS = new Set<HostErrorCode>([
  "HOST_NOT_FOUND", "HOST_FORBIDDEN", "FORBIDDEN_ORIGIN", "SCHEMA_MISSING", "MODEL_UNAVAILABLE",
]);

/** Popup copy for each error: what is wrong and what fixes it (section 12). */
export function explain(error: HostError | undefined, extensionId = ""): string {
  if (!error) return "";
  switch (error.code) {
    case "HOST_NOT_FOUND":
      return `Native host not installed. Expected manifest at ${HOST_MANIFEST_PATH}`;
    case "HOST_FORBIDDEN":
    case "FORBIDDEN_ORIGIN":
      return `The host does not allow this extension. Its manifest needs "allowed_origins": ["chrome-extension://${extensionId}/"]`;
    case "SCHEMA_MISSING":
      return "Schemas missing. Run: diagonal-host --install-schemas";
    case "MODEL_UNAVAILABLE":
      return `On-device model unavailable: ${error.message}. Check System Settings → Apple Intelligence & Siri.`;
    case "RATE_LIMITED":
      return "The model is rate-limiting requests; naming is paused briefly.";
    case "TIMEOUT":
      return `The model timed out: ${error.message}`;
    case "GUARDRAIL":
      return "The model's safety layer refused a group; it keeps its current title.";
    case "BAD_MODEL_OUTPUT":
      return "The model returned an unusable reply; it will be retried.";
    case "HOST_CRASHED":
      return `The native host exited without replying: ${error.message}`;
    default:
      return `${error.code}: ${error.message}`;
  }
}
