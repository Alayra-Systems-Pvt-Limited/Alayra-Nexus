-- Enterprise SSO (Phase 6.6): a single active identity-provider configuration.
-- Additive only. `protocol` defaults to 'oidc' (the wired adapter); 'saml' is reserved
-- for a later adapter behind the same row. `clientSecret` holds an AES-256-GCM envelope,
-- never plaintext. Least-privilege by default: SSO users are viewers unless the configured
-- claim carries the configured owner value.
CREATE TABLE "SsoProvider" (
    "id"           TEXT NOT NULL DEFAULT 'singleton',
    "protocol"     TEXT NOT NULL DEFAULT 'oidc',
    "enabled"      BOOLEAN NOT NULL DEFAULT false,
    "displayName"  TEXT NOT NULL DEFAULT 'Single Sign-On',
    "issuer"       TEXT NOT NULL DEFAULT '',
    "clientId"     TEXT NOT NULL DEFAULT '',
    "clientSecret" TEXT NOT NULL DEFAULT '',
    "scopes"       TEXT NOT NULL DEFAULT 'openid email profile',
    "roleClaim"    TEXT NOT NULL DEFAULT '',
    "ownerValue"   TEXT NOT NULL DEFAULT '',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SsoProvider_pkey" PRIMARY KEY ("id")
);
