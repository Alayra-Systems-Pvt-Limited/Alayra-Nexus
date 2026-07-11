# Alayra Nexus™ — Development Log

**Project:** Alayra Nexus™ (formerly Kinetic Nexus)  
**Maintainer:** Alayra Systems Pvt. Limited & Alayra Systems LLC  
**Author:** Abbas  
**Purpose:** Official session-by-session development log for the Alayra Nexus open-source AI gateway. Entries are recorded per work session in reverse chronological order — newest at the top. (Entries prior to the July 2026 rebrand reference the project's former name, Kinetic Nexus.)

---

## 2026-07-11

---

**Date:** 2026-07-11 · Session 41  
**Author:** Abbas  
**Title:** Phase 7.2 — Overview screen goes live  

**Summary:**  
The redesigned console's main screen — the Overview an administrator sees first — is now wired to
real gateway data, replacing the placeholder layout from the previous session. Everything on it is
drawn from a single behind-the-scenes read, so the screen loads in one quick step rather than a
dozen separate lookups, and it fills in cleanly the moment the data arrives.

The screen now presents, at a glance: eight headline figures — total requests and total cost to
date, input and output volume over the last seven days, and live counts of active access keys,
available models, and teams — each a card that clicks through to the section behind it. Below
those sit four seven-day trend charts (input, output, request volume, and cost), a "top models"
leaderboard showing where the traffic is going, a "top access keys" table showing which keys are
driving spend, and a running list of the most recent administrative actions, each tagged with its
outcome. Where a day has no activity it is shown as a genuine zero rather than skipped, so the
week always reads as a full week.

The screen is also honest when the gateway cannot be reached: instead of a blank page it shows a
clear message with a one-click retry, so a brief outage never looks like a broken product. Under
the surface, the work was kept deliberately modular — the screen only arranges the pieces, while
each block (a chart tile, each leaderboard, the activity list) is its own small, self-contained
part, and a new shared table and set of formatting helpers were added for every future screen to
reuse. The new interface tests were extended to cover all of this, including the loading, error,
and populated states, so the checks that run on every push now guard the Overview end to end.

Everything passes cleanly on both parts of the project — code style, type safety, the full test
suites, the production builds, and a zero-vulnerability dependency check. The redesign continues
next with the Nexus, Models, and Connect sections.

---

**Date:** 2026-07-11 · Session 40  
**Author:** Abbas  
**Title:** Quality pass — review findings, dashboard build fix, and chart polish  

**Summary:**  
A short, focused clean-up session on top of the new dashboard foundation. Our automated code
reviewer flagged a handful of small robustness points across the gateway, and this session
resolves every one of them. The way one-time recovery codes are generated was rewritten to be
plainer and to remove a fragile assumption that could, in theory, have failed if the format ever
changed. The naming of an administrator access token is now checked and tidied inside the core
routine itself — not only at the edge — so an empty or over-long name can never be stored, no
matter how the routine is called. The cost calculator now states explicitly that a request using
a model it does not recognise is counted as zero spend, and that behaviour is now locked in place
by a dedicated test so it can never drift unnoticed. And one analytics field that carried a
slightly misleading name is now labelled honestly, with the old name kept alongside it so nothing
that already relies on it breaks.

Two issues on the new dashboard were also fixed. First, an error that stopped the dashboard's own
type-check from passing — an unused piece of configuration referencing a tool that wasn't needed —
was removed, so the interface once again builds cleanly. Second, a piece of visual polish: on the
overview charts, a faint horizontal line was showing along the bottom of the shaded area under
each trend line, and only in dark mode. The shaded fill now fades gently into the background
instead of ending in a hard edge, so the charts read as clean, modern sparklines in both themes.
As a side-effect of the new dashboard being a separate package, the main project's style check was
briefly picking up the dashboard's compiled output; it is now told to leave the dashboard folder
alone, since the dashboard already checks itself on every push.

Everything passes cleanly on both parts of the project — code style, type safety, the full test
suites, the production builds, and a zero-vulnerability dependency check. With the foundation now
tidy, the redesign continues with the main overview screen, wiring its live figures and charts to
real gateway data.

---

**Date:** 2026-07-11 · Session 39  
**Author:** Abbas  
**Title:** Phase 7.1 — Dashboard Redesign Foundation  

**Summary:**  
This session lays the groundwork for a complete redesign of the operator console — the screen
an administrator lives in. Rather than patch the old dashboard further, we started a fresh,
modern build of it alongside the existing one, so nothing in production is disturbed while the
new experience is assembled piece by piece. The new console is built on a compact, modern
toolchain but still compiles down to plain static files the gateway serves exactly as before —
so the product stays a single, easy-to-self-host package, with no extra servers to run and no
reliance on the public internet at runtime. That last point matters for serious deployments:
the fonts and the charts are now bundled in, where before the charts were fetched from an
outside service every time — something that quietly failed on locked-down or offline networks.

The foundation itself is what everything else will stand on. There is now a single, coherent
visual language — a calm "slate glass" look where the panels, sidebar, and bars float over one
continuous background — expressed once as a set of design tokens so the whole product stays
consistent. On top of that sits a proper **light and dark theme**, both tuned for eye comfort
rather than harsh pure-white or pure-black, switchable from the top bar and remembered between
visits. The full navigation for the redesigned product is in place — the twelve sections the
new console will offer, grouped sensibly with the everyday tools up top and the system controls
below — and the frame around them (sidebar, top bar, a live-status indicator, a theme switch,
and a notifications bell) is complete and responsive. A small, reusable kit of building blocks
(cards, buttons, badges, stat tiles, a self-contained chart) was created so every future screen
looks like part of one product rather than a patchwork.

Just as importantly, this new console ships with its own automated test suite wired into the
same checks that run on every push, so the interface is guarded against regressions from day
one — a change that would break a screen or a user's workflow is caught before it can land.
Everything in this foundation passes cleanly: code style, type safety, the interface tests, the
production build, and a zero-vulnerability dependency check. The redesigned sections now fill in
one at a time on top of this base, beginning with the main overview screen next.

---

**Date:** 2026-07-11 · Session 38  
**Author:** Abbas  
**Title:** Phase 6.7 — Audit Trail & Compliance Logging  

**Summary:**  
When more than one person can administer a system, "who changed this, and when?" stops being a
rhetorical question. Until now the gateway could tell you its current state but not its history:
a key was banned, a budget was changed, a setting was flipped — but nothing recorded that it
happened, who did it, or from where. This session adds that memory. Every action that changes
the gateway is now written to a permanent, append-only record — the action, the person's access
level, what they acted on, their address, the time, and the result. Sign-ins, sign-outs, and
single sign-on logins are recorded too, including the failed attempts, which are often the ones
worth seeing.

Two design choices make this trustworthy rather than decorative. First, the recording happens in
one place that sits across the whole admin surface, so a feature added next month is covered
automatically — no one has to remember to log it. Second, the record is genuinely read-only:
there is no way, through the product, to edit or quietly delete an entry; the log can be read and
filtered, but the only thing that ever removes an entry is the retention policy the operator sets.
Passwords, keys, and codes are stripped out before anything is written, so the trail can never
itself become a place a secret leaks. And because the writing is done in the background, keeping
this history never slows down the dashboard.

The same session adds the compliance controls that a serious deployment needs. An operator can
say how long to keep each record — the action history and the usage history are governed
separately, each up to ninety days, or set to "off" to keep everything indefinitely. Both start
at ninety days, a common international norm, applied automatically by a daily cleanup; an operator
who wants a full archive simply turns retention off. There is also an anonymization option for
privacy-strict environments, which de-identifies the traffic records — replacing the session
fingerprint with a one-way code and masking network addresses — so the analytics remain useful
while the personal detail is gone. The one honest note we put in front of the operator, right on
the control: shortening the usage window also shortens how far back the analytics charts can look.

The audit trail and the compliance controls appear together as a read-only, filterable view in
the Settings area, exactly where an administrator would look for them. Shipped green across the
board — code style, type safety, the full automated test suite (twenty-three new tests), the
production build, and a zero-vulnerability dependency audit, with no new dependency added.

---

**Date:** 2026-07-11 · Session 37  
**Author:** Abbas  
**Title:** Phase 6.6 — Enterprise Single Sign-On (OpenID Connect)  

**Summary:**  
Until now, signing in to the gateway's control panel meant one shared admin password (with an
optional authenticator code on top). That works for a solo operator, but it is not how a
company runs access. Larger organisations already have a single front door for every internal
tool — Okta, Microsoft Entra, Google Workspace, and the like — where joining, leaving, and
group membership are managed once, centrally. This session lets Alayra Nexus stand behind that
same front door. An operator can now point the gateway at their identity provider, and staff
sign in with the corporate account they already use, rather than a separate password kept just
for this tool.

The sign-in follows the modern, widely-supported OpenID Connect standard. When someone chooses
to sign in this way, the gateway hands them off to the company's login page; once the provider
confirms who they are, it sends them back and the gateway checks that confirmation against the
provider's own published credentials before trusting it. The heavy cryptographic verification
is delegated to a well-established, audited library rather than written by hand — the
responsible choice for something this security-sensitive, and consistent with the project's aim
of a small, trustworthy codebase.

Crucially, single sign-on is joined to the access levels introduced last session. An operator
names the group (or attribute) that should be treated as an administrator; anyone in it signs
in with full **owner** control, and everyone else who authenticates is admitted as a read-only
**viewer**. The default leans deliberately toward the cautious side — an unmapped or
misconfigured account is a viewer, never an accidental owner — and the master password stays as
a guaranteed way back in, so a configuration mistake can never lock the operator out of their
own gateway. The connection secret the provider issues is stored with the same strong
encryption as every other credential in the system, and the gateway's existing protection
against being pointed at internal addresses covers every request it makes to the provider.

This is off until switched on, so upgrading changes nothing for existing deployments: the
"Sign in with Single Sign-On" option only appears once an identity provider has been
configured. The design also leaves room for the one enterprise login standard not covered here,
SAML, to be added later as a second option without reworking what was built now. Shipped green
across the board — code style, type safety, the full automated test suite (twenty-eight new
tests), the production build, and a zero-vulnerability dependency audit.

---

**Date:** 2026-07-11 · Session 36  
**Author:** Abbas  
**Title:** Phase 6.5 — Role-Based Access Control  

**Summary:**  
Until now the gateway's control panel was all-or-nothing: whoever could get in could do
anything — read the numbers, but also rotate keys, change budgets, alter security settings,
mint new credentials. For a single operator that is fine, but the moment a second person is
involved it is too much. A colleague who only needs to watch usage, a monitoring tool that
only needs to read health, a contractor you want to show the dashboard to — none of them
should have to hold the one credential that can change everything. This phase introduces the
distinction that fixes that: an access level carried by every admin credential.

There are two levels. An **owner** has the full control the gateway has always offered. A
**viewer** may look but not touch — every page still opens and every figure is still visible,
but anything that would change the system is refused. The rule is enforced where it must be,
at the server: reading is open to either level, and every action that alters state requires an
owner, checked in a single shared place so that a route added tomorrow inherits the protection
without anyone having to remember to add it. The dashboard reflects the same truth rather than
pretending otherwise — a viewer sees a clear banner explaining the read-only state, and any
attempt that the server would refuse is met with a plain message instead of a silent failure.

