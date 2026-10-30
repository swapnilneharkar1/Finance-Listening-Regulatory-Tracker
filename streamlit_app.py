"""
Finance Listening Portal on Streamlit, with login and per-user regulator access.

- Users, passwords (hashed) and allowed regulators live in Streamlit secrets
  (App settings -> Secrets). See secrets_example.toml.
- Access is enforced server-side: data for regulators a user is not allowed to
  see is removed before the page is sent to their browser.
- Generate password hashes with: python make_password_hash.py
- "Forgot password" emails a 6-digit code (needs [smtp] and [password_store]).
- "Request access" emails the admins a ready-to-paste Secrets block (needs ADMIN_EMAILS).
"""
import base64
import calendar
import hashlib
import hmac
import html as html_lib
import json
import os
import re
import secrets as secrets_mod
import smtplib
import time
from email.message import EmailMessage
from pathlib import Path

import requests
import streamlit as st
import streamlit.components.v1 as components

REPO = "Finanace-Listening-Portal/Regulatory-Tracking"
BRANCH = "main"
HTML_FILE = "regulatory_tracker_live.html"
DATA_FILE = "data/regulatory_data.json"
RAW_URL = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/{DATA_FILE}"
ALL_REGULATORS = ["RBI", "SEBI", "BSE", "NSE", "IRDAI", "IEPFA", "MCA",
                  "NFRA", "PCAOB", "TAXATION", "NEWSLETTER", "TREASURY"]
REG_LABELS = {"TREASURY": "Treasury Peer Benchmarking"}


def reg_label(r: str) -> str:
    return REG_LABELS.get(r, r)


# Treasury Peer Benchmarking: built weekly by the "Treasury Peer Benchmarking" GitHub Action
# (scraper/treasury.js) from the NBFCs' annual reports, in the same repo as the regulator data.
TREASURY_FILE = "data/treasury/benchmark.json"
# AI-written commentary, produced on the VM by ai-treasury-commentary.js (Azure OpenAI).
TREASURY_AI_FILE = "data/treasury/ai_commentary.json"
# Repo where the "Treasury Peer Benchmarking" workflow runs and commits these files.
# Can be changed without editing code: add TREASURY_REPO = "owner/repo" to the app's Secrets.
TREASURY_REPO_DEFAULT = "swapnilneharkar1/Finance-Listening-Regulatory-Tracker"

BASE_DIR = Path(__file__).parent

st.set_page_config(page_title="Finance Listening Portal", page_icon="📊",
                   layout="wide", initial_sidebar_state="collapsed")

# Hide all Streamlit chrome on every screen
st.markdown(
    """
    <style>
      #MainMenu, header, footer, [data-testid="stToolbar"],
      [data-testid="stDecoration"], [data-testid="stStatusWidget"] {display: none !important;}
      .stApp {background: #f7f8fa;}
    </style>
    """,
    unsafe_allow_html=True,
)

# Streamlit Community Cloud adds a "Hosted with Streamlit" badge and the app owner's profile icon
# (bottom right) on its own page around the app. That page is served from the same address as the
# app, so this small script can reach it and hide both. Unofficial: if Streamlit ever isolates that
# page, the script silently does nothing. The owner's "Manage app" button is left alone.
HIDE_CLOUD_BADGES = """<script>
(function () {
  function hide() {
    var doc;
    try { doc = window.top.document; if (!doc || !doc.body || doc === document) return; } catch (e) { return; }
    if (!doc.getElementById('__hide_cloud_badges')) {
      var st = doc.createElement('style'); st.id = '__hide_cloud_badges';
      st.textContent = '[class*="viewerBadge"],[class*="ViewerBadge"],[class*="profileContainer"],[class*="ProfileContainer"],' +
        '[class*="profilePreview"],[data-testid="appCreatorAvatar"],[data-testid*="viewerBadge"]{display:none!important}';
      (doc.head || doc.body).appendChild(st);
    }
    // the badge links to streamlit.io, the avatar to the owner's profile: hide their floating boxes
    doc.querySelectorAll('a[href*="streamlit.io"], a[href*="/user/"]').forEach(function (a) {
      var n = a;
      for (var i = 0; i < 6 && n && n !== doc.body; i++) {
        if (doc.defaultView.getComputedStyle(n).position === 'fixed') { n.style.setProperty('display', 'none', 'important'); return; }
        n = n.parentElement;
      }
      a.style.setProperty('display', 'none', 'important');
    });
  }
  hide();
  try { new window.top.MutationObserver(hide).observe(window.top.document.body, { childList: true, subtree: true }); } catch (e) {}
  var k = 0, t = setInterval(function () { hide(); if (++k > 30) clearInterval(t); }, 1000);
})();
</script>"""
with st.container(key="cloudbadges"):
    components.html(HIDE_CLOUD_BADGES, height=0)
st.markdown("<style>.st-key-cloudbadges{display:none!important}</style>", unsafe_allow_html=True)


@st.cache_data
def load_asset(name: str) -> str:
    p = BASE_DIR / name
    return p.read_text(encoding="utf-8") if p.exists() else ""


@st.cache_data
def load_html() -> str:
    return (BASE_DIR / HTML_FILE).read_text(encoding="utf-8")


@st.cache_data
def company_logo() -> str:
    m = re.search(r'class="company-logo"[^>]*src="([^"]+)"', load_html())
    return m.group(1) if m else ""


# ───────────────────────── Authentication ─────────────────────────
# Only these email domains can reset passwords or request access
ALLOWED_EMAIL_DOMAINS = ("bajajfinserv.in", "bizsupportc.com", "bizsupporta.com")
OTP_TTL_SECONDS = 10 * 60
DEFAULT_ADMIN_EMAILS = ["swapnil.neharkar1@bajajfinserv.in"]  # used if ADMIN_EMAILS isn't in Secrets
DEFAULT_APP_URL = "https://finance-listening-regulatory-tracker.streamlit.app"
OTP_MAX_ATTEMPTS = 5
RESEND_COOLDOWN_SECONDS = 60
HASH_ITERATIONS = 200_000


def secret(key, default=None):
    try:
        return st.secrets.get(key, default)
    except FileNotFoundError:
        return default


