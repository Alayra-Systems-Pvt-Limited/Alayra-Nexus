<sub>Part of the [Alayra Nexus README](../README.md#accounts-and-roles), moved into its own page so the README stays inside npm's 64 KB render limit. The content is unchanged.</sub>

## Accounts and roles

The gateway has **accounts**. Everyone who administers it signs in as themselves, with their own
email, password and second factor — so the audit trail records **who** did each thing, and one person
can be removed without disturbing anyone else.

**First run.** A fresh gateway has no accounts, so the dashboard opens on a setup screen. It asks for
`ADMIN_PASSWORD` from your server's environment: that is the proof you are the person who installed
this gateway rather than the first stranger to find the port. You create the owner account, and are
handed a **recovery key** — shown once, and the way back if you forget your password.

After that, `ADMIN_PASSWORD` is **refused as a sign-in**. It keeps two jobs: claiming a fresh
gateway, and authorising a full reset. Everything else goes through an account.

> [!NOTE]
> **Upgrading changes nothing until you choose.** On a gateway that has not been claimed, sign-in
> behaves exactly as it did before: `ADMIN_PASSWORD`, and the second factor if you enrolled one. When
> you claim, your existing authenticator and unused recovery codes **carry over** to your new account
> — nothing to set up again.

**Three roles.**

| Role | Can |
|---|---|
| **Owner** | Everything, including managing people, single sign-on, compliance/retention, the master API key, and resetting the gateway. |
| **Admin** | Run the gateway day to day: provider pools, keys, models, teams, caching, routing, guardrails. Cannot manage people or edit the controls that constrain admins (SSRF policy, arbitrary settings). |
| **Viewer** | Read-only. Every mutation is refused. |

**Invites** are links, not emails: an owner creates one and hands it over however they like (email
delivery is optional in this gateway, so an email-only invite would be a flow that silently never
works for most deployments). Each works once, expires after 7 days, and the invitee chooses their own
password — the owner never learns it.

**Removing someone** revokes the admin API tokens they created and kills their sessions on the next
request. What they did stays in the audit trail under their name: a record of who did what has to
outlive the account.

**Single sign-on** provisions an account from the `email` claim on first sign-in. The claim's role
applies only to a *new* account — for one that already exists, what an owner set in the Users tab
wins, so an identity provider's groups cannot silently re-promote someone.

**Locked out?** Your **recovery key** resets a forgotten password. Your **recovery codes** stand in
for a lost authenticator. Lose both, and the documented way back is a full reset of the gateway,
which erases everything in it.

<details>
<summary><b>Admin authentication — sessions, 2FA, lockout</b></summary>


Signing in `POST`s your email and password (and, once enrolled, an authenticator code) to
`/admin/login` and receives a **session token**. The dashboard stores only that token;
your password is never written to browser storage.

Passwords are stored with **scrypt** — memory-hard, per-user salt, cost parameters kept with the
digest so they can be raised later without invalidating anyone. It is the only human-chosen secret
the gateway stores; every other credential here is a high-entropy value the gateway generates and
keeps only as a hash.

**Two-factor authentication (TOTP)** is optional, off by default, and **each person's own** — it used
to be a single secret for the whole gateway, shared by everyone who knew the password. Enable it from
**Security → Sign-in**, or via the API:

```bash

</details>

# 1. Enrol — returns a secret and an otpauth:// URI for your authenticator app
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/admin/auth/totp/enrol

# 2. Confirm with a code from the app — returns 10 single-use recovery codes
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"code":"123456"}' http://localhost:3000/admin/auth/totp/confirm
```

Enrolment does not take effect until a code confirms it, so an abandoned enrolment
can never lock you out. Recovery codes are shown once and stored only as hashes; any
one of them may be used in place of an authenticator code.

> [!IMPORTANT]
> **`ADMIN_PASSWORD` stops working as a bearer token on `/admin/*`** once you claim the gateway, or
> once 2FA is enabled — whichever comes first. Both have to close that door: a password that still
> authenticated API calls would bypass the second factor entirely, and would put the audit trail back
> to saying "password" instead of a name. Use a session token, or an **admin API token** for scripts
> and CI:
>
> ```bash
> curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
>   -d '{"name":"ci"}' http://localhost:3000/admin/tokens
> ```
>
> Admin API tokens are hashed, listed, and revocable, and are not subject to the
> second factor — treat them as the credential they are. Before 2FA is enabled, the
> password keeps working as a bearer token exactly as before, so upgrading changes
> nothing.

**Lockout.** After `ADMIN_MAX_LOGIN_ATTEMPTS` (default 5) failed sign-ins, the source
address is locked out for `ADMIN_LOCKOUT_SECONDS` (default 900) and receives `429`
with `Retry-After` — including for a correct password. A wrong password and a wrong
authenticator code are indistinguishable in the response, so the login form cannot be
used as a password oracle. `nexus_admin_login_total{result}` tracks
success / invalid / totp_required / locked_out.

<details>
<summary><b>SSRF protection</b></summary>


Because the gateway makes outbound calls to operator-configured provider base URLs, an
unrestricted URL could be pointed at internal-only addresses — cloud metadata
(`169.254.169.254`), loopback admin panels, or private LAN hosts — turning Nexus into a
proxy into your own network. To prevent that, **Nexus blocks private, loopback, and
link-local hosts by default** on every path that adds or uses a provider URL. A blocked
URL is rejected when you save the provider, so it never reaches the request path.

Running a **local model** (Ollama, LM Studio, a private gateway)? Allow just that host:

- **In the dashboard:** *Settings → Network security* — tick "Allow private / localhost"
  to disable blocking on a trusted network, or add specific hosts (e.g. `localhost:11434`)
  to the allowlist.
- **Via environment** (baseline the dashboard builds on):
  ```bash
  # allow a specific local provider without disabling blocking:
  SSRF_ALLOWLIST=localhost:11434,127.0.0.1:11434
  # or, on a fully trusted network, disable private-host blocking entirely:
  SSRF_ALLOW_PRIVATE=true
  ```

Allowlist entries are `host` or `host:port` (a bare host permits any port). The env values
form a read-only baseline; hosts added in the dashboard are merged on top.

</details>

<details>
<summary><b>Content guardrails (optional)</b></summary>


Guardrails are an **opt-in** content filter for prompts and responses — redact PII, or
block banned content and prompt-injection patterns. They are **off by default**; a fresh
deployment filters nothing until you enable them under *Settings → Content guardrails* (or
via `GUARDRAILS_*` env vars). Nexus hard-codes no policy — you bring the rules:

```jsonc
// each rule: name, pattern (regex), action (block|redact),
// appliesTo (input|output|both, default both), optional replacement
[
  { "name": "email", "pattern": "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}", "action": "redact", "replacement": "[REDACTED_EMAIL]" },
  { "name": "injection", "pattern": "ignore (?:all |the )?previous instructions", "action": "block", "appliesTo": "input" }
]
```

Named presets you can copy as starting points: `email`, `us-phone`, `credit-card`, `ssn`,
`api-key`, `prompt-injection`.

- **Input filtering** runs on the admission path *before* the request is forwarded — a
  `block` rule returns `400`, a `redact` rule masks the match and forwards the cleaned prompt.
- **Output filtering** applies to **non-streaming** responses (block ⇒ the content is
  withheld, redact ⇒ matches masked).
- **Streaming + output rules:** the streaming path is intentionally zero-buffer for
  latency, so a response can't be inspected mid-stream. By default streamed responses are
  **input-filtered only** and carry an explicit `X-Nexus-Guardrails-Output: skipped-streaming`
  header — never silently unfiltered. Enable **buffered-safe mode** to collect the response,
  filter it, and replay it as a single chunk, trading the streaming latency win for inspection.

</details>