Two things make this fit the product as it actually is. First, it changes nothing for anyone
already using the gateway: an existing credential, and the master password itself, are always
owners, so upgrading is invisible until you choose to create a read-only credential. Second,
a read-only credential can be handed out without handing over the master password at all — a
viewer token can be minted for a person or a tool, and it can be used to sign in to the
dashboard directly, arriving already limited to what it is allowed to see. Access can be
granted narrowly, and taken back, without ever exposing the credential that protects
everything else.

The change to stored data was a single additive field with a safe default, so nothing that
exists today is altered by the upgrade.

**Verification:** Full green gate — linter clean, type-checker clean, full test suite passing
with new coverage for role resolution, the owner-only gate, and signing in with a scoped
credential; production build clean; dependency audit reporting zero vulnerabilities.

---

**Date:** 2026-07-11 · Session 35  
**Author:** Abbas  
**Title:** Hardening — Notification Delivery and Analytics Aggregation  

**Summary:**  
A pass over the code turned up two things worth correcting before the next feature, and this
short session addressed both.

The first concerns the alerts the gateway now sends. When it reached out over email or a
webhook, it did not look closely enough at the answer it got back: a refusal from the mail
provider — a key that had been rotated, a sender address that was never verified — or an error
from a webhook endpoint was accepted as though the message had gone through. That would be a
small matter on its own, but the way the gateway avoids flooding an operator with repeats made
it consequential. To send exactly one message per problem per window, it marks the problem as
handled the moment before it tries to send. If that single attempt then failed unseen, the
mark stayed, and every later occurrence in the window was quietly held back — so the one
message that mattered could be lost with nothing to show for it. Now the answer is read
properly, and when a channel was actually tried and nothing got through, the mark is lifted so
the next occurrence tries again. A message that genuinely went out still counts, and the
one-per-window quiet is unchanged.

The second concerns the usage dashboards. The figures behind them — totals, the breakdown by
model and by provider, the per-day and per-team histories — were being assembled by pulling
every record for the chosen span out of the database and adding them up in the application.
For a long span on a busy gateway that is an enormous amount of data to move and hold, all to
produce a handful of summary numbers. That work now happens inside the database, which is
built for exactly this: it returns the already-summed figures, a small and steady amount no
matter how much traffic sits behind them. The dashboards read the same as before; only the
cost of producing them has dropped sharply. While there, the summary was also taught to report
the end of the range it covers, not only the start, so a custom date range is stated in full.

Neither change alters any behaviour an operator relies on, and no database change was required.

**Verification:** Full green gate — linter clean, type-checker clean, full test suite passing
with new coverage for the release-on-failed-delivery path and for the database-side
aggregation, production build clean, dependency audit reporting zero vulnerabilities.

---

**Date:** 2026-07-11 · Session 34  
**Author:** Abbas  
**Title:** Phase 6.4b — Budget and Capacity Alerts  

**Summary:**  
The previous session gave the gateway a voice for the troubles it discovers quietly in the
background — a dead credential, a failing upstream, someone at the admin door. This session
extends that voice to the two things an operator most wants to hear about while traffic is
actually flowing: money, and a refusal to serve. Both are conditions that reveal themselves
only in the middle of a live request, which is why they were deliberately held back from the
first pass — the path a request travels is the most sensitive part of the system, and it was
worth instrumenting it carefully rather than in the same breath as everything else.

The first alert is about spend. Every team may be given a budget for a window — a day, a
week, a month — and every completed request adds its real cost to that window's running
total. The moment that total first passes eight-tenths of the limit, and again the moment it
reaches the whole of it, a message goes out: the team is approaching its ceiling, and then,
the team has hit it and is now being turned away until the window resets. The crossing is
noticed as the cost is recorded, so no extra bookkeeping is added to the request; and it is
worded to fire once as each line is crossed, not once for every request that follows, so a
team that sits above its limit for the rest of the month is the subject of one message, not
a thousand.

The second alert is about capacity. When a request arrives and there is no healthy key left
anywhere that can serve it, the gateway has no choice but to refuse — and a refusal that no
one is told about is the worst kind of silence, because from the outside it looks like the
product is simply broken. That refusal happens at a single place the routing funnels
through, whichever kind of request it was — a chat, an embedding, an image, a transcription —
so one tap covers them all uniformly, and the message distinguishes the two shapes the
refusal can take: a shared pool that is momentarily out of headroom, or a team held in strict
isolation that has run through its own keys with no fall-back permitted.

Both messages travel the exact machinery built in the previous session — the same encrypted
channels, the same detachment from the request, the same one-message-per-window quieting —
so nothing about how alerts are delivered changed; only two new reasons to send one were
added, each with its own on-off switch in the settings card. As with every capability here,
the whole feature stays dark until an operator chooses to enable it. No database change was
required; the running spend was already tracked, and reading back its new total after each
addition was all that the budget alert needed.

**Verification:** Full green gate — linter clean, type-checker clean, complete test suite
passing with new coverage for the budget-crossing logic and the capacity tap, production
build clean, dependency audit reporting zero vulnerabilities.

---

**Date:** 2026-07-11 · Session 33  
**Author:** Abbas  
**Title:** Phase 6.4 — Operator Notifications  

**Summary:**  
Until now the gateway kept its troubles to itself. When a provider key died, when an
upstream began failing hard enough to be set aside, when someone hammered the admin login
until it locked — all of it was visible, but only to an operator who happened to be
looking at the dashboard. A gateway that quietly degrades while no one watches is doing
half its job. This phase gives it a voice: it can now reach out when something goes wrong.

The design followed the same rule every optional feature here has followed. It is off
until an operator turns it on, it is configured from a single card in the settings, and
the credential it needs — an email provider's key — is held under the same encryption as
every provider credential, never written in the clear and never shown again once saved,
only ever masked. Two channels are offered and either or both may be used: email through a
free provider, and a plain web address that a chat tool or a pager service can receive, so
an alert can land wherever the operator already looks.

The discipline that mattered most was keeping all of this away from the work the gateway
actually does. A request being proxied must never wait on an email, and must never fail
because one could not be sent; sending is entirely detached, and a delivery that hangs or
errors changes nothing a caller can see. The second concern was quiet. A failing key does
not fail once — it can fail hundreds of times a minute, and a naive design would answer
each with its own message until the inbox was the outage. So each kind of alert is sent at
most once within a window, claimed with a single atomic marker that every other occurrence
in that window sees and stands down for. A storm becomes one message.

Three situations were wired to it, chosen because each is a moment the gateway already
recognizes cleanly and none of them sit on the path of a normal request: a key being
automatically banned after repeated rejection, a breaker opening after repeated upstream
failures, and the admin login locking out after repeated bad attempts — degradation,
outage, and intrusion, one of each. Two further alerts that would be valuable — warning as
a team nears its spending cap, and warning when a whole tier has no key left to serve a
request — were deliberately left for the next step, because both must be measured on the
path of a live request rather than at a quiet failure point, and that instrumentation
deserves to be done carefully and uniformly rather than bolted on here.

The engine is proven by tests at both halves: the pure part — how a stored configuration
is made sane, how each message reads, how an occurrence is keyed — and the moving part —
that a configured alert sends by both channels, that a repeat inside the window sends
nothing, that a disabled feature and an unconfigured channel and a failed send all pass
quietly, and that the saved key is encrypted at rest and never handed back.

**Green gate:** lint 0 · typecheck 0 · 319 tests pass (+14) · build 0 · npm audit 0 vulnerabilities.

---

**Date:** 2026-07-11 · Session 32  
**Author:** Abbas  
**Title:** Phase 6.3d — Speech-to-Text, and Per-Modality Pricing in the Dashboard  

**Summary:**  
This phase closes the audio pair and, with it, the run of non-conversational endpoints.
Turning speech into text is the mirror image of the previous phase, and it is the harder
half for a reason that has nothing to do with the transcription itself: the recording is
not described in a request, it is uploaded as a file. That is a manner of carrying a
request the gateway had never handled — everything before it arrived as either text or a
small piece of structured data. So the gateway learned to receive an upload, and to do
so within a firm size limit, refusing an oversized file at the door rather than drawing
it into memory.

The care in this phase went to keeping the upload consistent with the promise the whole
gateway makes. From the beginning, the point of Nexus has been that the caller names a
model in the abstract and the gateway decides which real model, on which account,
actually serves the request. An upload made that promise harder to keep, because the
model to use is written inside the uploaded form alongside the audio. The gateway
therefore does not pass the upload along untouched; it reads the pieces out, sets aside
the model the caller named, and reassembles the form around the model it chose itself
before sending it on. The routing, the failover, the budgets, and the breaker are the
same as for every other endpoint; only the shape of what travels to the provider is new.
The answer that comes back can be a short document, a plain line of text, or a subtitle
file, depending on what the caller asked for, so it is returned exactly as it arrives
rather than assumed to be one of them.

Pricing for a transcription was kept deliberately simple and honest. The natural way to
charge for it is by the length of the recording, but the provider does not disclose that
length unless the caller gives up the format they asked for, and buying a cheaper price
at the cost of the caller's chosen output is a poor trade. So a transcription is billed
as one transcription, at a price the operator sets on the model, recorded in its own unit
beside the tokens and images and characters that came before it. Measuring by the second
remains possible later, and would sit on exactly the same accounting; it is a refinement,
not a foundation.

The phase also carried a smaller piece of work that had been owed since images first
arrived. The prices for these newer modalities existed in the data but could only be set
by editing the registry through the API, which is no way to ask an operator to work. The
Models tab now has plain fields for them — a price per image, a price per million
characters of speech, a price per transcription — sitting beneath the familiar per-token
costs, so every kind of model the gateway can route is now priced from the same screen.

With this, the gateway speaks the whole of the common surface: conversation in two
dialects, embeddings, completions, images, speech, and transcription, each one a front
door onto a single shared core rather than a system of its own. What was held back was
held back for cause and named where it was deferred — a Gemini-native dialect with a
small audience, video with no settled standard to be compatible with, and per-second
audio pricing that would cost the caller their chosen format. The tests cover the new
transport at its seams: the upload is rebuilt around the routed model rather than the
caller's, the multipart body is sent without a hand-set content type so its boundary is
correct, the reply is returned untouched, and a transcription is billed as its own unit.

**Green gate:** lint 0 · typecheck 0 · 305 tests pass (+1) · build 0 · npm audit 0 vulnerabilities.

---

**Date:** 2026-07-11 · Session 31  
**Author:** Abbas  
**Title:** Phase 6.3c — Text-to-Speech  

**Summary:**  
Every endpoint the gateway has offered until now returns text. A chat reply, an
embedding vector, an autocompletion, the description of a generated image — all of them
arrive as a document the gateway reads, accounts for, and hands on. Speech synthesis is
the first request whose answer is not a document at all. What comes back from the
provider is a piece of audio, a stream of bytes that means nothing if it is parsed as
text and is corrupted if it is re-encoded as one. This phase teaches the shared
transport to carry that kind of reply.

The change is contained. A request for spoken audio is still ordinary text going out —
the words to be spoken, the chosen voice — so it travels the same path as the endpoints
before it and picks a model the operator has marked as speech-capable. Only the return
trip is new: instead of reading the reply as data, the gateway passes the bytes back
exactly as they arrived and preserves the label that tells the caller what kind of audio
it is holding. Nothing about the routing, the failover, the budgets, or the circuit
breaker changes; a single switch decides whether a reply is read as a document or as raw
sound, and everything else is shared.

