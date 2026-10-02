// ─── Config ────────────────────────────────────────
// Must match the exact "API Model Identifier" shown in LM Studio's right-hand
// panel under Info → API Usage for your loaded model.
const MODEL_NAME = 'qwen 8b ggug q4';

// Which backend answers the chat-completions calls. All three speak the same
// OpenAI-style /chat/completions + tools format, so switching providers is
// just switching this one line — no other code changes needed.
//   'local'  → your own LM Studio server. Free and private, needs LM Studio
//              running, and an 8B model is by far the slowest of the three.
//   'gemini' → Google's OpenAI-compatible endpoint. Has a real free tier, is
//              dramatically faster than a local 8B, uses none of your RAM, and
//              follows the JSON + tool-calling instructions more reliably.
//              Get a key at https://aistudio.google.com/apikey
//   'openai' → a frontier hosted model. Same benefits, but paid.
// Hosted providers are reached through server.js (/api/llm/<provider>), which
// adds the API key from .env — no keys ever live in this browser-side file.
const PROVIDER = 'gemini';

const PROVIDERS = {
    local: {
        baseUrl: 'http://localhost:1234/v1/chat/completions',
        model: MODEL_NAME,
        // Qwen3 writes a long <think> block before every answer. We throw it
        // away, but we still wait for it and it still eats context — so switch
        // it off at the chat-template level. If a server rejects this field the
        // very first call automatically retries without it (see callLLM), so
        // it's safe to leave on.
        extraBody: { chat_template_kwargs: { enable_thinking: false } }
    },
    gemini: {
        baseUrl: '/api/llm/gemini',   // key: GEMINI_API_KEY in .env
        // Two traps worth knowing about here:
        //  1. Google retires older models for new keys — gemini-2.5-flash now
        //     404s with "no longer available to new users".
        //  2. Free-tier rate limits differ enormously between models. The big
        //     flash models allow only 5 requests/minute on the free tier, and
        //     one roadmap needs more than that (clarify + outline + several
        //     tool-calling turns), so they fail partway through every time.
        //     flash-lite has far more headroom and handles the tool calls and
        //     strict JSON this app needs perfectly well.
        // Swap to 'gemini-3.8-flash' or 'gemini-flash-latest' if you move to a
        // paid tier and want the stronger model.
        model: 'gemini-3.1-flash-lite'
    },
    openai: {
        baseUrl: '/api/llm/openai',   // key: OPENAI_API_KEY in .env
        model: 'gpt-4o-mini'  // or 'gpt-4o', etc.
    }
};

// Optional: set TAVILY_API_KEY in .env (https://tavily.com) to let the model
// search the live web while building a roadmap.
// Optional: set YOUTUBE_API_KEY in .env (console.cloud.google.com) to let the
// model find real, linkable YouTube videos/playlists for each roadmap step.
// server.js proxies both and returns an error if a key is missing, so steps
// still generate, just without search results or a working link.
//
// NOTE: both of these are wired up as OpenAI-style "tools" the model can call
// (function calling) — the practical browser-side equivalent of "search the
// web / search YouTube." That's different from running an actual MCP server:
// real MCP uses a stdio/SSE connection a static page can't speak to directly.
// If you need the real MCP protocol, it has to be hosted by something that
// speaks MCP (e.g. a small Node bridge or an MCP-aware client).
const TAVILY_ENABLED = true;
const YOUTUBE_ENABLED = true;

// Minimum subscriber count for a channel to count as "reputable." Purely a
// starting point — tune to taste. If nothing clears the bar for a given
// query, we fall back to the best available rather than returning nothing.
const REPUTABLE_SUBSCRIBER_THRESHOLD = 150000;

// Composite ranking weights for search_youtube results — tune to taste.
// Subscriber count still dominates (channel trust matters most for a
// learning resource); views add a traction signal; like ratio adds a
// lightweight quality signal. Subscribers/views are compared on a log scale
// so one mega-channel or one viral outlier doesn't completely drown out
// everything else.
const RANK_WEIGHTS = { subscribers: 2, views: 1.5, likeRatio: 0.5 };

// How many candidates each search asks YouTube for, and how many survive
// ranking to actually be shown to the model. Everything the model reads has to
// be re-processed on every subsequent turn, so trimming these is the cheapest
// real speedup available — 5 well-ranked candidates is plenty to choose from,
// and the 6th-10th were never getting picked anyway.
const YT_VIDEO_FETCH = 8;
const YT_VIDEO_SHOW = 5;
const YT_PLAYLIST_FETCH = 6;
const YT_PLAYLIST_SHOW = 4;

// Safety net only (not a design choice): stops a misbehaving model from
// trapping someone in an endless questionnaire. The prompt itself asks for
// "as many as genuinely necessary," with no target number.
const MAX_CLARIFYING_QUESTIONS = 8;

// ─── Themes ────────────────────────────────────────
// Every colour in styles.css comes from a token defined per theme, so the only
// thing switching a theme does is set data-theme on <html> — the whole app
// (start screen, questions, plan preview, roadmap, modals) follows from there.
const THEMES = [
    { id: 'minimalist', name: 'Minimalist' },
    { id: 'eco', name: 'Eco' },
    { id: 'neon', name: 'Neon' },
    { id: 'baby', name: 'Baby' }
];
const DEFAULT_THEME = 'minimalist';
const THEME_STORAGE_KEY = 'roadmaper:theme';

// localStorage genuinely throws in private windows and with site data blocked,
// and a stored preference is never worth taking the app down for.
function readStored(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
}

function writeStored(key, value) {
    try { localStorage.setItem(key, value); } catch (err) { /* won't persist; fine */ }
}

function applyTheme(id) {
    const theme = THEMES.some(t => t.id === id) ? id : DEFAULT_THEME;
    document.documentElement.dataset.theme = theme;
    writeStored(THEME_STORAGE_KEY, theme);
    document.querySelectorAll('.theme-swatch').forEach(btn => {
        btn.setAttribute('aria-checked', String(btn.dataset.theme === theme));
    });
}

function buildThemePicker() {
    const wrap = document.createElement('div');
    wrap.className = 'theme-picker';

    const label = document.createElement('span');
    label.className = 'theme-picker-label';
    label.textContent = 'Theme';
    wrap.appendChild(label);

    const row = document.createElement('div');
    row.className = 'theme-swatches';
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', 'Colour theme');

    THEMES.forEach(theme => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'theme-swatch';
        btn.dataset.theme = theme.id;
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', 'false');
        btn.title = `${theme.name} theme`;

        const chip = document.createElement('span');
        chip.className = 'theme-chip';
        const name = document.createElement('span');
        name.className = 'theme-name';
        name.textContent = theme.name;

        btn.appendChild(chip);
        btn.appendChild(name);
        btn.addEventListener('click', () => applyTheme(theme.id));
        row.appendChild(btn);
    });

    wrap.appendChild(row);
    return wrap;
}

// Applied before anything renders so a stored theme doesn't flash as the
// default first. Re-applied once the picker exists, to sync its checked state.
applyTheme(readStored(THEME_STORAGE_KEY) || DEFAULT_THEME);

// ─── Inline icons ──────────────────────────────────
const ICON_PATHS = {
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
    bars: '<line x1="6" y1="20" x2="6" y2="14"/><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="5"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="M10.2 8.4 16 12l-5.8 3.6Z" fill="currentColor"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 1.9"/>',
    star: '<path d="m12 3.6 2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 17l-5.25 2.75 1-5.85L3.5 9.75l5.9-.85Z"/>',
    check: '<path d="M20 6.5 9.5 17 4 11.5"/>',
    chevron: '<path d="m9.5 6 6 6-6 6"/>'
};

function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICON_PATHS[name] || '';
    return svg;
}

// ─── DOM ───────────────────────────────────────────
const app = document.getElementById('app');
const dots = document.querySelectorAll('.dot'); // static snapshot: only step-1..4's dots
const topicInput = document.getElementById('topicInput');
const continueBtn = document.getElementById('continueBtn');
const summaryTopic = document.getElementById('summaryTopic');
const summaryStyle = document.getElementById('summaryStyle');
const downloadBtn = document.getElementById('downloadBtn');

const STATIC_STEP_NUMBERS = { 'step-1': 1, 'step-2': 2, 'step-4': 3 };
const TOTAL_DOTS = 3;

// ─── State ─────────────────────────────────────────
const responses = {
    topic: '',
    learningStyle: '',
    clarifications: [], // [{ question, answer }]
    preferences: [] // free-text revision notes from the plan-preview step, e.g. "avoid Stanford", "shorter videos"
};
let isTransitioning = false;
let pendingTransition = null;   // a transition requested while one was already running
let activeStepEl = document.getElementById('step-1'); // what is actually on screen
let lastRoadmapError = '';
let stepHistory = [document.getElementById('step-1')];
let dynamicStepEls = [];

// Tool results keyed by "toolName:argsJson", kept for the whole session rather
// than per-LLM-call. Revising the outline and then generating, or hitting a
// JSON-retry, used to re-run identical YouTube searches from scratch; now the
// second ask is free. Cleared on Start Over.
let sessionToolCache = new Map();

// Every real video the YouTube API handed back this session. Shares the cache's
// lifetime on purpose: a cached tool result still refers to refs minted here, so
// the two must be cleared together or those refs would dangle.
let sessionVideoRegistry = createVideoRegistry();

// ─── Helper: Update Dots (static steps 1–4 only) ──
function updateDots(step) {
    dots.forEach(dot => {
        const num = parseInt(dot.dataset.dot);
        dot.classList.remove('active', 'done');
        if (num === step) dot.classList.add('active');
        else if (num < step) dot.classList.add('done');
    });
}

function buildDotsRow(activeDot, doneUpTo) {
    const wrap = document.createElement('div');
    wrap.className = 'step-dots';
    for (let i = 1; i <= TOTAL_DOTS; i++) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        if (i === activeDot) dot.classList.add('active');
        else if (i <= doneUpTo) dot.classList.add('done');
        wrap.appendChild(dot);
    }
    return wrap;
}

