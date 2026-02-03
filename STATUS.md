# Implementation Status Tracker

## Batch 1 — UI Redesign

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Two-bar header (top blue + bottom white) | DONE | |
| 2 | Tabs moved to hamburger menu | DONE | |
| 3 | Call + SMS contact buttons in detail | DONE | |
| 4 | Gate code less prominent (inline row) | DONE | |
| 5 | Scheduled time on two lines | DONE | |
| 6 | Stacked worker names (no "+1 more") | BUG | Falls back to "+N more" when API call fails or offline. Names not cached. |

## Batch 1 — Hotfixes

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 7 | Menu dropdown goes right (not off-screen left) | DONE | |
| 8 | Phone number on job card | DONE | |

## Batch 2 — Tabs, Stage Gate, Notes, Journal

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Job notes (todo + description) on cards | DONE | Truncated 80 chars, hidden if empty |
| 2 | `todo` field added to Odoo fetch fields | DONE | |
| 3 | Instructions shown in Info panel | DONE | Stripped of HTML |
| 4 | Description/Notes shown in Info panel | DONE | Stripped of HTML |
| 5 | Swipeable tabbed detail (Info/Work/Journal) | NEEDS TEST | CSS scroll-snap + flex height fix pushed. Needs phone verification. |
| 6 | Tab bar with active indicator | DONE | Click + scroll sync |
| 7 | Stage-filtered photos on Work tab | NEEDS TEST | Arrived→equipment_off+before, InProgress→after+problem_areas+other |
| 8 | Photo gate: block In Progress without before photos | DONE | _checkPhotoGate logic, _updateStageGate UI |
| 9 | Photo gate: block Completed without after photos | DONE | Same mechanism |
| 10 | Bypass checkbox + reason textarea | DONE | Posts [PHOTO BYPASS] journal entry |
| 11 | Auto-switch to Work tab after status change | DONE | Journal tab after Completed |
| 12 | Journal FAB (floating button) | DONE | Opens modal overlay |
| 13 | Journal tab shows all photos + journal entries | DONE | Uses Photos.renderPhotoSection for all categories |
| 14 | Materials on Work tab (In Progress / Completed) | DONE | Hidden for other stages |

## Known Bugs / Issues

| # | Issue | Severity | File:Line |
|---|-------|----------|-----------|
| 1 | Crew names fall back to "+N more" if API fails or offline — plan said show all stacked | MEDIUM | jobs.js:927,941 |
| 2 | Crew names not cached — every detail open re-fetches | LOW | jobs.js:921-943 |
| 3 | Swipeable tabs untested after flex height fix | HIGH | mobile.css:168-178 |
| 4 | Stage-filtered photos on Work tab untested | HIGH | jobs.js:336-347 |
| 5 | Journal module uses hardcoded element IDs — modal + tab both call renderSection, potential ID collision | MEDIUM | journal.js:13,23,28 |

## Still Needs Verification (on device)

- [ ] Swipe left/right between Info / Work / Journal tabs
- [ ] Tab buttons highlight correctly when swiping
- [ ] Arrived stage: equipment_off + before photos appear on Work tab
- [ ] In Progress stage: after + problem_areas + other photos appear on Work tab
- [ ] New/En Route: no photos on Work tab (just status button)
- [ ] Photo gate blocks "In Progress" until photos taken
- [ ] Bypass works: check box, type reason, advance stage
- [ ] Journal FAB opens modal from any tab
- [ ] Completing a job auto-switches to Journal tab
- [ ] Job cards show notes/instructions text
- [ ] Back button works from detail view
- [ ] Gate code edit still works in Info tab
