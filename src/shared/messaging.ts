/** Popup/options → worker commands. */
export async function send<T = any>(cmd: string, extra: Record<string, unknown> = {}): Promise<T> {
  const reply = await chrome.runtime.sendMessage({ cmd, ...extra });
  if (!reply?.ok) throw new Error(reply?.error ?? "no reply from the extension");
  return reply.result as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & Record<string, any> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "dataset") Object.assign(node.dataset, v);
    else (node as any)[k] = v;
  }
  node.append(...children);
  return node;
}

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
