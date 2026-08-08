# Copyright (c) 2026 Alayra Systems Pvt. Limited (Pakistan) & Alayra Systems LLC (USA).
# Licensed under the Apache License, Version 2.0. See LICENSE at the repository root.
#
# The benchmark's stand-in provider, as an image rather than a bind mount.
#
# Bind-mounting scripts/bench would be shorter and would fail on any machine where the drive is not
# shared with Docker — which is a setting an operator has to have enabled, and not one a
# reproducible benchmark can assume. Copying the file in costs one small layer and works everywhere.

FROM node:22-alpine

COPY scripts/bench/mockUpstream.mjs /mock.mjs

ENV PORT=3210
# See mockUpstream.mjs: the default is loopback so that running it on a laptop does not put a mock
# provider on somebody's network. In a container loopback means "reachable by nothing", so the
# container opts in explicitly.
ENV HOST=0.0.0.0

EXPOSE 3210

CMD ["node", "/mock.mjs"]
