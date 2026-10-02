// Tiny zero-dependency server: serves the static app and proxies every call
// that needs an API key, so keys stay in .env and never reach the browser.
//   POST /api/llm/<provider>   → that provider's /chat/completions
//   POST /api/search           → Tavily
//   GET  /api/youtube/<path>   → YouTube Data API v3
// Run with: npm start   (then open http://localhost:8777)

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8777;

// Minimal .env loader (KEY=value lines; # comments).
try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
} catch (err) { /* no .env; rely on real environment variables */ }

const LLM = {
    gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: 'GEMINI_API_KEY' },
    openai: { url: 'https://api.openai.com/v1/chat/completions', key: 'OPENAI_API_KEY' }
};

// Only these files are served — nothing else in the folder (.env included).
const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/script.js': ['script.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8']
};

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', reject);
    });
}

// Pass the upstream status and body straight through so the client's existing
// error handling (400 retry, 429 detection, etc.) keeps working unchanged.
async function relay(res, upstream) {
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
    res.end(text);
}

http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
        const llm = url.pathname.match(/^\/api\/llm\/([a-z]+)$/);
        if (llm && req.method === 'POST') {
            const cfg = LLM[llm[1]];
            if (!cfg) return sendJson(res, 404, { error: 'Unknown provider' });
            const key = process.env[cfg.key];
            if (!key) return sendJson(res, 500, { error: `${cfg.key} is not set in .env` });
            return relay(res, await fetch(cfg.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
                body: await readBody(req)
            }));
        }

        if (url.pathname === '/api/search' && req.method === 'POST') {
            const key = process.env.TAVILY_API_KEY;
            if (!key) return sendJson(res, 500, { error: 'TAVILY_API_KEY is not set in .env' });
            const { query, max_results } = JSON.parse(await readBody(req) || '{}');
            return relay(res, await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: key, query, max_results })
            }));
        }

        const yt = url.pathname.match(/^\/api\/youtube\/([a-zA-Z]+)$/);
        if (yt && req.method === 'GET') {
            const key = process.env.YOUTUBE_API_KEY;
            if (!key) return sendJson(res, 500, { error: { message: 'YOUTUBE_API_KEY is not set in .env' } });
            const target = new URL(`https://www.googleapis.com/youtube/v3/${yt[1]}`);
            url.searchParams.forEach((v, k) => target.searchParams.set(k, v));
            target.searchParams.set('key', key);
            return relay(res, await fetch(target));
        }

        const file = STATIC[url.pathname];
        if (file && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': file[1] });
            return fs.createReadStream(path.join(ROOT, file[0])).pipe(res);
        }

        sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
        console.error(err);
        sendJson(res, 502, { error: 'Upstream request failed' });
    }
}).listen(PORT, () => console.log(`Roadmaper running at http://localhost:${PORT}`));
