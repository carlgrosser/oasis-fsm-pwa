# Field Worker PWA — Implementation Plan

## Overview

Mobile-first PWA for field service workers to manage jobs, track time, capture photos, and sync with Odoo FSM.

---

## Batch 1 — UI Redesign (COMPLETE)

### 1.1 Two-Bar Header
- **Top bar**: Blue background, brand name, clock button, sync badge, pending badge
- **Bottom bar**: White background, hamburger menu, page title
- **Status**: DONE

### 1.2 Tabs in Hamburger Menu
- Today / This Week / History as menu items
- **Status**: DONE

### 1.3 Contact Number with Call + SMS Buttons
- Phone number displayed in job detail with Call and SMS buttons
- **Status**: CODE DONE — requires `job.phone` field to have data in Odoo

### 1.4 Gate Code Less Prominent
- Inline detail-row style instead of big orange block
- **Status**: DONE

### 1.5 Scheduled Time on Two Lines
- Line 1: "Monday, February 2"
- Line 2: "8:00 AM - 12:00 PM"
- **Status**: DONE

### 1.6 Stacked Worker Names
- All assigned workers shown vertically, no "+1 more" badge
- Names cached after first fetch for offline/re-render
- **Status**: DONE

---

## Batch 2 — Tabbed Detail, Stage Gate, Notes, Journal FAB

### 2.1 Job Notes on Cards
- Show `todo` (instructions) + `description` (notes) on job list cards
- Truncated to 80 characters, hidden if both empty
- **Status**: CODE DONE — requires `job.todo` or `job.description` to have data in Odoo

### 2.2 `todo` Field Added to Fetch
- Added 'todo' to FSM_ORDER_FIELDS in config.js
- **Status**: DONE

### 2.3 Swipeable Tabbed Detail View
Three horizontal panels with CSS scroll-snap:
- **Info**: Location, contact, schedule, crew, instructions, notes, gate code, actions
- **Work**: Status button, stage-filtered photos, materials
- **Journal**: All photos gallery, journal compose + entries

**Status**: CODE DONE — CSS may need fixes for proper swipe behavior

### 2.4 Tab Bar with Active Indicator
- Three buttons: Info / Work / Journal
- Click switches panel, swipe syncs active tab
- **Status**: DONE

### 2.5 Stage-Filtered Photos on Work Tab
| Current Stage | Photos Shown |
|---------------|--------------|
| New | None |
| En Route | None |
| Arrived | Equipment Off + Before |
| In Progress | After + Problem Areas + Other |
| Completed | None (job complete message) |

**Status**: CODE DONE — verify on device

### 2.6 Photo Gate for Status Advancement
- **Arrived → In Progress**: Requires equipment_off (1) + before (2) photos
- **In Progress → Completed**: Requires after (2) photos
- Button disabled until requirements met OR bypass used
- **Status**: DONE

### 2.7 Bypass Mechanism
- Checkbox: "Bypass photo requirement"
- Textarea: "Explain why photos could not be taken..."
- Posts `[PHOTO BYPASS] <reason>` as journal entry before advancing
- **Status**: DONE

### 2.8 Auto Tab Switch After Status Change
- After any status change → switch to Work tab
- After Completed → switch to Journal tab
- **Status**: DONE

### 2.9 Journal FAB (Floating Action Button)
- Fixed button at bottom-right during detail view
- Opens journal as modal overlay from any tab
- **Status**: DONE

### 2.10 Materials on Work Tab
- Shown when stage is "In Progress" or "Completed"
- Hidden for other stages
- **Status**: CODE DONE — Materials.renderSection must be configured in Odoo

---

## Known Issues / Bugs

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 1 | Tabs may not swipe | NEEDS FIX | Flex height chain may still be broken |
| 2 | Phone not showing | DATA | `job.phone` may be empty in Odoo |
| 3 | Notes not showing | DATA | `job.todo` / `job.description` may be empty in Odoo |
| 4 | Stage photos not rendering | NEEDS TEST | Code is there, untested on device |

---

## Verification Checklist

### Job List View
- [ ] Phone number shows on cards (if data exists)
- [ ] Notes preview shows on cards (if data exists)
- [ ] Gate code hint (🔑) shows if gate code exists
- [ ] Crew badge shows if multi-worker job

### Job Detail — Info Tab
- [ ] Location name + map link
- [ ] Phone with Call + SMS buttons (if data exists)
- [ ] Gate code row (editable)
- [ ] Schedule on two lines
- [ ] Assigned workers stacked (all names, no "+N more")
- [ ] Instructions row (if `todo` has data)
- [ ] Notes row (if `description` has data)
- [ ] Navigate button
- [ ] Sales Order PDF link (if linked)

### Job Detail — Work Tab
- [ ] Status button shows next stage
- [ ] **New/En Route**: No photos section
- [ ] **Arrived**: Equipment Off + Before photos
- [ ] **In Progress**: After + Problem Areas + Other photos
- [ ] Photo gate blocks advancement until requirements met
- [ ] Bypass checkbox enables button when reason entered
- [ ] Materials section visible for In Progress / Completed

### Job Detail — Journal Tab
- [ ] All photos gallery (all categories)
- [ ] Journal compose textarea + Post button
- [ ] Journal entries list

### Swipe / Tab Behavior
- [ ] Can swipe left/right between tabs
- [ ] Tab bar highlights correct tab when swiping
- [ ] Clicking tab button scrolls to correct panel
- [ ] Status change auto-switches to Work tab
- [ ] Completion auto-switches to Journal tab

### Journal FAB
- [ ] Floating button visible on all tabs
- [ ] Opens journal modal on tap
- [ ] Modal journal works (compose + post)
- [ ] FAB removed when leaving detail view

---

## Files Modified

### Batch 1
- `app.html` — Two-bar header structure
- `css/mobile.css` — Header styles, removed tab bar
- `css/components.css` — Menu styles, contact buttons, crew stack
- `js/app.js` — Menu-based view switching, page title updates
- `js/jobs.js` — Contact buttons, gate code row, schedule formatting, crew display

### Batch 2
- `js/config.js` — Added 'todo' to FSM_ORDER_FIELDS
- `js/photos.js` — Added getPhotoCountsByCategory(), renderFilteredPhotoSection()
- `js/journal.js` — Refactored to use container-scoped queries (no ID collisions)
- `js/jobs.js` — Major refactor: tabbed detail, stage gate, bypass, journal FAB, card notes
- `js/app.js` — Detail-active class toggle, FAB cleanup
- `css/components.css` — Tabs, panels, gate UI, FAB, modal styles
- `css/mobile.css` — Detail view flex layout for swipeable panels

---

## Next Steps

1. **Fix CSS for swipeable tabs** — Ensure flex height chain is complete
2. **Verify on device** — Test all swipe, photo, gate, bypass functionality
3. **Check Odoo data** — Ensure phone, todo, description fields are populated
4. **Materials config** — Verify Materials module is configured in Odoo
