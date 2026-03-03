/*
 * twitter-login.js — Auto-generates X/Twitter session cookies
 *
 * Uses X's mobile app API endpoints to authenticate and get session cookies.
 * No browser/Chromium required — pure HTTPS requests, ~0 RAM overhead.
 *
 * Usage:
 *   const { autoLoginTwitter } = require('./twitter-login');
 *   await autoLoginTwitter(); // writes cookies to /tmp/cookies.txt
 *
 * Requires env vars:
 *   TWITTER_EMAIL    — your burner X account email
 *   TWITTER_PASSWORD — your burner X account password
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const IS_RENDER    = !!process.env.RENDER;
const COOKIES_PATH = IS_RENDER
    ? '/tmp/cookies.txt'
    : path.join(__dirname, 'cookies.txt');

// X mobile app credentials — these are public/hardcoded in the official app
// They identify the "client" (the app itself), not the user
const BEARER_TOKEN  = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const X_CLIENT_UUID = '00000000-0000-0000-0000-000000000000';

// ── Low-level HTTPS helper ────────────────────────────────────────────────────
function httpsRequest(options, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                resolve({
                    status:  res.statusCode,
                    headers: res.headers,
                    body:    data,
                    json:    () => {
                        try { return JSON.parse(data); }
                        catch { throw new Error('JSON parse failed: ' + data.slice(0, 100)); }
                    },
                });
            });
        });
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

// ── Step 1: Get a guest token ─────────────────────────────────────────────────
async function getGuestToken() {
    const res = await httpsRequest({
        hostname: 'api.twitter.com',
        path:     '/1.1/guest/activate.json',
        method:   'POST',
        headers:  {
            'Authorization':   'Bearer ' + BEARER_TOKEN,
            'Content-Length':  '0',
            'Content-Type':    'application/json',
            'User-Agent':      'TwitterAndroid/10.21.0-release.0 (310210000-r-0) ONEPLUS+A3010/9 (OnePlus;ONEPLUS+A3010;OnePlus;OnePlus3;0;;1;2016)',
            'X-Twitter-Client-Language': 'en',
        },
    }, '');

    if (res.status !== 200) throw new Error('Guest token failed: HTTP ' + res.status);
    const j = res.json();
    if (!j.guest_token) throw new Error('No guest_token in response');
    console.log('[twitter-login] Guest token obtained');
    return j.guest_token;
}

// ── Step 2: Init login flow ───────────────────────────────────────────────────
async function initLoginFlow(guestToken) {
    const body = JSON.stringify({
        input_flow_data: {
            flow_context: {
                debug_overrides: {},
                start_location: { location: 'splash_screen' },
            },
        },
        subtask_versions: {
            action_list: 2, alert_dialog: 1, app_download_cta: 1,
            check_logged_in_account: 1, choice_selection: 3,
            contacts_live_sync_permission_prompt: 0, cta: 7,
            email_verification: 2, end_flow: 1, enter_date: 1,
            enter_email: 2, enter_password: 5, enter_phone: 2,
            enter_recaptcha: 1, enter_text: 5, enter_username: 2,
            generic_urt: 3, in_app_notification: 1, interest_picker: 3,
            js_instrumentation: 1, menu_dialog: 1, notifications_permission_prompt: 2,
            open_account: 2, open_home_timeline: 1, open_link: 1,
            phone_verification: 4, privacy_options: 1, security_key: 3,
            select_avatar: 4, select_banner: 2, settings_list: 7,
            show_code: 1, sign_up: 2, sign_up_review: 4,
            tweet_selection_urt: 1, update_users: 1, upload_media: 1,
            user_recommendations_list: 4, user_recommendations_urt: 1,
            wait_spinner: 3, web_modal: 1,
        },
    });

    const res = await httpsRequest({
        hostname: 'api.twitter.com',
        path:     '/1.1/onboarding/task.json?flow_name=login',
        method:   'POST',
        headers:  {
            'Authorization':        'Bearer ' + BEARER_TOKEN,
            'Content-Type':         'application/json',
            'User-Agent':           'TwitterAndroid/10.21.0-release.0',
            'X-Guest-Token':        guestToken,
            'X-Twitter-Client-Language': 'en',
            'X-Twitter-Active-User': 'yes',
            'Content-Length':       Buffer.byteLength(body),
        },
    }, body);

    if (res.status !== 200) throw new Error('Init flow failed: HTTP ' + res.status);
    const ct0 = (res.headers['set-cookie'] || [])
        .map(c => c.match(/ct0=([^;]+)/))
        .filter(Boolean)[0]?.[1] || '';
    const flowToken = res.json().flow_token;
    if (!flowToken) throw new Error('No flow_token in init response');
    console.log('[twitter-login] Login flow initiated');
    return { flowToken, ct0 };
}

// ── Step 3: Submit a subtask (email, password, etc.) ─────────────────────────
async function submitSubtask(guestToken, ct0, flowToken, subtasks) {
    const body = JSON.stringify({ flow_token: flowToken, subtask_inputs: subtasks });

    const res = await httpsRequest({
        hostname: 'api.twitter.com',
        path:     '/1.1/onboarding/task.json',
        method:   'POST',
        headers:  {
            'Authorization':         'Bearer ' + BEARER_TOKEN,
            'Content-Type':          'application/json',
            'User-Agent':            'TwitterAndroid/10.21.0-release.0',
            'X-Guest-Token':         guestToken,
            'X-Csrf-Token':          ct0,
            'X-Twitter-Active-User': 'yes',
            'X-Twitter-Client-Language': 'en',
            'Content-Length':        Buffer.byteLength(body),
            'Cookie':                `ct0=${ct0}; guest_token=${guestToken}`,
        },
    }, body);

    // Collect any new cookies from response
    const newCt0 = (res.headers['set-cookie'] || [])
        .map(c => c.match(/ct0=([^;]+)/))
        .filter(Boolean)[0]?.[1] || ct0;

    const authToken = (res.headers['set-cookie'] || [])
        .map(c => c.match(/auth_token=([^;]+)/))
        .filter(Boolean)[0]?.[1] || null;

    let j;
    try { j = res.json(); } catch { throw new Error('Subtask parse error, HTTP ' + res.status); }

    if (j.errors) throw new Error('Subtask error: ' + JSON.stringify(j.errors));

    return { flowToken: j.flow_token, ct0: newCt0, authToken, subtaskId: j.subtasks?.[0]?.subtask_id };
}

// ── Main: full login flow ─────────────────────────────────────────────────────
async function autoLoginTwitter() {
    const email    = process.env.TWITTER_EMAIL;
    const password = process.env.TWITTER_PASSWORD;

    if (!email || !password) {
        console.log('[twitter-login] TWITTER_EMAIL / TWITTER_PASSWORD not set — skipping auto-login');
        return false;
    }

    console.log('[twitter-login] Starting auto-login for', email);

    try {
        // Step 1: Guest token
        const guestToken = await getGuestToken();

        // Step 2: Init flow
        let { flowToken, ct0 } = await initLoginFlow(guestToken);

        // Step 3: JS instrumentation (required handshake)
        ({ flowToken, ct0 } = await submitSubtask(guestToken, ct0, flowToken, [{
            subtask_id: 'LoginJsInstrumentationSubtask',
            js_instrumentation: { response: '{}', link: 'next_link' },
        }]));

        // Step 4: Enter email/username
        ({ flowToken, ct0 } = await submitSubtask(guestToken, ct0, flowToken, [{
            subtask_id: 'LoginEnterUserIdentifierSSO',
            settings_list: {
                setting_responses: [{
                    key:           'user_identifier',
                    response_data: { text_data: { result: email } },
                }],
                link: 'next_link',
            },
        }]));

        // Step 5: Enter password
        const { flowToken: ft2, ct0: ct1, authToken } = await submitSubtask(guestToken, ct0, flowToken, [{
            subtask_id: 'LoginEnterPassword',
            enter_password: { password, link: 'next_link' },
        }]);

        if (!authToken) {
            // Try one more step — account duplication check
            const { authToken: at2, ct0: ct2 } = await submitSubtask(guestToken, ct1, ft2, [{
                subtask_id: 'AccountDuplicationCheck',
                check_logged_in_account: { link: 'AccountDuplicationCheck_false' },
            }]);
            if (!at2) throw new Error('No auth_token received after all steps');
            return writeCookies(guestToken, at2, ct2, email);
        }

        return writeCookies(guestToken, authToken, ct1, email);

    } catch (e) {
        console.error('[twitter-login] ❌ Auto-login failed:', e.message);
        return false;
    }
}

// ── Write cookies.txt in Netscape format ──────────────────────────────────────
function writeCookies(guestToken, authToken, ct0, email) {
    const expiry = Math.floor(Date.now() / 1000) + (365 * 24 * 3600); // 1 year
    const lines = [
        '# Netscape HTTP Cookie File',
        '# Auto-generated by OmniFetch twitter-login.js',
        '# Do not edit manually',
        '',
        // auth_token — the main session cookie
        `.twitter.com\tTRUE\t/\tTRUE\t${expiry}\tauth_token\t${authToken}`,
        `.x.com\tTRUE\t/\tTRUE\t${expiry}\tauth_token\t${authToken}`,
        // ct0 — CSRF token, required alongside auth_token
        `.twitter.com\tTRUE\t/\tFALSE\t${expiry}\tct0\t${ct0}`,
        `.x.com\tTRUE\t/\tFALSE\t${expiry}\tct0\t${ct0}`,
        // guest_token — for unauthenticated fallback requests
        `.twitter.com\tTRUE\t/\tFALSE\t${expiry}\tguest_token\t${guestToken}`,
        `.x.com\tTRUE\t/\tFALSE\t${expiry}\tguest_token\t${guestToken}`,
    ].join('\n');

    try {
        fs.writeFileSync(COOKIES_PATH, lines, 'utf8');
        console.log(`[twitter-login] ✅ Cookies written to ${COOKIES_PATH} for ${email}`);
        console.log('[twitter-login] auth_token:', authToken.slice(0, 8) + '...');
        return true;
    } catch (e) {
        console.error('[twitter-login] ❌ Failed to write cookies:', e.message);
        return false;
    }
}

// ── Schedule auto-refresh every 12 hours ─────────────────────────────────────
function scheduleRefresh() {
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;
    setInterval(async () => {
        console.log('[twitter-login] Refreshing cookies...');
        await autoLoginTwitter();
    }, TWELVE_HOURS);
}

module.exports = { autoLoginTwitter, scheduleRefresh };