// ─── Helper: Transition between two step elements ─
function transitionTo(prevEl, nextEl, direction = 'forward') {
    if (!nextEl || nextEl === prevEl) return;

    // A transition arriving mid-animation used to be thrown away, which left the
    // app stranded on whatever screen was showing — the next step existed in
    // stepHistory but was never displayed. That only needed an LLM reply in
    // under 350ms to trigger, which a slow local model rarely managed but a
    // hosted one or a cache hit does routinely. Queue it instead of dropping it.
    if (isTransitioning) {
        pendingTransition = { nextEl, direction };
        return;
    }

    isTransitioning = true;

    prevEl.classList.add(direction === 'forward' ? 'exit-up' : 'exit-down');
    prevEl.classList.remove('active');

    setTimeout(() => {
        prevEl.classList.remove('exit-up', 'exit-down');
        prevEl.style.display = 'none';

        nextEl.style.display = 'flex';
        nextEl.classList.add('active');
        void nextEl.offsetWidth;

        // Steps that latch once used (a clarifying question takes one answer)
        // need to unlatch when the user navigates back onto them.
        if (typeof nextEl.onStepShown === 'function') nextEl.onStepShown();

        isTransitioning = false;
        activeStepEl = nextEl;

        if (pendingTransition) {
            const queued = pendingTransition;
            pendingTransition = null;
            // Always leave from whatever is actually on screen now, not from the
            // element that was current when this was queued.
            transitionTo(activeStepEl, queued.nextEl, queued.direction);
            return;
        }

        if (STATIC_STEP_NUMBERS[nextEl.id]) updateDots(STATIC_STEP_NUMBERS[nextEl.id]);

        nextEl.querySelectorAll('.heading, .btn-group, .input-wrapper, .continue-btn, .summary-card, .download-btn, .roadmap-slot, .step-subtext')
            .forEach(el => {
                el.style.animation = 'none';
                void el.offsetWidth;
                el.style.animation = '';
            });

        if (nextEl.id === 'step-1') topicInput.focus();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 350);
}

function goForward(nextEl) {
    const prevEl = stepHistory[stepHistory.length - 1];
    stepHistory.push(nextEl);
    transitionTo(prevEl, nextEl, 'forward');
}

function goBack() {
    if (stepHistory.length <= 1) return;
    const prevEl = stepHistory[stepHistory.length - 1];

    // Skip transient screens ("Thinking of the best follow-up…", "Sketching out
    // a plan…"). They have no controls, and the request that would carry the
    // user off them has already resolved, so landing on one is a dead end.
    let target = stepHistory.length - 2;
    while (target > 0 && stepHistory[target].dataset.transient === 'true') target--;
    const nextEl = stepHistory[target];
    if (!nextEl || nextEl === prevEl) return;

    stepHistory.length = target + 1;
    transitionTo(prevEl, nextEl, 'backward');
}

// ─── Helper: Validate Topic ───────────────────────
function validateTopic() {
    continueBtn.disabled = topicInput.value.trim().length === 0;
}

// ─── Helper: Generate response.txt content ────────
function generateResponseText() {
    const styleMap = { video: 'Video', reading: 'Reading' };
    const lines = [
        `"Topic  - ${responses.topic}"`,
        `"Learning style - ${styleMap[responses.learningStyle]}"`
    ];
    (responses.clarifications || []).forEach(c => {
        lines.push(`"${c.question} - ${c.answer}"`);
    });
    return lines.join('\n');
}

// ─── Helper: Download File ────────────────────────
function downloadResponseFile() {
    const blob = new Blob([generateResponseText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'response.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// ─── Helper: Update Summary (step-4 path) ─────────
function updateSummary() {
    const styleMap = { video: 'Video', reading: 'Reading' };
    summaryTopic.textContent = responses.topic;
    summaryStyle.textContent = styleMap[responses.learningStyle];
}

// ─── Helper: pull JSON out of an LLM response, tolerating <think> blocks ─
// Walks braces with string/escape awareness instead of a greedy regex, so a
// stray "{" or "}" inside a quoted "reason" string (or trailing chatter after
// the object) can't grab the wrong span or merge two objects into one.
function extractJson(rawContent) {
    const cleaned = (rawContent || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
    const start = cleaned.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escapeNext = false;
    for (let i = start; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (escapeNext) { escapeNext = false; continue; }
        if (ch === '\\') { escapeNext = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { return null; }
            }
        }
    }
    return null; // braces never balanced — truncated response
}

// ─── Tool: Tavily web search ───────────────────────
async function searchTavily(query) {
    if (!TAVILY_ENABLED) return { error: 'Web search is not configured for this app.' };
    try {
        const res = await fetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, max_results: 5 })
        });
        if (!res.ok) throw new Error(`Tavily returned ${res.status}`);
        const data = await res.json();
        return (data.results || []).map(r => ({ title: r.title, url: r.url, snippet: r.content }));
    } catch (err) {
        console.error('Tavily search failed:', err);
        return { error: 'Web search failed.' };
    }
}

// ─── YouTube helpers ───────────────────────────────
async function ytFetch(path, params) {
    const url = new URL(`/api/youtube/${path}`, location.origin);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (!res.ok) {
        let reason = '';
        try {
            const body = await res.json();
            reason = body?.error?.errors?.[0]?.reason || body?.error?.status || body?.error?.message || '';
        } catch { /* body wasn't JSON or was empty — fall through with just the status */ }
        throw new Error(`YouTube API returned ${res.status}${reason ? ` (${reason})` : ''}`);
    }
    return res.json();
}

// The YouTube list endpoints all take up to 50 IDs per call. Chunk into 50s and
// fire every chunk at once — these are independent requests, so awaiting them in
// sequence just added round-trips for nothing (a 150-video playlist went from
// three serial fetches to one parallel wait).
async function ytFetchBatched(path, part, ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    const chunks = [];
    for (let i = 0; i < unique.length; i += 50) chunks.push(unique.slice(i, i + 50));
    const pages = await Promise.all(
        chunks.map(chunk => ytFetch(path, { part, id: chunk.join(',') }))
    );
    return pages.flatMap(page => page.items || []);
}

async function getChannelSubscriberCounts(channelIds) {
    const counts = {};
    const items = await ytFetchBatched('channels', 'statistics', channelIds);
    items.forEach(item => {
        counts[item.id] = parseInt(item.statistics?.subscriberCount || '0', 10);
    });
    return counts;
}

// "PT1H2M10S" → 3730 (seconds). Returns null if missing/unparseable.
function parseISODuration(iso) {
    if (!iso) return null;
    const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
    if (!m) return null;
    const [, h, min, s] = m;
    return (parseInt(h || 0, 10) * 3600) + (parseInt(min || 0, 10) * 60) + parseInt(s || 0, 10);
}