def make_hash(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, HASH_ITERATIONS)
    return f"pbkdf2_sha256${HASH_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """stored format: pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>"""
    try:
        algo, iterations, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        calc = hashlib.pbkdf2_hmac("sha256", password.encode(),
                                   bytes.fromhex(salt_hex), int(iterations))
        return hmac.compare_digest(calc.hex(), hash_hex)
    except (ValueError, AttributeError):
        return False


def secrets_users() -> dict:
    try:
        return {k.lower(): dict(v) for k, v in st.secrets["users"].items()}
    except (KeyError, FileNotFoundError):
        return {}


def get_users() -> dict:
    """Users from Secrets, plus users approved in the portal (stored in GitHub)."""
    users = secrets_users()
    try:
        doc, _ = load_store()
    except (requests.RequestException, ValueError, KeyError):
        return users
    for name, extra in doc["users"].items():
        users[name] = {**users.get(name, {}), **extra}
    return users


def admin_emails() -> list[str]:
    admins = secret("ADMIN_EMAILS", DEFAULT_ADMIN_EMAILS)
    if isinstance(admins, str):
        admins = admins.split(",")
    return [a.strip().lower() for a in admins if a.strip()]


def is_admin(username: str, users: dict) -> bool:
    return str(users.get(username, {}).get("email", "")).strip().lower() in admin_emails()


def app_url() -> str:
    return str(secret("APP_URL", DEFAULT_APP_URL)).rstrip("/")


def allowed_regulators(user: dict) -> list[str]:
    regs = [str(r).upper() for r in user.get("regulators", [])]
    if "ALL" in regs:
        return ALL_REGULATORS
    return [r for r in ALL_REGULATORS if r in regs]  # keep portal order


def email_allowed(email: str) -> bool:
    email = email.strip().lower()
    if not re.fullmatch(r"[a-z0-9._%+\-]+@[a-z0-9.\-]+", email):
        return False
    return email.rsplit("@", 1)[1] in ALLOWED_EMAIL_DOMAINS


def domains_text() -> str:
    return ", ".join("@" + d for d in ALLOWED_EMAIL_DOMAINS)


def password_problem(pw: str, confirm: str, username: str = "") -> str | None:
    if len(pw) < 8:
        return "Password must be at least 8 characters."
    if not (re.search(r"[A-Za-z]", pw) and re.search(r"\d", pw)):
        return "Password must contain both letters and numbers."
    if username and username.lower() in pw.lower():
        return "Password must not contain your username."
    if pw != confirm:
        return "Passwords don't match."
    return None


# ── Portal store: approved users, reset passwords and access requests ──
# Kept in one JSON file in a private GitHub repo, because Streamlit Secrets are read-only.
def store_cfg() -> dict | None:
    cfg = secret("password_store")
    if cfg and cfg.get("repo") and cfg.get("token"):
        return dict(cfg)
    return None


def _store_request(method: str, cfg: dict, **kw) -> requests.Response:
    path = cfg.get("path", "portal_auth.json")
    return requests.request(
        method, f"https://api.github.com/repos/{cfg['repo']}/contents/{path}",
        headers={"Authorization": f"Bearer {cfg['token']}",
                 "Accept": "application/vnd.github+json"},
        timeout=20, **kw)


def _normalise(doc: dict) -> dict:
    if doc and not {"passwords", "users", "requests"} & set(doc):
        doc = {"passwords": doc}  # older file that only held reset passwords
    for key in ("passwords", "users", "requests", "directory", "visits"):
        doc.setdefault(key, {})
    return doc


@st.cache_data(ttl=30, show_spinner=False)
def load_store() -> tuple[dict, str | None]:
    """Returns (doc, file_sha). Raises if GitHub can't be reached (errors aren't cached)."""
    cfg = store_cfg()
    if not cfg:
        return _normalise({}), None
    r = _store_request("GET", cfg, params={"ref": cfg.get("branch", "main")})
    if r.status_code == 404:
        return _normalise({}), None
    r.raise_for_status()
    body = r.json()
    return _normalise(json.loads(base64.b64decode(body["content"]).decode() or "{}")), body["sha"]


def diagnose_store(status: int, cfg: dict) -> str:
    """Turn a GitHub error into a plain-English reason."""
    repo, branch = cfg["repo"], cfg.get("branch", "main")
    if status == 401:
        return ("GitHub rejected the token (it's wrong, expired or deleted). "
                "Create a new token and update [password_store] token in Secrets.")
    try:
        r = requests.get(f"https://api.github.com/repos/{repo}",
                         headers={"Authorization": f"Bearer {cfg['token']}",
                                  "Accept": "application/vnd.github+json"}, timeout=15)
    except requests.RequestException:
        return "Couldn't reach GitHub. Please try again in a minute."
    if r.status_code == 401:
        return ("GitHub rejected the token (it's wrong, expired or deleted). "
                "Create a new token and update [password_store] token in Secrets.")
    if r.status_code == 404:
        return (f"The token can't see the repo '{repo}'. Check the repo name and owner are exactly "
                "right in Secrets, and that the token's 'Repository access' includes it "
                "(and, for an organization repo, that the token isn't still pending approval).")
    if r.status_code == 200:
        info = r.json()
        if not info.get("permissions", {}).get("push", True) or status == 403:
            return (f"The token can read '{repo}' but can't write to it. Give the token "
                    "'Contents: Read and write' (or approve it in the organization's settings).")
        if info.get("size", 1) == 0 or status in (404, 409):
            return (f"The repo '{repo}' looks empty or has no '{branch}' branch. Add a README on "
                    f"GitHub (Add file -> Create new file) so the '{branch}' branch exists.")
    return f"GitHub returned an error ({status}). Check the [password_store] settings in Secrets."


def update_store(change, message: str) -> bool:
    """Apply change(doc) and save. Retries if someone else saved at the same moment.
    On failure, puts a plain-English reason in st.session_state.store_error."""
    st.session_state.pop("store_error", None)

    def fail(reason: str) -> bool:
        st.session_state.store_error = reason
        print(f"[store] FAILED: {reason}", flush=True)  # visible in Manage app -> logs
        return False

    cfg = store_cfg()
    if not cfg:
        return fail("The [password_store] section is missing from Secrets (or has no repo/token).")
    for _ in range(3):
        load_store.clear()
        try:
            doc, sha = load_store()
        except requests.HTTPError as e:
            return fail(diagnose_store(e.response.status_code if e.response is not None else 0, cfg))
        except requests.RequestException:
            return fail("Couldn't reach GitHub. Please try again in a minute.")
        doc = json.loads(json.dumps(doc))  # don't mutate the cached copy
        change(doc)
        payload = {"message": message,
                   "content": base64.b64encode(json.dumps(doc, indent=2).encode()).decode(),
                   "branch": cfg.get("branch", "main")}
        if sha:
            payload["sha"] = sha
        try:
            r = _store_request("PUT", cfg, json=payload)
        except requests.RequestException:
            return fail("Couldn't reach GitHub. Please try again in a minute.")
        if r.status_code in (200, 201):
            load_store.clear()
            return True
        if r.status_code == 409 and sha:
            continue  # someone else saved first; reload and retry
        return fail(diagnose_store(r.status_code, cfg))
    return fail("The file kept changing while saving. Please try again.")


def store_error_text(prefix: str) -> str:
    return f"{prefix} Reason: {st.session_state.get('store_error', 'unknown')}"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ───────────────────────── Usage tracking ─────────────────────────
# Each sign-in is recorded in the portal store (doc["visits"]): per user (first/last visit, total,
# sign-ins per day) and per day (sign-ins, distinct users). Dates are India time. Only usernames
# are kept: no IP addresses, devices or pages viewed.
IST_OFFSET = 5.5 * 3600
USER_DAYS_KEPT, DAILY_DAYS_KEPT = 180, 400


def ist_date(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime((ts or time.time()) + IST_OFFSET))


def record_visit(username: str, name: str) -> None:
    """Never blocks or breaks sign-in: on any problem the visit is simply not counted."""
    if not store_cfg():
        return
    today, stamp = ist_date(), now_iso()

    def change(doc):
        v = doc.setdefault("visits", {})
        u = v.setdefault("users", {}).setdefault(username, {"first": stamp, "count": 0, "days": {}})
        u["name"], u["last"] = name, stamp
        u["count"] = u.get("count", 0) + 1
        days = u.setdefault("days", {})
        days[today] = days.get(today, 0) + 1
        for d in sorted(days)[:-USER_DAYS_KEPT]:
            days.pop(d, None)
        daily = v.setdefault("daily", {})
        dd = daily.setdefault(today, {"logins": 0, "users": []})
        dd["logins"] = dd.get("logins", 0) + 1
        if username not in dd["users"]:
            dd["users"].append(username)
        for d in sorted(daily)[:-DAILY_DAYS_KEPT]:
            daily.pop(d, None)

    try:
        if not update_store(change, f"Sign-in: {username}"):
            st.session_state.pop("store_error", None)
    except Exception as e:  # noqa: BLE001 — usage stats must never stop anyone signing in
        print(f"[visits] not recorded: {e}", flush=True)


def save_override(username: str, password_hash: str) -> bool:
    def change(doc):
        doc["passwords"][username] = {"password_hash": password_hash, "updated_at": now_iso()}
    return update_store(change, f"Password reset for {username}")


def current_password_hash(username: str, user: dict) -> str | None:
    """Reset password wins over the stored one. None = store unreachable."""
    try:
        doc, _ = load_store()
    except (requests.RequestException, ValueError, KeyError):
        return None if store_cfg() else user.get("password_hash", "")
    entry = doc["passwords"].get(username)
    return entry["password_hash"] if entry else user.get("password_hash", "")


def notification_directory(users: dict) -> dict:
    """Who should get which email alerts: name, email and regulators only (no passwords)."""
    out = {}
    for uname, u in users.items():
        email = str(u.get("email", "")).strip().lower()
        regs = allowed_regulators(u)
        if email and regs:
            out[uname] = {"name": u.get("name", uname), "email": email, "regulators": regs,
                          "notify": bool(u.get("notify", True))}
    return out


def sync_directory(users: dict | None = None) -> None:
    """Keep the recipient list in portal-auth up to date for the scraper's email alerts.
    Only writes when something changed, so it's cheap to call often."""
    if not store_cfg():
        return
    users = users if users is not None else get_users()
    wanted = notification_directory(users)
    try:
        doc, _ = load_store()
    except (requests.RequestException, ValueError, KeyError):
        return
    if doc.get("directory", {}).get("users") == wanted:
        return

    def change(d):
        d["directory"] = {"users": wanted, "updated_at": now_iso(),
                          "note": "Written by the portal app; read by the scraper for email alerts."}
    if not update_store(change, "Update email alert recipients"):
        print(f"[directory] sync failed: {st.session_state.get('store_error')}", flush=True)


