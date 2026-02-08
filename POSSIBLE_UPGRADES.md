# Field Worker PWA - Possible Upgrades

This document tracks potential upgrades identified from:
- features already present in `office-app`
- common field-service worker app capabilities

## Priority 1 - High Impact

1. Worker calendar view with time-off overlays
- Add a day/week calendar tab for workers.
- Show assigned jobs and approved/pending time-off in one timeline.
- Reuse `fieldservice_dispatch` time-off APIs and event mapping approach used by the office dispatch board.

2. Assignment and schedule-change alerts
- In-app notifications when dispatch reassigns a job, changes start/end time, or updates stage expectations.
- Optional badge/count in the hamburger menu.

3. "My Week" summary panel
- Hours worked, jobs completed, upcoming jobs, and overdue jobs.
- Mirror office worker detail metrics with worker-specific scope.

## Priority 2 - Operational Efficiency

4. Enhanced location context in job detail
- Add recent service history at this location.
- Show prior notes, recurring issues, and last gate/access updates.
- Reduce back-and-forth calls to office.

5. Offline queue for time-off requests
- Current time-off request submission is online-only.
- Add queued request creation when offline, with automatic sync when connection returns.

6. Richer communication center
- Add a dedicated "Messages" / "Office Notes" history screen.
- Keep sent notes and office responses visible in one thread.

## Priority 3 - Advanced / Future

7. Smart route hints for the worker's day
- Suggested job order and estimated travel impact when sequence changes.
- "Next best stop" prompt based on current location and schedule windows.

8. Job prep checklist templates by service type
- Pre-arrival checklist and completion checklist by order category.
- Helps standardize work quality and documentation.

9. Customer sign-off capture on completion
- Signature/photo confirmation tied to completion transition.
- Optional enforcement by service type or customer contract.

## Suggested Delivery Order

1. Calendar + time-off overlay
2. Schedule-change alerts
3. My Week summary
4. Offline time-off queue
5. Enhanced location context