// 3730 → "1:02:10" (or "12:34" under an hour). Used so the model sees a
// human-readable duration instead of raw seconds or ISO-8601.
function formatDuration(totalSeconds) {
    if (totalSeconds == null) return null;
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Batch-fetch per-video statistics/duration/captions (videos.list also takes
// up to 50 IDs per call). This is the signal that used to be missing
// entirely — previously the only ranking input was channel subscriber count.
async function getVideoDetails(videoIds) {
    const details = {};
    const items = await ytFetchBatched('videos', 'statistics,contentDetails', videoIds);
    items.forEach(item => {
        details[item.id] = {
            viewCount: parseInt(item.statistics?.viewCount || '0', 10),
            // Some creators hide the like count; keep that distinguishable
            // from "zero likes" so we don't unfairly penalize them.
            likeCount: item.statistics?.likeCount != null ? parseInt(item.statistics.likeCount, 10) : null,
            durationSeconds: parseISODuration(item.contentDetails?.duration),
            hasCaptions: item.contentDetails?.caption === 'true'
        };
    });
    return details;
}

// Batch-fetch how many videos are actually in each candidate playlist
// (playlists.list also takes up to 50 IDs per call). Without this, the model
// had no way to tell a 4-video teaser apart from a 120-video full course.
async function getPlaylistItemCounts(playlistIds) {
    const counts = {};
    const items = await ytFetchBatched('playlists', 'contentDetails', playlistIds);
    items.forEach(item => {
        counts[item.id] = item.contentDetails?.itemCount ?? null;
    });
    return counts;
}

// Sort candidate playlists by channel subscriber count and prefer ones that
// clear the reputability bar; if none do, fall back to the best available
// rather than nothing. (No per-item view/like data exists at the playlist
// level, so subscriber count is still the right primary signal here.)
function rankByReputation(results) {
    const sorted = [...results].sort((a, b) => (b.subscribers || 0) - (a.subscribers || 0));
    const reputable = sorted.filter(r => (r.subscribers || 0) >= REPUTABLE_SUBSCRIBER_THRESHOLD);
    return (reputable.length ? reputable : sorted).slice(0, YT_PLAYLIST_SHOW);
}

// Composite score for individual videos: channel authority + video traction
// + a quality signal, instead of subscriber count alone. Log-scaled so one
// mega-channel or one viral outlier doesn't drown everything else out.
function scoreVideo(v) {
    const subScore = Math.log10((v.subscribers || 0) + 1);
    const viewScore = Math.log10((v.views || 0) + 1);
    // Neutral-ish default like ratio when hidden, so those videos aren't
    // unfairly punished relative to ones that expose the real number.
    const likeScore = v.like_ratio_pct != null ? v.like_ratio_pct : 3;
    return subScore * RANK_WEIGHTS.subscribers + viewScore * RANK_WEIGHTS.views + likeScore * RANK_WEIGHTS.likeRatio;
}

function rankVideos(results) {
    const reputable = results.filter(r => (r.subscribers || 0) >= REPUTABLE_SUBSCRIBER_THRESHOLD);
    const pool = reputable.length ? reputable : results;
    return [...pool].sort((a, b) => scoreVideo(b) - scoreVideo(a)).slice(0, YT_VIDEO_SHOW);
}

// The YouTube API returns titles HTML-escaped ("Python &amp; Django"), and since
// every title here is rendered with textContent, that escaping would otherwise
// show up literally on screen.
const HTML_ENTITIES = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&apos;': "'", '&nbsp;': ' '
};

function decodeEntities(s) {
    return String(s || '')
        .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, m => HTML_ENTITIES[m])
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

// 1_400_000 → "1.4M". Shorter to read and costs a third of the tokens of the
// raw integer, and the model only ever compares these, never does arithmetic.
function compactCount(n) {
    if (!n) return '0';
    if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
    return String(n);
}

// ─── Video registry: the single source of truth for links ──────────────
// Every video any tool call actually returned gets recorded here with a short
// "ref" (v1, v2, …). The model is shown refs and titles but NEVER raw URLs, and
// is asked to answer with a ref. That kills the failure mode this app kept
// hitting: a small model retyping a random-looking 11-character video ID from
// memory several turns later, getting one character wrong, and producing a dead
// link that looked perfectly valid. A 2-character ref is both far cheaper in
// tokens and trivially verifiable — and if it's wrong we still recover the real
// video by matching the title (see resolveStepVideo).
function createVideoRegistry() {
    return { byRef: new Map(), byId: new Map(), byTitle: new Map(), next: 1 };
}

function normalizeTitle(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function registerVideo(reg, { title, url, channel = '', playlistId = null, position = null, duration = '' }) {
    const videoId = extractVideoId(url);
    if (!videoId || !title) return null;

    const existing = reg.byId.get(videoId);
    if (existing) {
        // Same video seen again, this time with playlist context — keep it, since
        // playlist position is what lets us guarantee watch order later.
        if (existing.playlistId == null && playlistId != null) {
            existing.playlistId = playlistId;
            existing.position = position;
        }
        if (!existing.duration && duration) existing.duration = duration;
        return existing;
    }

    const entry = {
        ref: `v${reg.next++}`,
        videoId, title, channel, url, playlistId, position, duration
    };
    reg.byId.set(videoId, entry);
    reg.byRef.set(entry.ref, entry);
    const key = normalizeTitle(title);
    if (!reg.byTitle.has(key)) reg.byTitle.set(key, entry);
    return entry;
}

// ─── Tool: YouTube video search ────────────────────
async function searchYouTube(query, registry) {
    if (!YOUTUBE_ENABLED) return { error: 'YouTube search is not configured for this app.' };
    try {
        const data = await ytFetch('search', { part: 'snippet', type: 'video', maxResults: YT_VIDEO_FETCH, q: query });
        const items = data.items || [];
        const videoIds = items.map(it => it.id.videoId);
        const [subMap, detailMap] = await Promise.all([
            getChannelSubscriberCounts(items.map(it => it.snippet.channelId)),
            getVideoDetails(videoIds)
        ]);
        const results = items.map(it => {
            const vid = it.id.videoId;
            const d = detailMap[vid] || {};
            const likeRatio = (d.likeCount != null && d.viewCount) ? +(d.likeCount / d.viewCount * 100).toFixed(2) : null;
            return {
                title: decodeEntities(it.snippet.title),
                channel: decodeEntities(it.snippet.channelTitle),
                url: `https://www.youtube.com/watch?v=${vid}`,
                subscribers: subMap[it.snippet.channelId] || 0,
                views: d.viewCount || 0,
                like_ratio_pct: likeRatio, // null if the creator hides like counts
                published: it.snippet.publishedAt ? it.snippet.publishedAt.slice(0, 10) : null,
                duration: formatDuration(d.durationSeconds),
                has_captions: !!d.hasCaptions
            };
        });
        // Register the real URLs on our side, hand the model refs instead.
        return rankVideos(results).map(v => {
            const entry = registerVideo(registry, v);
            return {
                ref: entry ? entry.ref : undefined,
                title: v.title,
                channel: v.channel,
                subs: compactCount(v.subscribers),
                views: compactCount(v.views),
                like_ratio_pct: v.like_ratio_pct,
                duration: v.duration,
                published: v.published,
                has_captions: v.has_captions
            };
        });
    } catch (err) {
        console.error('YouTube search failed:', err);
        return { error: 'YouTube search failed.' };
    }
}

// ─── Tool: YouTube playlist search ─────────────────
async function searchYouTubePlaylist(query) {
    if (!YOUTUBE_ENABLED) return { error: 'YouTube search is not configured for this app.' };
    try {
        const data = await ytFetch('search', { part: 'snippet', type: 'playlist', maxResults: YT_PLAYLIST_FETCH, q: query });
        const items = data.items || [];
        const playlistIds = items.map(it => it.id.playlistId);
        const [subMap, itemCountMap] = await Promise.all([
            getChannelSubscriberCounts(items.map(it => it.snippet.channelId)),
            getPlaylistItemCounts(playlistIds)
        ]);
        const results = items.map(it => ({
            playlist_id: it.id.playlistId,
            title: decodeEntities(it.snippet.title),
            channel: decodeEntities(it.snippet.channelTitle),
            subscribers: subMap[it.snippet.channelId] || 0,
            video_count: itemCountMap[it.id.playlistId] ?? null,
            published: it.snippet.publishedAt ? it.snippet.publishedAt.slice(0, 10) : null
        }));
        return rankByReputation(results).map(p => ({
            playlist_id: p.playlist_id,
            title: p.title,
            channel: p.channel,
            subs: compactCount(p.subscribers),
            video_count: p.video_count,
            published: p.published
        }));
    } catch (err) {
        console.error('YouTube playlist search failed:', err);
        return { error: 'YouTube playlist search failed.' };
    }
}

// ─── Tool: fetch every video in a playlist, in ONE tool call ─
// (Internally this may make a couple of paginated HTTP requests — YouTube
// caps each page at 50 items — but the model only ever sees a single call.)
async function getPlaylistVideos(playlistId, registry) {
    if (!YOUTUBE_ENABLED) return { error: 'YouTube search is not configured for this app.' };
    if (!playlistId) return { error: 'playlist_id is required.' };
    try {
        const videos = [];
        let pageToken = '';
        const MAX_VIDEOS = 150; // sanity cap
        do {
            const data = await ytFetch('playlistItems', {
                part: 'snippet',
                maxResults: 50,
                playlistId,
                ...(pageToken ? { pageToken } : {})
            });
            (data.items || []).forEach(it => {
                const videoId = it.snippet?.resourceId?.videoId;
                if (videoId && it.snippet.title && it.snippet.title !== 'Private video' && it.snippet.title !== 'Deleted video') {
                    videos.push({
                        title: decodeEntities(it.snippet.title),
                        // The uploader, not the playlist curator — these differ on
                        // compilation playlists, and this is the name shown to the
                        // learner, so it has to come from the API rather than from
                        // whatever the model claimed.
                        channel: decodeEntities(it.snippet.videoOwnerChannelTitle || ''),
                        url: `https://www.youtube.com/watch?v=${videoId}`,
                        position: it.snippet.position,
                        videoId
                    });
                }
            });
            pageToken = data.nextPageToken || '';
        } while (pageToken && videos.length < MAX_VIDEOS);

        // A playlist arrives in upload order, but `position` is the authoritative
        // sequence — sort by it so "the next video" really is the next one.
        videos.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

        // Lightweight enrichment: duration only. Full per-video stats (like
        // search_youtube returns) isn't worth the token cost across 100+ videos,
        // but duration is exactly what's needed to judge pacing for a step.
        const detailMap = await getVideoDetails(videos.map(v => v.videoId));

        // The model-facing shape is deliberately tiny: a ref, the watch order,
        // the title, the length. Dropping the 43-character URL from every row is
        // what makes a 120-video playlist affordable to put in front of a local
        // model at all — it cuts this payload by roughly half.
        const modelVideos = videos.map((v, i) => {
            const duration = formatDuration((detailMap[v.videoId] || {}).durationSeconds);
            const entry = registerVideo(registry, {
                title: v.title,
                url: v.url,
                channel: v.channel,
                playlistId,
                position: v.position ?? i,
                duration
            });
            return {
                ref: entry ? entry.ref : undefined,
                n: i + 1, // watch order within the playlist
                title: v.title,
                duration
            };
        });

        return {
            playlist_id: playlistId,
            video_count: modelVideos.length,
            note: 'Listed in playlist watch order. Assign them to consecutive steps in this same order.',
            videos: modelVideos
        };
    } catch (err) {
        console.error('Fetching playlist videos failed:', err);
        return { error: 'Fetching playlist videos failed.' };
    }
}

function buildTools() {
    const tools = [];
    if (TAVILY_ENABLED) {
        tools.push({
            type: 'function',
            function: {
                name: 'search_web',
                description: 'Look up background facts about a TOPIC — e.g. what the prerequisites for a concept are, or the order concepts are normally taught in. Use it only to get the curriculum right. Do NOT use it to find learning resources, courses, or links: YouTube is the only permitted source of resources for this roadmap, and results from Coursera, Udemy, edX, LinkedIn Learning, X/Twitter, blogs or docs must never be offered to the learner as a step.',
                parameters: {
                    type: 'object',
                    properties: { query: { type: 'string', description: 'A focused search query.' } },
                    required: ['query']
                }
            }
        });
    }
    if (YOUTUBE_ENABLED) {
        tools.push({
            type: 'function',
            function: {
                name: 'search_youtube_playlist',
                description: 'Search YouTube for playlists matching a query. Prefer this over search_youtube when a single well-established playlist could cover most or all of the roadmap. Returns candidate playlists (title, channel, playlist_id, subscriber count, video_count, publish date), weighted toward reputable channels. Check video_count before committing — a 4-video teaser and a 120-video full course can rank similarly on subscribers alone.',
                parameters: {
                    type: 'object',
                    properties: { query: { type: 'string', description: 'Search query for a playlist, e.g. "complete python course for beginners".' } },
                    required: ['query']
                }
            }
        });
        tools.push({
            type: 'function',
            function: {
                name: 'get_playlist_videos',
                description: 'Fetch every video in a given playlist in a single call, in playlist watch order. Each video comes back with a "ref" (use this to identify it), its order number "n", its title, and its duration. Use the durations to sanity-check pacing. Call this ONCE per playlist you decide to use — never call it repeatedly or try to fetch a playlist\'s videos one at a time.',
                parameters: {
                    type: 'object',
                    properties: { playlist_id: { type: 'string', description: 'The playlist_id returned by search_youtube_playlist.' } },
                    required: ['playlist_id']
                }
            }
        });
        tools.push({
            type: 'function',
            function: {
                name: 'search_youtube',
                description: 'Search YouTube for individual videos matching a query. Use this as a fallback when no suitable playlist covers a topic/segment. Each result comes back with a "ref" (use this to identify the video you pick), plus title, channel, subs, views, like_ratio_pct, publish date, duration and caption availability — ranked by a blend of channel authority and video traction, not subscriber count alone.',
                parameters: {
                    type: 'object',
                    properties: { query: { type: 'string', description: 'Search query, e.g. "python basics for beginners tutorial".' } },
                    required: ['query']
                }
            }
        });
    }
    return tools.length ? tools : undefined;
}

async function runTool(name, argsJson, registry) {
    let args = {};
    try { args = JSON.parse(argsJson || '{}'); } catch { /* ignore */ }
    if (name === 'search_web') return searchTavily(args.query || responses.topic);
    if (name === 'search_youtube') return searchYouTube(args.query || responses.topic, registry);
    if (name === 'search_youtube_playlist') return searchYouTubePlaylist(args.query || responses.topic);
    if (name === 'get_playlist_videos') return getPlaylistVideos(args.playlist_id, registry);
    return { error: `Unknown tool: ${name}` };
}

// ─── Shared: call the configured LLM provider, handling a tool-calling loop ─
// `callCache`, if passed, is a Map shared across retries (see callLLMForJson)
// so an identical tool call is never re-executed even across a JSON-retry.
// Writes a line of progress onto whichever waiting screen is showing, so a long
// pause always has a visible reason.
function setStatusNote(text) {
    const note = document.querySelector('.step.active .step-subtext')
        || document.querySelector('.step.active .roadmap-slot div');
    if (note) note.textContent = text;
}

// Sends one chat-completions request. `extraBody` (used to turn off Qwen3's
// <think> block) is a non-standard field, so if a server rejects it we retry
// once without it and remember that for the rest of the session — the speedup
// is worth having, but never at the cost of breaking a working setup.
let providerExtraBodySupported = true;

async function postChatCompletion(provider, body) {
    const wantsExtra = providerExtraBodySupported && !!provider.extraBody;
    const send = (withExtra) => fetch(provider.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withExtra ? { ...body, ...provider.extraBody } : body)
    });

    let res = await send(wantsExtra);
    if (!res.ok && res.status === 400 && wantsExtra) {
        console.warn('Server rejected the extra request fields — retrying without them for the rest of this session.');
        providerExtraBodySupported = false;
        res = await send(false);
    }

    // Free tiers routinely answer "currently experiencing high demand" (503) or
    // rate-limit (429). Those are momentary, so retry instead of throwing the
    // learner out to the error screen partway through a roadmap.
    for (let attempt = 1; attempt <= 3 && (res.status === 503 || res.status === 429); attempt++) {
        // A 429 usually carries the exact wait the server wants ("Please retry
        // in 51.8s"). Honouring it beats guessing — guessing short just burns
        // another attempt against the same limit.
        const suggested = await readSuggestedRetryMs(res);
        const waitMs = Math.min(suggested || 1500 * attempt, 60000);
        const seconds = Math.round(waitMs / 1000);
        console.warn(`Provider returned ${res.status}; retrying in ${seconds}s (attempt ${attempt} of 3).`);
        // Without this the app just sits on a spinner for up to a minute with no
        // explanation, which reads as a hang rather than a wait.
        setStatusNote(res.status === 429
            ? `Hit the API rate limit — waiting ${seconds}s before retrying (${attempt} of 3).`
            : `The model is busy — retrying in ${seconds}s (${attempt} of 3).`);
        await new Promise(r => setTimeout(r, waitMs));
        res = await send(providerExtraBodySupported && !!provider.extraBody);
    }
    return res;
}

