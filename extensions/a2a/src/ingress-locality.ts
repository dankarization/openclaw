/**
 * Inbound locality for the A2A route.
 *
 * A2A shares the Gateway's HTTP listener, so a Gateway bound to a LAN address also
 * publishes `/a2a/v1` to that network. Peer bearer tokens stay the message
 * authentication boundary; these helpers only answer whether a request reached the
 * listener directly from the local host, so an operator can additionally pin ingress
 * to the local host without changing the Gateway bind.
 */

/**
 * Headers a reverse proxy adds while forwarding a request. A proxy in front of the
 * listener connects from loopback, so the socket address alone cannot separate a
 * direct local peer from a proxied one; the presence of any of these headers is the
 * only in-request evidence that another hop exists. A direct local client does not
 * send them, and a request that carries one is never treated as local.
 */
const FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
] as const;
export function isLoopbackRemoteAddress(address: string | undefined | null): boolean {
  const normalized = address?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  // IPv4-mapped IPv6 loopback arrives as ::ffff:127.0.0.1.
  const mapped = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  if (mapped === "::1" || mapped === "0:0:0:0:0:0:0:1") {
    return true;
  }
  return /^127(?:\.\d{1,3}){3}$/.test(mapped);
}

/**
 * True when the request carries evidence of an intermediate hop. An empty value is
 * ignored so a proxy that sends an empty placeholder does not by itself count, while
 * any non-empty forwarding header fails the locality check closed.
 */
export function hasForwardingHeaders(headers: Record<string, unknown> | undefined | null): boolean {
  if (!headers) {
    return false;
  }
  for (const [name, value] of Object.entries(headers)) {
    const key = name.trim().toLowerCase();
    if (!(FORWARDING_HEADERS as readonly string[]).includes(key)) {
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.some((entry) => typeof entry === "string" && entry.trim() !== "")) {
      return true;
    }
  }
  return false;
}

/**
 * Decide whether a request must be refused under `localIngressOnly`. Returns the
 * operator-facing reason to reject, or `undefined` to continue handling. The check
 * runs before the body is read, the peer token is resolved or any task work happens,
 * and it never trusts a forwarded header to *grant* access: a forwarding header is
 * only ever a reason to refuse.
 */
export function describeA2aIngressDenial(input: {
  remoteAddress?: string | null;
  headers?: Record<string, unknown> | undefined | null;
}): string | undefined {
  if (!isLoopbackRemoteAddress(input.remoteAddress)) {
    return "A2A ingress is restricted to loopback";
  }
  if (hasForwardingHeaders(input.headers)) {
    return "A2A ingress is restricted to direct local traffic";
  }
  return undefined;
}
