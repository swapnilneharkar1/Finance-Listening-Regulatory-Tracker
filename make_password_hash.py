"""
Generate a password hash for the portal's Streamlit secrets.

Usage:  python make_password_hash.py
Paste the printed value into password_hash = "..." for that user.
"""
import getpass
import hashlib
import os

ITERATIONS = 200_000

pw = getpass.getpass("Password: ")
if pw != getpass.getpass("Confirm:  "):
    raise SystemExit("Passwords don't match.")
salt = os.urandom(16)
digest = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, ITERATIONS)
print(f"pbkdf2_sha256${ITERATIONS}${salt.hex()}${digest.hex()}")
