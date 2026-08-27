// CryptoBetGrade backend Worker.
//
// Serves the static site (via the ASSETS binding — see wrangler.jsonc)
// for every request, except paths under /api/*, which this script
// handles directly: passwordless email-link accounts, and the
// complaint submission / admin-review / message-thread system.
//
// Design choices, and why:
//  - No passwords anywhere. Logging in means typing your email and
//    clicking a one-time link sent to it. Nothing to leak in a breach.
//  - New complaints never go public on their own. They land as
//    "pending_review" and only become visible once an admin approves
//    them — see the moderation queue in the admin panel.
//  - Admin rights aren't a database flag someone has to set by hand —
//    they're granted automatically to any email listed in the
//    ADMIN_EMAILS environment variable the moment that email logs in.

const SESSION_COOKIE = "cbg_session";
const SESSION_DAYS = 30;
const MAGIC_LINK_MINUTES = 15;

// ---------------------------------------------------------------------
// SEO-friendly server-rendered pages: /sportsbooks/{id}, /sportsbooks/{id}/
// complaints, /complaints/{slug}. See seo-pages.js for why these exist and
// how they're generated/kept in sync with dashboard.html.
// ---------------------------------------------------------------------
import { matchSeoRoute, renderSeoPage } from "./seo-pages.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        if (err instanceof HttpError) {
          return json({ error: err.message }, err.status);
        }
        console.error("API error:", err);
        return json({ error: "Something went wrong on our end. Try again shortly." }, 500);
      }
    }

    const seoMatch = matchSeoRoute(url.pathname);
    if (seoMatch) {
      const rendered = renderSeoPage(seoMatch);
      if (rendered) {
        return new Response(rendered, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      // Path had the right shape (e.g. /sportsbooks/not-a-real-one) but no
      // matching operator/complaint — fall through to the normal static
      // 404 page rather than inventing content.
    }

    // Everything else is a static file (index.html, dashboard.html, ...).
    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/auth/request-link" && method === "POST") {
    return requestMagicLink(request, env);
  }
  if (pathname === "/api/auth/verify" && method === "GET") {
    return verifyMagicLink(request, env, url);
  }
  if (pathname === "/api/auth/logout" && method === "POST") {
    return logout(request, env);
  }
  if (pathname === "/api/me" && method === "GET") {
    return meEndpoint(request, env);
  }

  if (pathname === "/api/complaints" && method === "GET") {
    return listComplaints(request, env, url);
  }
  if (pathname === "/api/complaints" && method === "POST") {
    return submitComplaint(request, env);
  }

  const singleMatch = pathname.match(/^\/api\/complaints\/(\d+)$/);
  if (singleMatch && method === "GET") {
    return getComplaint(request, env, Number(singleMatch[1]));
  }

  const messagesMatch = pathname.match(/^\/api\/complaints\/(\d+)\/messages$/);
  if (messagesMatch && method === "POST") {
    return postMessage(request, env, Number(messagesMatch[1]));
  }

  if (pathname === "/api/admin/complaints" && method === "GET") {
    return adminListComplaints(request, env, url);
  }
  const adminStatusMatch = pathname.match(/^\/api\/admin\/complaints\/(\d+)$/);
  if (adminStatusMatch && method === "PATCH") {
    return adminUpdateComplaintStatus(request, env, Number(adminStatusMatch[1]));
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------
// Auth: request a magic link
// ---------------------------------------------------------------------

async function requestMagicLink(request, env) {
  const body = await safeJson(request);
  const email = normalizeEmail(body?.email);
  if (!email || !isValidEmail(email)) {
    return json({ error: "Enter a valid email address." }, 400);
  }

  // Throttle: skip sending (but still report success, so we don't leak
  // who has an account or invite repeated-send abuse) if this email
  // already has an unexpired, unused link from the last 60 seconds.
  const recent = await env.DB.prepare(
    `SELECT token FROM magic_links WHERE email = ? AND expires_at > datetime('now') AND created_at > datetime('now', '-60 seconds') LIMIT 1`
  ).bind(email).first();

  if (!recent) {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + MAGIC_LINK_MINUTES * 60_000).toISOString();
    await env.DB.prepare(
      `INSERT INTO magic_links (token, email, expires_at) VALUES (?, ?, ?)`
    ).bind(token, email, expiresAt).run();

    const redirect = typeof body?.redirect === "string" ? body.redirect : "/";
    const link = `${env.SITE_URL}/api/auth/verify?token=${token}&redirect=${encodeURIComponent(redirect)}`;
    await sendMagicLinkEmail(env, email, link);
  }

  return json({ ok: true, message: "If that's a valid address, a login link is on its way." });
}

async function sendMagicLinkEmail(env, email, link) {
  if (!env.RESEND_API_KEY) {
    // No email provider configured yet — log it so local/dev testing
    // still works, but don't pretend an email went out.
    console.warn(`RESEND_API_KEY not set — would have emailed ${email}: ${link}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${env.SITE_NAME || "CryptoBetGrade"} <login@${new URL(env.SITE_URL).hostname}>`,
      to: [email],
      subject: "Your CryptoBetGrade login link",
      text: `Click to log in (expires in ${MAGIC_LINK_MINUTES} minutes):\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
      html: `<p>Click below to log in. This link expires in ${MAGIC_LINK_MINUTES} minutes.</p><p><a href="${link}">${link}</a></p><p>If you didn't request this, you can ignore this email.</p>`,
    }),
  });
  if (!res.ok) {
    console.error("Resend send failed:", res.status, await res.text());
  }
}

