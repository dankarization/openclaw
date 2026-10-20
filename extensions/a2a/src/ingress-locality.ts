/**
 * Inbound locality for the A2A route.
 *
 * A2A shares the Gateway's HTTP listener, so a Gateway bound to a LAN address also
 * publishes `/a2a/v1` to that network. Peer bearer tokens stay the message
 * authentication boundary; this helper only answers whether the socket peer is
 * loopback, so an operator can additionally pin ingress to the local host without
 * changing the Gateway bind.
 */
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