// Reads the server's own "retry after" hint. Works off Retry-After when present
// and otherwise off the delay Google embeds in the 429 text. Clones the response
// so the body stays readable by the caller.
async function readSuggestedRetryMs(res) {
    const header = res.headers.get('retry-after');
    if (header && !Number.isNaN(Number(header))) return Number(header) * 1000;
    try {
        const text = await res.clone().text();
        const m = text.match(/retry in ([\d.]+)s/i);
        if (m) return Math.ceil(parseFloat(m[1]) * 1000) + 500;
    } catch { /* fall through to the caller's backoff */ }
    return 0;
}

// Pulls the human-readable reason out of an error body so the UI can say
// "no longer available to new users" instead of just "404". Gemini wraps its
// error in an array, OpenAI and LM Studio don't — handle both.
async function describeHttpError(res) {
    let detail = '';
    try {
        const body = await res.json();
        const err = (Array.isArray(body) ? body[0]?.error : body?.error) || {};
        detail = err.message || '';
    } catch { /* not JSON — status alone will have to do */ }
    return detail;
}

async function callLLM(messages, { tools, temperature = 0.3, max_tokens = 4000, maxTurns = 1, callCache, registry } = {}) {
    const provider = PROVIDERS[PROVIDER];
    const cache = callCache || new Map();

    for (let turn = 0; turn < maxTurns; turn++) {
        // On the last allowed turn, stop offering tools at all so the model
        // can't spend its final turn on another tool call that would just get
        // silently dropped — it's forced to produce the actual final answer.
        const forceFinal = turn === maxTurns - 1;
        const res = await postChatCompletion(provider, {
            model: provider.model,
            messages,
            temperature,
            max_tokens,
            ...(tools && !forceFinal ? { tools, tool_choice: 'auto' } : {}),
            ...(tools && forceFinal ? { tool_choice: 'none' } : {})
        });
        if (!res.ok) {
            const detail = await describeHttpError(res);
            const who = PROVIDER === 'local' ? 'LM Studio' : 'The API';
            throw new Error(`${who} returned ${res.status}${detail ? `: ${detail}` : ''}`);
        }
        const data = await res.json();
        const choice = data.choices && data.choices[0];
        if (!choice || !choice.message) throw new Error('No response from the model');
        const msg = choice.message;

        if (msg.tool_calls && msg.tool_calls.length > 0 && !forceFinal) {
            messages.push(msg);
            for (const call of msg.tool_calls) {
                const sig = `${call.function.name}:${call.function.arguments}`;
                let result;
                if (cache.has(sig)) {
                    // Same tool, same arguments, already answered this turn or an
                    // earlier retry — hand back the cached result instead of
                    // burning another HTTP call, and tell the model not to repeat it.
                    result = cache.get(sig);
                    messages.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        content: JSON.stringify({ note: 'Duplicate call with identical arguments — reusing the previous result. Do not call this again with the same arguments.', ...result })
                    });
                } else {
                    result = await runTool(call.function.name, call.function.arguments, registry);
                    cache.set(sig, result);
                    messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
                }
            }
            continue;
        }
        return msg.content || '';
    }
    return ''; // unreachable in practice (forceFinal guarantees a text turn), kept as a safe fallback
}

// ─── Shared: call the LLM and retry with a corrective nudge if the JSON ─
// comes back malformed or fails schema validation, instead of failing on the
// first bad response. `validate(json)` should return the usable payload on
// success or throw a short, specific Error describing what's wrong — that
// message gets fed back to the model verbatim as the correction request.
async function callLLMForJson(messages, llmOptions, { validate, maxRetries = 2 }) {
    const callCache = sessionToolCache;
    let lastError = 'The response was not valid JSON.';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const content = await callLLM(messages, { ...llmOptions, callCache });
        const json = extractJson(content);
        if (json) {
            try {
                return validate(json);
            } catch (err) {
                lastError = err.message;
            }
        }
        if (attempt < maxRetries) {
            messages.push({ role: 'assistant', content });
            messages.push({
                role: 'user',
                content: `That response couldn't be used: ${lastError} Reply again with ONLY the corrected JSON object — no commentary, no markdown fences — matching the exact schema from the system prompt.`
            });
        }
    }
    throw new Error(lastError);
}

// ─── System prompt: clarifying follow-up questions ─
const CLARIFY_SYSTEM_PROMPT = `
You are helping design a personalized learning roadmap. You'll be given the learner's topic and their answers so far.

Decide what follow-up questions, if any, are genuinely needed before building the best possible roadmap for them. There is no fixed number — ask as many as the topic honestly calls for. A narrow, well-scoped topic might need zero or one; a broad or ambiguous one might genuinely need several (depth, prior experience, goal/use case, time available, preferred pace, tools/platform, etc.).

### Rules
- Every question must meaningfully change the final roadmap. Never ask something you can reasonably infer, or that wouldn't change the output.
- Don't ask two questions that are really asking the same thing in different words.
- The goal is the best possible roadmap using the fewest questions that actually matter — not a fixed quota in either direction.
- NEVER ask where the learner wants to learn from, which platform/site/service to use, or whether to use Coursera, Udemy, edX, LinkedIn Learning, Khan Academy, X/Twitter, books, blogs, docs or paid courses. That decision is already made and is not the learner's to make: every resource in this roadmap comes from YouTube, always. Asking about it is a wasted question.
- Ask only about the learner and their goals — current level, what they want to build or do with it, depth, time available, pace, which tools/language/framework they're targeting.

### Output format
Respond with ONLY valid JSON:
{"questions": [{"headline": "A short, direct question, e.g. 'How deep do you want to go?'", "options": ["Option A", "Option B", "Option C"]}]}
Use {"questions": []} if none are needed. Each question needs 2-4 short, mutually exclusive options. No markdown fences, no commentary, no extra keys.
`.trim();

// Belt-and-braces for the "YouTube only" rule. The prompt tells the model not to
// ask which platform to learn from, but a small model ignores that often enough
// that the learner was regularly being asked to choose between Coursera, X and
// LinkedIn Learning — a choice this app can't honour, since every resource comes
// from YouTube. So the question is also blocked here, where it can't leak
// through. Matches named providers and "where do you want to learn"-shaped
// phrasing; deliberately does NOT match legitimate target questions like
// "iOS or Android?".
const OFF_PLATFORM_PATTERNS = [
    /\b(?:coursera|udemy|edx|linkedin|khan academy|skillshare|pluralsight|datacamp|codecademy|udacity|masterclass|freecodecamp\.org)\b/i,
    /\b(?:twitter|x\.com|reddit|medium\.com|stack overflow)\b/i,
    // Bare "X" for the site formerly called Twitter. Case-sensitive and anchored
    // to a preposition or a YouTube comparison, so the letter x in ordinary words
    // (or "x or y" phrasing) doesn't trip it.
    /\b(?:on|from|via|search|searching|use|using|check|browse)\s+X\b/,
    /\bX\s+or\s+You\s?Tube\b/i,
    /\bYou\s?Tube\s+or\s+X\b/,
    /\bX \(formerly Twitter\)/i,
    /\bwhere (?:do|would|should) you (?:want to|prefer to|like to)?\s*(?:learn|study)\b/i,
    // "Which platform do you want to use?" is a source question and gets blocked;
    // "Which platform are you targeting — iOS or Android?" is a legitimate
    // question about what they're building, so exempt the build-target phrasings.
    /\bwhich (?:platform|website|site|service|provider|source)\b(?![\s\S]{0,80}\b(?:target|targeting|build|building|deploy|develop|developing|ship)\b)/i,
    /\bprefer(?:red)? (?:learning )?(?:platform|source|website|site)\b/i,
    /\bpaid (?:course|courses|content)\b/i,
    // Re-asking video vs. written material — already answered in step 2.
    /\b(?:books?|blogs?|articles?|podcasts?|documentation|written (?:guides?|content|material))\b[\s\S]*\bvideos?\b/i,
    /\bvideos?\b[\s\S]*\b(?:books?|blogs?|articles?|podcasts?|documentation|written (?:guides?|content|material))\b/i
];

function mentionsOffPlatformSource(text) {
    return OFF_PLATFORM_PATTERNS.some(re => re.test(text));
}

// Throws (triggering a retry) only when the shape is actually wrong — an
// empty `questions` array is a legitimate, valid answer, not a failure.
function validateClarifyingJson(json) {
    if (!json || !Array.isArray(json.questions)) {
        throw new Error('The top-level "questions" field must be an array.');
    }
    return json.questions
        .filter(q => q && typeof q.headline === 'string' && Array.isArray(q.options) && q.options.length >= 2)
        .filter(q => {
            if (mentionsOffPlatformSource([q.headline, ...q.options].join(' | '))) {
                console.warn(`Dropping off-platform clarifying question: "${q.headline}"`);
                return false;
            }
            return true;
        })
        .slice(0, MAX_CLARIFYING_QUESTIONS);
}

async function getClarifyingQuestions() {
    const messages = [
        { role: 'system', content: CLARIFY_SYSTEM_PROMPT },
        { role: 'user', content: generateResponseText() }
    ];
    try {
        return await callLLMForJson(
            messages,
            { temperature: 0.4, max_tokens: 1500, maxTurns: 1 },
            { validate: validateClarifyingJson }
        );
    } catch (err) {
        console.error('Clarifying-question call failed:', err);
        return []; // fail safe: never block the user, just skip straight to the roadmap
    }
}

// ─── System prompt: the roadmap OUTLINE (structure only, no resources) ─
// This is deliberately a separate, tools-free call from the resource-finding
// one below. Planning the curriculum and searching for videos used to happen
// in the same long tool-calling session, which is exactly how a model loses
// the thread on its own structure partway through (hence steps that don't
// build on each other sensibly). Splitting them means the structure gets one
// focused, undistracted reasoning pass, gets shown to the learner to confirm
// or correct, and is then LOCKED before any resource search happens.
const OUTLINE_SYSTEM_PROMPT = `
You are planning a learning roadmap's structure. This is a pure curriculum-planning step — you have no tools, don't search for or mention anything, and don't include URLs or specific resources. You're deciding WHAT the learner should cover and in what order; WHERE they'll learn it from comes later, after they approve this plan.

Given the learner's topic, learning style, and answers/preferences below, produce a short, logically ordered list of steps that build on each other — foundations and prerequisites before the material that depends on them. Avoid vague steps ("get better at X") and avoid two steps covering overlapping ground.

### Ordering is the most important thing here
The learner works straight down this list, one step at a time, without skipping. So every step must be genuinely watchable/readable using only what the steps before it already covered:
- Never use a concept in step N that isn't introduced until step N+1 or later.
- Each step should be the natural next thing after the one above it — either the next part of the same idea, or the thing that idea unlocks.
- Read your finished list back in order once, as if you were the learner, and fix anything that arrives too early.

All resources for this roadmap will come from YouTube, so never mention or assume any other platform, course provider, book, or paid product.

Each step is either:
- "video": a distinct concept or skill the learner should watch/read about.
- "project": a hands-on exercise applying what was just covered. Insert one roughly every 3-6 "video" steps where hands-on practice would meaningfully reinforce them — not on a rigid schedule, and not after every cluster.

No fixed step count and no upper limit — use exactly as many as the topic and the learner's answers genuinely call for.

Each step needs:
- "type": "video" or "project"
- "title": 3-8 words, specific (e.g. "Linear algebra for ML: vectors & matrices", not "Learn the basics")
- "description": one sentence on what it covers (or what to build, for a project) and why it belongs at this point in the sequence

If the message includes "Revision requests," you're revising a previous outline — read the requests and the previous outline carefully, then output the FULL corrected outline (not a diff). A request that's really about resources rather than structure ("avoid Stanford," "shorter videos") may not change this outline much, if at all — carry it forward faithfully anyway, since it'll also be applied later when actual resources are chosen.

Respond with ONLY: {"steps": [{"type": "video", "title": "...", "description": "..."}]}
No commentary, no markdown fences.
`.trim();