# ── Email ──
def send_email(to: list[str] | str, subject: str, body_html: str) -> bool:
    """Sends an email. On failure, stores a plain-English reason in st.session_state.email_error."""
    st.session_state.pop("email_error", None)

    def fail(reason: str) -> bool:
        st.session_state.email_error = reason
        print(f"[email] FAILED to {to}: {reason}", flush=True)  # visible in Manage app -> logs
        return False

    cfg = secret("smtp")
    if not cfg:
        return fail("Email isn't configured: the [smtp] section is missing from the app's Secrets.")
    if not cfg.get("user") or not cfg.get("password"):
        return fail("Email isn't configured: [smtp] needs both 'user' and 'password' in Secrets.")
    host, port = cfg.get("host", "smtp.office365.com"), int(cfg.get("port", 587))
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"Finance Listening Portal <{cfg['user']}>"
    msg["To"] = ", ".join(to) if isinstance(to, list) else to
    msg.set_content("Please view this email in an HTML-capable client.")
    msg.add_alternative(body_html, subtype="html")
    try:
        with smtplib.SMTP(host, port, timeout=20) as server:
            server.starttls()
            server.login(cfg["user"], cfg["password"])
            server.send_message(msg)
        return True
    except smtplib.SMTPAuthenticationError as e:
        detail = e.smtp_error.decode(errors="ignore") if isinstance(e.smtp_error, bytes) else str(e.smtp_error)
        if "disabled" in detail.lower() or "5.7.139" in detail:
            return fail("The mailbox refused login because SMTP AUTH is disabled for it. "
                        "Ask IT to enable 'Authenticated SMTP' for this mailbox in Microsoft 365.")
        return fail(f"The mailbox refused the username/password ({e.smtp_code}). "
                    "Check [smtp] user and password in Secrets.")
    except smtplib.SMTPRecipientsRefused:
        return fail("The mail server refused the recipient address.")
    except smtplib.SMTPSenderRefused as e:
        return fail(f"The mail server refused to send from {cfg['user']} ({e.smtp_code}).")
    except (TimeoutError, ConnectionError, OSError) as e:
        return fail(f"Couldn't connect to {host}:{port} ({type(e).__name__}). "
                    "Check host/port in Secrets.")
    except smtplib.SMTPException as e:
        return fail(f"The mail server returned an error: {e}")


def email_error_text(prefix: str) -> str:
    return f"{prefix} Reason: {st.session_state.get('email_error', 'unknown')}"


def email_shell(title: str, inner: str) -> str:
    return f"""<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;
    border:1px solid #e2e6ea;border-radius:10px;overflow:hidden">
    <div style="background:#1a56db;color:#fff;padding:14px 22px;font-weight:600">Finance Listening Portal</div>
    <div style="padding:22px;color:#1a2030;font-size:14px;line-height:1.6">
    <h2 style="font-size:17px;margin:0 0 12px">{title}</h2>{inner}</div></div>"""


# ── Screens ──
LOGIN_CSS = """
<style>
  html, body, .stApp, input, button, label, p, textarea {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
  }
  .block-container, [data-testid="stMainBlockContainer"] {max-width: 460px !important; padding-top: 9vh !important;}
  .login-brand {
    display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px;
    background: #fff; border: 1px solid #e2e6ea; border-bottom: none;
    border-radius: 10px 10px 0 0; padding: 22px 28px 18px;
  }
  .login-brand img {height: 46px;}
  .login-brand h1 {font-size: 19px !important; font-weight: 700 !important;
                   color: #1a2030 !important; margin: 0 !important; padding: 0 !important; line-height: 1.25; white-space: nowrap;}
  .login-brand p {font-size: 13px; color: #5a6474; margin: 2px 0 0;}
  [data-testid="stForm"] {
    background: #fff; border: 1px solid #e2e6ea; border-top: 1px solid #eef0f3;
    border-radius: 0 0 10px 10px; padding: 22px 28px 26px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.06);
  }
  [data-testid="stForm"] label p {font-size: 13px !important; font-weight: 600; color: #5a6474;}
  [data-testid="stForm"] input, [data-testid="stForm"] textarea {font-size: 14px !important; background: #fff !important;}
  [data-testid="stForm"] [data-baseweb="input"] *, [data-testid="stForm"] [data-baseweb="input"] button,
  [data-testid="stForm"] [data-baseweb="textarea"] *, [data-testid="stForm"] [data-baseweb="select"] > div {background-color: #fff !important;}
  [data-testid="stForm"] [data-baseweb="input"], [data-testid="stForm"] [data-baseweb="textarea"],
  [data-testid="stForm"] [data-baseweb="select"] > div {
    background: #fff !important; border: 1px solid #e2e6ea !important; border-radius: 8px !important;
  }
  [data-testid="stForm"] [data-baseweb="input"]:focus-within {border-color: #1a56db !important;}
  [data-testid="stFormSubmitButton"] button {
    background: #1a56db !important; color: #fff !important; border: none !important;
    border-radius: 8px !important; height: 42px; font-weight: 600 !important; margin-top: 6px;
  }
  [data-testid="stFormSubmitButton"] button:hover {background: #1546b8 !important;}
  .login-links {display: flex; justify-content: center; gap: 0;}
  [class*="st-key-link_"] button {
    background: none !important; border: none !important; box-shadow: none !important;
    color: #1a56db !important; font-size: 13px !important; font-weight: 600 !important;
    padding: 4px 0 !important; min-height: 0 !important;
  }
  [class*="st-key-link_"] button:hover {text-decoration: underline;}
  [class*="st-key-link_"] {display: flex !important; justify-content: center !important; width: 100% !important; margin-top: 8px;}
  [class*="st-key-link_"] > div {display: flex; justify-content: center; width: 100%;}
  [data-testid="stForm"] [data-testid="stMultiSelect"] [data-baseweb="select"] > div {background: #fff !important;}
  .login-hint {font-size: 12px; color: #5a6474; margin: -4px 0 8px;}
  [class*="st-key-reject_"] button {background: #fff !important; color: #c0392b !important;
                                    border: 1px solid #e8b4ae !important;}
  [class*="st-key-reject_"] button:hover {background: #fdf2f1 !important;}
  [data-testid="stMultiSelectTagsContainer"] [data-tag] {background: #e8f0fe !important; color: #1a56db !important;}
  [data-testid="stMultiSelectTagsContainer"] [data-tag] * {color: #1a56db !important; background: transparent !important;}
  .login-foot {text-align: center; font-size: 12px; color: #9aa3b0; margin-top: 18px;}
</style>
"""


def brand(subtitle: str):
    st.markdown(LOGIN_CSS, unsafe_allow_html=True)
    st.markdown(
        f"""<div class="login-brand">
          <img src="{company_logo()}" alt="Bajaj Finance"/>
          <div><h1>Finance Listening Portal</h1><p>{html_lib.escape(subtitle)}</p></div>
        </div>""",
        unsafe_allow_html=True,
    )


def go(view: str):
    st.session_state.view = view
    st.rerun()


def flash() -> bool:
    msg = st.session_state.pop("flash", None)
    if msg:
        st.success(msg)
    return bool(msg)


def footer():
    st.markdown("<div class='login-foot'>Bajaj Finserv · Internal use only</div>",
                unsafe_allow_html=True)


def view_login(users: dict):
    brand("Sign in to continue")
    if st.session_state.get("review_id"):
        st.info("Sign in as an admin to review the access request.")
    with st.form("login"):
        username = st.text_input("Username", placeholder="Enter your username").strip().lower()
        password = st.text_input("Password", type="password", placeholder="Enter your password")
        submitted = st.form_submit_button("Sign in", use_container_width=True)
    flash()

    if submitted:
        user = users.get(username)
        stored = current_password_hash(username, user) if user else ""
        if user and stored is None:
            st.error("Can't verify your password right now. Please try again in a minute.")
        elif user and verify_password(password, stored):
            regs = ALL_REGULATORS if is_admin(username, users) else allowed_regulators(user)
            if not regs:
                st.error("Your account has no regulators assigned. Use 'Request access' below.")
            else:
                st.session_state.auth = {"username": username,
                                         "name": user.get("name", username),
                                         "regulators": regs}
                st.session_state.pop("data", None)  # fetch fresh data after every login
                sync_directory(users)
                record_visit(username, user.get("name", username))
                st.rerun()
        else:
            st.error("Invalid username or password.")

    c1, c2 = st.columns(2)
    with c1:
        if st.button("Forgot password?", key="link_forgot"):
            go("forgot")
    with c2:
        if st.button("Request access", key="link_request"):
            go("request")
    footer()


