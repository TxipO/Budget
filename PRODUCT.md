# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Multiple households, each with 2 (sometimes more) members sharing one budget. Founding household is Паша & Женя. Each household self-registers via an onboarding wizard and gets an isolated tenant; a household PIN gates entry, and an app-wide PIN lock sits in front of that.

## Product Purpose

A shared household budget tracker: every transaction (manual or bank-synced) lands in one place both partners can see and reason about together, so "who spent what" and "where did the money go" never requires reconciling separate records.

## Positioning

Two mechanisms a generic single-user budgeting app or a bank's own statistics screen can't truthfully copy:
- **Multi-bank auto-sync into one shared ledger** — live pull integrations with Monobank and SpareBank 1 (via Enable Banking) land transactions automatically, including automatic detection of transfers between the household's own connected accounts, so no manual CSV import and no double-counted internal transfers.
- **A budget built for two, not one** — transactions, categories, and planning are shared household state by default, with an explicit manual toggle for expenses that shouldn't count toward the shared balance (e.g. pre-accounted-elsewhere spending), rather than every user maintaining their own private ledger.

## Operating Context

- Bank sync runs on schedules outside user action (GitHub Actions cron for SpareBank/Enable Banking, since Vercel Cron's Hobby-tier limit doesn't fit a 1x/day-per-household job); Monobank sync is pull-based.
- A Telegram bot (voice + text) is a first-class entry point for logging transactions outside the web app.
- Households operate independently (mts-tenant isolation); a security/IDOR posture treats cross-household data leakage as the primary threat model, not just auth bypass.

## Capabilities and Constraints

- Interface language is Ukrainian; do not translate UI copy to English.
- Currency is currently hardcoded to NOK everywhere. Moving to a per-household currency is a known, prioritized gap (relevant for EU/Poland-based households) — future work should not deepen the NOK hardcoding, but changing it is out of scope unless explicitly requested.
- Two PIN layers exist and are distinct: an app-wide PIN lock (all households) and a per-household PIN login (e.g. founding household's own PIN). Do not collapse these into one concept.
- Bank-synced transactions (Monobank, SpareBank) are never silently deleted by automated flows — deletion of a synced transaction requires asking the user each time, even if a similar case was already resolved earlier in the same session.
- Category-matching rules for bank transactions should stay generalized to the underlying pattern, not hardcoded to one specific sender/merchant.

## Brand Commitments

Product name/title: "Бюджет" (app title and PWA name), tagline "Сімейний трекер бюджету". No further binding brand identity confirmed yet.

## Evidence on Hand

- App icons at `public/icon-192.png` / `public/icon-512.png` and `public/manifest.json` (PWA).
- Live integrations in production: Monobank (since 2026-07-08), SpareBank 1 / Enable Banking (since 2026-07-25), Telegram voice/text logging (since 2026-07-08).
- No testimonials, case studies, or external press exist — do not fabricate any.

## Product Principles

1. Shared-by-default: household data (transactions, categories, plans) is joint state, not per-user, with an explicit opt-out for the rare pre-accounted expense.
2. Sync over manual entry: prefer automatic bank sync and voice logging paths over asking users to type/import data by hand.
3. Never silently destroy synced financial history — deletions and irreversible actions on bank-sourced data stay human-confirmed.
4. Tenant isolation is a security property, not just a UX nicety — every feature must assume other households' data is hostile-adjacent and must not leak.
5. Ukrainian-first interface; localization changes are a product decision, not a default.

## Accessibility & Inclusion

No product-specific accessibility standard has been established yet.