function validateOutlineJson(json) {
    if (!json || !Array.isArray(json.steps) || json.steps.length === 0) {
        throw new Error('The top-level "steps" field must be a non-empty array.');
    }
    const steps = json.steps
        .filter(s => s && typeof s.title === 'string')
        .map(s => ({
            type: s.type === 'project' ? 'project' : 'video',
            title: s.title.trim(),
            description: typeof s.description === 'string' ? s.description.trim() : ''
        }));
    if (!steps.length) throw new Error('None of the "steps" entries had a usable "title" field.');
    return steps;
}

function buildOutlineUserMessage(previousOutline) {
    let msg = generateResponseText();
    if (responses.preferences.length) {
        msg += '\n\nRevision requests (apply all of these):\n' + responses.preferences.map(p => `- ${p}`).join('\n');
    }
    if (previousOutline) {
        msg += '\n\nPrevious outline to revise:\n' + previousOutline.map((s, i) => `${i + 1}. (${s.type}) ${s.title} — ${s.description}`).join('\n');
    }
    return msg;
}

// Note: unlike the other two LLM calls, errors here are NOT swallowed — this
// now sits in an interactive loop with the learner, so the caller shows a
// real error + retry option instead of silently guessing what to do next.
async function getRoadmapOutline(previousOutline = null) {
    const messages = [
        { role: 'system', content: OUTLINE_SYSTEM_PROMPT },
        { role: 'user', content: buildOutlineUserMessage(previousOutline) }
    ];
    return callLLMForJson(
        messages,
        { temperature: 0.4, max_tokens: 2000, maxTurns: 1 },
        { validate: validateOutlineJson }
    );
}

// ─── System prompt: the roadmap itself ────────────
const ROADMAP_SYSTEM_PROMPT = `
You are finding real learning resources for an ALREADY-APPROVED roadmap outline. The learner has reviewed and confirmed this exact step sequence — your job is only to attach real resources to it, never to redesign it.

You will be given the approved outline as a numbered list, each marked (video) or (project).

### YouTube is the only permitted source
Every single resource must be a real YouTube video found through the tools below. Never suggest, mention, or link Coursera, Udemy, edX, LinkedIn Learning, Khan Academy, X/Twitter, blogs, books, docs, or any paid course — not as a step, not as an alternative, and not as a note. Never ask the learner where they'd like to learn from; that's already decided.

### Your job
- Output exactly the same steps, in exactly the same order, with exactly the same "type" for each. Never add, remove, reorder, merge, or split steps, and never change what a step is fundamentally about.
- For each "video" step: pick one real video that matches that step's title/description. Identify it by the "ref" the search tool gave it. Set the step's "title" to that video's real title (not the outline's placeholder title) and write a "reason" (1-2 sentences) tying it to what this specific step needs to cover.
- For each "project" step: keep its meaning from the outline, but flesh it out into a concrete, specific exercise — write "description" (2-4 sentences on what to build and what it should demonstrate) and scale "duration" to its real scope: a small applied drill gets "1-3 hours"; a capstone pulling multiple skills together gets "3-5 days" or "1-2 weeks".

### Identify every video by its "ref"
Search results never contain URLs. Each candidate has a short "ref" like "v7" — put that exact string in the step's "ref" field and the real link gets attached for you. Never write a URL yourself, never guess a video ID, and never reuse a ref you weren't given. Copy refs character for character.

### Each video must follow on from the one before it
The learner watches these videos in order, back to back, so consecutive video steps must genuinely chain together:
- The second video has to make sense immediately after the first — either it's the next part of the same series, or it's the natural next topic once the first is understood.
- Never put a video that assumes later material before the video that teaches it.
- Never use the same video for two steps. Every step gets a different video.
- Prefer a run of consecutive videos from ONE playlist in that playlist's own order, because that order is already a working sequence.
- Before you answer, read your video titles top to bottom in order and check each one is watchable given only the ones above it.

### Finding videos — prefer one strong playlist over scattered videos
If "search_youtube_playlist" is available, start there: search for an existing playlist that closely matches a run of consecutive "video" steps, from a reputable, well-established channel. If you find a strong fit:
- Call "get_playlist_videos" ONCE with its playlist_id to retrieve its full video list — this returns every video in the playlist in a single call, already in watch order. Never call it more than once per playlist, and never try to fetch a playlist's videos one at a time via search_youtube.
- Map its videos onto the matching outline steps in ascending "n" order — step after step, never jumping backwards.
- Give every video from that playlist the same "channel" name, and still write a step-specific "reason" for each.

If no sufficiently relevant playlist exists, or it only covers part of a step, fall back to "search_youtube" for the remaining steps — one focused, specific query per step.

Never invent a title or channel name. If a tool returns nothing usable for a step, omit "ref" for that step rather than making one up, but keep the step and still give it a specific, well-chosen title describing exactly what to search for.

### Reputable channels only
Only use videos/playlists from established, reputable channels — the kind a learner would already trust (large, well-known educational or industry channels; official docs/tooling channels; well-known instructors). The search tools already weight results toward better-subscribed channels; when choosing among what they return, still prefer the more established, recognizable option.

### Using the extra signals on each candidate
search_youtube results also include subs, views, like_ratio_pct, published date, duration, and has_captions. When several candidates are all reasonably reputable, prefer the one with a healthier view count and like_ratio_pct over a bare subscriber-count tiebreak, and pick a duration that actually fits the step (don't send a beginner to a 4-hour stream for a "basics" step, or to a 3-minute clip for a "deep dive" step). search_youtube_playlist results include video_count — check it before committing to a playlist; a 4-video teaser is not the same commitment as a 120-video full course, even from the same channel.

### Additional preferences
Any "Additional preferences" listed below are hard constraints from the learner — apply every one of them to every relevant step, not just the step it happens to be mentioned near (e.g. a duration or channel preference applies to ALL video steps, not just one).

### Research
If "search_web" is available, use it only to get facts straight — e.g. what the current recommended version or prerequisite order for a fast-moving framework is. Never use it to find resources or links, since YouTube is the only permitted source. Don't search things you're already confident about.

### Difficulty and the roadmap header
Give every step a "difficulty" of exactly "Beginner", "Intermediate" or "Advanced" — where that step sits for THIS learner given their stated background, not in the abstract. Difficulty should generally climb across the roadmap.

Also return a "meta" object describing the roadmap as a whole:
- "goal": one short phrase for what the learner will be able to do at the end, written as a goal ("Become a machine learning engineer", "Build and ship React apps"). Base it on their topic and answers.
- "level": the learner's own starting level — "Beginner", "Intermediate" or "Advanced" — taken from their answers below, not guessed.
- "estimated_time": realistic calendar time to finish at the pace they said they can commit to, e.g. "~3 months", "~6 weeks". Account for the project steps, not just video length.

### Output format
Respond with ONLY valid JSON:
{"meta": {"goal": "...", "level": "Beginner", "estimated_time": "~3 months"},
 "steps": [
  {"type": "video", "title": "...", "ref": "v7", "channel": "Channel name", "difficulty": "Beginner", "reason": "1-2 sentences on why this specific video fits here, for this learner"},
  {"type": "project", "title": "...", "duration": "1-3 hours", "difficulty": "Intermediate", "description": "2-4 sentences on what to build and what it should demonstrate"}
]}
"ref" and "channel" are optional (omit rather than fabricate); every other field is required. Never include a "url" field — links are attached from the ref. No markdown fences, no commentary, no extra keys.
`.trim();