Billing followed the same principle set down in the previous phase. Synthesized speech
is not priced by tokens; it is priced by the number of characters spoken, which is
something the request itself already tells us — there is no need to inspect the audio
that comes back, which is fortunate, since it carries no account of itself. So the
gateway measures the text it was asked to speak and records it in the unit providers
actually publish their prices in, a rate per million characters, against a price the
operator sets on the model. The per-unit accounting added for images last time needed no
change to hold a second modality, which was the reason for building it that way.

One half of audio remains for the next phase, and again for a real reason rather than
caution. Turning speech back into text is the mirror image of this work: the recording
is uploaded rather than described, which is a different manner of carrying a request than
anything the gateway does today, and the natural way to price it is by the length of the
audio, which the provider does not disclose unless the caller gives up the format they
asked for. That is the whole of the phase that follows, and it will reuse the accounting
and the routing this one leaves in place. Keeping speech synthesis on its own held this
change small and entirely covered by tests: the audio is returned intact with its type
preserved, and the characters of the request are billed as their own unit rather than as
tokens, all confirmed through the same stubbed routing the other endpoints use.

**Green gate:** lint 0 · typecheck 0 · 304 tests pass (+2) · build 0 · npm audit 0 vulnerabilities.

---

**Date:** 2026-07-11 · Session 30  
**Author:** Abbas  
**Title:** Phase 6.3b — Image Generation and Per-Modality Billing  

**Summary:**  
The previous phase deliberately left one thing unfinished. Embeddings and completions
are measured in tokens, and the gateway has always counted tokens, so they cost nothing
extra to account for. Images are different. An image is not billed by the words in its
prompt; it is billed per picture produced. The remaining non-conversational endpoints
all share this property in their own way, and none of them can be accounted honestly by
a token count alone. Before adding any of them, the gateway needed a way to record what
was actually bought.

This phase gives it one. Every usage record now carries the unit it was measured in and
a quantity in that unit, alongside the token figures it always had. A chat request still
reads as tokens, exactly as before; an image request reads as a count of images. The two
never mix, so the token totals that drive the charts and the usage leaderboard stay
clean while image spend is tracked truthfully beside them. The change to the database is
additive and carries its own defaults, so every existing record and every request in
flight continues to read correctly with nothing to migrate by hand.

On that foundation the phase adds a single endpoint: image generation. It routes to a
model the operator has marked as image-capable, priced per image, and it travels the
same path as every other request — the same choice of model and key, the same circuit
breaker, the same team budgets, the same failover and analytics. Nothing about the
routing is new; only the meter is. A request with no image-capable model configured is
refused plainly, naming what is missing and pointing at the Models tab, in the same
manner as the endpoints before it.

Audio was again held back, and for a concrete reason rather than caution. Synthesized
speech is returned not as a document but as a stream of sound, and a transcription is
submitted not as text but as an uploaded recording — a different manner of carrying the
request and the reply than anything the gateway does today, and one that also needs a
way to measure the length of audio in order to price it. That is its own body of work,
and it is the whole of the next phase, which now rests on the per-unit accounting this
one put in place. Keeping images separate held this phase to a small, reviewable change
fully covered by tests: the image count is read from the provider's reply, falls back to
the number requested when the reply omits it, and is recorded as a unit of images rather
than as tokens, all verified through the same stubbed routing the other endpoints use.

**Green gate:** lint 0 · typecheck 0 · 302 tests pass (+4) · build 0 · npm audit 0 vulnerabilities.

---

**Date:** 2026-07-11 · Session 29  
**Author:** Abbas  
**Title:** Phase 6.3 — Embeddings and Legacy Completions  

**Summary:**  
With the Anthropic dialect in place, the gateway still answered only conversational
requests. A great deal of real work is not a conversation: a retrieval system turns
documents into vectors through an embeddings endpoint, and an editor's autocomplete
fills in the middle of a line through the older completions endpoint. Neither has
messages, neither is a chat, and so neither could pass through the chat handler, which
is built around messages from end to end. This phase adds both endpoints, and it does
so without standing up a second gateway beside the first.

The distinction that made this clean is between routing and transport. Routing — which
model, which key, which provider, whether the breaker allows it, whether the team is
within budget, whether a private key must be preferred, and how the result is
accounted — is the hard, careful part, and it is already shared. Transport is merely the
shape of the request and reply on the wire, and a non-conversational request has a
simpler shape than a chat one: a body in, a body out, no streaming, no output to
inspect. So the new endpoints keep the entire routing and resilience path unchanged and
add only a lean transport around it. A request selects a model by the capability the
endpoint needs, is forwarded to the provider with the model the gateway chose in place
of whatever the client named, and the response's token counts are recorded against that
real model exactly as chat does. Every failure mode is handled the same way it is for
chat: a rate limit cools the key, a server error strikes the breaker, an authentication
failure moves toward banning it, and a timeout refunds the reserved capacity.

Because selection is now by capability, an endpoint that has no model to serve it does
not fail obscurely. A request for embeddings when no embedding-capable model is
configured returns a plain refusal that names the missing capability and points at the
Models tab, rather than a generic rate-limit message that would send an operator
looking in the wrong place. The endpoint always exists; whether it can be served is a
matter of configuration, and the response says so.

Both of these modalities are measured in tokens, which is what the usage pipeline
already records, so they needed no change to how spend is tracked. The remaining
modalities do not fit that shape — an image is billed per image, synthesized speech per
character, a transcription per second of audio — and honest accounting for them needs a
unit alongside the count. That is a schema change, and rather than fold it into this
phase it is deliberately held for the next, where images and audio are added together
with the accounting they actually require. Keeping this phase to the two token-shaped
endpoints kept it free of a migration and fully covered by tests: the reserve
estimates, the usage extraction, and the whole forward-and-report path driven through
stubbed routing to confirm success records usage and each upstream failure feeds the
breaker.

**Green gate:** lint 0 · typecheck 0 · 298 tests pass (+10) · build 0 · npm audit 0 vulnerabilities.

---

**Date:** 2026-07-11 · Session 28  
**Author:** Abbas  
**Title:** Phase 6.2 — The Anthropic Messages API  

**Summary:**  
The gateway spoke one protocol, OpenAI's, and that single fact was why an entire class
of tools could not use it. Claude Code, and every application built on Anthropic's own
SDK, address a different endpoint with a differently shaped request, a differently
shaped reply, and a wholly different streaming format. No base URL or key could bridge
that; the endpoint simply did not exist. It exists now. Alayra Nexus answers Anthropic's
Messages API at the same origin it answers OpenAI's, and a request arriving in either
dialect is served by exactly the same machinery behind it.

The design rule that governed the phase was that there must not be a second gateway
hiding inside the first. Routing, failover, the circuit breaker, budget enforcement,
the bring-your-own-key isolation, guardrails, the response cache, and the analytics
pipeline are difficult precisely because they are careful, and duplicating them for a
second protocol would mean maintaining two subtly diverging copies of the most
important code in the project. So the Anthropic endpoint owns none of that. It
translates the incoming request into the canonical OpenAI shape, hands it to the same
function that already serves OpenAI traffic, and translates whatever comes back. The
core does not know, and does not need to know, which dialect the caller spoke.

Making the response translation invisible to that core was the interesting part. The
core writes its answer — a JSON body, or a stream of server-sent events — to a reply
object. Rather than teach it a second output format, the Anthropic route hands it a
stand-in reply that looks exactly like the real one and quietly translates every write
on its way to the socket. A non-streaming completion becomes an Anthropic message; an
error becomes an Anthropic error envelope with the right type for its status; and a
streamed OpenAI response is re-framed, event by event, into Anthropic's flow of a
message opening, a content block opening, a run of deltas, the block closing, a final
delta bearing the stop reason, and the message closing. The translation happens on the
wire, never by collecting the whole answer first, so the time a user waits for the first
token is unchanged.

The two formats disagree about structure, not merely about names, and the streaming
translator is where that shows. OpenAI streams flat fragments; Anthropic frames a
message as a sequence of self-contained content blocks, each opened and closed in turn,
with tool calls appearing as their own blocks distinct from text. The translator is a
small state machine that opens a text block when the first text arrives, closes it and
opens a tool block when a tool call begins, streams the tool's arguments as they trickle
in, and closes everything cleanly at the end — even for an empty response, which still
must be a well-formed message. Requests are translated in the other direction with the
same care: a top-level system prompt becomes a leading message, tool definitions and
tool results and image blocks are each mapped across, and the model the caller named is
replaced with the gateway's own, because Nexus decides the model, not the client.

Because Anthropic clients present their key in a different header, the authenticator now
accepts it either as a bearer token or as the header Anthropic uses, and the
model-discovery endpoint returns a description broad enough that a client of either
dialect reads what it expects. The whole path is covered by unit tests: the request and
response translations, the error mapping, and the streaming state machine driven through
recorded fragment sequences for plain text, for tool calls, for a response split
awkwardly across network reads, and for the empty case. A separate suite drives the
reply stand-in exactly as the core does and confirms Anthropic events emerge on the
socket. What remains is to point Claude Code at a running gateway and watch a real
session, which is a live check rather than a code one.

**Green gate:** lint 0 · typecheck 0 · 288 tests pass (+31) · build 0 · npm audit 0 vulnerabilities.

---

**Date:** 2026-07-10 · Session 27  
**Author:** Abbas  
**Title:** Phase 6.1 — Model-First Routing  

**Summary:**  
Until now the gateway decided which model to run from a field on the pool. A pool is a
provider's credentials — a base URL, an authentication scheme, and one or more keys —
and hanging a single model off it meant one key could serve exactly one model, while
the Models registry that operators actually edit did not influence routing at all.
Worse, the two disagreed silently: a request recorded its cost by matching the pool's
model string against the registry, and when the two did not line up the request was
booked at zero. Selecting a model in the Models tab did nothing; the pool always won.

Routing now walks models rather than pools. The registry is the source of truth for
which model runs, its tier, and its priority. Selection considers every active model
that declares the requested capability and whose provider has a configured pool, orders
them by tier, then by priority, then — when cost-aware routing is enabled — by price
within a tier, and for the best model finds a healthy key belonging to its provider.
The consequence operators asked for falls straight out of this: a single Anthropic key
can now serve a premium model and a fast model at the same time, because the tier lives
on the model, not on the credential. The mechanics that make routing safe — the circuit
breaker, atomic admission, the bring-your-own-key ownership filter, and sticky
cache-affinity — are untouched; only the outer choice of what to attempt changed, and
each selected key still passes through exactly the same gates.

Every model now carries a set of capabilities — chat, completion, embedding, image,
speech, transcription — which is the foundation the coming protocol work stands on. An
endpoint asks for a capability and only models that declare it are eligible, so the
Anthropic Messages endpoint and the embedding, image, and audio endpoints that follow
will each select from the same registry without a second routing path. A model with no
declared capability is treated as a chat model, and a legacy tool-completion flag is
read as the completion capability, so nothing an operator configured before is lost.

The transition was built to be invisible. The registry begins empty rather than
shipping phantom default models that would route to providers nobody configured, and on
startup any active pool that still carries a model contributes a registry entry with its
tier and the chat capability, so an upgraded deployment routes exactly as it did the day
before. Should the registry ever be empty when a chat request arrives, the old
pool-tier walk still answers it, so there is no version in which upgrading takes the
gateway offline. The pool's model field remains, now optional and labelled as legacy.

