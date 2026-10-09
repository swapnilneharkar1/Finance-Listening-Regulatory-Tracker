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
import json
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


def login_screen():
    st.markdown(
        """
        <style>
          #MainMenu, header, footer {visibility: hidden;}
          .block-container {max-width: 420px; padding-top: 8vh;}
        </style>
        """,
        unsafe_allow_html=True,
    )
    st.markdown("## Finance Listening Portal")
    st.caption("Bajaj Finserv · Sign in to continue")

    users = get_users()
    if not users:
        st.error("No users configured. Add a [users] section in the app's Secrets.")
        st.stop()

    with st.form("login"):
        username = st.text_input("Username").strip().lower()
        password = st.text_input("Password", type="password")
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


@st.cache_data
def load_html() -> str:
    return (BASE_DIR / HTML_FILE).read_text(encoding="utf-8")


def filter_data(data: dict, regs: list[str]) -> dict:
    """Keep only the keys (e.g. 'RBI_0', 'SEBI_3') for allowed regulators."""
    if not data:
        return {}
    keep = {k: v for k, v in data.get("data", {}).items()
            if k.rsplit("_", 1)[0].upper() in regs}
    return {**data, "data": keep}


def build_page(html: str, data: dict, regs: list[str]) -> str:
    def js(obj) -> str:  # JSON safe to embed inside <script>
        return json.dumps(obj).replace("</", "<\\/")

    # 1) Use embedded (filtered) data instead of fetching the JSON file
    html = html.replace(
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
    html = html.replace("/* ── Bootstrap ── */", access_js, 1)

    inject = f"<script>window.__EMBEDDED_DATA__ = {js(data)};</script>"
    return html.replace("<head>", "<head>" + inject, 1) if "<head>" in html else inject + html


# ───────────────────────── Page ─────────────────────────
st.markdown(
    """
    <style>
      #MainMenu, header, footer {visibility: hidden;}
      .block-container {padding: 0.4rem 0 0 0 !important; max-width: 100% !important;}
      iframe {display: block;}
      .userbar {font-size: 0.85rem; color: #555; padding-top: 0.45rem;}
    </style>
    """,
    unsafe_allow_html=True,
)

left, right = st.columns([6, 1])
with left:
    st.markdown(
        f"<div class='userbar'>&nbsp;&nbsp;Signed in as <b>{auth['name']}</b> · "
        f"Access: {', '.join(auth['regulators'])}</div>",
        unsafe_allow_html=True,
    )
with right:
    if st.button("Sign out", use_container_width=True):
        del st.session_state["auth"]
        st.rerun()

page = build_page(load_html(), filter_data(load_data(), auth["regulators"]), auth["regulators"])
components.html(page, height=2200, scrolling=True)