function cleanMetaField(value) {
    return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function makeRoadmapValidator(outline) {
    return function validateRoadmapJson(json) {
        if (!json || !Array.isArray(json.steps) || json.steps.length === 0) {
            throw new Error('The top-level "steps" field must be a non-empty array.');
        }
        const steps = json.steps.filter(s => s && typeof s.title === 'string');
        if (!steps.length) throw new Error('None of the "steps" entries had a usable "title" field.');
        // Hard enforcement, not just a prompt request: if the count drifts from
        // the approved outline, force a corrective retry rather than silently
        // accepting a roadmap the learner never actually confirmed.
        if (outline && steps.length !== outline.length) {
            throw new Error(`Expected exactly ${outline.length} steps matching the approved outline, in the same order — got ${steps.length}. Do not add, remove, or merge steps.`);
        }
        // "meta" is header decoration, so a model that skips it shouldn't cost
        // the learner a whole retry — the header just renders fewer pills.
        const rawMeta = json.meta && typeof json.meta === 'object' ? json.meta : {};
        const meta = {
            goal: cleanMetaField(rawMeta.goal),
            level: cleanMetaField(rawMeta.level),
            estimatedTime: cleanMetaField(rawMeta.estimated_time || rawMeta.estimatedTime)
        };
        return { steps, meta };
    };
}

function buildRoadmapUserMessage(outline) {
    let msg = generateResponseText();
    if (responses.preferences.length) {
        msg += '\n\nAdditional preferences (apply to every relevant step):\n' + responses.preferences.map(p => `- ${p}`).join('\n');
    }
    msg += '\n\nApproved outline — do not add, remove, reorder, or change the meaning of any step:\n' +
        outline.map((s, i) => `${i + 1}. (${s.type}) ${s.title} — ${s.description}`).join('\n');
    return msg;
}

// Pulls the 11-char video ID out of any watch?v=... or youtu.be/... URL,
// regardless of extra query params, so it can be checked against a cache of
// URLs we actually fetched ourselves.
function extractVideoId(url) {
    if (!url) return null;
    const m = String(url).match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
}

// A link that always works: YouTube's own search results for this step's title.
// Used only when nothing in the registry can be matched, so a step is never
// left with no way to reach the material.
function youtubeSearchUrl(query) {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

// Loose title match, for when a ref is missing or mangled but the model clearly
// copied a real video's title. Compares meaningful words only, so punctuation,
// casing and dropped filler ("| Part 3") don't stop a match.
function bestTitleMatch(title, registry) {
    const wanted = new Set(normalizeTitle(title).split(' ').filter(w => w.length > 2));
    if (!wanted.size) return null;

    let best = null;
    let bestScore = 0;
    for (const entry of registry.byId.values()) {
        const have = new Set(normalizeTitle(entry.title).split(' ').filter(w => w.length > 2));
        if (!have.size) continue;
        let shared = 0;
        wanted.forEach(w => { if (have.has(w)) shared++; });
        const score = shared / wanted.size;
        if (score > bestScore) { bestScore = score; best = entry; }
    }
    return bestScore >= 0.6 ? best : null;
}

// Turns whatever the model said about a video into the real video we fetched.
// Tries the cheap, exact routes first, then falls back to matching on title.
function resolveStepVideo(step, registry) {
    if (step.ref && registry.byRef.has(step.ref)) return registry.byRef.get(step.ref);

    // Older prompts (and occasionally a stubborn model) still emit a URL.
    const id = extractVideoId(step.url);
    if (id && registry.byId.has(id)) return registry.byId.get(id);

    const exact = registry.byTitle.get(normalizeTitle(step.title));
    if (exact) return exact;

    return bestTitleMatch(step.title, registry);
}

// Two steps pointing at the same video breaks the "watch these in order" promise
// and wastes a step. When it happens inside a playlist we can fix it properly:
// take the next video in that playlist that nothing else is using yet.
function nextUnusedInPlaylist(entry, registry, usedIds) {
    if (!entry || !entry.playlistId) return null;
    const siblings = [...registry.byId.values()]
        .filter(e => e.playlistId === entry.playlistId && !usedIds.has(e.videoId))
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return siblings.find(e => (e.position ?? 0) > (entry.position ?? 0)) || siblings[0] || null;
}

// Attaches the real link to every video step, from our own records rather than
// from anything the model retyped. Guarantees each video step ends up with a
// working URL — a verified watch link where we can identify the video, and a
// YouTube search link for its title otherwise. That's the fix for steps that
// used to open the modal saying no link was available.
function attachRealLinks(steps, registry) {
    const usedIds = new Set();

    return steps.map(step => {
        if (step.type === 'project') return step;

        let match = resolveStepVideo(step, registry);
        if (match && usedIds.has(match.videoId)) {
            const replacement = nextUnusedInPlaylist(match, registry, usedIds);
            if (replacement) {
                console.warn(`Step "${step.title}" reused a video; advanced to "${replacement.title}".`);
                match = replacement;
            }
        }

        if (match && !usedIds.has(match.videoId)) {
            usedIds.add(match.videoId);
            return {
                ...step,
                title: match.title,              // the real title, not the model's paraphrase
                channel: match.channel || step.channel || '',
                duration: match.duration || '',
                url: match.url,
                linkKind: 'watch',
                playlistId: match.playlistId,
                position: match.position
            };
        }

        // Nothing verified, so drop the channel too — it came from the model, and
        // showing an unchecked channel name next to an unchecked link just lends
        // it false authority.
        console.warn(`No verified video for step "${step.title}" — falling back to a YouTube search link.`);
        return { ...step, channel: '', url: youtubeSearchUrl(step.title), linkKind: 'search', playlistId: null, position: null };
    });
}

// Final ordering guarantee. Within any run of consecutive video steps drawn from
// the same playlist, put them back into that playlist's own order — so the second
// video really is the one meant to follow the first. Whole step objects move
// together, so each video keeps the reason written for it.
function enforceWatchOrder(steps) {
    const ordered = [...steps];
    let i = 0;
    while (i < ordered.length) {
        const playlistId = ordered[i].type !== 'project' ? ordered[i].playlistId : null;
        if (!playlistId) { i++; continue; }

        let end = i;
        while (
            end + 1 < ordered.length &&
            ordered[end + 1].type !== 'project' &&
            ordered[end + 1].playlistId === playlistId
        ) end++;

        if (end > i) {
            const run = ordered.slice(i, end + 1);
            const sorted = [...run].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
            for (let k = 0; k < sorted.length; k++) ordered[i + k] = sorted[k];
        }
        i = end + 1;
    }
    return ordered;
}

// Finds a course playlist for the topic BEFORE the model is asked anything, and
// hands the videos over in the prompt.
//
// This exists because the model cannot be trusted to search. Gemini in
// particular will happily answer the whole roadmap in one turn without calling a
// single tool, inventing plausible-sounding video titles — which is exactly how
// every step ends up with no real link. Pre-seeding means real videos are on the
// table whether or not it decides to use a tool.
async function prefetchPlaylistCandidates(outline, registry) {
    if (!YOUTUBE_ENABLED) return '';
    const videoStepCount = outline.filter(s => s.type !== 'project').length;
    if (!videoStepCount) return '';

    try {
        const playlists = await searchYouTubePlaylist(`${responses.topic} full course tutorial for beginners`);
        if (playlists.error || !playlists.length) return '';

        const best = playlists.find(p => (p.video_count || 0) >= videoStepCount) || playlists[0];
        const listed = await getPlaylistVideos(best.playlist_id, registry);
        if (listed.error || !listed.videos || !listed.videos.length) return '';

        return [
            `\n\nVideos already found for you, from the playlist "${best.title}" by ${best.channel} (${listed.video_count} videos, listed in watch order):`,
            listed.videos.map(v => `${v.ref} | #${v.n} | ${v.title}${v.duration ? ` (${v.duration})` : ''}`).join('\n'),
            'Assign these refs to the matching steps, keeping their order. If a step needs something this playlist does not cover, call search_youtube for that step.'
        ].join('\n');
    } catch (err) {
        console.warn('Playlist pre-fetch failed; falling back to tool-driven search.', err);
        return '';
    }
}

// Last-resort guarantee: any step the model left without a real video gets one
// searched for directly. No model cooperation required — this is plain code
// doing the lookup the model was supposed to do.
async function backfillMissingVideos(steps, registry) {
    const used = new Set(steps.map(s => extractVideoId(s.url)).filter(Boolean));
    let searchesLeft = 8; // each search costs 100 YouTube quota units — don't burn the daily cap

    for (const step of steps) {
        if (step.type === 'project' || step.linkKind !== 'search' || searchesLeft <= 0) continue;
        searchesLeft--;
        try {
            const results = await searchYouTube(`${step.title} ${responses.topic} tutorial`, registry);
            if (results.error || !results.length) continue;
            const pick = results
                .map(r => registry.byRef.get(r.ref))
                .find(entry => entry && !used.has(entry.videoId));
            if (!pick) continue;

            used.add(pick.videoId);
            step.title = pick.title;
            step.channel = pick.channel || '';
            step.duration = pick.duration || '';
            step.url = pick.url;
            step.linkKind = 'watch';
            step.playlistId = pick.playlistId;
            step.position = pick.position;
        } catch (err) {
            console.warn(`Backfill search failed for "${step.title}".`, err);
        }
    }
    return steps;
}

async function getRoadmapFromLLM(outline) {
    setStatusNote('Finding a course to build this from…');
    const seeded = await prefetchPlaylistCandidates(outline, sessionVideoRegistry);
    setStatusNote('Matching videos to your steps…');

    const messages = [
        { role: 'system', content: ROADMAP_SYSTEM_PROMPT },
        { role: 'user', content: buildRoadmapUserMessage(outline) + seeded }
    ];
    try {
        const { steps, meta } = await callLLMForJson(
            messages,
            {
                tools: buildTools(),
                temperature: 0.3,
                max_tokens: 7000,
                // Every turn re-processes the whole conversation, so each extra
                // turn costs more than the last. The playlist-first strategy
                // needs about three (find playlist → list its videos → answer);
                // this leaves room for fallback searches without letting a
                // confused model grind through twenty full-context passes.
                maxTurns: 8,
                registry: sessionVideoRegistry
            },
            { validate: makeRoadmapValidator(outline) }
        );
        const linked = attachRealLinks(steps, sessionVideoRegistry);
        const missing = linked.filter(s => s.type !== 'project' && s.linkKind === 'search').length;
        if (missing) setStatusNote(`Looking up ${missing} more video${missing > 1 ? 's' : ''}…`);
        const ordered = enforceWatchOrder(await backfillMissingVideos(linked, sessionVideoRegistry));
        return { steps: ordered, meta };
    } catch (err) {
        console.error('LLM call failed:', err);
        lastRoadmapError = err.message || 'Unknown error';
        return null;
    }
}

// ─── Detail modal (opened by clicking a marker) ────
function ensureModal() {
    let modal = document.getElementById('detailModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'detailModal';
    modal.className = 'modal-backdrop';

    const card = document.createElement('div');
    card.className = 'modal-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeModal);

    const body = document.createElement('div');
    body.className = 'modal-body';

    card.appendChild(closeBtn);
    card.appendChild(body);
    modal.appendChild(card);
    document.body.appendChild(modal);

    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
    });

    return modal;
}

function openModal(contentNode) {
    const modal = ensureModal();
    const body = modal.querySelector('.modal-body');
    body.innerHTML = '';
    body.appendChild(contentNode);
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    const modal = document.getElementById('detailModal');
    if (!modal) return;
    modal.classList.remove('open');
    document.body.style.overflow = '';
}

function buildVideoModalContent(stepData) {
    const wrap = document.createElement('div');

    const title = document.createElement('h3');
    title.className = 'modal-title';
    title.textContent = stepData.title;
    wrap.appendChild(title);

    if (stepData.channel) {
        const channel = document.createElement('div');
        channel.className = 'modal-meta';
        channel.textContent = stepData.channel;
        wrap.appendChild(channel);
    }

    const reason = document.createElement('p');
    reason.className = 'modal-text';
    reason.textContent = stepData.reason || 'No explanation was provided for this pick.';
    wrap.appendChild(reason);

    // There is always a link now: the verified watch URL for this exact video
    // when we could identify it, or YouTube's search results for its title when
    // we couldn't. Either way the learner gets to the material in one click.
    const isSearchFallback = stepData.linkKind === 'search';
    const url = stepData.url || youtubeSearchUrl(stepData.title);

    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'modal-link-btn';
    link.textContent = isSearchFallback ? 'Find on YouTube ↗' : 'Watch on YouTube ↗';
    wrap.appendChild(link);

    if (isSearchFallback) {
        const note = document.createElement('p');
        note.className = 'modal-text modal-muted';
        note.textContent = "Couldn't pin down one specific video for this step, so this opens a YouTube search for it.";
        wrap.appendChild(note);
    }

    return wrap;
}

function buildProjectModalContent(stepData) {
    const wrap = document.createElement('div');

    const title = document.createElement('h3');
    title.className = 'modal-title';
    title.textContent = stepData.title;
    wrap.appendChild(title);

    if (stepData.duration) {
        const dur = document.createElement('div');
        dur.className = 'modal-meta';
        dur.textContent = stepData.duration;
        wrap.appendChild(dur);
    }

    const desc = document.createElement('p');
    desc.className = 'modal-text';
    desc.textContent = stepData.description || 'No description was provided for this project.';
    wrap.appendChild(desc);

    return wrap;
}

// ─── Roadmap: progress tracking ────────────────────
// Keyed by normalised step title rather than position, so ticking steps off
// survives a regenerate that reorders or rewords the list.
const PROGRESS_KEY_PREFIX = 'roadmaper:progress:';

function progressKey() {
    return PROGRESS_KEY_PREFIX + normalizeTitle(responses.topic);
}

function loadProgress() {
    try {
        const parsed = JSON.parse(readStored(progressKey()) || '[]');
        return new Set(Array.isArray(parsed) ? parsed : []);
    } catch (err) {
        return new Set();
    }
}

function saveProgress(done) {
    writeStored(progressKey(), JSON.stringify([...done]));
}

// ─── Roadmap: header helpers ───────────────────────
function difficultyLevel(text) {
    const t = String(text || '').toLowerCase();
    if (t.includes('advanced') || t.includes('expert')) return 3;
    if (t.includes('intermediate')) return 2;
    if (t.includes('beginner') || t.includes('basic') || t.includes('foundation')) return 1;
    return 0;
}

// Used only when the model didn't return a level. Reads it back off the
// learner's own clarifying answers — never guesses, because an invented
// "Beginner" badge on an experienced learner's roadmap is worse than no badge.
function inferLevel() {
    for (const { question, answer } of responses.clarifications || []) {
        if (!/level|experience|background|familiar/i.test(question)) continue;
        if (difficultyLevel(answer)) return answer.replace(/\s*\(.*\)\s*$/, '').trim();
    }
    return '';
}

function parseDurationSeconds(text) {
    const parts = String(text || '').split(':').map(Number);
    if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) return 0;
    return parts.reduce((total, n) => total * 60 + n, 0);
}

