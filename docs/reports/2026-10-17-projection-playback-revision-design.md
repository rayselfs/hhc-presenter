# R7 playback report content identity

Design for the existing refactor audit. No new projection mode or ProPresenter feature.

- Keep window generation and item ownership checks; additionally require matching blobId/contentRevision before a report can change replay state, pending controls or operator video state. The fields are additive to the wire shape, but missing identity cannot bypass a coordinator-owned revision.
- HTML reports capture the loaded element's blob/revision and event.currentTarget. Reject callbacks whose element, load sequence or source revision is no longer current; never stamp an old event with a latest revision ref.
- VLC start accepts additive initial contentRevision. The owned session retains sourceFileId, normalized playbackVariant and revision. Both preparation and progress reports copy this primitive identity into the outgoing payload.
- The already validated main-to-projection file:show and replay forwarding path may rebind the revision of the currently owned VLC session only when generation, item, source blob and playback variant all match and the show still uses VLC. It changes no player, attempt ID, transport or pending controls. A different source cannot rebind. Queued reports retain their original identity.
- Retain the latest validated current-generation identity until start ingress, so renewal overtaking a delayed native start seeds that same-source session with the authoritative revision. A delayed versioned start for replaced/ended content does not create a player. Audio uses the same source-keyed element replacement as video.
- Do not add contentRevision to VLC start-effect dependencies or add a new preload channel. Ordinary stream renewal must retain the current player.

Acceptance: failing-before same-item stale/missing/mismatched report tests; exact current reports accepted; rejected reports do not notify/publish/acknowledge controls. Retained stale HTML callbacks cannot report new content. Native preparation/progress identity, matching rebind without restart, queued old report rejection, mismatched-source/variant/generation rebind rejection and legacy start validation are covered. Full applicable checks and real Browser/Electron playback smoke remain required. Native source smoke is distinct from packaged/projector acceptance. No tags/releases/manual deployments.