Two long-standing defects were closed along the way. A request whose model was missing
from the registry is no longer booked at zero cost, because usage is now attributed to
the real model the router chose. And the endpoint that saves the registry, which
previously stored whatever it received, now validates every entry and refuses duplicate
identifiers or duplicate provider-and-model pairs, either of which would have made
selection non-deterministic.

**Green gate:** lint 0 · typecheck 0 · 257 tests pass (+28) · build 0 · npm audit 0 vulnerabilities.

---

**Date:** 2026-07-10 · Session 26  
**Author:** Abbas  
**Title:** Phase 6 — Security & Auth Hardening  

**Summary:**  
The admin password, the gateway's API key, and the metrics token were each compared
with a plain equality check. String equality abandons the comparison at the first
byte that differs, so the time taken to reject a wrong guess reveals how many leading
characters were right, and a patient caller can recover a secret one character at a
time. All three now go through a constant-time comparison over fixed-width digests,
which also sidesteps the trap that the underlying primitive rejects operands of
unequal length — a naive guard against that would itself have disclosed the length of
the secret. Team keys were never affected; they have always been hashed lookups.

The larger problem was structural, and the phase could not be honestly delivered
without confronting it. The dashboard held the administrator's password in browser
storage and presented it as the bearer token on every request. A second factor cannot
be attached to an arrangement like that. A second factor exists to make a login
produce a credential that proves the factor was satisfied; if the credential is the
password itself, then anyone who has the password never encounters the factor at all.
Adding a code prompt to the sign-in screen while leaving password-bearer authentication
in place would have looked like two-factor authentication and protected nothing.

Signing in therefore now exchanges the password, and an authenticator code once one is
enrolled, for a short-lived session token. Only that token is stored by the browser,
which also removes the administrator's password from the reach of any cross-site
scripting on the page — a category of flaw this project has had to fix twice in the
last week. Once a second factor is confirmed, the password stops being accepted as a
bearer token on the administrative API, because leaving it accepted would restore the
bypass the factor exists to close. Scripts and continuous integration, which cannot
present a code, authenticate instead with named administrative tokens that are stored
hashed, listed in the dashboard, and revocable. Before anyone enrols a factor,
everything behaves exactly as it did, so upgrading changes nothing.

The time-based algorithm itself is implemented against node's cryptography rather than
taken from a package. It is a keyed hash, a truncation, and a modulo, and both governing
specifications publish test vectors — so its correctness is demonstrated by those
vectors rather than assumed, and the most security-sensitive path in the project takes
on no third-party code. Verification accepts one time step of clock drift in either
direction, compares every candidate in constant time, and deliberately does not stop at
the first match, because an early exit would make a correct-but-skewed code faster to
check than a wrong one and thereby disclose the device's clock offset.

Enrolment is deliberately two-staged. A secret is minted and stored encrypted but
inert; nothing about authentication changes until a code proves the operator actually
holds it. An enrolment abandoned halfway therefore cannot lock anybody out of their own
gateway. Confirmation issues ten single-use recovery codes, shown once and retained
only as hashes, any one of which substitutes for the authenticator when a phone is
lost.

Repeated sign-in failures now lock the originating address out for a fixed window and
return the wait time. A correct password offers no escape from an active lockout, and a
wrong password is reported identically to a wrong code, so the form cannot be used to
learn whether a password was right before the second factor was reached. Sign-in
outcomes are counted by result, because a rising rate of rejections is how an operator
learns someone is guessing.

Finally the schema gained a table for custom domains, each with its own verification
state and challenge token, ahead of the interface that will drive it — a table rather
than a column, because a team may map more than one hostname and each has to be proven
separately, and because discovering that halfway through a user-interface phase would
mean migrating the database in the middle of it.

**Green gate:** lint 0 · typecheck 0 · 220 tests pass (+62) · build 0 · npm audit 0 vulnerabilities.

---

**Date:** 2026-07-10 · Session 25  
**Author:** Abbas  
**Title:** Startup Diagnostics — Saying What Is Missing  

**Summary:**  
Starting the gateway without Redis produced about twenty identical connection-refused
stack traces, each several lines deep, and then terminated with a message about a
retry limit and an option name. Every fact an operator needed was absent: which
service was unreachable, at which address, whether it was required, and what to run.
The gateway was behaving correctly — it depends on Redis and Postgres, and refusing to
start without them is right — but it was reporting that correctness as though it were
an internal fault.

Startup now verifies both dependencies before doing any other work, using the same
clients the application itself uses, so a pass means the configuration is sound rather
than merely that something is listening on a port. A failure prints one short block:
the service, the host and port it was looked for at, the underlying reason, the
command that starts it, and a one-line explanation of what that service holds and why
it cannot simply be skipped. The stack trace is dropped, because the stack of a
refused connection describes the network library, not the problem. Genuine internal
errors keep their stacks.

The address in that message is derived rather than echoed. Connection strings commonly
carry a password, and a startup failure is written to standard output and swept into
log aggregation, so the URL is reduced to a host and port before it is printed and an
unparseable value degrades to a constant rather than being repeated verbatim. That
property is pinned by tests, since a regression there would leak a credential into
logs that outlive the process.

Reconnection noise during ordinary operation was addressed at the same time. The
driver emits an error for every retry, and logging the full object each time buries
the single line that matters. The first occurrence is now logged as one line, and
subsequent ones are collapsed into a periodic count.

The message also points anyone who only wants to look at the dashboard toward serving
it on its own, which needs neither database nor gateway. Two long-standing errors in
the setup documentation were corrected while the path was being walked: the dashboard
is served at the root, not under a separate path, and the manual instructions never
mentioned that the two dependencies had to be running before the server would start.

**Green gate:** lint 0 · typecheck 0 · 158 tests pass (+8) · build 0 · npm audit 0 vulnerabilities.

---

**Date:** 2026-07-10 · Session 24  
**Author:** Abbas  
**Title:** Dashboard — Verifying the Preview, and a Regression the Move Introduced  

**Summary:**  
Every section of the dashboard's server-less preview was exercised in a real browser
rather than reasoned about: the endpoint panel, the provider pools with their key
tables and utilisation meters, the model registry, the team keys, all four analytics
charts, and the settings cards. All render, and no script error is raised anywhere in
the walk. The preview needs neither a database nor a running gateway, which makes it
the fastest honest check that the dashboard still works after any change to it.

The exercise was prompted by a genuine defect, and it found one. Splitting the
dashboard into ES modules made it lintable and reviewable, but it also made it
unopenable: a browser refuses to load a module from a filesystem origin, so
double-clicking the page now renders the login screen with every button silently
inert. Nothing is logged, nothing is thrown, and the natural conclusion is that the
dashboard is broken. The previous single-file page had no such constraint. A classic
script — one that a browser *will* load from the filesystem, and which therefore still
runs when the module graph cannot — now detects that origin and replaces the login box
with the command needed to serve the page properly. A silent failure has been turned
into an instruction.

The preview's provider tables were also a version behind: they still showed the four
columns that existed before keys could be owned by a team. They now carry the owner
column, with one key attributed to a team and the rest to the shared pool, so the
preview shows the product as it actually is rather than as it was.

Finally, the local preview configuration had been pointing at a directory that ceased
to exist when the project was renamed, which is why the dashboard could not be served
during earlier sessions and why its behaviour had been argued about rather than
observed. It points at the right place now.

---

**Date:** 2026-07-10 · Session 23  
**Author:** Abbas  
**Title:** Brand — Generated Banners for README, X, and the Social Card  

**Summary:**  
The project now has a banner set: a hero for the top of the README, a header sized for
an X profile, and the social card GitHub serves when the repository is linked
anywhere. All three are generated rather than drawn. A build script lifts the crest
out of the canonical artwork and composes each layout around it, so the mark cannot
drift out of sync across surfaces the way hand-maintained exports always eventually
do. Editing the crest and re-running the script updates every banner at once.

Two constraints shaped the layouts. X renders a profile header at roughly a fifth of
its upload canvas, so that variant carries larger type, drops the fine print, and
seats the crest on the right, where the profile avatar — itself the crest — cannot
overlap it. And because both X and GitHub re-compress on high-density displays, the
exports ship at twice their nominal size; the single-density files are kept only as
fallbacks and are explicitly marked as the wrong thing to upload. The brand
documentation now records which file belongs on which surface, so the question does
not have to be answered twice.

The hero reference had been added to the README a commit earlier while the image
itself was still untracked, which left the front page of the repository showing a
broken image for the few minutes between the two pushes. Both are now committed
together.

---

**Date:** 2026-07-10 · Session 22  
**Author:** Abbas  
**Title:** Phase 5.6 — Structural Split, Architecture Docs, and a Silent Packaging Defect  

**Summary:**  
The gateway's backend layering has been sound from the beginning — pure, unit-tested
logic in one directory, side effects in another, HTTP handling in a third — but two
files had grown past the point where that discipline was visible. The dashboard was a
single document carrying its own markup, stylesheet, and every line of its behaviour,
and the admin API had become one flat sequence of thirty handlers. Neither was
incorrect. Both were becoming unreviewable, and a file nobody wants to open is where
defects go to live quietly.

This session moved them apart without changing what either does. The dashboard now
lives under a directory named for what it is, its stylesheet extracted, its behaviour
split into a small module per section and an entry point that composes them. The admin
API is now one file per resource, with the authentication guard defined once so a new
sub-router cannot accidentally publish an unauthenticated endpoint. The route paths,
request shapes, and responses are untouched; the entire test suite passed before and
after with no edits.

The one deliberate compromise is a bridge in the entry point that republishes the
dashboard's handler functions onto the global object, because roughly sixty inline
event attributes in the markup still call them by name. Converting those to delegated
listeners is correct and is coming, but doing it inside a commit that already moves
two thousand lines would have made any regression untraceable. The bridge is marked
for deletion in the redesign that follows.

Splitting the dashboard into real modules had an immediate and unplanned benefit: it
became lintable. The linter, run against it for the first time, found two functions
that the split had separated from the code calling them — a latent break the move
itself would otherwise have shipped. Because the previous single-file dashboard could
not be linted at all, those checks now run on every commit, and the whole module graph
is additionally exercised outside a browser to prove that every section still loads and
every bridged handler resolves.

Auditing the packaging for the directory rename surfaced something considerably more
serious than the rename. The container image had never copied the dashboard's static
files into its runtime stage. The static-file plugin does not treat a missing root as
fatal — it emits a warning and continues — so every published image started cleanly,
passed its healthcheck, served the API correctly, and returned a bare 404 to anyone who
opened it in a browser. The defect is the same shape as the migration problem found
earlier: a container that starts is not a container that works, and both were invisible
precisely because the failure was silent. The image now carries the dashboard, and the
changelog tells existing users which releases were affected.

A separate finding, raised against the routing sweep, was that the tier-downgrade flag
carried no information. It was assigned before the first routing attempt in every tier,
so by the time it was read it was always true and the expression reduced to "we are not
in the first tier". Simply deleting the redundant term would have preserved the
behaviour, but the behaviour was itself wrong: an operator who had never configured a
premium provider was told that every single request had been downgraded. The flag now
records whether a higher tier existed, held providers, and failed to serve — which is
what a downgrade is. An empty tier is skipped, because there was nothing to fall back
from. Five tests pin the distinction.

Finally, the repository gained an architecture directory. One document explains the
layering rule, walks a request end to end through admission, breaker, scope, cache, and
usage, and states which direction dependencies are allowed to point. The other is a
where-to-look index of every source file plus a short checklist for adding a feature.
The internal planning notes remain private; only these two are published.