// Fallback for the "Estimated time" pill: real total watch time, added up from
// the durations YouTube reported for the videos actually chosen.
function totalWatchTime(steps) {
    const seconds = steps.reduce((sum, s) => sum + parseDurationSeconds(s.duration), 0);
    if (!seconds) return '';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.round((seconds % 3600) / 60);
    if (hours && mins) return `~${hours}h ${mins}m of video`;
    if (hours) return `~${hours}h of video`;
    return `~${mins}m of video`;
}

function buildGoalPill(iconName, label, value) {
    const pill = document.createElement('span');
    pill.className = 'goal-pill';
    pill.appendChild(icon(iconName));
    const text = document.createElement('span');
    text.textContent = `${label}: ${value}`;
    pill.appendChild(text);
    return pill;
}

function buildGoalCard(steps, meta, done) {
    const card = document.createElement('div');
    card.className = 'goal-card';

    const head = document.createElement('div');
    head.className = 'goal-head';

    const iconWrap = document.createElement('span');
    iconWrap.className = 'goal-icon';
    iconWrap.appendChild(icon('target'));
    head.appendChild(iconWrap);

    const titleWrap = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'goal-label';
    label.textContent = 'Goal:';
    const title = document.createElement('h2');
    title.className = 'goal-title';
    title.textContent = meta.goal || responses.topic;
    titleWrap.appendChild(label);
    titleWrap.appendChild(title);
    head.appendChild(titleWrap);
    card.appendChild(head);

    const track = document.createElement('div');
    track.className = 'goal-progress';
    const bar = document.createElement('span');
    bar.className = 'goal-progress-bar';
    track.appendChild(bar);
    card.appendChild(track);

    const progressText = document.createElement('div');
    progressText.className = 'goal-progress-text';
    card.appendChild(progressText);

    const metaRow = document.createElement('div');
    metaRow.className = 'goal-meta';

    // Each pill is shown only when there's something real behind it.
    const level = meta.level || inferLevel();
    if (level) metaRow.appendChild(buildGoalPill('bars', 'Level', level));

    const styleMap = { video: 'Video', reading: 'Reading' };
    metaRow.appendChild(buildGoalPill('play', 'Preference', styleMap[responses.learningStyle] || 'Video'));

    const estimate = meta.estimatedTime || totalWatchTime(steps);
    if (estimate) metaRow.appendChild(buildGoalPill('clock', 'Estimated time', estimate));

    card.appendChild(metaRow);

    const refresh = () => {
        // Counted against the steps actually on screen: `done` can still hold
        // titles from an earlier roadmap for this same topic.
        const complete = steps.filter(s => done.has(normalizeTitle(s.title))).length;
        const pct = steps.length ? Math.round((complete / steps.length) * 100) : 0;
        bar.style.width = `${pct}%`;
        progressText.textContent = `${complete} of ${steps.length} steps complete`;
    };
    refresh();

    return { card, refresh };
}

// ─── Roadmap: timeline ─────────────────────────────
function buildStepPills(stepData) {
    const pills = document.createElement('div');
    pills.className = 'tl-pills';
    const isVideo = stepData.type !== 'project';

    const source = document.createElement('span');
    source.className = 'tl-pill source';
    source.appendChild(icon(isVideo ? 'play' : 'star'));
    const sourceText = document.createElement('span');
    sourceText.textContent = isVideo ? (stepData.channel || 'Video') : 'Hands-on project';
    source.appendChild(sourceText);
    pills.appendChild(source);

    if (stepData.duration) {
        const time = document.createElement('span');
        time.className = 'tl-pill time';
        time.appendChild(icon('clock'));
        const timeText = document.createElement('span');
        timeText.textContent = stepData.duration;
        time.appendChild(timeText);
        pills.appendChild(time);
    }

    const level = difficultyLevel(stepData.difficulty);
    if (level) {
        const diff = document.createElement('span');
        diff.className = `tl-pill level-${level}`;
        diff.appendChild(icon('bars'));
        const diffText = document.createElement('span');
        diffText.textContent = stepData.difficulty;
        diff.appendChild(diffText);
        pills.appendChild(diff);
    }

    return pills;
}

function buildTimelineRow(stepData, index, done, onToggle) {
    const isVideo = stepData.type !== 'project';
    const key = normalizeTitle(stepData.title);

    const row = document.createElement('div');
    row.className = 'tl-row';

    const rail = document.createElement('div');
    rail.className = 'tl-rail';
    const node = document.createElement('span');
    node.className = `tl-node${isVideo ? '' : ' project'}`;
    node.textContent = String(index + 1);
    rail.appendChild(node);
    row.appendChild(rail);

    const card = document.createElement('div');
    card.className = 'tl-card';

    const head = document.createElement('div');
    head.className = 'tl-card-head';

    // A stretched ::after on this button makes the whole card clickable without
    // nesting the completion toggle inside another button.
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'tl-open';
    open.textContent = stepData.title;
    open.addEventListener('click', () => {
        openModal(isVideo ? buildVideoModalContent(stepData) : buildProjectModalContent(stepData));
    });
    head.appendChild(open);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tl-toggle';
    const toggleText = document.createElement('span');
    toggle.appendChild(icon('check'));
    toggle.appendChild(toggleText);
    head.appendChild(toggle);
    card.appendChild(head);

    const desc = document.createElement('p');
    desc.className = 'tl-desc';
    desc.textContent = isVideo
        ? (stepData.reason || 'Picked for this step of the roadmap.')
        : (stepData.description || 'A hands-on exercise applying the steps above.');
    card.appendChild(desc);

    card.appendChild(buildStepPills(stepData));

    const chevron = document.createElement('span');
    chevron.className = 'tl-chevron';
    chevron.appendChild(icon('chevron'));
    card.appendChild(chevron);

    const syncDone = () => {
        const isDone = done.has(key);
        card.classList.toggle('done', isDone);
        toggleText.textContent = isDone ? 'Completed' : 'Mark done';
        toggle.setAttribute('aria-pressed', String(isDone));
    };

    toggle.addEventListener('click', () => {
        if (done.has(key)) done.delete(key);
        else done.add(key);
        saveProgress(done);
        syncDone();
        onToggle();
    });
    syncDone();

    row.appendChild(card);
    return row;
}

// Draws the winding connector from the nodes' measured positions rather than
// from assumed row heights — card heights depend on how much text each step
// carries, and change again whenever the page reflows.
function drawTimelineConnector(timeline, svg) {
    const nodes = [...timeline.querySelectorAll('.tl-node')];
    if (!nodes.length) return;

    const base = timeline.getBoundingClientRect();
    if (!base.height) return;

    const centres = nodes.map(n => {
        const r = n.getBoundingClientRect();
        return { x: r.left + r.width / 2 - base.left, y: r.top + r.height / 2 - base.top };
    });

    const cx = centres[0].x;
    const maxAmp = Math.min(15, cx * 0.45);
    const startY = Math.max(0, centres[0].y - 34);
    const endY = centres[centres.length - 1].y + 34;

    // Straight lead-in and lead-out, waves only between nodes. Curving over the
    // short 34px approach put a visible kink right above the first node.
    let d = `M ${cx.toFixed(1)} ${startY.toFixed(1)} L ${cx.toFixed(1)} ${centres[0].y.toFixed(1)}`;
    let dir = 1;
    for (let i = 1; i < centres.length; i++) {
        const prevY = centres[i - 1].y;
        const y = centres[i].y;
        const dy = y - prevY;
        // Amplitude tracks the gap, so tightly packed cards bend gently instead
        // of zig-zagging.
        const amp = Math.min(maxAmp, dy * 0.22) * dir;
        d += ` C ${(cx + amp).toFixed(1)} ${(prevY + dy * 0.35).toFixed(1)},`
           + ` ${(cx - amp).toFixed(1)} ${(prevY + dy * 0.65).toFixed(1)},`
           + ` ${cx.toFixed(1)} ${y.toFixed(1)}`;
        dir *= -1;
    }
    d += ` L ${cx.toFixed(1)} ${endY.toFixed(1)}`;

    const svgNS = 'http://www.w3.org/2000/svg';
    svg.textContent = '';

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);

    // Arrowhead closing off the bottom of the road.
    const arrow = document.createElementNS(svgNS, 'polygon');
    const half = 9;
    arrow.setAttribute('points', [
        `${(cx - half).toFixed(1)},${(endY - 1).toFixed(1)}`,
        `${(cx + half).toFixed(1)},${(endY - 1).toFixed(1)}`,
        `${cx.toFixed(1)},${(endY + 12).toFixed(1)}`
    ].join(' '));
    svg.appendChild(arrow);
}

function buildRoadmapVisual(stepsData, meta = {}) {
    const done = loadProgress();

    const view = document.createElement('div');
    view.className = 'roadmap-view';

    const header = buildGoalCard(stepsData, meta, done);
    view.appendChild(header.card);

    const timeline = document.createElement('div');
    timeline.className = 'timeline';

    // No viewBox on purpose: user units then map 1:1 to pixels of the timeline
    // box, which is exactly the coordinate space the measurements are in.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'tl-line');
    svg.setAttribute('aria-hidden', 'true');
    timeline.appendChild(svg);

    stepsData.forEach((stepData, i) => {
        timeline.appendChild(buildTimelineRow(stepData, i, done, header.refresh));
    });

    view.appendChild(timeline);

    const redraw = () => drawTimelineConnector(timeline, svg);
    requestAnimationFrame(redraw);
    // Card heights change with the viewport and once webfonts land, so one pass
    // at build time isn't enough.
    if (typeof ResizeObserver === 'function') new ResizeObserver(redraw).observe(timeline);

    return view;
}

async function renderRoadmap(slotEl, outline, headingEl) {
    lastRoadmapError = '';
    slotEl.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'roadmap-loading';
    loading.textContent = 'Generating your roadmap…';
    slotEl.appendChild(loading);

    const result = await getRoadmapFromLLM(outline);

    if (!result || !result.steps || !result.steps.length) {
        const detail = lastRoadmapError ? ` (${lastRoadmapError})` : '';
        slotEl.textContent = '';
        const errorEl = document.createElement('div');
        errorEl.className = 'roadmap-error';
        const hint = PROVIDER === 'local'
            ? "Make sure LM Studio's local server is running at localhost:1234 with CORS enabled, then try again."
            : `Check that server.js is running (npm start), the ${PROVIDER.toUpperCase()}_API_KEY in .env and PROVIDERS.${PROVIDER}.model are set correctly, then try again.`;
        errorEl.textContent = `Could not generate a roadmap${detail}. ${hint}`;
        slotEl.appendChild(errorEl);
        return;
    }

    slotEl.textContent = '';
    slotEl.appendChild(buildRoadmapVisual(result.steps, result.meta || {}));
    // The goal card is the page header now, so the placeholder title above it
    // would only repeat it.
    if (headingEl) headingEl.remove();
}

