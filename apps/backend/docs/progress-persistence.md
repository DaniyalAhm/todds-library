# Per-user progress persistence

Each `reading_progress` row is uniquely keyed by authenticated user and book.
The progress API validates `expected_user_id` against the authenticated user;
it never uses a request body to choose the user whose row is updated.

Clients include `captured_at`, a monotonically increasing Unix millisecond
capture time. An atomic upsert accepts only a newer capture time. Replayed or
duplicate snapshots cannot move a saved position backward; a deliberate seek
backward has a newer capture time and is accepted. Unstamped legacy saves can
update legacy rows, but cannot overwrite a timestamped row. Capture times more
than five minutes ahead of the server are rejected. Cross-device ordering relies
on the devices' wall clocks being reasonably synchronized.

`position_updated_at` records database acceptance of the position. `completed_at`
records the first completion; `review_updated_at` records the latest review save.
`last_updated` records any accepted row change. PostgreSQL generates these times
with `clock_timestamp()` and API responses normalize them to UTC. Completion and
review writes do not change the saved position or its timestamp.

The browser journals snapshots in IndexedDB by user and book before ordinary
network saves. It also sends keepalive saves on pause, page exit, hiding, and
reader unmount. The foreground retries the journal every five seconds and after
reconnection; Background Sync retries where available. Replay sends only the
signed-in user's entries and deletes an entry only after server acknowledgement,
retaining any newer queued snapshot. Legacy entries without an account identity
are discarded during the queue upgrade because their owner cannot be verified.

Offline saves reach the database after connectivity returns. A browser crash
before its local transaction or keepalive request completes cannot guarantee
that the very last position was persisted.
