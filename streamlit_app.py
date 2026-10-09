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
                  "NFRA", "PCAOB", "TAXATION", "NEWSLETTER"]

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
    for key in ("passwords", "users", "requests"):
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
  .st-key-reject_btn button {background: #fff !important; color: #c0392b !important;
                             border: 1px solid #e8b4ae !important;}
  .st-key-reject_btn button:hover {background: #fdf2f1 !important;}
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
            regs = allowed_regulators(user)
            if not regs:
                st.error("Your account has no regulators assigned. Use 'Request access' below.")
            else:
                st.session_state.auth = {"username": username,
                                         "name": user.get("name", username),
                                         "regulators": regs}
                st.session_state.pop("data", None)  # fetch fresh data after every login
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
        regs = st.multiselect("Regulators you need", ALL_REGULATORS,
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
                if not update_store(lambda d: d["requests"].__setitem__(rid, req),
                                    f"Access request from {email}"):
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

    current = allowed_regulators(users.get(req["username"], {})) if req["existing"] else []
    with st.form("review"):
        st.markdown(
            f"**{safe(req['name'])}** · {safe(req['email'])}  \n"
            + (f"Existing user **{safe(req['username'])}**, currently has: "
               f"{', '.join(current) or 'nothing'}" if req["existing"]
               else f"New user · will sign in as **{safe(req['username'])}**")
            + f"  \n**Reason:** {safe(req['reason'])}")
        default = [r for r in ALL_REGULATORS if r in set(current) | set(req["regulators"])]
        regs = st.multiselect("Regulators to grant", ALL_REGULATORS, default=default)
        c1, c2 = st.columns(2)
        approve = c1.form_submit_button("Approve", use_container_width=True)
        reject = c2.form_submit_button("Reject", use_container_width=True, key="reject_btn")

    if approve and not regs:
        st.error("Choose at least one regulator, or reject the request.")
    elif approve or reject:
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
        else:
            if approve:
                body = (f"<p>Hi {safe(req['name'])},</p><p>Your access to the Finance Listening "
                        f"Portal has been approved for <b>{safe(', '.join(regs))}</b>.</p>"
                        f"<p>Sign in at <a href='{app_url()}'>{app_url()}</a> with username "
                        f"<b>{safe(req['username'])}</b>"
                        + ("." if req["existing"] else " and the password you chose.") + "</p>")
            else:
                body = (f"<p>Hi {safe(req['name'])},</p><p>Your access request for the Finance "
                        "Listening Portal was not approved. Please contact the portal admin "
                        "if you have questions.</p>")
            sent = send_email(req["email"], f"Portal access {status}",
                              email_shell(f"Access {status}", body))
            st.session_state.flash = (f"Request {status}. " + (
                f"{req['name']} has been emailed." if sent
                else email_error_text("Couldn't email them.")))
            st.rerun()

    done_button()
    footer()
    st.stop()


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

auth = st.session_state.auth


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


def latest_data_sha() -> str | None:
    """SHA of the newest commit that changed the data file (always live, no CDN cache)."""
    try:
        r = requests.get(
            f"https://api.github.com/repos/{REPO}/commits",
            params={"sha": BRANCH, "path": DATA_FILE, "per_page": 1},
            headers=gh_headers(), timeout=15,
        )
        if r.status_code == 200 and r.json():
            return r.json()[0]["sha"]
    except (requests.RequestException, ValueError, KeyError, IndexError):
        pass
    return None


@st.cache_data(max_entries=3, show_spinner=False)
def data_at_commit(sha: str) -> dict:
    """A file at a fixed commit never changes, so it is safe to cache by SHA."""
    r = requests.get(f"https://raw.githubusercontent.com/{REPO}/{sha}/{DATA_FILE}", timeout=60)
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


def filter_data(data: dict, regs: list[str]) -> dict:
    """Keep only the keys (e.g. 'RBI_0', 'SEBI_3') for allowed regulators."""
    if not data:
        return {}
    keep = {k: v for k, v in data.get("data", {}).items()
            if k.rsplit("_", 1)[0].upper() in regs}
    return {**data, "data": keep}


def build_page(page: str, data: dict, regs: list[str], name: str) -> str:
    def js(obj) -> str:  # JSON safe to embed inside <script>
        return json.dumps(obj).replace("</", "<\\/")

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
    user_ui = f"""<span class="header-time" id="headerTime"></span>
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
</style>"""
    return page.replace("<head>", "<head>" + head_extra, 1) if "<head>" in page else head_extra + page


# ───────────────────────── Portal page ─────────────────────────
st.markdown(
    """
    <style>
      .block-container {padding: 0 !important; max-width: 100% !important;}
      [data-testid="stMainBlockContainer"] {padding: 0 !important;}
      .st-key-signout, .st-key-reload {display: none !important;}
      iframe {display: block; height: 100vh !important; border: 0;}
      [data-testid="stVerticalBlock"] {gap: 0 !important;}
    </style>
    """,
    unsafe_allow_html=True,
)

# Hidden buttons clicked by the portal's own "Sign out" and "Refresh"
if st.button("Sign out", key="signout"):
    st.session_state.view = "login"
    for k in ("auth", "data", "data_version"):
        st.session_state.pop(k, None)
    st.rerun()

refresh_clicked = st.button("Reload", key="reload")

if refresh_clicked or "data" not in st.session_state:
    old_version = st.session_state.get("data_version")
    with st.spinner("Loading latest data from GitHub…"):
        data, version = fetch_latest_data()
    st.session_state.data = data
    st.session_state.data_version = version
    st.session_state.loads = st.session_state.get("loads", 0) + 1  # forces the page to re-render
    if refresh_clicked:
        if version != old_version:
            st.toast("Loaded the latest data.")
        else:
            st.toast("Already up to date.")

page = build_page(load_html(), filter_data(st.session_state.data, auth["regulators"]),
                  auth["regulators"], auth["name"])
page += f"\n<!-- load {st.session_state.loads} -->"
components.html(page, height=1000, scrolling=True)