def view_forgot(users: dict):
    brand("Reset your password")
    with st.form("forgot"):
        email = st.text_input("Registered email", placeholder="name@bajajfinserv.in").strip().lower()
        st.markdown(f"<div class='login-hint'>Allowed domains: {domains_text()}</div>",
                    unsafe_allow_html=True)
        submitted = st.form_submit_button("Send verification code", use_container_width=True)

    if submitted:
        last = st.session_state.get("reset", {}).get("sent_at", 0)
        if not email_allowed(email):
            st.error(f"Please use your work email ({domains_text()}).")
        elif time.time() - last < RESEND_COOLDOWN_SECONDS:
            st.error(f"Please wait {int(RESEND_COOLDOWN_SECONDS - (time.time() - last))}s before requesting another code.")
        elif not store_cfg():
            st.error("Password reset isn't set up yet. Please contact the portal admin.")
        else:
            match = next((u for u, d in users.items()
                          if str(d.get("email", "")).strip().lower() == email), None)
            state = {"email": email, "username": match, "otp_hash": None,
                     "expires": time.time() + OTP_TTL_SECONDS, "attempts": 0,
                     "sent_at": time.time()}
            if match:
                code = f"{secrets_mod.randbelow(1_000_000):06d}"
                state["otp_hash"] = hashlib.sha256(code.encode()).hexdigest()
                ok = send_email(email, "Your password reset code", email_shell(
                    "Password reset code",
                    f"<p>Hi {html_lib.escape(users[match].get('name', match))},</p>"
                    f"<p>Your verification code is:</p>"
                    f"<p style='font-size:28px;font-weight:700;letter-spacing:6px;color:#1a56db'>{code}</p>"
                    f"<p>It expires in {OTP_TTL_SECONDS // 60} minutes. Your username is "
                    f"<b>{html_lib.escape(match)}</b>.</p>"
                    "<p style='color:#5a6474'>If you didn't ask for this, ignore this email; "
                    "your password won't change.</p>"))
                if not ok:
                    st.error(email_error_text("Couldn't send the email."))
                    st.stop()
            st.session_state.reset = state
            st.session_state.flash = ("If this email is registered, a 6-digit code has been sent to it. "
                                      "Check your inbox (and spam).")
            go("verify")

    if st.button("Back to sign in", key="link_back_f"):
        go("login")
    footer()


def view_verify(users: dict):
    brand("Enter code and new password")
    reset = st.session_state.get("reset")
    if not reset:
        go("forgot")
    with st.form("verify"):
        code = st.text_input("6-digit code", max_chars=6, placeholder="123456").strip()
        pw = st.text_input("New password", type="password",
                           placeholder="At least 8 characters, letters and numbers")
        pw2 = st.text_input("Confirm new password", type="password")
        submitted = st.form_submit_button("Reset password", use_container_width=True)
    flash()

    if submitted:
        reset["attempts"] += 1
        username = reset.get("username")
        if reset["attempts"] > OTP_MAX_ATTEMPTS:
            st.session_state.pop("reset", None)
            st.error("Too many attempts. Please request a new code.")
        elif time.time() > reset["expires"]:
            st.error("This code has expired. Please request a new one.")
        elif not (reset.get("otp_hash") and hmac.compare_digest(
                hashlib.sha256(code.encode()).hexdigest(), reset["otp_hash"])):
            st.error("Incorrect code.")
        elif problem := password_problem(pw, pw2, username or ""):
            st.error(problem)
        elif not save_override(username, make_hash(pw)):
            st.error(store_error_text("Couldn't save your new password."))
        else:
            send_email(reset["email"], "Your password was changed", email_shell(
                "Password changed",
                f"<p>The password for <b>{html_lib.escape(username)}</b> was just changed.</p>"
                "<p style='color:#5a6474'>If this wasn't you, contact the portal admin immediately.</p>"))
            st.session_state.pop("reset", None)
            st.session_state.flash = "Password updated. You can sign in now."
            go("login")

    if st.button("Didn't get a code? Request again", key="link_resend"):
        go("forgot")
    if st.button("Back to sign in", key="link_back_v"):
        go("login")
    footer()


def view_request(users: dict):
    brand("Request access")
    with st.form("request"):
        name = st.text_input("Full name").strip()
        email = st.text_input("Work email", placeholder="name@bajajfinserv.in").strip().lower()
        st.markdown(f"<div class='login-hint'>Allowed domains: {domains_text()}</div>",
                    unsafe_allow_html=True)
        regs = st.multiselect("Regulators you need", ALL_REGULATORS, format_func=reg_label,
                              placeholder="Choose one or more")
        reason = st.text_area("Reason / team", height=80)
        pw = st.text_input("Choose a password", type="password",
                           placeholder="At least 8 characters, letters and numbers")
        pw2 = st.text_input("Confirm password", type="password")
        submitted = st.form_submit_button("Send request", use_container_width=True)

    if submitted:
        base = re.sub(r"[^a-z0-9_]", "_", email.split("@")[0]) if "@" in email else ""
        username, n = base, 2
        while username in users:
            username, n = f"{base}{n}", n + 1
        existing = next((u for u, d in users.items()
                         if str(d.get("email", "")).strip().lower() == email), None)
        admins = admin_emails()
        last = st.session_state.get("last_request", 0)

        if not name:
            st.error("Please enter your name.")
        elif not email_allowed(email):
            st.error(f"Please use your work email ({domains_text()}).")
        elif not regs:
            st.error("Please choose at least one regulator.")
        elif not reason.strip():
            st.error("Please tell the admin why you need access.")
        elif not existing and (problem := password_problem(pw, pw2, username)):
            st.error(problem)
        elif time.time() - last < 300:
            st.error("You've just sent a request. Please wait a few minutes before sending another.")
        elif not admins:
            st.error("Access requests aren't set up yet. Please contact the portal admin directly.")
        else:
            safe = html_lib.escape
            details = (f"<p><b>Name:</b> {safe(name)}<br><b>Email:</b> {safe(email)}<br>"
                       f"<b>Regulators:</b> {safe(', '.join(regs))}<br>"
                       f"<b>Reason:</b> {safe(reason)}</p>")
            kind = (f"Existing user <b>{safe(existing)}</b> asks for more regulators."
                    if existing else f"New user request (username will be <b>{safe(username)}</b>).")
            if store_cfg():
                rid = secrets_mod.token_urlsafe(16)
                req = {"name": name, "email": email, "username": existing or username,
                       "existing": bool(existing), "regulators": regs, "reason": reason,
                       "status": "pending", "created_at": now_iso()}
                if not existing:
                    req["password_hash"] = make_hash(pw)
                def add_request(d):
                    for r in d["requests"].values():  # a newer request replaces an older pending one
                        if r.get("status") == "pending" and r.get("email") == email:
                            r.pop("password_hash", None)
                            r.update({"status": "superseded", "decided_by": "system",
                                      "decided_at": now_iso()})
                    d["requests"][rid] = req

                if not update_store(add_request, f"Access request from {email}"):
                    st.error(store_error_text("Couldn't save your request."))
                    st.stop()
                link = f"{app_url()}/?review={rid}"
                ok = send_email(admins, f"Portal access request: {name}", email_shell(
                    "Access request", f"<p>{kind}</p>{details}"
                    f"<p style='margin:22px 0'><a href='{link}' style='background:#1a56db;color:#fff;"
                    "padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600'>"
                    "Review &amp; approve</a></p>"
                    "<p style='color:#5a6474;font-size:12px'>Opens the portal; sign in as admin, "
                    "then click Approve or Reject. Access is granted immediately on approval.</p>"))
            else:  # no store configured: fall back to a block the admin pastes into Secrets
                if existing:
                    current = allowed_regulators(users[existing])
                    merged = [r for r in ALL_REGULATORS if r in set(current) | set(regs)]
                    block = (f"[users.{existing}]  # existing user - update the regulators line only\n"
                             f"regulators = {json.dumps(merged)}")
                else:
                    block = (f"[users.{username}]\nname = {json.dumps(name)}\n"
                             f"email = {json.dumps(email)}\npassword_hash = \"{make_hash(pw)}\"\n"
                             f"regulators = {json.dumps(regs)}")
                ok = send_email(admins, f"Portal access request: {name}", email_shell(
                    "Access request", f"<p>{kind}</p>{details}"
                    "<p><b>To approve:</b> paste this into the app's Secrets and save.</p>"
                    f"<pre style='background:#f7f8fa;border:1px solid #e2e6ea;border-radius:6px;"
                    f"padding:12px;font-size:12px;white-space:pre-wrap'>{safe(block)}</pre>"))
            if not ok:
                st.error(email_error_text("Couldn't send your request."))
            else:
                send_email(email, "We received your access request", email_shell(
                    "Request received",
                    f"<p>Hi {safe(name)},</p><p>Your request for "
                    f"<b>{safe(', '.join(regs))}</b> has been sent to the portal admin. "
                    "You'll be able to sign in once it's approved"
                    + ("." if existing else
                       f", using username <b>{safe(username)}</b> and the password you chose.")
                    + "</p>"))
                st.session_state.last_request = time.time()
                st.session_state.flash = "Request sent. You'll get an email confirmation; the admin will review it."
                go("login")

    if st.button("Back to sign in", key="link_back_r"):
        go("login")
    footer()


