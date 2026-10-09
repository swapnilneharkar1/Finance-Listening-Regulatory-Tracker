"""
Finance Listening Portal on Streamlit, with login and per-user regulator access.

- Users, passwords (hashed) and allowed regulators live in Streamlit secrets
  (App settings -> Secrets). See secrets_example.toml.
- Access is enforced server-side: data for regulators a user is not allowed to
  see is removed before the page is sent to their browser.
- Generate password hashes with: python make_password_hash.py
"""
import hashlib
import hmac
import html as html_lib
import json
import re
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


def get_users() -> dict:
    try:
        return {k.lower(): dict(v) for k, v in st.secrets["users"].items()}
    except (KeyError, FileNotFoundError):
        return {}


def allowed_regulators(user: dict) -> list[str]:
    regs = [str(r).upper() for r in user.get("regulators", [])]
    if "ALL" in regs:
        return ALL_REGULATORS
    return [r for r in ALL_REGULATORS if r in regs]  # keep portal order


LOGIN_CSS = """
<style>
  html, body, .stApp, input, button, label, p {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
  }
  .block-container, [data-testid="stMainBlockContainer"] {max-width: 460px !important; padding-top: 11vh !important;}
  .login-brand {
    display: flex; flex-direction: column; align-items: center; text-align: center; gap: 12px;
    background: #fff; border: 1px solid #e2e6ea; border-bottom: none;
    border-radius: 10px 10px 0 0; padding: 22px 28px 18px;
  }
  .login-brand img {height: 46px;}
  .login-brand .divider {display: none;}
  .login-brand h1 {font-size: 19px !important; font-weight: 700 !important;
                   color: #1a2030 !important; margin: 0 !important; padding: 0 !important; line-height: 1.25; white-space: nowrap;}
  .login-brand p {font-size: 13px; color: #5a6474; margin: 2px 0 0;}
  [data-testid="stForm"] {
    background: #fff; border: 1px solid #e2e6ea; border-top: 1px solid #eef0f3;
    border-radius: 0 0 10px 10px; padding: 22px 28px 26px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.06);
  }
  [data-testid="stForm"] label p {font-size: 13px !important; font-weight: 600; color: #5a6474;}
  [data-testid="stForm"] input {font-size: 14px !important; background: #fff !important;}
  [data-testid="stForm"] [data-baseweb="input"] *, [data-testid="stForm"] [data-baseweb="input"] button {background-color: #fff !important;}
  [data-testid="stForm"] [data-baseweb="input"] {
    background: #fff !important; border: 1px solid #e2e6ea !important; border-radius: 8px !important;
  }
  [data-testid="stForm"] [data-baseweb="input"]:focus-within {border-color: #1a56db !important;}
  [data-testid="stForm"] [data-baseweb="input"] > div {background: #fff !important;}
  [data-testid="stFormSubmitButton"] button {
    background: #1a56db !important; color: #fff !important; border: none !important;
    border-radius: 8px !important; height: 42px; font-weight: 600 !important; margin-top: 6px;
  }
  [data-testid="stFormSubmitButton"] button:hover {background: #1546b8 !important;}
  .login-foot {text-align: center; font-size: 12px; color: #9aa3b0; margin-top: 18px;}
</style>
"""


def login_screen():
    st.markdown(LOGIN_CSS, unsafe_allow_html=True)
    st.markdown(
        f"""
        <div class="login-brand">
          <img src="{company_logo()}" alt="Bajaj Finance"/>
          <div class="divider"></div>
          <div><h1>Finance Listening Portal</h1><p>Sign in to continue</p></div>
        </div>
        """,
        unsafe_allow_html=True,
    )

    users = get_users()
    if not users:
        st.error("No users configured. Add a [users] section in the app's Secrets.")
        st.stop()

    with st.form("login"):
        username = st.text_input("Username", placeholder="Enter your username").strip().lower()
        password = st.text_input("Password", type="password", placeholder="Enter your password")
        submitted = st.form_submit_button("Sign in", use_container_width=True)

    if submitted:
        user = users.get(username)
        if user and verify_password(password, user.get("password_hash", "")):
            regs = allowed_regulators(user)
            if not regs:
                st.error("Your account has no regulators assigned. Contact the admin.")
                st.stop()
            st.session_state.auth = {
                "username": username,
                "name": user.get("name", username),
                "regulators": regs,
            }
            st.rerun()
        else:
            st.error("Invalid username or password.")

    st.markdown("<div class='login-foot'>Bajaj Finserv · Internal use only</div>",
                unsafe_allow_html=True)
    st.stop()


if "auth" not in st.session_state:
    login_screen()

auth = st.session_state.auth


# ───────────────────────── Data ─────────────────────────
@st.cache_data(ttl=900, show_spinner="Loading latest regulatory data…")
def load_data() -> dict:
    try:
        r = requests.get(RAW_URL, timeout=30)
        if r.status_code == 200:
            return r.json()
    except (requests.RequestException, ValueError):
        pass
    local = BASE_DIR / DATA_FILE
    if local.exists():
        return json.loads(local.read_text(encoding="utf-8"))
    return {}


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
document.querySelectorAll('.reg-btn').forEach(b => b.classList.toggle('active', b.dataset.reg === currentReg));
if (REGULATORS[currentReg]) document.documentElement.style.setProperty('--active-accent', REGULATORS[currentReg].color);

/* ── Bootstrap ── */"""
    page = page.replace("/* ── Bootstrap ── */", access_js, 1)

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
      .st-key-signout {display: none !important;}
      iframe {display: block; height: 100vh !important; border: 0;}
      [data-testid="stVerticalBlock"] {gap: 0 !important;}
    </style>
    """,
    unsafe_allow_html=True,
)

# Hidden button the portal's "Sign out" clicks
if st.button("Sign out", key="signout"):
    del st.session_state["auth"]
    st.rerun()

page = build_page(load_html(), filter_data(load_data(), auth["regulators"]),
                  auth["regulators"], auth["name"])
components.html(page, height=1000, scrolling=True)