**Green gate:** lint 0 (now covering the dashboard) · typecheck 0 · 150 tests pass · build 0 · npm audit 0 vulnerabilities.

---

**Date:** 2026-07-10 · Session 21  
**Author:** Abbas  
**Title:** Phase 5.5 — BYOK (Bring Your Own Key)  

**Summary:**  
A provider key may now be owned by a team rather than sitting in the shared pool. An
owned key is encrypted with the same AES-256-GCM path as every other credential, and
it serves only its owner's traffic. Routing resolves in two passes: the team's own
keys first, in the usual tier order with least-recently-used selection inside a tier,
and then — only when the team permits it — the shared pool. A team that disables
fall-back is hard-isolated: once its own keys are exhausted it receives a 503 with a
retry window, never a credential it did not bring. Teams that own no keys are
untouched by any of this and continue to use the shared pool exactly as before.

The governing constraint was that BYOK must not become a second code path. It has not.
Ownership lives on the credential, not on the provider, so an owned key inherits the
provider's shared configuration — base URL, tier, model, auth scheme — and passes
through the identical admission control, circuit breaker, guardrail evaluation, SSRF
validation, and analytics pipeline as a pooled key. Scoping is expressed as an equality
filter on the key query and a second sweep of the same tier-selection routine. The
proxy's request path grew by roughly a dozen lines; nothing was forked.

Two isolation boundaries required work that the phase brief did not anticipate, and
both were found by auditing the existing code rather than by writing the new feature.
The first is sticky routing. A session's pin to its last-successful key lives in Redis
and outlives any individual request, so a pin established while a caller was on the
shared pool would have been honoured later for an isolated team, and the reverse. Pins
are now re-authorised against the caller's scope on every use, and an ineligible pin
simply falls through to ordinary discovery. The second is the response cache, whose
identity was derived from the request content alone. Left as it was, a response paid
for by one team's private key would have been replayed from Redis to another team, and
an isolated team could have received an answer its own keys never produced. The cache
key is now partitioned by routing scope, and both the scope used for routing and the
scope used for caching are derived from a single resolved value, so the two cannot
drift apart. Existing cached entries are ignored after upgrade and the cache
repopulates over one expiry window.

Deleting a team destroys the provider keys it owns. Every other relation in the schema
nulls its foreign key on delete, and following that convention here would have quietly
released a team's private credentials into the shared pool for every other caller to
route through. The delete endpoint reports how many owned keys went with the team, and
the behaviour is documented rather than merely implemented. Access keys are unaffected
and survive unassigned, losing only their budget cap. Spend on owned keys continues to
be costed, attributed, and counted against the team's cap; an operator who funds a
team's own credentials simply leaves that team's budget unset.

Observability follows the same principle as the rest of the gateway — a sustained
fall-back rate is an operational signal, not an error — so the new counter records
whether each request from a key-owning team was served by its own key, by the pool
after its own keys were exhausted, or refused under isolation. Responses from an owned
key are labelled in the headers alongside the existing tier and provider fields.

This session also cleared the outstanding code-scanning findings on the dashboard.
Values that originate outside the gateway — provider base URLs, team and key names,
error text — are now escaped before they reach the document, and the copy buttons
carry their payload in a data attribute read by a single delegated listener instead of
being interpolated into an inline handler where a quote could break out. Separately, an
optimistic write to the model registry no longer survives a rejected save, a button
left in an error state now recovers, and the analytics charts index their series once
rather than rescanning the result set for every plotted point.

Migration 0004 is additive: existing keys carry no owner, which is precisely the shared
pool, and existing routing behaviour is unchanged on upgrade.

**Green gate:** lint 0 · typecheck 0 · 145 tests pass (+22) · build 0 · npm audit 0 vulnerabilities.

---

**Date:** 2026-07-10 · Session 20  
**Author:** Abbas  
**Title:** Phase 4.5 — Response Caching (Exact-Match)  

**Summary:**  
Added an optional response cache — the real-money complement to the cache-aware
routing shipped earlier, and a genuinely different mechanism: rather than reusing a
provider's own prompt cache, this caches the response itself. When enabled, a request
that exactly matches an earlier one — same model, same messages, same generation
parameters — is answered straight from Redis, skipping the provider entirely. That is
a true zero-cost call, not merely a cheaper one.

The design keeps the gateway's contracts intact. The cache is checked before routing,
so only a miss falls through to provider selection; on a hit nothing downstream runs.
The cache identity ignores whether the caller asked for streaming, so a streamed and a
non-streamed request with identical content share one entry, and a hit is replayed in
whichever mode the caller wants — a streamed hit is delivered as server-sent events for
drop-in compatibility. Populating the cache from a streamed response reuses the buffer
the streaming path already assembles for token accounting, adding no second copy. Every
hit still emits a distinct usage event, valued at zero provider cost but attributed to
the requesting team, so cost and analytics figures never silently drift and a free hit
does not draw down a team's budget. Tool-call responses and multi-choice requests are
deliberately left uncached, since a single stored answer cannot faithfully stand in for
them.

Caching is off by default and configurable from the dashboard or the environment, with
a time-to-live governing freshness. Responses are tagged so a caller and the metrics
endpoint can see hits, misses, and stores. Added unit coverage for the cache-key
identity rules, the eligibility checks, and the streamed-content assembly (123 tests
total, all green), and documented the feature — including how it differs from cache-
aware routing — in the README. Semantic caching remains a noted, heavier extension for
a later phase.

---

## 2026-07-09

---

**Date:** 2026-07-09 · Session 19  
**Author:** Abbas  
**Title:** Release v1.1.0 — Teams & Budgets, Observability, and an Important Install Fix  

**Summary:**  
Tagged and published version 1.1.0, bundling the work since launch into one coherent
release: the team and budget hierarchy with admission-path enforcement, the
Prometheus metrics endpoint with optional distributed tracing, the copy-paste client
connection guide, and — most importantly for anyone installing fresh — the fix that
makes database migrations genuinely apply at container startup. Users of the 1.0.0
single-container quickstart should upgrade to 1.1.0, which provisions a fresh
database correctly; upgrade notes for existing deployments are in the changelog.
The multi-architecture container image for 1.1.0 is published to the registry under
the same name, and the package version now tracks the release version.

---

**Date:** 2026-07-09 · Session 18  
**Author:** Abbas  
**Title:** Phase 5 — Teams, Budget Hierarchy, and a Migration-Pipeline Fix  

**Summary:**  
Introduced a real team entity. Until now a "team key" was just a named access token;
there was no team to attach members, budgets, or policy to. Teams now group scoped
access keys and carry a spending budget — a USD cap per day, week, or month — plus a
status and an assigned routing tier (stored now, wired into the dashboard's Teams
tab in an upcoming phase). The model is deliberately shaped so a parent organization
level can wrap it later with a single additive column, no restructuring required.

Budget enforcement rides the admission path, before any provider work happens. A key
belonging to a team that has exhausted its budget receives a clear rejection with the
current spend, the cap, and exactly when the window resets; a suspended team's keys
are refused outright. Spend is tracked in Redis for per-request cheapness but seeded
from the real recorded usage history on a cache miss — so a cap set mid-period starts
from what the team has genuinely spent, and budgets survive a Redis restart. Because
cost on a streaming gateway is only knowable after a response completes, enforcement
is check-then-spend: requests already in flight when a cap is crossed can overshoot
by their own cost, a documented and standard trade. Keys without a team, and teams
without a cap, behave exactly as before. A new admin API manages teams (list with
live period spend, create, update, delete) and assigns keys to teams; the Teams
dashboard tab will consume it in the UI rebuild phase.

The phase also surfaced and fixed a real deployment bug: the migration files were
flat SQL that the container's startup migration step silently ignored, leaving a
fresh single-container database with no tables at all. Migrations now use the
standard layout and genuinely apply in order at startup, and the compose file's
init-mount workaround was removed. Existing deployments created by the old path
baseline once with two commands, documented in the changelog.

Added unit coverage for the budget window math (including ISO-week year boundaries),
the seed-from-history path, and the allow/block decision (111 tests total, all
green), and documented teams, budgets, and the new endpoints in the README.

---

**Date:** 2026-07-09 · Session 17  
**Author:** Abbas  
**Title:** Phase 4.6 — Observability: Prometheus /metrics and Optional OpenTelemetry  

**Summary:**  
Added a scrapeable, Prometheus-compatible metrics endpoint so the gateway drops
straight into an existing operations stack. The endpoint exposes the shape an
operator actually needs: request rate and duration broken down by outcome and tier,
the upstream time-to-first-byte, input and output tokens, the prompt-cache hit rate
from sticky routing, per-provider request and error rates classified by cause
(rate limit, auth, server, timeout), pool utilization as active/cooling/banned key
counts, and the standard process and runtime metrics. Counters and histograms are
updated cheaply in memory on the request path; the pool gauges are refreshed from the
database per scrape.

The endpoint is guarded rather than world-readable: a scraper authenticates with a
dedicated metrics token (falling back to the admin password if none is set), and it
is exempted from the abuse-guard rate limit but never from authentication — reusing
the same allow-list pattern the health check uses. Distributed tracing is available
but optional: the gateway-to-provider call is wrapped in an OpenTelemetry span that
is a no-op with zero overhead unless the operator runs the app with an OpenTelemetry
SDK, at which point the spans are exported and correlated automatically.

Added unit coverage for the metrics recording paths and exposition (99 tests total,
all green) and documented scraping and tracing setup in the README. Two small
dependencies were added (the Prometheus client and the OpenTelemetry API); the
production dependency audit remains clean.

---

**Date:** 2026-07-09 · Session 16  
**Author:** Abbas  
**Title:** Move Repository and Container Image Under the Alayra Systems Organization  

**Summary:**  
Moved the project to its permanent home under the Alayra Systems organization,
matching the ownership to the brand now that Alayra Nexus™ is a distinct Alayra
Systems product rather than a sibling hosted alongside the Kinetic IDE line. The
repository transfer preserves all history, releases, and stars, and the previous
location redirects automatically, so existing links and clones keep working.

Every reference the project controls was repointed to the new organization: the
repository URLs across the README badges, contributor guide, changelog links, issue
templates, and the container image's source label, plus the maintainer and project
links. The published container image moves with it — the release workflow now
publishes to the organization's own registry namespace, and the quickstart and
badges reference the new image path. References to the separate Kinetic IDE product
and its website are intentionally left untouched, since that remains its own product.

No application behaviour changes. Green gate: lint 0, typecheck 0, 93 tests pass,
build 0. The v1.0.0 tag was re-cut so the image republishes under the new namespace.

---

**Date:** 2026-07-09 · Session 15  
**Author:** Abbas  
**Title:** Packaging & Release Readiness — Multi-Arch Container Image, CHANGELOG, and Versioning  

**Summary:**  
Made Alayra Nexus™ installable as a first-class package rather than a repository you
clone and build. A release workflow now builds a multi-architecture image (Intel and
ARM, so it runs natively on cloud instances and Apple Silicon alike) and publishes it
to the GitHub Container Registry on every version tag, meaning an operator can run the
gateway with a single command against their own Postgres and Redis, without cloning
anything. The container was hardened for production distribution: a build-time ignore
file keeps dependencies, git history, brand assets, and — critically — environment
files out of the image, closing a secret-leak path; the runtime image drops root and
runs as an unprivileged user; a container healthcheck reports liveness against the
service's own health endpoint; and standard image metadata records the title, source,
license, and vendor.

