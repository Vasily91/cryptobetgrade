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
      try {
        const rendered = await renderSeoPage(seoMatch, env, request);
        if (rendered) {
          return new Response(rendered, {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        // Path had the right shape (e.g. /sportsbooks/not-a-real-one) but no
        // matching operator/complaint — fall through to the normal static
        // 404 page rather than inventing content.
      } catch (err) {
        console.error("SEO page render error:", err);
        // Fall through to the normal static 404 rather than leaking internals.
      }
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

  if (pathname === "/api/reviews" && method === "GET") {
    return listReviews(request, env, url);
  }
  if (pathname === "/api/reviews" && method === "POST") {
    return submitReview(request, env);
  }

  if (pathname === "/api/admin/reviews" && method === "GET") {
    return adminListReviews(request, env, url);
  }
  const adminReviewStatusMatch = pathname.match(/^\/api\/admin\/reviews\/(\d+)$/);
  if (adminReviewStatusMatch && method === "PATCH") {
    return adminUpdateReviewStatus(request, env, Number(adminReviewStatusMatch[1]));
  }
  if (pathname === "/api/admin/migrate-reviews" && method === "POST") {
    return adminMigrateReviews(request, env);
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

// Admin notification — fired off after a new community complaint is filed
// (see submitComplaint below), so whoever's listed in ADMIN_EMAILS finds out
// there's something to review instead of having to keep checking
// admin-complaints.html. Best-effort: a failure here is logged but never
// blocks the complaint submission itself (see the try/catch around the call).
async function sendComplaintNotificationEmail(env, complaint) {
  const adminEmails = (env.ADMIN_EMAILS || "").split(",").map(e => e.trim()).filter(Boolean);
  if (!adminEmails.length) {
    console.warn("ADMIN_EMAILS not set — skipping new-complaint notification email.");
    return;
  }
  if (!env.RESEND_API_KEY) {
    console.warn(`RESEND_API_KEY not set — would have emailed ${adminEmails.join(", ")} about complaint #${complaint.id}`);
    return;
  }
  const reviewUrl = `${env.SITE_URL}/admin-complaints.html`;
  const amountLine = complaint.amount ? `Amount at stake: ${complaint.amount}\n` : "";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${env.SITE_NAME || "CryptoBetGrade"} <complaints@${new URL(env.SITE_URL).hostname}>`,
      to: adminEmails,
      subject: `New complaint: ${complaint.operatorName} — ${complaint.title}`,
      text: `A new complaint was filed and needs review.\n\nSportsbook: ${complaint.operatorName}\nTitle: ${complaint.title}\n${amountLine}Submitted by: ${complaint.submitterEmail}\n\nWhat happened:\n${complaint.description}\n\nReview it: ${reviewUrl}`,
      html: `<p>A new complaint was filed and needs review.</p>
        <p><b>Sportsbook:</b> ${escapeHtml(complaint.operatorName)}<br>
        <b>Title:</b> ${escapeHtml(complaint.title)}<br>
        ${complaint.amount ? `<b>Amount at stake:</b> ${escapeHtml(complaint.amount)}<br>` : ""}
        <b>Submitted by:</b> ${escapeHtml(complaint.submitterEmail)}</p>
        <p><b>What happened:</b><br>${escapeHtml(complaint.description).replace(/\n/g, "<br>")}</p>
        <p><a href="${reviewUrl}">Review it on admin-complaints.html</a></p>`,
    }),
  });
  if (!res.ok) {
    console.error("Resend send failed (complaint notification):", res.status, await res.text());
  }
}

// Admin notification — fired off after a new community review is submitted
// (see submitReview below), same reasoning and same ADMIN_EMAILS/Resend
// setup as sendComplaintNotificationEmail above. The full review text is
// included right in the email body — not just a link — so the admin can
// read and judge it without opening admin-complaints.html first; the link
// is still there for the actual approve/reject action. Best-effort: a
// failure here is logged but never blocks the review submission itself
// (see the try/catch around the call in submitReview).
async function sendReviewNotificationEmail(env, review) {
  const adminEmails = (env.ADMIN_EMAILS || "").split(",").map(e => e.trim()).filter(Boolean);
  if (!adminEmails.length) {
    console.warn("ADMIN_EMAILS not set — skipping new-review notification email.");
    return;
  }
  if (!env.RESEND_API_KEY) {
    console.warn(`RESEND_API_KEY not set — would have emailed ${adminEmails.join(", ")} about review #${review.id}`);
    return;
  }
  const reviewUrl = `${env.SITE_URL}/admin-complaints.html`;
  const stars = "★".repeat(review.rating) + "☆".repeat(5 - review.rating);
  const titleLine = review.title ? `Title: ${review.title}\n` : "";
  const titleHtml = review.title ? `<b>Title:</b> ${escapeHtml(review.title)}<br>` : "";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${env.SITE_NAME || "CryptoBetGrade"} <reviews@${new URL(env.SITE_URL).hostname}>`,
      to: adminEmails,
      subject: `New review: ${review.operatorName} — ${review.rating}/5 stars`,
      text: `A new review was submitted and needs approval.\n\nSportsbook: ${review.operatorName}\nRating: ${stars} (${review.rating}/5)\n${titleLine}Submitted by: ${review.submitterEmail}\n\nReview:\n${review.body}\n\nApprove or reject it: ${reviewUrl}`,
      html: `<p>A new review was submitted and needs approval.</p>
        <p><b>Sportsbook:</b> ${escapeHtml(review.operatorName)}<br>
        <b>Rating:</b> ${stars} (${review.rating}/5)<br>
        ${titleHtml}
        <b>Submitted by:</b> ${escapeHtml(review.submitterEmail)}</p>
        <p><b>Review:</b><br>${escapeHtml(review.body).replace(/\n/g, "<br>")}</p>
        <p><a href="${reviewUrl}">Approve or reject it on admin-complaints.html</a></p>`,
    }),
  });
  if (!res.ok) {
    console.error("Resend send failed (review notification):", res.status, await res.text());
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

  // Best-effort admin notification — never fail the submission itself over
  // an email hiccup, the complaint is already safely saved above.
  try {
    await sendComplaintNotificationEmail(env, {
      id: inserted.id, operatorName, title, description, amount,
      submitterEmail: user.email,
    });
  } catch (e) {
    console.error("New-complaint notification email failed:", e);
  }

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
// Reviews: public read (approved only) + summary
// ---------------------------------------------------------------------
//
// Mirrors the complaints system above (same auth, same pending_review ->
// admin-decides flow), but simpler: a review is a one-shot 1-5 star
// rating + text, not a back-and-forth thread, so its lifecycle is just
// pending_review -> approved | rejected (see d1-schema.sql). One review
// per (operator, user), enforced by a unique index — see submitReview.

async function listReviews(request, env, url) {
  const slug = url.searchParams.get("operator_slug");
  if (!slug) return json({ error: "operator_slug is required" }, 400);

  const rows = await env.DB.prepare(
    `SELECT r.id, r.rating, r.title, r.body, r.created_at, u.email AS submitter_email
     FROM reviews r JOIN users u ON u.id = r.submitter_user_id
     WHERE r.operator_slug = ? AND r.status = 'approved'
     ORDER BY r.created_at DESC`
  ).bind(slug).all();
  const rawReviews = rows.results || [];

  const count = rawReviews.length;
  const average = count ? rawReviews.reduce((sum, r) => sum + r.rating, 0) / count : null;

  // Never expose a submitter's real email to the public list — mask it
  // the way the rest of the site keeps submitter identity out of public
  // views (the complaint thread shows "Submitter", never an email).
  const reviews = rawReviews.map(r => ({
    id: r.id, rating: r.rating, title: r.title, body: r.body, created_at: r.created_at,
    submitter: maskEmail(r.submitter_email),
  }));

  return json({ reviews, summary: { count, average } });
}

// ---------------------------------------------------------------------
// Reviews: submit (auth required, starts pending_review)
// ---------------------------------------------------------------------

async function submitReview(request, env) {
  const user = await requireUser(request, env);
  const body = await safeJson(request);

  const operatorSlug = trimmed(body?.operator_slug);
  const operatorName = trimmed(body?.operator_name);
  const rating = Number(body?.rating);
  const title = trimmed(body?.title) || null;
  const reviewBody = trimmed(body?.body);

  if (!operatorSlug || !operatorName) return json({ error: "Missing operator." }, 400);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return json({ error: "Pick a rating from 1 to 5 stars." }, 400);
  }
  if (title && title.length > 100) {
    return json({ error: "Title is too long (max 100 characters)." }, 400);
  }
  if (!reviewBody || reviewBody.length < 20 || reviewBody.length > 3000) {
    return json({ error: "Please describe your experience in at least 20 characters." }, 400);
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM reviews WHERE operator_slug = ? AND submitter_user_id = ?`
  ).bind(operatorSlug, user.id).first();
  if (existing) return json({ error: "You've already reviewed this sportsbook." }, 409);

  let inserted;
  try {
    inserted = await env.DB.prepare(
      `INSERT INTO reviews (operator_slug, operator_name, submitter_user_id, rating, title, body, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_review') RETURNING id`
    ).bind(operatorSlug, operatorName, user.id, rating, title, reviewBody).first();
  } catch (e) {
    // Race with another submission from the same user — the unique index
    // (operator_slug, submitter_user_id) is the real guard; the SELECT
    // above is just a friendlier first check.
    return json({ error: "You've already reviewed this sportsbook." }, 409);
  }

  // Best-effort admin notification — never fail the submission itself over
  // an email hiccup, the review is already safely saved above.
  try {
    await sendReviewNotificationEmail(env, {
      id: inserted.id, operatorName, rating, title, body: reviewBody,
      submitterEmail: user.email,
    });
  } catch (e) {
    console.error("New-review notification email failed:", e);
  }

  return json({ ok: true, id: inserted.id, status: "pending_review" });
}

// ---------------------------------------------------------------------
// Admin: reviews moderation queue + status changes
// ---------------------------------------------------------------------

async function adminListReviews(request, env, url) {
  await requireAdmin(request, env);
  const status = url.searchParams.get("status");
  const query = status
    ? env.DB.prepare(
        `SELECT r.id, r.operator_slug, r.operator_name, r.rating, r.title, r.body, r.status, r.created_at, u.email AS submitter_email
         FROM reviews r JOIN users u ON u.id = r.submitter_user_id
         WHERE r.status = ? ORDER BY r.created_at DESC`
      ).bind(status)
    : env.DB.prepare(
        `SELECT r.id, r.operator_slug, r.operator_name, r.rating, r.title, r.body, r.status, r.created_at, u.email AS submitter_email
         FROM reviews r JOIN users u ON u.id = r.submitter_user_id
         ORDER BY r.created_at DESC`
      );
  const rows = await query.all();
  return json({ reviews: rows.results || [] });
}

const REVIEW_ALLOWED_STATUSES = ["approved", "rejected"];

async function adminUpdateReviewStatus(request, env, id) {
  const admin = await requireAdmin(request, env);
  const body = await safeJson(request);
  const status = body?.status;
  if (!REVIEW_ALLOWED_STATUSES.includes(status)) {
    return json({ error: `status must be one of: ${REVIEW_ALLOWED_STATUSES.join(", ")}` }, 400);
  }

  const existing = await env.DB.prepare(`SELECT id FROM reviews WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);

  await env.DB.prepare(
    `UPDATE reviews SET status = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?`
  ).bind(status, admin.id, id).run();

  return json({ ok: true, status });
}

// ---------------------------------------------------------------------
// Admin: one-time (idempotent) reviews table migration.
//
// This pipeline deploys by uploading files through GitHub's web UI, with
// no wrangler/CLI access to the live D1 database — so there's no way to
// run `wrangler d1 execute --file=d1-schema.sql` directly. Instead, an
// admin session hits this endpoint once (the admin-complaints.html
// Reviews tab does this automatically on first open) and it creates the
// table + indexes via the Worker's own DB binding. Every statement uses
// IF NOT EXISTS, so calling it again later is always a harmless no-op.
// ---------------------------------------------------------------------

async function adminMigrateReviews(request, env) {
  await requireAdmin(request, env);

  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS reviews (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    operator_slug      TEXT NOT NULL,
    operator_name      TEXT NOT NULL,
    submitter_user_id  INTEGER NOT NULL REFERENCES users(id),
    rating             INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    title              TEXT,
    body               TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending_review',
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at        TEXT,
    reviewed_by        INTEGER REFERENCES users(id)
  )`).run();
  await env.DB.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_one_per_user ON reviews(operator_slug, submitter_user_id)`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_reviews_operator_slug ON reviews(operator_slug)`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status)`
  ).run();

  return json({ ok: true, message: "reviews table ready." });
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

// "ko*******1@gmail.com" — enough for a reader to tell two reviews came
// from different people without exposing a real, findable email address.
function maskEmail(email) {
  const at = (email || "").indexOf("@");
  if (at < 1) return "Verified user";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  const hiddenLen = Math.max(local.length - visible.length, 3);
  return `${visible}${"*".repeat(hiddenLen)}@${domain}`;
}

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
