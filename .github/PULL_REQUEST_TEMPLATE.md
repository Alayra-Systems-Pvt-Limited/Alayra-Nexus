<!-- Thanks for contributing to Alayra Nexus! Please fill this out so reviewers can move fast. -->

## Summary

<!-- What does this PR change, and why? -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Documentation / chore

## Related issues

<!-- e.g. "Closes #123" -->

## Checklist

- [ ] `npm run lint` passes with 0 errors
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] Dashboard checks pass, if I touched `web/` (`cd web && npm run lint && npm run typecheck && npm test`)
- [ ] I added/updated tests for my change where it made sense — and checked they fail without it
- [ ] I updated the README / docs if behavior or the API changed
- [ ] This PR is **one logical change**, not several bundled together
- [ ] No generated or build output is committed (`dist/`, `web/dist/`, coverage)

## Security

<!-- Alayra Nexus handles provider credentials and production traffic, so every PR is read with
     this in mind. See the security rules in CONTRIBUTING.md. -->

- [ ] No secrets, real API keys, tokens, or `.env` values anywhere in this diff — including tests and fixtures
- [ ] This PR does not weaken authentication, authorization, encryption, or audit logging
- [ ] This PR does not disable, reorder, or bypass security middleware
- [ ] Any new dependency is justified in the summary above
- [ ] This is **not** a fix for an undisclosed vulnerability — those go to [SECURITY.md](../SECURITY.md), never a public PR

## Notes for reviewers

<!-- Anything reviewers should focus on, trade-offs made, or follow-ups. -->
