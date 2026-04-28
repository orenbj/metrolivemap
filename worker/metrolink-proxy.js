// Cloudflare Worker — Metrolink GTFS-RT CORS Proxy
// Deploy to: https://workers.cloudflare.com/
// After deploying, set METROLINK_PROXY_URL in metrolink.js to your worker URL.

const UPSTREAM = 'https://metrolink-gtfsrt.gbsdigital.us/extended/vehicles';
const API_KEY  = 'Umyp2Txlov26s3ccrk72x8dmPkGzp0Wj7tjjOEpu';

// Allowed origins — add metrolivemap.net and localhost for dev
const ALLOWED_ORIGINS = [
    'https://metrolivemap.net',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
];

export default {
    async fetch(request) {
        const origin = request.headers.get('Origin') || '';
        const isAllowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));

        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(origin, isAllowed),
            });
        }

        try {
            const upstream = await fetch(`${UPSTREAM}?t=${Date.now()}`, {
                headers: { 'X-Api-Key': API_KEY },
            });

            const body = await upstream.text();

            return new Response(body, {
                status: upstream.status,
                headers: {
                    'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
                    ...corsHeaders(origin, isAllowed),
                },
            });
        } catch (err) {
            return new Response(JSON.stringify({ error: err.message }), {
                status: 502,
                headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, isAllowed) },
            });
        }
    },
};

function corsHeaders(origin, isAllowed) {
    return {
        'Access-Control-Allow-Origin': isAllowed ? origin : 'https://metrolivemap.net',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
    };
}
