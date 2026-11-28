# Desktop size exception decisions

Desktop staging, audits and release artifacts enforce the hard caps in
`src/frontend/desktop/runtime/size-budgets.json` and compare component regressions
with that target's entry in `size-baseline.json`, taken from its last released
size report: macOS 0.1.5 and Windows 0.1.6. A target with no released entry is
held to the hard caps alone.
Neither a successful development build nor an unsigned size report changes a cap.

An exception requires an explicit owner decision for an exact target, component,
byte ceiling and last applicable app version. Record the requested scope in
`runtime/size-exceptions.json` and the actual approved decision in
`runtime/size-approvals.json`, both relative to `src/frontend/desktop`.
The approval record uses schema `animama-size-approvals/1`; each approval has
`decision: "approved"` and exactly matching `id`, `component`, `target`,
`approved_byte_ceiling`, `rationale`, `author`, `approval_date` and
`last_applicable_app_version` fields. Dates must not be in the future and the
current app version must be within the recorded limit. Changing an exception's
scope invalidates its old approval. Missing or malformed approval evidence fails
closed; an ID mentioned in prose is not an approval.

The only granted exceptions cover `web_javascript` up to 25,500,000 bytes on
both targets through 0.1.7, for in-app generation's draft-checks worker. Add an
approval only after the owner explicitly accepts the concrete measured scope;
never populate it automatically to pass a build. Keep the complete review and
candidate hashes with the release evidence. These durable records are the build
inputs and do not require a private planning checkout.

A size exception approves only the specified size limit. Licensing, signing,
notarization, fresh-profile/native acceptance and publication remain separate
[release gates](release-process.md#release-gates-in-order).