def decide(rid: str, req: dict, approve: bool, regs: list[str]):
    """Approve or reject a request, email the requester, then rerun with a flash message."""
    safe = html_lib.escape
    status = "approved" if approve else "rejected"
    admin = auth_user()

    def change(d):
        r = d["requests"][rid]
        if r["status"] != "pending":
            return
        if approve:
            entry = d["users"].get(r["username"], {})
            if not r["existing"]:
                entry.update({"name": r["name"], "email": r["email"],
                              "password_hash": r["password_hash"]})
            entry.update({"regulators": regs, "approved_by": admin, "approved_at": now_iso()})
            d["users"][r["username"]] = entry
        r.pop("password_hash", None)
        r.update({"status": status, "decided_by": admin, "decided_at": now_iso(),
                  "granted": regs if approve else []})

    if not update_store(change, f"{status.title()} access request for {req['email']}"):
        st.error(store_error_text("Couldn't save the decision."))
        return
    if approve:
        sync_directory()
    if approve:
        body = (f"<p>Hi {safe(req['name'])},</p><p>Your access to the Finance Listening "
                f"Portal has been approved for <b>{safe(', '.join(regs))}</b>.</p>"
                f"<p>Sign in at <a href='{app_url()}'>{app_url()}</a> with username "
                f"<b>{safe(req['username'])}</b>"
                + (" and your existing password." if req["existing"]
                   else " and the password you chose.") + "</p>")
    else:
        body = (f"<p>Hi {safe(req['name'])},</p><p>Your access request for the Finance "
                "Listening Portal was not approved. Please contact the portal admin "
                "if you have questions.</p>")
    sent = send_email(req["email"], f"Portal access {status}",
                      email_shell(f"Access {status}", body))
    st.session_state.flash = (f"{req['name']}: request {status}. " + (
        "They have been emailed." if sent else email_error_text("Couldn't email them.")))
    st.rerun()


def request_summary(req: dict, users: dict) -> tuple[str, list[str]]:
    """Markdown description of a request, and the regulators to pre-tick."""
    safe = html_lib.escape
    current = allowed_regulators(users.get(req["username"], {})) if req["existing"] else []
    text = (f"**{safe(req['name'])}** · {safe(req['email'])}  \n"
            + (f"Existing user **{safe(req['username'])}**, currently has: "
               f"{', '.join(current) or 'nothing'}" if req["existing"]
               else f"New user · will sign in as **{safe(req['username'])}**")
            + f"  \n**Asked for:** {', '.join(req['regulators'])}"
            + f"  \n**Reason:** {safe(req['reason'])}"
            + f"  \n<span style='color:#9aa3b0;font-size:12px'>Requested {req.get('created_at', '')[:16].replace('T', ' ')} UTC</span>")
    default = [r for r in ALL_REGULATORS if r in set(current) | set(req["regulators"])]
    return text, default


def view_review(users: dict):
    rid = st.session_state.review_id
    brand("Review access request")
    safe = html_lib.escape

    def done_button():
        if st.button("Go to the portal", key="link_portal"):
            st.session_state.pop("review_id", None)
            st.query_params.clear()
            st.rerun()

    if not is_admin(auth_user(), users):
        st.error("Only portal admins can review access requests.")
        done_button(); footer(); st.stop()
    try:
        doc, _ = load_store()
    except requests.RequestException:
        st.error("Couldn't load the request right now. Please try again in a minute.")
        done_button(); footer(); st.stop()
    req = doc["requests"].get(rid)
    just_decided = flash()
    if not req:
        st.error("This request link isn't valid (it may have been removed).")
        done_button(); footer(); st.stop()
    if req["status"] != "pending":
        if not just_decided:
            st.info(f"This request was already **{req['status']}** by {req.get('decided_by', '?')} "
                    f"on {req.get('decided_at', '?')[:10]}.")
        done_button(); footer(); st.stop()

    text, default = request_summary(req, users)
    with st.form("review"):
        st.markdown(text, unsafe_allow_html=True)
        regs = st.multiselect("Regulators to grant", ALL_REGULATORS, default=default, format_func=reg_label)
        c1, c2 = st.columns(2)
        approve = c1.form_submit_button("Approve", use_container_width=True)
        reject = c2.form_submit_button("Reject", use_container_width=True, key="reject_btn")

    if approve and not regs:
        st.error("Choose at least one regulator, or reject the request.")
    elif approve or reject:
        decide(rid, req, approve, regs)

    done_button()
    footer()
    st.stop()


ADMIN_CSS = """
<style>
  .block-container, [data-testid="stMainBlockContainer"] {max-width: 900px !important; padding-top: 4vh !important;}
  .admin-head {display: flex; align-items: center; gap: 14px; background: #fff; border: 1px solid #e2e6ea;
               border-radius: 10px; padding: 14px 22px; margin-bottom: 14px;}
  .admin-head img {height: 36px;}
  .admin-head h1 {font-size: 18px !important; font-weight: 700 !important; margin: 0 !important; padding: 0 !important; color: #1a2030 !important;}
  .admin-head p {font-size: 12px; color: #5a6474; margin: 0;}
  [data-testid="stMetric"] {background: #fff; border: 1px solid #e2e6ea; border-radius: 10px; padding: 12px 16px;}
  [data-testid="stForm"] {border-radius: 10px !important; margin-bottom: 12px;}
  [data-testid="stTabs"] button p {font-weight: 600;}
  .st-key-back_portal button {background: #fff !important; border: 1px solid #e2e6ea !important; color: #1a2030 !important;}
</style>
"""


def admin_page(users: dict):
    st.markdown(LOGIN_CSS + ADMIN_CSS, unsafe_allow_html=True)
    sync_directory(users)
    safe = html_lib.escape
    h1, h2 = st.columns([5, 1.3])
    with h1:
        st.markdown(f"""<div class="admin-head"><img src="{company_logo()}"/>
            <div><h1>Admin</h1><p>Finance Listening Portal · signed in as {safe(auth_user())}</p></div></div>""",
                    unsafe_allow_html=True)
    with h2:
        st.write("")
        if st.button("← Back to portal", key="back_portal", use_container_width=True):
            st.session_state.pop("admin_view", None)
            st.rerun()

    try:
        doc, _ = load_store()
    except requests.RequestException:
        st.error("Couldn't load data from the portal store. Please try again in a minute.")
        st.stop()
    reqs = doc["requests"]
    pending = sorted(((rid, r) for rid, r in reqs.items() if r.get("status") == "pending"),
                     key=lambda x: x[1].get("created_at", ""))
    decided = sorted(((rid, r) for rid, r in reqs.items()
                      if r.get("status") in ("approved", "rejected")),
                     key=lambda x: x[1].get("decided_at", ""), reverse=True)
    flash()

    t_req, t_users, t_usage = st.tabs([f"Requests ({len(pending)} pending)", f"Users ({len(users)})", "Usage"])

    with t_req:
        if not store_cfg():
            st.info("Access requests need the [password_store] section in Secrets.")
        elif not pending:
            st.success("No pending requests.")
        for rid, req in pending:
            text, default = request_summary(req, users)
            with st.form(f"req_{rid}"):
                st.markdown(text, unsafe_allow_html=True)
                regs = st.multiselect("Regulators to grant", ALL_REGULATORS, default=default, format_func=reg_label,
                                      key=f"regs_{rid}")
                c1, c2, _ = st.columns([1, 1, 2])
                approve = c1.form_submit_button("Approve", use_container_width=True)
                reject = c2.form_submit_button("Reject", use_container_width=True,
                                               key=f"reject_{rid}")
            if approve and not regs:
                st.error("Choose at least one regulator, or reject the request.")
            elif approve or reject:
                decide(rid, req, approve, regs)

        if decided:
            st.markdown("##### Recent decisions")
            st.dataframe(
                [{"Name": r.get("name"), "Email": r.get("email"), "Username": r.get("username"),
                  "Decision": r.get("status", "").title(),
                  "Granted": ", ".join(r.get("granted", [])),
                  "By": r.get("decided_by"),
                  "On": r.get("decided_at", "")[:16].replace("T", " ")}
                 for _, r in decided[:25]],
                hide_index=True, use_container_width=True)

    with t_users:
        rows = []
        for uname, u in sorted(users.items()):
            regs = allowed_regulators(u)
            rows.append({
                "Name": u.get("name", uname), "Username": uname, "Email": u.get("email", ""),
                "Role": "Admin" if is_admin(uname, users) else "User",
                "Access": "ALL" if len(regs) == len(ALL_REGULATORS) else ", ".join(regs) or "—",
                "# Regulators": len(regs),
                "Added via": "Portal request" if uname in doc["users"] else "Secrets",
                "Email alerts": ("Off" if not u.get("notify", True)
                                 else "On" if u.get("email") and regs else "No email"),
                "Approved on": doc["users"].get(uname, {}).get("approved_at", "")[:10],
            })
        m1, m2, m3, m4 = st.columns(4)
        m1.metric("Total users", len(rows))
        m2.metric("Admins", sum(r["Role"] == "Admin" for r in rows))
        m3.metric("Full access", sum(r["# Regulators"] == len(ALL_REGULATORS) for r in rows))
        m4.metric("Pending requests", len(pending))

        st.markdown("##### Users per regulator")
        counts = {reg: sum(reg in allowed_regulators(u) for u in users.values()) for reg in ALL_REGULATORS}
        st.bar_chart(counts, height=220, color="#1a56db")

        st.markdown("##### All users")
        q = st.text_input("Filter", placeholder="Search name, username, email or regulator",
                          label_visibility="collapsed")
        reg_filter = st.multiselect("Has access to", ALL_REGULATORS, format_func=reg_label, key="user_reg_filter",
                                    placeholder="Filter by regulator")
        shown = [r for r in rows
                 if (not q or q.lower() in " ".join(str(v) for v in r.values()).lower())
                 and all(x in allowed_regulators(users[r["Username"]]) for x in reg_filter)]
        st.dataframe(shown, hide_index=True, use_container_width=True,
                     column_config={"# Regulators": st.column_config.NumberColumn(width="small")})
        st.caption(f"Showing {len(shown)} of {len(rows)} users. Users from Secrets are edited in "
                   "Streamlit → Settings → Secrets; approved users live in your portal-auth repo.")

    with t_usage:
        usage_tab(doc, users)
    st.stop()