// ---------------------------------------------------------------------
// Auth: verify a magic link, start a session
// ---------------------------------------------------------------------

async function verifyMagicLink(request, env, url) {
  const token = url.searchParams.get("token");
  const redirect = url.searchParams.get("redirect") || "/";
  if (!token) return htmlMessage("Missing login link. Request a new one from the site.", 400);

  const row = await env.DB.prepare(
    `SELECT email, expires_at FROM magic_links WHERE token = ?`
  ).bind(token).first();

  // One-time use: delete immediately regardless of outcome.
  await env.DB.prepare(`DELETE FROM magic_links WHERE token = ?`).bind(token).run();

  if (!row) return htmlMessage("This login link is invalid or was already used. Request a new one.", 400);
  if (new Date(row.expires_at) < new Date()) {
    return htmlMessage("This login link expired. Request a new one — they're valid for 15 minutes.", 400);
  }

  const email = row.email;
  const adminEmails = (env.ADMIN_EMAILS || "").split(",").map(e => normalizeEmail(e)).filter(Boolean);
  const isAdmin = adminEmails.includes(email) ? 1 : 0;

  let user = await env.DB.prepare(`SELECT id, is_admin FROM users WHERE email = ?`).bind(email).first();
  if (!user) {
    const inserted = await env.DB.prepare(
      `INSERT INTO users (email, is_admin) VALUES (?, ?) RETURNING id, is_admin`
    ).bind(email, isAdmin).first();
    user = inserted;
  } else if (isAdmin && !user.is_admin) {
    // Email was added to ADMIN_EMAILS after the account already existed.
    await env.DB.prepare(`UPDATE users SET is_admin = 1 WHERE id = ?`).bind(user.id).run();
    user.is_admin = 1;
  }

  const sessionToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  ).bind(sessionToken, user.id, expiresAt).run();

  const headers = new Headers();
  headers.set("Set-Cookie", cookieHeader(SESSION_COOKIE, sessionToken, SESSION_DAYS * 86400));
  headers.set("Location", redirect);
  return new Response(null, { status: 302, headers });
}

async function logout(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
  }
  const headers = new Headers();
  headers.set("Set-Cookie", cookieHeader(SESSION_COOKIE, "", 0));
  return json({ ok: true }, 200, headers);
}

async function meEndpoint(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ user: null });
  return json({ user: { email: user.email, is_admin: !!user.is_admin } });
}

// ---------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------

async function currentUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.is_admin FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).bind(token).first();
  return row || null;
}

async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, "Log in to do that.");
  return user;
}

async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (!user.is_admin) throw new HttpError(403, "Admins only.");
  return user;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------------
// Complaints: public read
// ---------------------------------------------------------------------

const PUBLIC_STATUSES = ["open", "awaiting_response", "resolved", "rejected"];

async function listComplaints(request, env, url) {
  const slug = url.searchParams.get("operator_slug");
  if (!slug) return json({ error: "operator_slug is required" }, 400);

  const placeholders = PUBLIC_STATUSES.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, operator_slug, operator_name, title, description, amount, status, created_at, updated_at
     FROM complaints
     WHERE operator_slug = ? AND status IN (${placeholders})
     ORDER BY created_at DESC`
  ).bind(slug, ...PUBLIC_STATUSES).all();

  return json({ complaints: rows.results || [] });
}

async function getComplaint(request, env, id) {
  const complaint = await env.DB.prepare(
    `SELECT id, operator_slug, operator_name, submitter_user_id, title, description, amount, status, created_at, updated_at
     FROM complaints WHERE id = ?`
  ).bind(id).first();
  if (!complaint) return json({ error: "Not found" }, 404);

  if (!PUBLIC_STATUSES.includes(complaint.status)) {
    // Pending/removed complaints are only visible to the submitter or an admin.
    const user = await currentUser(request, env);
    const allowed = user && (user.is_admin || user.id === complaint.submitter_user_id);
    if (!allowed) return json({ error: "Not found" }, 404);
  }

  const messages = await env.DB.prepare(
    `SELECT id, author_role, body, created_at FROM complaint_messages WHERE complaint_id = ? ORDER BY created_at ASC`
  ).bind(id).all();

  return json({ complaint, messages: messages.results || [] });
}

// ---------------------------------------------------------------------
// Complaints: submit (auth required, starts pending_review)
// ---------------------------------------------------------------------

async function submitComplaint(request, env) {
  const user = await requireUser(request, env);
  const body = await safeJson(request);

  const operatorSlug = trimmed(body?.operator_slug);
  const operatorName = trimmed(body?.operator_name);
  const title = trimmed(body?.title);
  const description = trimmed(body?.description);
  const amount = trimmed(body?.amount) || null;

  if (!operatorSlug || !operatorName) return json({ error: "Missing operator." }, 400);
  if (!title || title.length < 6 || title.length > 140) {
    return json({ error: "Title should be 6-140 characters." }, 400);
  }
  if (!description || description.length < 30 || description.length > 6000) {
    return json({ error: "Please describe what happened in at least 30 characters." }, 400);
  }

  const inserted = await env.DB.prepare(
    `INSERT INTO complaints (operator_slug, operator_name, submitter_user_id, title, description, amount, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending_review') RETURNING id`
  ).bind(operatorSlug, operatorName, user.id, title, description, amount).first();

  // The description doubles as the first message in the thread, so the
  // admin-facing view and the public view (once approved) are one
  // consistent timeline rather than a separate "description" field.
  await env.DB.prepare(
    `INSERT INTO complaint_messages (complaint_id, author_user_id, author_role, body) VALUES (?, ?, 'submitter', ?)`
  ).bind(inserted.id, user.id, description).run();

  return json({ ok: true, id: inserted.id, status: "pending_review" });
}

