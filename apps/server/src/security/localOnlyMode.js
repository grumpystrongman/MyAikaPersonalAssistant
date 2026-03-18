function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function isLocalOnlyMode() {
  return (
    isTruthy(process.env.LOCAL_ONLY_MODE) ||
    isTruthy(process.env.RAG_LOCAL_ONLY_MODE) ||
    isTruthy(process.env.FIREFLIES_LOCAL_ONLY_MODE) ||
    isTruthy(process.env.FIREFLIES_RAG_LOCAL_ONLY)
  );
}

export function isFirefliesPullAllowed() {
  return (
    isTruthy(process.env.ALLOW_FIREFLIES_PULL) ||
    isTruthy(process.env.LOCAL_ONLY_ALLOW_FIREFLIES_PULL) ||
    isTruthy(process.env.FIREFLIES_PULL_ALLOWED)
  );
}

export function isMicrosoftTodoSyncAllowed() {
  return (
    isTruthy(process.env.ALLOW_MICROSOFT_TODO_SYNC) ||
    isTruthy(process.env.LOCAL_ONLY_ALLOW_MICROSOFT_TODO_SYNC) ||
    isTruthy(process.env.FIREFLIES_ALLOW_MICROSOFT_TODO_SYNC)
  );
}

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0"
]);

const FIREFLIES_HOSTS = new Set([
  "api.fireflies.ai"
]);

const MICROSOFT_TODO_HOSTS = new Set([
  "graph.microsoft.com",
  "login.microsoftonline.com",
  "graph.microsoft.us",
  "login.microsoftonline.us"
]);

export function isLocalHostname(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return false;
  if (LOCAL_HOSTS.has(host)) return true;
  return host.endsWith(".localhost");
}

export function shouldBlockExternalUrl(rawUrl) {
  const text = String(rawUrl || "").trim();
  if (!text) return false;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    // Relative URL (not outbound).
    return false;
  }
  const protocol = String(parsed.protocol || "").toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return false;
  if (isLocalHostname(parsed.hostname)) return false;
  if (isLocalOnlyMode()) {
    const hostname = String(parsed.hostname || "").toLowerCase();
    if (isFirefliesPullAllowed() && FIREFLIES_HOSTS.has(hostname)) {
      return false;
    }
    if (isMicrosoftTodoSyncAllowed() && MICROSOFT_TODO_HOSTS.has(hostname)) {
      return false;
    }
  }
  return true;
}

export function makeLocalOnlyError(target = "") {
  const hint = target ? `: ${target}` : "";
  const err = new Error(`local_only_mode_network_blocked${hint}`);
  err.code = "local_only_mode_network_blocked";
  return err;
}
