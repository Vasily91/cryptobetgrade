// Shared across every page: who's logged in (real accounts, via a
// one-time email link — see /api/auth/*), and the small nav/modal
// widget that goes with it. Loaded with <script src="/site.js"></script>.
//
// This is separate from the older client-side "admin" password gate
// some pages still have for editing the curated operator dataset —
// that's a different, unrelated thing from real user accounts.

let CBG_USER = null; // { email, is_admin } | null, filled in by checkSession()

async function cbgCheckSession(){
  try{
    const res = await fetch("/api/me");
    const data = await res.json();
    CBG_USER = data.user || null;
  }catch(e){
    CBG_USER = null;
  }
  cbgRenderNavAuth();
  return CBG_USER;
}

function cbgRenderNavAuth(){
  const slot = document.getElementById("navAuthSlot");
  if(!slot) return;
  if(CBG_USER){
    slot.innerHTML = `
      ${CBG_USER.is_admin ? `<a href="admin-complaints.html" class="link-muted">Admin</a>` : ""}
      <div class="nav-user-menu" id="cbgUserMenu">
        <button type="button" class="nav-user-trigger" onclick="cbgToggleUserMenu()" aria-haspopup="true" aria-expanded="false" aria-controls="cbgUserMenuPanel" title="${CBG_USER.email}">
          <span class="nav-user-email">${cbgTruncateEmail(CBG_USER.email)}</span>
          <svg class="nav-user-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div class="nav-user-menu-panel" id="cbgUserMenuPanel">
          <button type="button" class="nav-user-menu-item" onclick="return cbgUserMenuFileComplaint()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
            File a complaint
          </button>
        </div>
      </div>
      <button class="btn btn-outline btn-sm" onclick="cbgLogout()">Log out</button>
    `;
    cbgBindUserMenuListeners();
  } else {
    slot.innerHTML = `
      <a href="#" class="link-muted" onclick="return cbgOpenAuthModal()">Log in</a>
      <a href="#" class="btn btn-outline btn-sm" onclick="return cbgOpenAuthModal()">Sign up</a>
    `;
  }
  // Some pages also carry a duplicate "File a complaint" entry inside the
  // mobile hamburger panel (hidden by default in markup) — keep it in sync
  // with login state too. The top-bar dropdown above is desktop-only (see
  // #cbgUserMenu's mobile breakpoint rule in each page's own stylesheet);
  // this is how mobile users reach the same feature.
  const mobileItem = document.getElementById("mobileNavFileComplaint");
  if(mobileItem) mobileItem.style.display = CBG_USER ? "" : "none";
}

// ---- Nav "<email> ▾" dropdown (desktop) — currently just "File a
// complaint", more items expected here later. --------------------------

function cbgToggleUserMenu(){
  const panel = document.getElementById("cbgUserMenuPanel");
  const trigger = document.querySelector(".nav-user-trigger");
  if(!panel || !trigger) return;
  const isOpen = panel.classList.toggle("open");
  trigger.setAttribute("aria-expanded", isOpen ? "true" : "false");
}
function cbgCloseUserMenu(){
  const panel = document.getElementById("cbgUserMenuPanel");
  const trigger = document.querySelector(".nav-user-trigger");
  if(panel) panel.classList.remove("open");
  if(trigger) trigger.setAttribute("aria-expanded", "false");
}
let cbgUserMenuListenersBound = false;
function cbgBindUserMenuListeners(){
  if(cbgUserMenuListenersBound) return;
  cbgUserMenuListenersBound = true;
  document.addEventListener("click", e => {
    const menu = document.getElementById("cbgUserMenu");
    if(menu && !menu.contains(e.target)) cbgCloseUserMenu();
  });
  document.addEventListener("keydown", e => {
    if(e.key === "Escape") cbgCloseUserMenu();
  });
}
function cbgUserMenuFileComplaint(){
  cbgCloseUserMenu();
  return cbgFileComplaintNavClick();
}