// ---------------------------------------------------------------------
// Complaints: message thread (submitter or admin, after submission)
// ---------------------------------------------------------------------

async function postMessage(request, env, complaintId) {
  const user = await requireUser(request, env);
  const complaint = await env.DB.prepare(
    `SELECT id, submitter_user_id, status FROM complaints WHERE id = ?`
  ).bind(complaintId).first();
  if (!complaint) return json({ error: "Not found" }, 404);

  const isSubmitter = user.id === complaint.submitter_user_id;
  if (!isSubmitter && !user.is_admin) return json({ error: "Not your complaint." }, 403);
  if (complaint.status === "pending_review" && !user.is_admin) {
    return json({ error: "This complaint hasn't been reviewed yet." }, 403);
  }

  const body = await safeJson(request);
  const text = trimmed(body?.body);
  if (!text || text.length < 1 || text.length > 4000) {
    return json({ error: "Message can't be empty (max 4000 characters)." }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO complaint_messages (complaint_id, author_user_id, author_role, body) VALUES (?, ?, ?, ?)`
  ).bind(complaintId, user.id, isSubmitter ? "submitter" : "admin", text).run();

  await env.DB.prepare(`UPDATE complaints SET updated_at = datetime('now') WHERE id = ?`).bind(complaintId).run();

  return json({ ok: true });
}

// ---------------------------------------------------------------------
// Admin: moderation queue + status changes
// ---------------------------------------------------------------------

async function adminListComplaints(request, env, url) {
  await requireAdmin(request, env);
  const status = url.searchParams.get("status");
  const query = status
    ? env.DB.prepare(
        `SELECT c.id, c.operator_slug, c.operator_name, c.title, c.status, c.created_at, u.email AS submitter_email
         FROM complaints c JOIN users u ON u.id = c.submitter_user_id
         WHERE c.status = ? ORDER BY c.created_at DESC`
      ).bind(status)
    : env.DB.prepare(
        `SELECT c.id, c.operator_slug, c.operator_name, c.title, c.status, c.created_at, u.email AS submitter_email
         FROM complaints c JOIN users u ON u.id = c.submitter_user_id
         ORDER BY c.created_at DESC`
      );
  const rows = await query.all();
  return json({ complaints: rows.results || [] });
}

const ALLOWED_STATUSES = ["open", "awaiting_response", "resolved", "rejected", "removed"];

async function adminUpdateComplaintStatus(request, env, id) {
  const admin = await requireAdmin(request, env);
  const body = await safeJson(request);
  const status = body?.status;
  if (!ALLOWED_STATUSES.includes(status)) {
    return json({ error: `status must be one of: ${ALLOWED_STATUSES.join(", ")}` }, 400);
  }

  const existing = await env.DB.prepare(`SELECT id, status FROM complaints WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);

  const firstReview = existing.status === "pending_review";
  if (firstReview) {
    await env.DB.prepare(
      `UPDATE complaints SET status = ?, updated_at = datetime('now'), reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?`
    ).bind(status, admin.id, id).run();
  } else {
    await env.DB.prepare(
      `UPDATE complaints SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(status, id).run();
  }

  return json({ ok: true, status });
}

// ---------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------

function json(data, status = 200, extraHeaders) {
  const headers = extraHeaders instanceof Headers ? extraHeaders : new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

function htmlMessage(message, status = 200) {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <div style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;text-align:center;padding:0 20px;">
    <p style="font-size:15px;color:#333;">${escapeHtml(message)}</p>
    <a href="/" style="color:#0b6e4f;font-weight:600;">Back to CryptoBetGrade</a>
  </div>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
}

function trimmed(v) { return typeof v === "string" ? v.trim() : ""; }

function normalizeEmail(v) { return typeof v === "string" ? v.trim().toLowerCase() : ""; }

function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function cookieHeader(name, value, maxAgeSeconds) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}
