import type { RuntimeEnv } from "./domain";

const encoder = new TextEncoder();

export function requireAdmin(request: Request, env: RuntimeEnv): Response | null {
  const token = env.ADMIN_TOKEN;
  if (!token) {
    return jsonError("ADMIN_TOKEN is not configured; write actions are disabled.", 503);
  }
  const header = request.headers.get("Authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!timingSafeEqual(candidate, token)) {
    return jsonError("Unauthorized", 401);
  }
  return null;
}

export function requireInternal(request: Request, env: RuntimeEnv): Response | null {
  const token = env.SHARED_SECRET;
  if (!token) {
    return jsonError("SHARED_SECRET is required for internal probe calls.", 503);
  }
  const candidate = request.headers.get("X-MonsterTracker-Secret") ?? "";
  if (!timingSafeEqual(candidate, token)) {
    return jsonError("Unauthorized internal call", 401);
  }
  return null;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const max = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < max; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