Adopted formal versioning: the project now follows semantic versioning with a
Keep-a-Changelog changelog, and the public routing contract (the single virtual model
name) is the surface that versioning covers. The README leads with a no-clone
"published image" quickstart alongside the existing Compose and manual paths, and
carries release and container badges.

Green gate: lint 0, typecheck 0, 93 tests pass, build 0, npm audit 0 vulns. (The
container image itself is built and verified by the release workflow in CI. A
follow-up hardened the image to install OpenSSL in both the build and runtime
Alpine stages, so the Prisma query engine resolves the correct OpenSSL 3.x variant
and starts cleanly.)

---

**Date:** 2026-07-09 · Session 14  
**Author:** Abbas  
**Title:** Phase 4 — Async Analytics Pipeline  

**Summary:**  
Decoupled analytics writes from the request path. Previously every proxied request
wrote its usage record to Postgres with an individual insert; at scale those
per-request inserts compete with the transactional key-lookup queries on the same
database. Usage events are now handed to an in-process pipeline that buffers them
and writes them to Postgres in a single batched insert, either on a short interval
(about one and a half seconds by default) or as soon as the buffer reaches a size
threshold. The request path no longer waits on the analytics write at all.

The pipeline is deliberately hidden behind a single `emit(event)` call. Swapping the
in-process buffer for a durable queue later — a managed queue, or a streaming path
into a columnar store if the project ever needs that scale — is a change to one
module, not a change to every caller. That is the cheap-now, expensive-to-retrofit
seam being put in early. The buffer is bounded so a database outage sheds load
rather than growing memory without limit, a failed flush re-queues rather than
dropping data, batched inserts are chunked and idempotent so a retry cannot
duplicate rows, and a graceful-shutdown drain flushes anything still buffered before
the process exits. Combined with the real tokenizer from Phase 2, the same pipe now
carries accurate numbers rather than guesses.

Added unit coverage for the buffering, size-threshold flush, failure re-queue,
load-shedding cap, and drain behaviours (93 tests total, all green).

---

**Date:** 2026-07-09 · Session 13  
**Author:** Abbas  
**Title:** Brand Identity — Three-Tier Alayra Nexus™ Logo System  

**Summary:**  
Established a formal visual identity for Alayra Nexus™: a three-tier logo system
built around a cyan neon vortex converging on a faceted core, with a bronze accent
inherited from the Alayra Systems parent mark. The tiers scale from a ceremonial
crest (with an ALAYRA · NEXUS wordmark lockup for marketing headers), through a
working logo for site and documentation headers, down to a reduced glyph that stays
legible as a favicon or avatar, plus a monochrome recolorable variant. Each mark is
provided as a scalable vector source with rendered raster exports at the sizes each
context needs, together with a short brand guide (usage and palette) and a
regeneration script so the exports can be rebuilt whenever a source is refined.

The kit was wired into the product surfaces: the dashboard now carries the glyph as
its header logo and browser favicon, and the repository README leads with the crest
lockup. The complete asset kit lives in the repository so the identity ships with the
project. The Apache 2.0 license covers the code; the name and logo remain trademarks
of Alayra Systems, as recorded in the trademark policy.

---

**Date:** 2026-07-09 · Session 12  
**Author:** Abbas  
**Title:** Rebrand to Alayra Nexus™ and Relicense under Apache 2.0  

**Summary:**  
Renamed the project from Kinetic Nexus to **Alayra Nexus™** across the codebase,
dashboard, documentation, and package metadata, and moved the repository to its new
home. The change is purely one of name and branding — no functional behaviour is
affected. Internal identifiers that never carried the old brand (Redis key
namespaces, response headers, and environment variables) are unchanged, so existing
deployments and integrations continue to work without modification.

The public virtual model identifier is now **`alayra-nexus-1`**, with the previous
`kinetic-nexus-1` and `nexus` strings preserved as silent backward-compatible
aliases so no existing client request breaks. The trademark symbol is applied to the
brand in the primary interfaces.

Alongside the rename, the project's license was changed from MIT to the **Apache
License, Version 2.0**, chosen to keep the project fully open source while adding an
explicit patent grant and an explicit statement that the license conveys no
trademark rights. A standard Apache copyright-and-license header was added to every
source file, and NOTICE and TRADEMARK files were added to record the copyright and
the name/logo usage policy. The "Alayra Nexus" name and logo remain trademarks of
Alayra Systems; the open-source license covers the code, not the brand.

---

**Date:** 2026-07-08 · Session 11  
**Author:** Abbas  
**Title:** Cost-Aware Routing — Bias Toward the Cheapest Healthy, In-Headroom Provider  

**Summary:**  
Added a cost dimension to the router, completing the load / cost / latency /
capability picture. When several providers in the same tier are healthy and have
request and token headroom, Nexus can now prefer the cheaper one, using the
per-token pricing already carried in the model registry — no new data source. It is
a tiebreaker only, governed by a single cost-weight knob from 0 to 1: zero leaves
the existing provider order untouched (the default, so no deployment changes
behaviour until an operator opts in), one is strict cheapest-first within a tier,
and values in between interpolate, biasing toward cheaper without discarding the
operator's configured order. Unpriced providers rank last but are never dropped.

Correctness comes first by construction. Cost is applied only in the fallback
selection path, after sticky cache affinity — a continuing conversation stays pinned
to the key holding its prompt cache even when a cheaper provider exists, because a
cache hit usually wins on total cost. It sits within a tier, never across tiers, so
capability is never traded for price. And it reorders only which providers are
*tried*: every candidate still passes the circuit breaker and the atomic
rate/token-headroom check, so a cheaper provider that is cooling or over its limits
is still skipped — cost can never promote an ineligible key. The weight is editable
live from a new Cost-aware routing panel in the dashboard Settings tab, backed by a
new admin endpoint, and can also be seeded from an environment variable.

Added unit coverage for the pricing signal and the ordering blend, including the
sticky/eligibility guarantees at the boundaries (87 tests total, all green), and
documented the feature and its ordering rules in the README.

---

**Date:** 2026-07-08 · Session 10  
**Author:** Abbas  
**Title:** Guardrails — Optional, Pluggable Prompt and Response Content Filtering  

**Summary:**  
Added an optional content-guardrails layer that lets an operator redact sensitive
data or block banned content and prompt-injection patterns, without Nexus imposing
any policy of its own. It is off by default — a fresh deployment filters nothing —
and operators supply their own rules as a simple ruleset, with named starting-point
presets (email, phone, card, SSN, API key, and injection patterns) available to copy.

Filtering follows the request lifecycle deliberately. Input rules run on the
admission path before a request is ever forwarded: a blocking rule rejects the call
outright, and a redaction rule masks the match and forwards the cleaned prompt.
Output rules apply to non-streaming responses, where the full body is already
available to inspect. The streaming path is intentionally zero-buffer for latency,
so streamed responses are input-filtered only by default and are marked with an
explicit header rather than being silently passed through unfiltered; an operator
who needs output filtering on streams can opt into a buffered-safe mode that collects
the response, filters it, and replays it as a single chunk, accepting the loss of
streaming latency as a conscious trade.

The ruleset and its toggles are managed live from a new Content guardrails panel in
the dashboard Settings tab, backed by new admin endpoints, and can also be seeded
from environment variables. Rule patterns are validated when saved so a bad
expression is caught at configuration time, malformed rules are skipped rather than
allowed to break the request path, and the amount of text scanned per field is
capped to keep filtering inexpensive. Added unit coverage for the filtering engine
(75 tests total, all green), documented the feature and the streaming trade-off in
the README, and verified the new settings panel renders in the dashboard.

---

**Date:** 2026-07-08 · Session 9  
**Author:** Abbas  
**Title:** Network Security — SSRF Protection with Default-On Private-Host Blocking and an Opt-In Allowlist  

**Summary:**  
Hardened the gateway's outbound requests against server-side request forgery. Because
Nexus fetches operator-configured provider base URLs, an unrestricted URL could be
aimed at internal-only addresses — cloud metadata, loopback services, or private LAN
hosts — and use the gateway as a proxy into its own network. Requests to private,
loopback, link-local, and internal-name hosts are now refused by default across every
path that adds or uses a provider URL: a bad URL is rejected the moment a provider is
created or updated, so it never reaches the request path, and the proxy path re-checks
as defense in depth.

Operators who run a legitimate local provider (Ollama, LM Studio) can permit exactly
the host they need rather than turning the protection off wholesale. A new *Network
security* panel in the dashboard Settings tab lets an admin toggle private-host
blocking and manage an allowlist of specific hosts live, backed by new admin endpoints;
the same values can be seeded from environment variables, which the dashboard settings
build on top of. The default posture is secure — blocking on, allowlist empty — so a
fresh deployment is protected without any configuration.

Added a private-host classifier covering IPv4 and IPv6 ranges (including cloud-metadata
and IPv4-mapped addresses) and the URL validator, with unit coverage for the blocking,
allowlist, and disabled-blocking paths (64 tests total, all green). Documented the
feature and the local-provider workflow in the README, and verified the new settings
panel renders in the dashboard.

---

**Date:** 2026-07-08 · Session 8  
**Author:** Abbas  
**Title:** Phase 3 — Resilience: Circuit Breaker + Cache-Aware Sticky Routing  

**Summary:**  
Replaced the single flat cooldown with a real per-key circuit breaker and added
cache-aware sticky routing, so the gateway both fails gracefully and stops wasting
provider prompt caches. All breaker state lives in Redis, keeping it atomic and
consistent across replicas with no database writes on the hot path.

The breaker distinguishes the kinds of failure a provider can return. Server-side
faults (5xx, upstream timeouts, and streams that connect but hang) accumulate as
strikes and trip the breaker after three consecutive failures in a five-minute
window. Each trip escalates the cooldown — ten seconds, then twenty, then forty,
doubling to a ten-minute ceiling — so a key that keeps failing is pushed further
away rather than retried on the same fixed timer indefinitely. When a cooldown
expires the router admits exactly one half-open probe: success closes the breaker
and resets the streak, while failure re-escalates without returning full traffic to
a still-unhealthy provider. Rate-limit responses (429) are handled separately on
their own flat, non-escalating cooldown, and two consecutive authentication
failures (401/403) ban a key outright, since a bad credential does not recover on
its own. Any success at any point resets the streak, and the dashboard's cooling and
banned states — plus the admin unban action — stay in step with the live breaker.

Cache-aware sticky routing pins a multi-turn conversation to the key that last
served it, so follow-up turns reuse the upstream provider's prompt cache instead of
being scattered across the pool by least-recently-used rotation. A session is
identified by an explicit `X-Nexus-Session` header, the OpenAI `user` field, or a
stable fingerprint of the opening messages, and falls back to normal tier and LRU
selection for new sessions or when the pinned key is unavailable. The routing
contract remains a single virtual model (`kinetic-nexus-1` — the pre-rebrand
identifier; now `alayra-nexus-1`, which still accepts the old id as an alias); this
decision is now documented so early adopters can depend on it.

Added unit tests for the breaker escalation curve and thresholds and for the
session-fingerprinting logic (51 tests total, all green), and documented both the
breaker behaviour and sticky routing in the README.

---

**Date:** 2026-07-08 · Session 7  
**Author:** Abbas  
**Title:** Security Hardening — Resolve CodeQL Alerts (XSS, ReDoS, URL Validation, CI Permissions)  