def usage_tab(doc: dict, users: dict):
    v = doc.get("visits") or {}
    vu, daily = v.get("users", {}), v.get("daily", {})
    if not vu:
        st.info("No sign-ins recorded yet. From now on every sign-in is counted here.")
        return
    today = ist_date()
    last_n = lambda n: [ist_date(time.time() - i * 86400) for i in range(n)]  # noqa: E731
    d7, d30 = set(last_n(7)), set(last_n(30))
    active = lambda days: {u for u, x in vu.items() if days & set(x.get("days", {}))}  # noqa: E731

    m1, m2, m3, m4, m5 = st.columns(5)
    m1.metric("Users today", len(active({today})))
    m2.metric("Users, 7 days", len(active(d7)))
    m3.metric("Users, 30 days", len(active(d30)))
    m4.metric("Sign-ins, 30 days", sum(daily.get(d, {}).get("logins", 0) for d in d30))
    never = [u for u in users if u not in vu]
    m5.metric("Never signed in", len(never), help=", ".join(sorted(never)) or None)

    period = st.radio("Period", ["Last 30 days", "Last 90 days", "Last 12 months"], horizontal=True,
                      label_visibility="collapsed", key="usage_period")
    n = {"Last 30 days": 30, "Last 90 days": 90, "Last 12 months": 365}[period]
    days = sorted(last_n(n))
    st.markdown("##### Daily head count")
    st.caption("Distinct users who signed in each day (India time).")
    st.bar_chart({"Users": {d: len(daily.get(d, {}).get("users", [])) for d in days}}, height=220, color="#1a56db")

    in_period = set(days)
    rows = []
    for uname in sorted(set(users) | set(vu)):
        x, u = vu.get(uname, {}), users.get(uname, {})
        dd = x.get("days", {})
        last = x.get("last", "")
        last_ist = (time.strftime("%Y-%m-%d %H:%M", time.gmtime(calendar.timegm(time.strptime(last, "%Y-%m-%dT%H:%M:%SZ")) + IST_OFFSET))
                    if last else "")
        rows.append({
            "Name": x.get("name") or u.get("name", uname), "Username": uname, "Email": u.get("email", ""),
            "Last visit (IST)": last_ist or "never",
            f"Sign-ins ({period.lower()})": sum(c for d, c in dd.items() if d in in_period),
            f"Days active ({period.lower()})": sum(1 for d in dd if d in in_period),
            "Total sign-ins": x.get("count", 0),
            "First visit": x.get("first", "")[:10],
            "Status": "Removed user" if uname not in users else "",
        })
    rows.sort(key=lambda r: r["Last visit (IST)"] if r["Last visit (IST)"] != "never" else "", reverse=True)
    st.markdown("##### Visits by user")
    st.dataframe(rows, hide_index=True, use_container_width=True)
    import csv, io  # noqa: E401
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
    w.writeheader(); w.writerows(rows)  # noqa: E702
    st.download_button("Download as CSV", buf.getvalue().encode("utf-8-sig"), file_name=f"portal_usage_{today}.csv",
                       mime="text/csv")
    st.caption("A visit is counted each time someone signs in. Only usernames and times are kept "
               f"(no IP addresses or pages viewed). Per-user history is kept for {USER_DAYS_KEPT} days.")


def auth_user() -> str:
    return st.session_state.get("auth", {}).get("username", "")


def auth_screens():
    users = get_users()
    if not users and st.session_state.get("view", "login") == "login":
        brand("Sign in to continue")
        st.error("No users configured. Add a [users] section in the app's Secrets.")
        st.stop()
    {"login": view_login, "forgot": view_forgot, "verify": view_verify,
     "request": view_request}.get(st.session_state.get("view", "login"), view_login)(users)
    st.stop()


if st.query_params.get("review"):
    st.session_state.review_id = st.query_params.get("review")

if "auth" not in st.session_state:
    auth_screens()

if st.session_state.get("review_id"):
    view_review(get_users())

if st.session_state.get("admin_view"):
    _users = get_users()
    if is_admin(auth_user(), _users):
        admin_page(_users)
    st.session_state.pop("admin_view", None)

auth = st.session_state.auth
# Re-read access on every visit, so new access (e.g. Treasury) shows without signing out.
# Admins always see everything.
_all_users = get_users()
_me = _all_users.get(auth.get("username", ""))
if _me:
    _regs = ALL_REGULATORS if is_admin(auth["username"], _all_users) else allowed_regulators(_me)
    if _regs and _regs != auth.get("regulators"):
        auth["regulators"] = _regs
        st.session_state.pop("data", None)


# ───────────────────────── Data ─────────────────────────
def gh_headers() -> dict:
    """Optional GITHUB_TOKEN secret raises GitHub's API limit from 60 to 5,000 calls/hour."""
    h = {"Accept": "application/vnd.github+json"}
    try:
        token = st.secrets.get("GITHUB_TOKEN")
    except FileNotFoundError:
        token = None
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def latest_data_sha(path: str = DATA_FILE, repo: str | None = None) -> str | None:
    """SHA of the newest commit that changed the data file (always live, no CDN cache)."""
    try:
        r = requests.get(
            f"https://api.github.com/repos/{repo or REPO}/commits",
            params={"sha": BRANCH, "path": path, "per_page": 1},
            headers=gh_headers(), timeout=15,
        )
        if r.status_code == 200 and r.json():
            return r.json()[0]["sha"]
    except (requests.RequestException, ValueError, KeyError, IndexError):
        pass
    return None


@st.cache_data(max_entries=3, show_spinner=False)
def data_at_commit(sha: str, path: str = DATA_FILE, repo: str | None = None) -> dict:
    """A file at a fixed commit never changes, so it is safe to cache by SHA."""
    r = requests.get(f"https://raw.githubusercontent.com/{repo or REPO}/{sha}/{path}", timeout=60)
    r.raise_for_status()
    return r.json()


def fetch_latest_data() -> tuple[dict, str]:
    """Return (data, version). Tries the exact latest commit first, then fallbacks."""
    sha = latest_data_sha()
    if sha:
        try:
            return data_at_commit(sha), sha
        except (requests.RequestException, ValueError):
            pass
    try:  # fallback: branch URL with cache-busting
        r = requests.get(RAW_URL, params={"t": int(time.time())},
                         headers={"Cache-Control": "no-cache"}, timeout=60)
        if r.status_code == 200:
            return r.json(), "raw"
    except (requests.RequestException, ValueError):
        pass
    local = BASE_DIR / DATA_FILE
    if local.exists():
        return json.loads(local.read_text(encoding="utf-8")), "local"
    return {}, "none"


def treasury_repo() -> str:
    try:
        return st.secrets.get("TREASURY_REPO") or TREASURY_REPO_DEFAULT
    except FileNotFoundError:
        return TREASURY_REPO_DEFAULT


def fetch_repo_json(path: str) -> dict:
    """Latest version of a treasury JSON file. Empty dict if it doesn't exist yet."""
    repo = treasury_repo()
    sha = latest_data_sha(path, repo)
    if sha:
        try:
            return data_at_commit(sha, path, repo)
        except (requests.RequestException, ValueError):
            pass
    try:
        r = requests.get(f"https://raw.githubusercontent.com/{repo}/{BRANCH}/{path}",
                         params={"t": int(time.time())}, timeout=60)
        if r.status_code == 200:
            return r.json()
    except (requests.RequestException, ValueError):
        pass
    local = BASE_DIR / path
    if local.exists():
        try:
            return json.loads(local.read_text(encoding="utf-8"))
        except ValueError:
            pass
    return {}


def basis_hash(text: str) -> str:  # same as ai-treasury-commentary.js
    return hashlib.sha256(str(text).encode("utf-8")).hexdigest()[:16]


