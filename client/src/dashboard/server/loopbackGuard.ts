import type { IncomingMessage } from 'http';

/**
 * The dashboard's HTTP API and WebSocket have no authentication and handle Deca
 * accounts, so they listen on loopback only: never on the LAN, and no Windows
 * Firewall prompt on first launch.
 */
export const DASHBOARD_BIND_HOST = '127.0.0.1';

const LOOPBACK_NAMES = ['localhost', '127.0.0.1'];

/**
 * A request is the dashboard's own when its Host names this server by a
 * loopback name and its real port (a rebinding page's Host names the page's
 * domain), and it carries no Origin or a loopback one for that port. Browsers
 * send Origin on every WebSocket and cross-site request, and a page on another
 * site would otherwise reach ws://localhost with a legitimate Host. Non-browser
 * clients send no Origin.
 */
export function isDashboardRequest(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = String(req.headers.host ?? '').trim().toLowerCase();
  if (!LOOPBACK_NAMES.some((name) => host === `${name}:${port}`)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const normalized = String(origin).trim().toLowerCase();
  return LOOPBACK_NAMES.some((name) => normalized === `http://${name}:${port}`);
}