**Summary:**  
Addressed the security alerts raised by GitHub CodeQL scanning. Added an
HTML-escaping helper to the dashboard and applied it to the model card and model
form renderers so a model or provider name containing markup can no longer be
reinterpreted as HTML (cross-site scripting); verified in a browser that a hostile
name renders as inert escaped text and executes nothing. Introduced a small URL
utility (`src/lib/url.ts`): a non-regex trailing-slash strip that removes a
potential polynomial-backtracking (ReDoS) pattern, and a scheme validator that
restricts outbound provider requests to http(s), blocking `file:` and similar
schemes through the gateway's fetch. Wired both into the key-test, provider-
credential, model-validation, and proxy paths. Added a least-privilege
`permissions: contents: read` block to the CI workflow.

Added unit tests for the URL utility (36 tests total, all green) and a CI status
badge to the README so the passing checks are visible on the repository's front
page. The remaining CodeQL "missing rate limiting" notices concern admin routes
that are already covered by the global per-credential abuse guard and admin
authentication.

---

**Date:** 2026-07-08 · Session 6  
**Author:** Abbas  
**Title:** Phase 2 — Real Admission Control: Atomic RPM/TPM, Tokenizer, Reservation, and Upstream Timeouts  

**Summary:**  
Replaced the request-admission path with real, race-free budget enforcement.
Previously each key's requests-per-minute counter was checked and then incremented
in two separate Redis calls, so under concurrency several requests could pass a
check only one should have; tokens-per-minute limits were stored but never
enforced; and input token counts were a crude character-count divided by four.

Introduced an atomic admission primitive (`src/lib/admission.ts`): a single Redis
Lua script that checks both the RPM and TPM budgets and, only if both have
headroom, increments the request counter and reserves the request's estimated
tokens — in one atomic operation. Pool selection (`nexus.service.ts`) now calls
this per key and rotates to the next key or tier when a key is out of either
budget, only failing the request once the entire pool is exhausted (rotate first,
fail last).

Added a real tokenizer (`src/lib/tokenizer.ts`, built on `js-tiktoken`) to
estimate a request's input tokens before it is forwarded, replacing the
character-count heuristic. Each request reserves `estimated input + max_tokens`
against the chosen key's TPM budget; when the response completes, the reservation
is reconciled down to the provider's real token usage, and a failed request
releases its full reservation.

Hardened the upstream call in the completions proxy with three independent
timeouts: a time-to-first-byte deadline (abort if the provider never returns
headers), a body-read deadline for non-streaming responses, and an idle-gap
deadline for streaming responses (a hung stream is aborted while a legitimately
long one keeps flowing as chunks arrive). All three are environment-configurable.

Added unit tests for the tokenizer, the reservation math, and the admission key
derivation (29 tests total, all green), and documented the new environment
variables in the README and `.env.example`.

---

**Date:** 2026-07-08 · Session 5  
**Author:** Abbas  
**Title:** Community Health Files, Security Policy, and Dependency Automation Hardening  

**Summary:**  
Added the standard open-source community health set so the repository is ready for
external contributors and reporters. Wrote `SECURITY.md` with a private
vulnerability-disclosure process (report to `report-nexus@alayrasystems.com`),
scope, and a no-secrets-in-reports rule. Wrote `CONTRIBUTING.md` covering local
setup, the required check gate (`lint` / `typecheck` / `test` / `build`), the pull
request process, and commit conventions. Added a pull request template and two
structured GitHub issue forms (bug report and feature request) with an issue
template config that routes security reports and questions to the right place.
Added a `FUNDING.yml` sponsor configuration.

Hardened the Dependabot configuration: grouped the Prisma client and CLI packages
so they always upgrade together (a mismatched bump breaks client generation), and
configured it to skip breaking major-version Prisma upgrades so they are performed
deliberately rather than via automated pull requests.

---

**Date:** 2026-07-08 · Session 4  
**Author:** Abbas  
**Title:** Launch Readiness — CI Pipeline, Test Suite, Linting, and Zero-Vulnerability Dependency Tree  

**Summary:**  
Prepared the repository for public release with a full automated verification gate so that every push is provably green. Added ESLint (flat config, TypeScript-aware) with `lint`/`lint:fix` scripts — the entire source tree passes with zero errors and zero warnings. Added Vitest with an initial test suite of 14 tests: AES-256-GCM encryption round-trip, random-IV uniqueness, GCM tamper rejection, ciphertext-format validation, key masking, and the Phase 1 rate-limit key derivation (per-credential hashing, IP fallback, determinism, and no-raw-token-leak guarantees). Added `typecheck`, `test`, and `test:watch` scripts.

Added a GitHub Actions CI workflow (`.github/workflows/ci.yml`) that runs lint, typecheck, test, build, and a dependency audit on every push and pull request to `main`, with a production-dependency audit as a hard security gate. Added a Dependabot configuration for weekly npm and GitHub Actions updates. Upgraded the test tooling so that the dependency tree now reports **zero vulnerabilities** across the board.

Performed final repository hygiene: stripped a UTF-8 byte-order mark from two source files, corrected the repository URL in their MIT license headers, excluded test files from the production build output, and removed an internal editor configuration file from version control.

---

**Date:** 2026-07-08 · Session 3  
**Author:** Abbas  
**Title:** Phase 1 — Abuse-Guard Rate Limiter (Removed the Global Throughput Ceiling)  

**Summary:**  
Replaced the flat global rate limit in `src/server.ts` — a blanket 200 requests per minute applied across the entire server, which capped total gateway throughput regardless of how many provider keys were pooled behind it — with a purpose-built abuse guard. The new guard is Redis-backed, so the limit stays correct across horizontally-scaled instances rather than under-counting per replica. It is keyed per credential: the bearer token is SHA-256 hashed (the raw token is never used as, or stored in, a Redis key) so that each team key is isolated to its own bucket and a single leaked or runaway key cannot throttle the whole gateway; requests without valid auth fall back to a per-IP bucket. Health checks are exempted, and the guard fails open if Redis is briefly unreachable so a cache blip can never take the proxy down.

The guard is sized entirely above real pool capacity and is configurable via two new environment variables, `ABUSE_RATE_LIMIT_MAX` (default 12,000/min per credential) and `ABUSE_RATE_LIMIT_WINDOW`. Documented the critical distinction — real per-key provider RPM/TPM limits are the throughput control; the server guard is only DoS/abuse protection — in a new README section ("Rate limits, explained") and in `.env.example`.

Extracted the key-derivation logic into a pure, unit-tested helper (`src/lib/rateLimitKey.ts`), and replaced two loosely-typed `as Record<string, unknown>` request casts with a proper Fastify request type augmentation (`src/types/fastify.d.ts`), which additionally cleared pre-existing type errors so the project now typechecks cleanly end to end.

---

**Date:** 2026-07-08 · Session 2  
**Author:** Abbas  
**Title:** GitHub Public Launch — README, LICENSE, .gitignore, and Security Audit  

**Summary:**  
Prepared the repository for its first public push to GitHub. Conducted a thorough security audit of every file in the repository to confirm that no sensitive internal details were present before public exposure. Verified through `git log` that the `.env` file containing the `MASTER_ENCRYPTION_KEY` and `ADMIN_PASSWORD` had never been committed to version history. Confirmed the `.gitignore` correctly excludes `.env`, `.env.local`, OS artifacts, and editor metadata.

Removed a proprietary copyright header that had been carried over into `src/lib/encryption.ts` and `src/lib/prisma.ts`, replacing each with a clean MIT license attribution line. These were the only contaminated files; the rest of the codebase was confirmed clean.

Wrote a comprehensive `README.md` from scratch — enterprise-grade, with badges, architecture ASCII diagram, provider support table, feature matrix, environment variable reference, security model breakdown, quick-start for both Docker Compose and manual setup, full API reference table, and roadmap checklist. Wrote the MIT `LICENSE` file attributed to Alayra Systems Pvt. Limited. Expanded `.gitignore` to cover logs, OS metadata, coverage directories, Prisma shadow database artifacts, and the `.claude/` internal directory.

Provided GitHub organization profile description for the Alayra Systems Pvt. Limited account, and documented the correct push procedure including `git branch -M main` to align local `master` with GitHub's default `main` branch.

---

**Date:** 2026-07-08 · Session 1  
**Author:** Abbas  
**Title:** Phase Plan Finalization and Roadmap Update in Docs  

**Summary:**  
Continued from the July 6 feature review. Updated the phase plan documentation under `docs/` to reflect the current state of the project — marking completed phases and establishing the next milestones: alerts/webhook tab, per-team budget caps, CNAME/custom domain support, and an integration test suite. Discussed benchmark expectations for the proxy layer and framed realistic competitive positioning relative to LiteLLM for open-source adoption. Identified five capability gaps (provider breadth, guardrails/moderation hooks, observability ecosystem, SSO/SAML, provider-specific passthrough) and logged them as future phases rather than blockers for the v1.0 release.

Generated the structured prompt for creating `nexus-changes.md` as a standalone public-facing enterprise development log, with explicit instructions to exclude any reference to other internal systems or products.

---

## 2026-07-07

---

**Date:** 2026-07-07  
**Author:** Abbas  
**Title:** LiteLLM Feature Gap Analysis and Benchmark Planning  

**Summary:**  
Continued the feature review session from July 6. Conducted a systematic comparison of Kinetic Nexus against LiteLLM across dimensions including provider breadth, rate limit architecture, observability, and team management. Identified five areas where LiteLLM currently leads (SSO/SAML, provider passthrough headers, guardrails, embedded SDK, observability integrations) and confirmed these do not affect the core use case of key pool management and load balancing, where Kinetic Nexus holds its own.

Discussed benchmark targets for the proxy layer: latency overhead, throughput at concurrent load, and key rotation behavior under burst conditions. Confirmed the project is production-ready for the team-key and key-pool use cases without the five gap items.

---

## 2026-07-06

---

**Date:** 2026-07-06 · Session 2  
**Author:** Abbas  
**Title:** Feature Completeness Review and Rate Limit Architecture Analysis  

**Summary:**  
Opened a dedicated review session to evaluate Kinetic Nexus against enterprise gateway feature requirements. Identified a critical architectural issue: `src/server.ts` was applying a global Fastify rate limit of 200 requests per minute across the entire server instance, which would cap total throughput regardless of how many provider keys were pooled. This was flagged as a structural ceiling that must be addressed before the project can credibly claim key-pool-based throughput scaling. The global limit is correct for abuse protection but must not be confused with per-key or per-team rate limits, which are tracked independently via Redis.

Analyzed the full feature surface — provider cards, RPM/TPM meters, team leaderboard, cost tracking, Analytics charts — against what a team evaluating the project for production use would expect to see. Confirmed the dashboard is competitive for the targeted use case and provided framing for what to communicate in the README.

---

**Date:** 2026-07-06 · Session 1  
**Author:** Abbas  
**Title:** Phase 5c — Analytics Tab, Nexus Tab Rebuild, and Models Tab Rebuild  

**Summary:**  
Executed Phase 5c in full — the largest single session of work on the project to date.