// ─── Dynamic step builders ─────────────────────────
function newStepShell() {
    const stepDiv = document.createElement('div');
    stepDiv.className = 'step';
    stepDiv.style.display = 'none';
    app.appendChild(stepDiv);
    dynamicStepEls.push(stepDiv);
    return stepDiv;
}

function buildMessageStep(headingText, subText) {
    const stepDiv = newStepShell();
    stepDiv.dataset.transient = 'true';
    const h1 = document.createElement('h1');
    h1.className = 'heading small';
    h1.textContent = headingText;
    stepDiv.appendChild(h1);
    if (subText) {
        const p = document.createElement('p');
        p.className = 'step-subtext';
        p.textContent = subText;
        stepDiv.appendChild(p);
    }
    stepDiv.appendChild(buildDotsRow(3, 2));
    return stepDiv;
}

function buildClarifyingStep(question, onAnswer) {
    const stepDiv = newStepShell();
    const h1 = document.createElement('h1');
    h1.className = 'heading small';
    h1.textContent = question.headline;
    stepDiv.appendChild(h1);

    const shortOptions = question.options.every(o => o.length <= 22);
    const btnGroup = document.createElement('div');
    btnGroup.className = shortOptions ? 'btn-group row-layout' : 'btn-group';

    // Latches for the current presentation of this question only: two fast
    // clicks can't fork the flow, but going back and re-answering still works.
    let answered = false;
    stepDiv.onStepShown = () => { answered = false; };

    question.options.forEach(optText => {
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.type = 'button';
        const span = document.createElement('span');
        span.textContent = optText;
        btn.appendChild(span);
        btn.addEventListener('click', () => {
            if (answered) return;
            answered = true;
            onAnswer(optText);
        });
        btnGroup.appendChild(btn);
    });

    stepDiv.appendChild(btnGroup);
    stepDiv.appendChild(buildDotsRow(3, 2));
    return stepDiv;
}

function buildRoadmapStep() {
    const stepDiv = newStepShell();
    const h1 = document.createElement('h1');
    h1.className = 'heading small';
    h1.textContent = 'Your Personalized Roadmap';
    stepDiv.appendChild(h1);

    const slot = document.createElement('div');
    slot.className = 'roadmap-slot';
    stepDiv.appendChild(slot);

    const startOverBtn = document.createElement('button');
    startOverBtn.className = 'btn';
    const startOverSpan = document.createElement('span');
    startOverSpan.textContent = 'Start Over';
    startOverBtn.appendChild(startOverSpan);
    startOverBtn.addEventListener('click', resetApp);
    stepDiv.appendChild(startOverBtn);

    stepDiv.appendChild(buildDotsRow(3, 2));
    return { stepDiv, slot, heading: h1 };
}

function buildOutlineStepBadge(step) {
    const badge = document.createElement('span');
    badge.className = `outline-badge${step.type === 'project' ? ' project' : ''}`;
    return badge;
}

function buildOutlineConfirmStep(outline) {
    const stepDiv = newStepShell();
    const h1 = document.createElement('h1');
    h1.className = 'heading small';
    h1.textContent = "Here's the plan";
    stepDiv.appendChild(h1);

    const subText = document.createElement('p');
    subText.className = 'step-subtext';
    subText.textContent = 'Take a look before I go find real videos for each step.';
    stepDiv.appendChild(subText);

    const list = document.createElement('div');
    list.className = 'outline-card';
    outline.forEach((step, i) => {
        const item = document.createElement('div');
        item.className = 'outline-item';

        const badge = buildOutlineStepBadge(step);
        badge.textContent = i + 1;

        const textWrap = document.createElement('div');
        textWrap.className = 'outline-text';
        const title = document.createElement('div');
        title.className = 'outline-title';
        title.textContent = step.title;
        const desc = document.createElement('div');
        desc.className = 'outline-desc';
        desc.textContent = step.description;
        textWrap.appendChild(title);
        textWrap.appendChild(desc);

        item.appendChild(badge);
        item.appendChild(textWrap);
        list.appendChild(item);
    });
    stepDiv.appendChild(list);

    const feedbackWrap = document.createElement('div');
    feedbackWrap.className = 'outline-feedback';
    const feedbackLabel = document.createElement('p');
    feedbackLabel.className = 'step-subtext';
    feedbackLabel.style.margin = '0';
    feedbackLabel.textContent = 'Want to change anything? (topics, or resource preferences like "avoid Stanford" or "shorter videos")';
    const textarea = document.createElement('textarea');
    textarea.className = 'feedback-input';
    textarea.rows = 3;
    textarea.placeholder = 'Optional — leave blank if this looks good.';
    feedbackWrap.appendChild(feedbackLabel);
    feedbackWrap.appendChild(textarea);
    stepDiv.appendChild(feedbackWrap);

    const actions = document.createElement('div');
    actions.className = 'outline-actions';

    const reviseBtn = document.createElement('button');
    reviseBtn.className = 'btn';
    reviseBtn.disabled = true;
    const reviseSpan = document.createElement('span');
    reviseSpan.textContent = 'Update the plan';
    reviseBtn.appendChild(reviseSpan);
    textarea.addEventListener('input', () => { reviseBtn.disabled = !textarea.value.trim(); });
    reviseBtn.addEventListener('click', () => {
        const feedback = textarea.value.trim();
        if (!feedback) return;
        responses.preferences.push(feedback);
        launchOutlinePreview(outline);
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'continue-btn';
    confirmBtn.textContent = 'Looks good — build my roadmap';
    confirmBtn.addEventListener('click', () => {
        const feedback = textarea.value.trim();
        if (feedback) responses.preferences.push(feedback);
        launchRoadmapGeneration(outline);
    });

    actions.appendChild(reviseBtn);
    actions.appendChild(confirmBtn);
    stepDiv.appendChild(actions);

    stepDiv.appendChild(buildDotsRow(3, 2));
    return stepDiv;
}

function buildOutlineErrorStep(message, previousOutline) {
    const stepDiv = newStepShell();
    const h1 = document.createElement('h1');
    h1.className = 'heading small';
    h1.textContent = "Couldn't build the plan";
    stepDiv.appendChild(h1);

    const p = document.createElement('p');
    p.className = 'step-subtext';
    p.style.color = '#a33';
    p.textContent = message || 'Something went wrong talking to the model.';
    stepDiv.appendChild(p);

    const retryBtn = document.createElement('button');
    retryBtn.className = 'continue-btn';
    retryBtn.textContent = 'Try again';
    retryBtn.addEventListener('click', () => launchOutlinePreview(previousOutline));
    stepDiv.appendChild(retryBtn);

    stepDiv.appendChild(buildDotsRow(3, 2));
    return stepDiv;
}

// ─── Orchestration: clarifying questions → outline → roadmap ─
function askClarifyingQuestion(questions, index) {
    if (index >= questions.length) {
        launchOutlinePreview();
        return;
    }
    const q = questions[index];
    const stepDiv = buildClarifyingStep(q, (answer) => {
        responses.clarifications[index] = { question: q.headline, answer };
        // Anything recorded after this question belongs to a branch the user
        // has just re-opened; drop it rather than carrying stale answers forward.
        responses.clarifications.length = index + 1;
        askClarifyingQuestion(questions, index + 1);
    });
    goForward(stepDiv);
}

async function launchOutlinePreview(previousOutline = null) {
    const thinkingStep = buildMessageStep(
        previousOutline ? 'Updating the plan…' : 'Sketching out a plan…',
        'Just a moment — putting the steps in order.'
    );
    goForward(thinkingStep);

    try {
        const outline = await getRoadmapOutline(previousOutline);
        goForward(buildOutlineConfirmStep(outline));
    } catch (err) {
        console.error('Outline generation failed:', err);
        goForward(buildOutlineErrorStep(err.message, previousOutline));
    }
}

async function launchRoadmapGeneration(outline) {
    const { stepDiv, slot, heading } = buildRoadmapStep();
    goForward(stepDiv);
    await renderRoadmap(slot, outline, heading);
}

async function startClarifyingFlow() {
    responses.clarifications = [];
    responses.preferences = [];
    const thinkingStep = buildMessageStep('Thinking of the best follow-up…', 'Just a moment — figuring out what would help most.');
    goForward(thinkingStep);

    const questions = await getClarifyingQuestions();
    if (!questions.length) {
        await launchOutlinePreview();
        return;
    }
    askClarifyingQuestion(questions, 0);
}

// ─── Reset ─────────────────────────────────────────
function resetApp() {
    responses.topic = '';
    responses.learningStyle = '';
    responses.clarifications = [];
    responses.preferences = [];
    lastRoadmapError = '';
    // Cleared together — cached tool results reference refs minted in the registry.
    sessionToolCache = new Map();
    sessionVideoRegistry = createVideoRegistry();
    topicInput.value = '';
    validateTopic();
    closeModal();

    const current = stepHistory[stepHistory.length - 1];
    if (current) {
        current.classList.remove('active', 'exit-up', 'exit-down');
        current.style.display = 'none';
    }

    dynamicStepEls.forEach(el => el.remove());
    dynamicStepEls = [];

    const step1 = document.getElementById('step-1');
    step1.style.display = 'flex';
    step1.classList.add('active');
    void step1.offsetWidth;

    stepHistory = [step1];
    activeStepEl = step1;
    pendingTransition = null;
    isTransitioning = false;
    updateDots(1);
    topicInput.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Event Listeners ──────────────────────────────
topicInput.addEventListener('input', validateTopic);
topicInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && topicInput.value.trim()) {
        responses.topic = topicInput.value.trim();
        goForward(document.getElementById('step-2'));
    }
});

continueBtn.addEventListener('click', () => {
    responses.topic = topicInput.value.trim();
    goForward(document.getElementById('step-2'));
});

// Step 2 buttons. The old "do you want me to make the roadmap?" step is gone —
// choosing Video goes straight into building one.
document.querySelectorAll('#step-2 .btn[data-choice]').forEach(btn => {
    btn.addEventListener('click', () => {
        responses.learningStyle = btn.dataset.choice;
        updateSummary();

        if (responses.learningStyle === 'video') {
            startClarifyingFlow();
        } else {
            goForward(document.getElementById('step-4'));
        }
    });
});

// Download button
downloadBtn.addEventListener('click', downloadResponseFile);

// Keyboard navigation
function isTextEntryTarget(el) {
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace') return;

    // Inside any field Backspace means "delete a character", never "go back a
    // step". Checked on both the event target and the focused element so a
    // field that swallows the event still counts.
    if (isTextEntryTarget(e.target) || isTextEntryTarget(document.activeElement)) return;

    // A step behind an open modal isn't what the user is looking at.
    const modal = document.getElementById('detailModal');
    if (modal && modal.classList.contains('open')) return;

    e.preventDefault();
    goBack();
});

// Initialisation
// Steps only pick up an inline display:none once they've been transitioned away
// from, so any step never visited on this run (the reading-path summary, for
// one) stayed laid out — an invisible 80vh block padding the document's scroll
// height. Hide them up front; transitionTo sets display explicitly from here on.
document.querySelectorAll('.step:not(.active)').forEach(el => { el.style.display = 'none'; });
document.getElementById('step-1').appendChild(buildThemePicker());
applyTheme(document.documentElement.dataset.theme);
validateTopic();
updateDots(1);