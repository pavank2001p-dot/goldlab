"""Outgoing email behind one function, so the provider can be swapped with EMAIL_PROVIDER.

- resend:  Resend's HTTP API (RESEND_API_KEY). The recommended choice.
- smtp:    any SMTP server (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD), e.g. Postmark, SES, Brevo, Gmail.
- console: writes the email to the API log instead of sending it. Used in development and tests.
"""

import html as _html
import logging
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage

import httpx

from . import config

log = logging.getLogger("mailer")


@dataclass
class Mail:
    to: str
    subject: str
    text: str
    html: str


# The console provider keeps the last messages here so tests (and a dev shell) can read them.
outbox: list[Mail] = []


def _console(m: Mail) -> None:
    outbox.append(m)
    del outbox[:-50]
    log.warning("EMAIL (console, not sent) to=%s subject=%r\n%s", m.to, m.subject, m.text)


def _resend(m: Mail) -> None:
    r = httpx.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {config.RESEND_API_KEY}"},
        json={"from": config.EMAIL_FROM, "to": [m.to], "subject": m.subject, "text": m.text, "html": m.html},
        timeout=15,
    )
    r.raise_for_status()


def _smtp(m: Mail) -> None:
    msg = EmailMessage()
    msg["From"] = config.EMAIL_FROM
    msg["To"] = m.to
    msg["Subject"] = m.subject
    msg.set_content(m.text)
    msg.add_alternative(m.html, subtype="html")
    with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=15) as s:
        s.starttls()
        if config.SMTP_USER:
            s.login(config.SMTP_USER, config.SMTP_PASSWORD)
        s.send_message(msg)


PROVIDERS = {"console": _console, "resend": _resend, "smtp": _smtp}


def send(m: Mail) -> bool:
    """Sends one email. Never raises: a failed send is logged and reported as False."""
    provider = PROVIDERS.get(config.EMAIL_PROVIDER, _console)
    try:
        provider(m)
        return True
    except Exception:
        log.exception("sending email to %s via %s failed", m.to, config.EMAIL_PROVIDER)
        return False


def _layout(title: str, intro: str, button: str, url: str, outro: str) -> str:
    return f"""<!doctype html><html><body style="margin:0;background:#f6f5f2;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1b19">
<div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;padding:32px;border:1px solid #e6e2d8">
<p style="margin:0 0 4px;font-weight:600;color:#b8892b">GoldLab</p>
<h1 style="margin:0 0 16px;font-size:20px">{title}</h1>
<p style="line-height:1.5">{intro}</p>
<p style="margin:24px 0"><a href="{url}" style="background:#d4a537;color:#000;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">{button}</a></p>
<p style="line-height:1.5;font-size:13px;color:#6b675e">{outro}</p>
<p style="font-size:12px;color:#8a857a;word-break:break-all">If the button doesn't work, paste this link into your browser:<br>{url}</p>
</div></body></html>"""


def verification(to: str, name: str, url: str) -> Mail:
    hi = f"Hi {name}," if name else "Hi,"
    hours = config.VERIFY_TOKEN_HOURS
    return Mail(
        to=to,
        subject="Confirm your GoldLab email",
        text=f"{hi}\n\nConfirm this is your email address by opening the link below:\n\n{url}\n\n"
        f"The link works for {hours} hours. If you didn't create a GoldLab account, you can ignore this email.\n",
        html=_layout(
            "Confirm your email",
            f"{_html.escape(hi)} confirm this is your email address so you can reset your password if you ever need to.",
            "Confirm email",
            url,
            f"The link works for {hours} hours. If you didn't create a GoldLab account, you can ignore this email.",
        ),
    )


def password_reset(to: str, name: str, url: str) -> Mail:
    hi = f"Hi {name}," if name else "Hi,"
    mins = config.RESET_TOKEN_MINUTES
    return Mail(
        to=to,
        subject="Reset your GoldLab password",
        text=f"{hi}\n\nSomeone asked to reset the password for this GoldLab account. Choose a new one here:\n\n{url}\n\n"
        f"The link works for {mins} minutes and only once. If it wasn't you, ignore this email: your password stays the same.\n",
        html=_layout(
            "Reset your password",
            f"{_html.escape(hi)} someone asked to reset the password for this GoldLab account.",
            "Choose a new password",
            url,
            f"The link works for {mins} minutes and only once. If it wasn't you, ignore this email: your password stays the same.",
        ),
    )