// "File a complaint" click handler, shared by the nav dropdown item and the
// mobile-panel duplicate. On dashboard.html itself (where the operator
// picker + file-complaint modal actually live), open the picker in place
// instead of navigating. On every other page, let the link through to
// dashboard.html?file=1, which auto-opens the picker on load (see the inline
// script after site.js in dashboard.html).
function cbgFileComplaintNavClick(){
  if(typeof cbgOpenComplaintPicker === "function"){
    cbgOpenComplaintPicker();
    return false;
  }
  return true;
}

function cbgTruncateEmail(email){
  return email.length > 22 ? email.slice(0, 19) + "…" : email;
}

// ---- Auth modal: email in, magic link out -------------------------------

function cbgOpenAuthModal(){
  const modal = document.getElementById("authModal");
  if(!modal) return false;
  document.getElementById("authStep1").style.display = "";
  document.getElementById("authStep2").style.display = "none";
  document.getElementById("authEmail").value = "";
  document.getElementById("authError").style.display = "none";
  modal.classList.add("open");
  return false;
}
function cbgCloseAuthModal(){
  document.getElementById("authModal").classList.remove("open");
}
async function cbgSubmitAuthEmail(){
  const input = document.getElementById("authEmail");
  const email = input.value.trim();
  const errorEl = document.getElementById("authError");
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    errorEl.textContent = "Enter a valid email address.";
    errorEl.style.display = "block";
    input.focus();
    return;
  }
  errorEl.style.display = "none";
  const btn = document.getElementById("authSubmitBtn");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try{
    const res = await fetch("/api/auth/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, redirect: location.pathname + location.hash }),
    });
    if(!res.ok){
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Couldn't send the link. Try again.");
    }
    document.getElementById("authStep1").style.display = "none";
    document.getElementById("authStep2").style.display = "";
    document.getElementById("authStep2Email").textContent = email;
  }catch(e){
    errorEl.textContent = e.message;
    errorEl.style.display = "block";
  }finally{
    btn.disabled = false;
    btn.textContent = "Send login link";
  }
}
async function cbgLogout(){
  await fetch("/api/auth/logout", { method: "POST" });
  location.reload();
}

// The auth modal markup itself — injected once per page so every page
// only needs the <div id="navAuthSlot"></div> placeholder and this
// script tag, not the full modal HTML copy-pasted everywhere.
function cbgInjectAuthModal(){
  if(document.getElementById("authModal")) return;
  const div = document.createElement("div");
  div.innerHTML = `
<div class="modal-bg" id="authModal">
  <div class="modal">
    <div id="authStep1">
      <h3>Log in or sign up</h3>
      <p class="hint">No password — enter your email and we'll send a one-time login link. New here? The same box creates your account.</p>
      <input type="email" id="authEmail" placeholder="you@example.com" style="width:100%;padding:11px 14px;border:1.5px solid var(--line);border-radius:10px;font-size:14px;margin-bottom:10px;box-sizing:border-box;" onkeydown="if(event.key==='Enter')cbgSubmitAuthEmail()">
      <p id="authError" style="display:none;color:var(--critical-ink);font-size:13px;margin:0 0 10px;"></p>
      <div class="modal-actions">
        <button class="btn btn-outline btn-sm" onclick="cbgCloseAuthModal()">Cancel</button>
        <button class="btn btn-sm" id="authSubmitBtn" onclick="cbgSubmitAuthEmail()">Send login link</button>
      </div>
    </div>
    <div id="authStep2" style="display:none;">
      <h3>Check your email</h3>
      <p class="hint">We sent a login link to <b id="authStep2Email"></b>. It's valid for 15 minutes — click it on this device to finish logging in.</p>
      <div class="modal-actions">
        <button class="btn" onclick="cbgCloseAuthModal()">Got it</button>
      </div>
    </div>
  </div>
</div>`;
  document.body.appendChild(div.firstElementChild);
}

document.addEventListener("DOMContentLoaded", () => {
  cbgInjectAuthModal();
  // Stashed on window so a page can `await window.cbgSessionReady` to know
  // CBG_USER has been resolved (e.g. dashboard.html deciding whether a
  // ?file=1 link should auto-open the complaint picker or the login modal).
  window.cbgSessionReady = cbgCheckSession();
  const bg = document.getElementById("authModal");
  if(bg) bg.addEventListener("click", e => { if(e.target === bg) cbgCloseAuthModal(); });
});