**token.service.ts** was rewritten from the ground up. Added a `resolveRange()` helper that accepts either a named period (`today`, `7d`, `30d`, `90d`) or explicit `customSince`/`customUntil` Date objects, enabling custom date range analytics. Added a `modelCost()` function that handles dual field naming across schema versions (`inputPricePer1k` from the original schema and `inputCostPer1M` from the new dashboard format) using null-coalescing to normalize both. `recordTokenUsage()` was updated to compute `estimatedUsd` at write time by looking up the model registry (cached via Redis with a 60-second TTL), so that all cost data is captured at the moment of usage rather than computed retrospectively. `getUsageSummary()` was extended to return `requests`, `estimatedUsd`, `byProvider`, and per-model input/output splits. Two new export functions were added: `getTimeSeriesByTeam()` returns a day-by-team matrix for multi-series request and token trend charts; `getTimeSeriesByModel()` returns a day-by-model matrix for stacked token breakdowns.

**src/routes/admin.ts** received four new analytics routes: `/admin/analytics/summary`, `/admin/analytics/by-team`, `/admin/analytics/timeseries/teams`, and `/admin/analytics/timeseries/models`. All four accept `from` and `to` query parameters (ISO date strings) that override the `period` parameter when present, enabling custom date range queries from the dashboard. The `90d` period was added to all period union types. Two additional routes were added: `GET /admin/nexus/summary` returning provider pool health counts (active / cooling / banned / total), and `GET /admin/keys/:id/metrics` reading real-time RPM from Redis key `nexus:rpm:{id}`.

**public/index.html** underwent a full rebuild. The Nexus tab was rebuilt to match enterprise-grade quality: a four-stat summary bar (Pools / Active / Cooling / Banned), color-coded provider cards per vendor (orange for Anthropic, blue for Google, purple for Groq, green for OpenAI, yellow for OpenRouter), expandable key tables within each provider card showing individual key status, RPM/TPM utilization progress bars with green/yellow/red threshold coloring (below 60%, 60–85%, above 85%), and a full Add Pool modal with provider-type-aware credential field defaults and a live credential test button. The Models tab was rebuilt to render registry cards with display name, model string, tier badge (Premium/Standard/Fast), status indicator, capability badges (Primary, Fallback, Vision, FIM, Tools), cost per 1M tokens, and context window. An Add/Edit model modal was added with all fields and capability toggles.

The Analytics tab was built from scratch as a Chart.js-powered analytics dashboard. The tab header includes period pills (Today / 7d / 30d / 90d), a custom date range picker (from/to `<input type="date">` fields), and a CSV export button. Five hero metric cards display Requests, Total Tokens, Input Tokens, Output Tokens, and Estimated Cost (in green). Four Chart.js visualizations were implemented: a multi-color line chart of daily request volume by team (`_buildReqChart`), a stacked bar chart of token consumption by model per day (`_buildTokChart`), an area chart of daily cost trend with green fill (`_buildCostChart`), and a horizontal grouped bar chart comparing input versus output tokens per model (`_buildIOChart`). A sortable team leaderboard table with medal icons and columns for tokens, requests, cost, estimated lines of code, and input/output split completes the tab. All Chart.js instances are tracked in a `_charts` object and destroyed before recreation to prevent canvas reuse errors.

Demo mode guards (`if (window._demoMode) return;`) were added to every tab load function — `loadConnect()`, `loadNexus()`, `loadModels()`, `renderTeamKeys()`, `loadSettings()`, and `loadAnalytics()` — to prevent fetch calls to the static server when previewing the dashboard without a backend. A full `_renderDemoAnalytics()` function was added that generates 30 days of realistic random data and renders all four Chart.js charts for demo purposes.

---

## 2026-07-04

---

**Date:** 2026-07-04 · Session entry 6 of 6 (13:08)  
**Author:** Abbas  
**Title:** Model Identifier Renamed to `kinetic-nexus-1`  

**Summary:**  
Renamed the catch-all proxy model identifier from `nexus` to `kinetic-nexus-1` across the routing engine, dashboard UI, and documentation references. The legacy `nexus` string was preserved as a silent backward-compatible alias so that any existing configurations continue to route correctly. The rename establishes the canonical model name that is referenced in the README and all public-facing materials going forward.

---

**Date:** 2026-07-04 · Session entry 5 of 6 (13:02)  
**Author:** Abbas  
**Title:** Phase 4 — Team Key Usage Tracking and Leaderboard  

**Summary:**  
Implemented team key attribution throughout the request pipeline. When a request is authenticated with a team key, the key's ID is stamped on the Fastify request object (`request.teamKeyId`) and forwarded to `recordTokenUsage()`, which writes it as a foreign key reference on the `TokenUsage` record. `getUsageByTeamKey()` was added to aggregate usage by team key — returning total tokens, input/output splits, request count, and estimated USD per key — sorted by total token consumption descending. The Usage tab in the dashboard was updated to render a team leaderboard table showing each named key's consumption, request count, cost, and estimated lines of code generated (computed as `Math.round(tokens / 50)`).

---

**Date:** 2026-07-04 · Session entry 4 of 6 (12:39)  
**Author:** Abbas  
**Title:** Demo Mode — Full Dashboard Preview Without a Running Server  

**Summary:**  
Added a demo mode that allows the dashboard to be opened as a static file and display realistic pre-populated content without any backend connection. Demo mode is detected via a `?demo=1` query parameter or a `sessionStorage` flag. When active, all tab load functions return early before attempting any fetch calls, and `enterDemoMode()` populates all tabs with representative static data: mock provider pools with key counts, a sample model registry, example team keys, and realistic usage statistics. This enables the dashboard to be shared, previewed in CI, or demonstrated to evaluators without requiring a live PostgreSQL/Redis stack.

---

**Date:** 2026-07-04 · Session entry 3 of 6 (12:26)  
**Author:** Abbas  
**Title:** Phase 3 — Five-Tab Web Dashboard  

**Summary:**  
Built the complete web dashboard served from `public/index.html`. The dashboard is a single-file vanilla JavaScript application with a persistent sidebar navigation and five tabs: **Connect** (server status, endpoint URL, model name, quick-copy team key generator), **Nexus** (provider pool management), **Models** (model registry), **Team Keys** (scoped access token management), and **Settings** (admin configuration). Each tab uses fetch calls to the admin API endpoints, renders HTML dynamically, and provides inline forms for all management operations. The sidebar uses an active-state indicator and all tabs load lazily on first click. The entire dashboard ships as a single HTML file with no external dependencies beyond the Fastify static file server.

---

**Date:** 2026-07-04 · Session entry 2 of 6 (12:14)  
**Author:** Abbas  
**Title:** Phase 2 — Smart Routing Engine with Tiered Fallback and Live Validation  

**Summary:**  
Rewrote the routing engine with a three-tier fallback system: Premium, Standard, and Fast. Each provider key in the pool is assigned a tier at creation time. On each incoming request, the router selects the highest-tier active key using round-robin selection across keys at that tier. If no key is available at the top tier (all cooling or banned), the router falls back to the next tier automatically. A live validation step runs when keys are added or tested: the system sends a minimal probe request to the provider's API and records the response time. Keys that fail validation are placed in a cooling state and retried on a configurable backoff. The `kinetic-nexus-1` catch-all model was introduced as the single model string that resolves to the best available provider/model combination based on the tier configuration.

---

**Date:** 2026-07-04 · Session entry 1 of 6 (12:10)  
**Author:** Abbas  
**Title:** Phase 1 — Dead Code Removal and Schema Cleanup  

**Summary:**  
Audited the full codebase for dead code, unused imports, unused schema fields, and redundant route handlers. Removed all identified dead paths. Cleaned the Prisma schema — consolidated the provider pool models, ensured foreign key relationships were correct between `NexusProvider`, `NexusKey`, `NexusTeamKey`, and `TokenUsage`, and removed fields that were no longer referenced. The resulting schema is the canonical data model for all subsequent phases.

---

## 2026-07-01

---

**Date:** 2026-07-01  
**Author:** Abbas  
**Title:** Phase Plan Finalized — Concurrency, RPM Architecture, and Model Naming Decisions  

**Summary:**  
Continued from the June 30 assessment session. Finalized critical architectural decisions ahead of Phase 1 execution. Confirmed that all incoming requests to the same provider run concurrently — the proxy does not serialize requests through a queue; the RPM limit is enforced via a Redis counter (INCR with 60-second TTL) that blocks individual keys when they exceed their limit, while all other keys in the pool remain fully available. This means pooling ten keys at 20 RPM each yields effectively 200 RPM aggregate throughput, with each key individually rate-limited, not the pool as a whole.

Decided that the model name exposed to users would always be a single fixed string (`nexus`, later renamed `kinetic-nexus-1`) rather than exposing provider-specific model IDs directly. This design choice hides provider implementation details, allows the routing tier to be changed transparently, and gives users one stable model string to configure across all their tools.

Confirmed the Connect tab design: it exposes a single base URL (local or domain-based) and a single model name, making the entire configuration of a client tool a two-field operation.

---

## 2026-06-30

---

**Date:** 2026-06-30 · Session entry 3 of 3 (12:44)  
**Author:** Abbas  
**Title:** Fix — Auto-Infer Provider from Model Name  

**Summary:**  
Fixed a routing bug where requests specifying a real provider model ID (e.g. `claude-3-5-sonnet-20241022`, `gpt-4o`, `gemini-1.5-pro`) would fail to route correctly because the provider field was not being inferred from the model string. Added a `resolveProvider()` lookup that inspects the model name prefix and maps it to the correct provider type, so that tools using real model IDs (rather than the `nexus` alias) route to the right provider pool without requiring the caller to specify a provider field explicitly.

---

**Date:** 2026-06-30 · Session entry 2 of 3 (12:41)  
**Author:** Abbas  
**Title:** Initial Release — First Version-Controlled Commit  

**Summary:**  
Made the first organized git commit of the Kinetic Nexus codebase under the tag `feat: initial release`. The committed code represented the foundation of the proxy: a Fastify v5 TypeScript server with a Prisma-managed PostgreSQL schema, Redis-backed RPM and TPM rate limiting via `ioredis`, AES-256-GCM encryption for all stored provider API keys, a multi-provider routing layer supporting Anthropic, OpenAI, Google, Groq, and OpenRouter, SHA-256-hashed team key authentication with usage attribution, an OpenAI-compatible `/v1/chat/completions` proxy endpoint with full streaming support via server-sent events, and a basic admin REST API for managing provider pools and keys. This commit established the project as a standalone open-source artifact.

---

**Date:** 2026-06-30 · Session entry 1 of 3 (07:47)  
**Author:** Abbas  
**Title:** Open Source Readiness Assessment and Phase Planning  

**Summary:**  
Conducted a full brutally honest evaluation of the existing Kinetic Nexus codebase to determine its readiness for public open-source release. The assessment covered: routing quality and fallback behavior, key pool management completeness, dashboard usability, schema design, competitive positioning relative to existing proxies in the ecosystem, and what a developer encountering the project for the first time would find. The evaluation confirmed the core proxy mechanics were sound but identified that the project needed a focused cleanup pass, a polished dashboard, and a cleaner public API surface before it could stand on its own as an open-source product.

Established the full 6-phase delivery plan: Phase 1 (dead code removal and schema cleanup), Phase 2 (smart routing engine with tiered fallback), Phase 3 (five-tab web dashboard), Phase 4 (team key usage tracking and leaderboard), Phase 5 (Nexus tab parity, Models tab, and Analytics with Chart.js), Phase 6 (integration tests, documentation, and public GitHub launch). Design decisions made in this session: the proxy would always expose a single model name rather than surfacing provider model IDs; the dashboard Connect tab would provide a one-URL-one-key setup experience; the project would be deployable by a single developer on a laptop with one command.

---

*End of log. Entries below this line will be added as work continues.*
