# Adult pickup demo

The participants are adults. Leo + Anthony is an operator-defined demo pair;
the model does not infer relationships or age. Use consenting subject references.

Set PICKUP_DEMO_ENABLED=true and distinct PICKUP_LEO_ID, PICKUP_REBECA_ID,
PICKUP_ANTHONY_ID registered subject UUIDs. Open /parent-child.html.

The external SubjectRegistry supplies target alerts independently of the local pickup decision.
Leo + Anthony in the same frame is approved automatically. Every single-person frame is blocked with Cannot exit alone and cannot create or approve a manual request. No missing participant name is disclosed. No email is sent.
Two identified participants outside the configured Leo + Anthony pair create a pending request for manual demo approval. Unknown participants, duplicate identities, and groups larger than two block approval.
The signed-in operator can approve only their current, unexpired pending request
while its participants remain freshly visible. Origin and CSRF checks apply.

Automatic pair approvals appear in Approved exits history independently of the
current camera decision. History and requests are scoped to the operator and
held in memory; restarting the server expires them. Historical approval never
authorizes a later frame. The demo does not verify liveness or control physical access.