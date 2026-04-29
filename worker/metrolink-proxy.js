// Cloudflare Worker — Metrolink GTFS-RT CORS Proxy
// Compatible with the Cloudflare dashboard drag-and-drop uploader.
// Deploy at: https://workers.cloudflare.com/
//
// API key setup (never hard-code the key):
//   wrangler secret put METROLINK_API_KEY
// Cloudflare binds it as the global `METROLINK_API_KEY` at runtime.

var UPSTREAM  = 'https://metrolink-gtfsrt.gbsdigital.us/extended/vehicles';
// eslint-disable-next-line no-undef
var API_KEY   = (typeof METROLINK_API_KEY !== 'undefined') ? METROLINK_API_KEY : '';
var ALLOWED   = [
    'https://metrolivemap.net',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
];

addEventListener('fetch', function(event) {
    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    var origin = request.headers.get('Origin') || '';
    var allowed = ALLOWED.some(function(o) { return origin.startsWith(o); });
    var corsOrigin = allowed ? origin : 'https://metrolivemap.net';

    var headers = {
        'Access-Control-Allow-Origin':  corsOrigin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age':       '86400',
    };

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: headers });
    }

    try {
        var upstream = await fetch(UPSTREAM + '?t=' + Date.now(), {
            headers: { 'X-Api-Key': API_KEY }
        });
        var body = await upstream.text();
        headers['Content-Type'] = upstream.headers.get('Content-Type') || 'application/json';
        return new Response(body, { status: upstream.status, headers: headers });
    } catch (err) {
        headers['Content-Type'] = 'application/json';
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: headers });
    }
}
