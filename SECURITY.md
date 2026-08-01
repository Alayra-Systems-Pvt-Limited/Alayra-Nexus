# Security Policy

Alayra Nexus is an AI gateway that handles provider API keys and proxies
traffic, so we take security seriously. Thank you for helping keep it and its
users safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, email **report-nexus@alayrasystems.com** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept, affected endpoints/config if relevant)
- Any suggested remediation, if you have one

You will receive an acknowledgement of your report, and we will keep you updated
as we investigate and work on a fix. We ask that you give us a reasonable window
to release a fix before any public disclosure, and we are happy to credit you
(if you wish) once the issue is resolved.

## Supported versions

Security fixes land on the latest minor release and on `main`. Older minors are not
back-patched — the project moves quickly and the upgrade path is deliberately small, so the
supported version is **the most recent release**. Always run it.

| Version | Supported |
|---|---|
| Latest release (`1.5.x`) | ✅ |
| Anything older | ❌ — upgrade |

## Never fix a vulnerability in a public pull request

A public fix is a public disclosure. It names the flaw, shows exactly how to exploit the versions
already deployed, and starts a race between attackers and everyone who has to upgrade.

If you have found a vulnerability, **email us instead of opening a PR** — even if the fix is one
line and you have it ready. We will bring you into the fix privately and credit you when it ships.

## Scope

Reports that are especially valuable include, but are not limited to:

- Exposure or leakage of stored provider keys or team keys
- Authentication or authorization bypass on the proxy or admin API
- Injection, SSRF, or request-smuggling in the proxy path
- Weaknesses in the encryption of secrets at rest

Out of scope: vulnerabilities in third-party providers you connect to, issues
requiring physical access to a deployed host, and findings that only affect
misconfigured self-hosted instances (e.g. a publicly exposed admin password).

## No secrets in reports

When sharing reproduction steps, please redact any real API keys, tokens, or
credentials. Use placeholder values.
