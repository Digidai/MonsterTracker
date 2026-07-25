export interface UrlValidationOptions {
  allowPrivateTargets?: boolean;
  allowLocalHttp?: boolean;
  allowedHostnameSuffix?: string;
}

export function normalizeTargetUrl(input: string, options: UrlValidationOptions = {}): string {
  if (input.length > 4_096) throw new Error("Target URL must be 4096 characters or fewer.");
  const url = parseUrl(input, "Target URL");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("Target URLs must not include embedded credentials.");
  }
  if (!options.allowPrivateTargets && isBlockedTargetHostname(url.hostname)) {
    throw new Error("Private, local, reserved, and IP-literal targets are blocked by default.");
  }
  url.hash = "";
  return url.toString();
}

export function normalizeWorkerUrl(input: string | null, options: UrlValidationOptions = {}): string | null {
  const trimmed = input?.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2_048) throw new Error("Worker URL must be 2048 characters or fewer.");

  const url = parseUrl(trimmed, "Worker URL");
  const localHttpAllowed =
    options.allowLocalHttp === true &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1");
  if (url.protocol !== "https:" && !localHttpAllowed) {
    throw new Error("Worker URL must use https outside local development.");
  }
  if (url.username || url.password) {
    throw new Error("Worker URL must not include embedded credentials.");
  }
  if (!options.allowPrivateTargets && isBlockedTargetHostname(url.hostname)) {
    throw new Error("Private, local, reserved, and IP-literal Worker URLs are blocked.");
  }
  const allowedSuffix = options.allowedHostnameSuffix?.trim().toLowerCase();
  if (allowedSuffix && !localHttpAllowed && !url.hostname.toLowerCase().endsWith(allowedSuffix)) {
    throw new Error(`Worker URL hostname must end with ${allowedSuffix}.`);
  }
  url.hash = "";
  return url.toString();
}

export function isBlockedTargetHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa")
  ) {
    return true;
  }
  if (isIpv4Literal(normalized)) {
    return true;
  }
  return normalized.includes(":");
}

function parseUrl(input: string, label: string): URL {
  try {
    return new URL(input);
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`);
  }
}

function isIpv4Literal(hostname: string): boolean {
  const parts = hostname.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}