def fetch_treasury() -> dict:
    """benchmark.json with the AI drafts applied where they still match the figures."""
    data = fetch_repo_json(TREASURY_FILE)
    if not data.get("companies"):
        return data
    ai = (fetch_repo_json(TREASURY_AI_FILE) or {}).get("items", {})
    data = json.loads(json.dumps(data))
    overview_basis = "\n".join(r.get("remark") or "" for t in data.get("summary", []) or []
                               for r in t.get("rows", []))

    def apply(item, field):
        a = ai.get(item.get("key"))
        if a and a.get("text") and a.get("basis") == basis_hash(item.get(field, "")):
            item["rule"] = item.get(field, "")
            item[field] = a["text"]
            item["ai"] = True

    for t in data.get("summary", []) or []:
        for r in t.get("rows", []):
            if r.get("key") and r.get("remark"):
                apply(r, "remark")
    for c in data.get("companies", []) or []:
        for r in c.get("readouts", []) or []:
            if r.get("key"):
                apply(r, "text")
    a = ai.get("summary:overview")
    if a and a.get("text") and a.get("basis") == basis_hash(overview_basis):
        data["overview_summary"] = {"key": "summary:overview", "text": a["text"], "ai": True,
                                    "at": a.get("at", ""), "model": a.get("model", "")}
    # dashboard summaries and BFL-vs-peer comparisons: shown while they match the current figures
    current = {data.get("fingerprint"), data.get("generated_at")} - {None}
    data["ai_sections"] = {
        k: {"key": k, "text": x["text"], "ai": True, "at": x.get("at", ""), "model": x.get("model", "")}
        for k, x in ai.items()
        if k != "summary:overview" and k.startswith(("summary:", "compare:")) and x.get("text")
        and x.get("fp") in current}
    return data


def treasury_notes() -> dict:
    """Commentary edited by Treasury users: {key: {text, by, at}} kept in the portal store."""
    if "tpb_notes" not in st.session_state:
        try:
            doc, _ = load_store()
            st.session_state.tpb_notes = doc.get("treasury_notes", {}) or {}
        except (requests.RequestException, ValueError, KeyError, TypeError):
            st.session_state.tpb_notes = {}
    return st.session_state.tpb_notes


def treasury_items(data: dict):
    """Every editable piece of commentary: (key, section, heading, auto text, item dict)."""
    if data.get("overview_summary"):
        o = data["overview_summary"]
        yield o["key"], "Overview · Summary", "Overall summary", o.get("auto", o.get("text", "")), o, "text"
    names = {c.get("key"): c.get("short") or c.get("name") for c in data.get("companies", []) or []}
    base = next((c.get("short") for c in data.get("companies", []) or [] if c.get("base")), "BFL")
    group = lambda k: (0 if k.startswith("summary:") and not k.startswith("summary:company:") else 1 if k.startswith("compare:") else 2, k)  # noqa: E731
    for k, x in sorted((data.get("ai_sections") or {}).items(), key=lambda kv: group(kv[0])):
        part = k.split(":")
        if k.startswith("compare:"):
            yield k, "BFL vs Peers · comparisons", f"{base} vs {names.get(part[1], part[1])}", x.get("auto", x.get("text", "")), x, "text"
        elif k.startswith("summary:company:"):
            yield k, "NBFC tabs · summaries", names.get(part[2], part[2]), x.get("auto", x.get("text", "")), x, "text"
        else:
            label = {"borrowing_mix": "Borrowing Mix", "investment_mix": "Investment Mix", "cost_kpis": "Cost & KPIs"}.get(part[1], part[1])
            yield k, "Dashboard summaries", label, x.get("auto", x.get("text", "")), x, "text"
    for t in data.get("summary", []) or []:
        for r in t.get("rows", []):
            if r.get("key") and (r.get("remark") or r.get("auto")):
                yield r["key"], f"Overview · {t.get('title', '')}", r.get("metric", ""), r.get("auto", r.get("remark", "")), r, "remark"
    for c in data.get("companies", []) or []:
        for r in c.get("readouts", []) or []:
            if r.get("key"):
                yield r["key"], f"{c.get('name', '')} · Key readouts", r.get("area", ""), r.get("auto", r.get("text", "")), r, "text"


def with_notes(data: dict, notes: dict) -> dict:
    """Copy of the benchmark with Treasury's edits in place of the drafted text."""
    data = json.loads(json.dumps(data))
    for key, _, _, auto, item, field in treasury_items(data):
        item["auto"] = auto
        n = notes.get(key)
        if n and n.get("text", "").strip():
            item[field] = n["text"]
            item["edited"] = {"by": n.get("by", ""), "at": n.get("at", "")}
    return data


def can_edit_treasury(username: str, users: dict) -> bool:
    if is_admin(username, users):
        return True
    return "TREASURY" in allowed_regulators(users.get(username, {}))


def view_tpb_edit(data: dict):
    """Edit the drafted commentary of the Treasury dashboards."""
    brand("Treasury Peer Benchmarking · Edit commentary")
    st.markdown("""<style>
  .block-container, [data-testid="stMainBlockContainer"] {max-width: 980px !important; padding-top: 4vh !important;}
  [data-testid="stForm"] {border-radius: 10px !important;}
  [data-testid="stForm"] strong {display: block; margin-top: 14px; font-size: 15px; color: #0f2d52;}
</style>""", unsafe_allow_html=True)
    flash()
    if not data.get("companies"):
        st.info("There is no benchmark data yet, so there is nothing to edit.")
    notes = treasury_notes()
    st.caption("Each box starts with the drafted text (written by AI from the extracted figures where "
               "available, otherwise by rules). Change it and press Save; "
               "clear a box (or use “Reset”) to go back to the drafted text. Edits stay when the "
               "data is refreshed, as long as the same item is still on the dashboard.")
    items = list(treasury_items(data))
    with st.form("tpb_edit_form"):
        values = {}
        section = None
        for key, sec, head, auto, item, _ in items:
            if sec != section:
                st.markdown(f"**{html_lib.escape(sec)}**")
                section = sec
            cur = (notes.get(key) or {}).get("text") or auto
            n = notes.get(key)
            label = head + (f"  ·  edited by {n.get('by', '')} {str(n.get('at', ''))[:10]}" if n
                            else ("  ·  AI draft" if item.get("ai") else ""))
            values[key] = (st.text_area(label, value=cur, key=f"tpb_{key}", height=80), auto)
        c1, c2 = st.columns(2)
        save = c1.form_submit_button("Save", type="primary", use_container_width=True)
        back = c2.form_submit_button("Back to portal", use_container_width=True)
    reset = st.multiselect("Reset to the drafted text", [k for k in notes if k in values],
                           format_func=lambda k: k.split(":", 2)[-1].replace(":", " · "))
    if reset and st.button("Reset selected"):
        values = {k: (a, a) if k in reset else ((notes.get(k) or {}).get("text") or a, a)
                  for k, (v, a) in values.items()}
        save = True
    if save:
        user = auth_user()
        stamp = now_iso()

        def change(doc):
            tn = doc.setdefault("treasury_notes", {})
            for k, (text, auto) in values.items():
                text = (text or "").strip()
                if not text or text == (auto or "").strip():
                    tn.pop(k, None)
                elif (tn.get(k) or {}).get("text") != text:
                    tn[k] = {"text": text, "by": user, "at": stamp}

        if update_store(change, f"Treasury commentary edited by {user}"):
            st.session_state.pop("tpb_notes", None)
            st.session_state.flash = "Commentary saved. Press “Back to portal” to see it on the dashboards."
            st.rerun()
        else:
            st.error(store_error_text("Couldn't save the commentary."))
    if back:
        st.session_state.pop("tpb_edit", None)
        st.rerun()
    st.stop()


# PAN numbers (5 letters + 4 digits + 1 letter, e.g. ABCDE1234F) appear in some regulator
# documents. Corporate DLP filters block pages that carry them, so they're masked before
# anything is sent to the browser. Links are left untouched so "Open" still works.
PAN_RE = re.compile(r"(?<![A-Za-z0-9])(?:[A-Z]{5}[0-9]{4}[A-Z]|[a-z]{5}[0-9]{4}[a-z])(?![A-Za-z0-9])")
PAN_RE_LOOSE = re.compile(r"[A-Z]{5}[0-9]{4}[A-Z]")  # also catches PANs glued to other text
PAN_MASK = "[PAN hidden]"
URL_KEYS = {"link", "url", "href", "src", "source", "pdf", "pdfurl", "pdf_url"}


