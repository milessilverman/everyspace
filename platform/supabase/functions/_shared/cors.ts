// Lets the Host Console (a web page on another domain) call these functions from the browser.
// Access is still decided by the login token each request carries, not by where it comes from.
export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
export const preflight = (req: Request) => (req.method === 'OPTIONS' ? new Response(null, { status: 204, headers: CORS }) : null);