def mask_pan(value, key: str = ""):
    if isinstance(value, str):
        if key.lower() in URL_KEYS or value.startswith(("http://", "https://")):
            return value
        return PAN_RE_LOOSE.sub(PAN_MASK, PAN_RE.sub(PAN_MASK, value))
    if isinstance(value, dict):
        return {k: mask_pan(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [mask_pan(v, key) for v in value]
    return value


def filter_data(data: dict, regs: list[str]) -> dict:
    """Keep only the keys (e.g. 'RBI_0', 'SEBI_3') for allowed regulators."""
    if not data:
        return {}
    keep = {k: v for k, v in data.get("data", {}).items()
            if k.rsplit("_", 1)[0].upper() in regs}
    return mask_pan({**data, "data": keep})


def build_page(page: str, data: dict, regs: list[str], name: str,
               admin_pending: int | None = None, treasury: dict | None = None,
               can_edit: bool = False) -> str:
    def js(obj) -> str:  # JSON safe to embed inside <script>
        return json.dumps(obj).replace("</", "<\\/")

    # 0) Treasury Peer Benchmarking dashboards (only for users with TREASURY access)
    if "TREASURY" in regs:
        script = load_asset("treasury_dashboard.js").replace("</", "<\\/")
        style = load_asset("treasury_dashboard.css")
        page = page.replace("/* ── Bootstrap ── */",
                            f"window.__TREASURY__ = {js(mask_pan(treasury or {}))};\n"
                            f"window.__TPB_CAN_EDIT__ = {js(bool(can_edit))};\n{script}\n"
                            "/* ── Bootstrap ── */", 1)
        page = page.replace("</head>", f"<style>{style}</style></head>", 1)

    # 1) Use embedded (filtered) data instead of fetching the JSON file
    page = page.replace(
        "async function loadStaticData(force = false) {",
        "async function loadStaticData(force = false) {\n"
        "  if (window.__EMBEDDED_DATA__) { staticData = window.__EMBEDDED_DATA__; "
        "staticDataError = null; return staticData; }",
        1,
    )

    # 2) Hide regulators this user may not see, and start on the first allowed one
    access_js = f"""
/* ── Access control (injected by Streamlit) ── */
const __ALLOWED__ = {js(regs)};
Object.keys(REGULATORS).forEach(k => {{ if (!__ALLOWED__.includes(k)) delete REGULATORS[k]; }});
document.querySelectorAll('.reg-btn').forEach(b => {{
  if (!__ALLOWED__.includes(b.dataset.reg)) b.remove();
}});
currentReg = __ALLOWED__.find(k => REGULATORS[k]) || currentReg;
try {{  // after a data refresh, return to the regulator/tab the user was on
  const v = JSON.parse(sessionStorage.getItem('__portal_view') || 'null');
  if (v && REGULATORS[v.reg]) {{
    currentReg = v.reg;
    if (v.tab < REGULATORS[v.reg].tabs.length) currentTabIdx = v.tab;
  }}
}} catch (e) {{}}
document.querySelectorAll('.reg-btn').forEach(b => b.classList.toggle('active', b.dataset.reg === currentReg));
if (REGULATORS[currentReg]) document.documentElement.style.setProperty('--active-accent', REGULATORS[currentReg].color);

/* ── Bootstrap ── */"""
    page = page.replace("/* ── Bootstrap ── */", access_js, 1)

    # Refresh button and the 30-minute auto-refresh pull live data from GitHub
    page = page.replace("function refreshCurrent() { loadTab(true); }",
                        "function refreshCurrent() { __reloadData(); }", 1)
    page = page.replace("setInterval(() => loadTab(true), 30 * 60 * 1000);",
                        "setInterval(() => __reloadData(), 30 * 60 * 1000);", 1)

    # 3) User initials + Sign out inside the portal header
    initials = "".join(w[0] for w in name.split()[:2]).upper() or "U"
    admin_btn = ""
    if admin_pending is not None:
        badge = f'<span class="__badge">{admin_pending}</span>' if admin_pending else ""
        admin_btn = f'<button class="__signout __admin" onclick="__openAdmin()">Admin{badge}</button>'
    user_ui = f"""<span class="header-time" id="headerTime"></span>
    {admin_btn}
    <div class="__user" title="{html_lib.escape(name)}">{html_lib.escape(initials)}</div>
    <button class="__signout" onclick="__signOut()">Sign out</button>"""
    page = page.replace('<span class="header-time" id="headerTime"></span>', user_ui, 1)

    head_extra = f"""<script>window.__EMBEDDED_DATA__ = {js(data)};
function __signOut() {{
  try {{
    const b = window.parent.document.querySelector('.st-key-signout button');
    if (b) {{ b.click(); return; }}
  }} catch (e) {{}}
  window.top.location.reload();
}}
function __openAdmin() {{
  try {{
    const b = window.parent.document.querySelector('.st-key-adminopen button');
    if (b) {{ b.click(); return; }}
  }} catch (e) {{}}
}}
function __reloadData() {{
  try {{ sessionStorage.setItem('__portal_view', JSON.stringify({{reg: currentReg, tab: currentTabIdx}})); }} catch (e) {{}}
  try {{ setLoading(true); }} catch (e) {{}}
  try {{
    const b = window.parent.document.querySelector('.st-key-reload button');
    if (b) {{ b.click(); return; }}
  }} catch (e) {{}}
  window.top.location.reload();
}}
</script>
<style>
  .__user {{width: 30px; height: 30px; border-radius: 50%; background: #e8f0fe; color: #1a56db;
            font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center;}}
  .__signout {{background: #fff; border: 1px solid var(--border, #e2e6ea); color: var(--text-secondary, #5a6474);
               border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer;
               font-family: inherit;}}
  .__signout:hover {{border-color: #c0392b; color: #c0392b;}}
  .__admin {{color: #1a56db; border-color: #c9d8f8; display: inline-flex; align-items: center; gap: 6px;}}
  .__admin:hover {{border-color: #1a56db !important; color: #1a56db !important; background: #f3f7ff;}}
  .__badge {{background: #c0392b; color: #fff; border-radius: 10px; font-size: 11px; padding: 1px 7px;}}
</style>"""
    return page.replace("<head>", "<head>" + head_extra, 1) if "<head>" in page else head_extra + page


# ───────────────────────── Portal page ─────────────────────────
# Treasury "Edit commentary" screen (opened from the dashboards)
if st.session_state.get("tpb_edit"):
    if "TREASURY" in auth["regulators"] and can_edit_treasury(auth_user(), get_users()):
        if "treasury" not in st.session_state:
            st.session_state.treasury = fetch_treasury()
        view_tpb_edit(st.session_state.treasury)
    st.session_state.pop("tpb_edit", None)

# Opened through the wrapper page (docs/index.html: embed mode, Cloud badges hidden)? That page
# clips a 44px strip at the bottom, so the portal is made 44px shorter to keep everything reachable.
if st.query_params.get("wrapped") == "1":
    st.session_state.wrapped = True
PORTAL_H = "calc(100vh - 44px)" if st.session_state.get("wrapped") else "100vh"

st.markdown(
    """
    <style>
      .block-container {padding: 0 !important; max-width: 100% !important;}
      [data-testid="stMainBlockContainer"] {padding: 0 !important;}
      .st-key-signout, .st-key-reload, .st-key-adminopen, .st-key-tpbedit {display: none !important;}
      iframe {display: block; height: __PORTAL_H__ !important; border: 0;}
      [data-testid="stVerticalBlock"] {gap: 0 !important;}
    </style>
    """.replace("__PORTAL_H__", PORTAL_H),
    unsafe_allow_html=True,
)

# Hidden buttons clicked by the portal's own "Sign out" and "Refresh"
if st.button("Sign out", key="signout"):
    st.session_state.view = "login"
    for k in ("auth", "data", "data_version", "treasury", "tpb_notes", "tpb_edit"):
        st.session_state.pop(k, None)
    st.rerun()

refresh_clicked = st.button("Reload", key="reload")

if st.button("Admin", key="adminopen"):
    st.session_state.admin_view = True
    st.rerun()

if st.button("Edit commentary", key="tpbedit"):
    st.session_state.tpb_edit = True
    st.rerun()

admin_pending = None
_users_now = get_users()
if is_admin(auth_user(), _users_now):
    try:
        _doc, _ = load_store()
        admin_pending = sum(r.get("status") == "pending" for r in _doc["requests"].values())
    except (requests.RequestException, ValueError, KeyError):
        admin_pending = 0

if refresh_clicked or "data" not in st.session_state:
    old_version = st.session_state.get("data_version")
    with st.spinner("Loading latest data from GitHub…"):
        data, version = fetch_latest_data()
    st.session_state.data = data
    st.session_state.data_version = version
    if "TREASURY" in auth["regulators"]:
        st.session_state.treasury = fetch_treasury()
        st.session_state.pop("tpb_notes", None)
    st.session_state.loads = st.session_state.get("loads", 0) + 1  # forces the page to re-render
    if refresh_clicked:
        if version != old_version:
            st.toast("Loaded the latest data.")
        else:
            st.toast("Already up to date.")

treasury_view = None
can_edit = False
if "TREASURY" in auth["regulators"]:
    if "treasury" not in st.session_state:
        st.session_state.treasury = fetch_treasury()
    can_edit = can_edit_treasury(auth_user(), _users_now)
    treasury_view = with_notes(st.session_state.treasury, treasury_notes())

page = build_page(load_html(), filter_data(st.session_state.data, auth["regulators"]),
                  auth["regulators"], auth["name"], admin_pending, treasury_view, can_edit)
page += f"\n<!-- load {st.session_state.loads} -->"
components.html(page, height=1000, scrolling=True)
