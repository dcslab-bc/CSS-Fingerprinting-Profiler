# CSS Fingerprinting Profiler

This repository contains a measurement toolkit for detecting and analyzing **CSS-based fingerprinting behaviors** on real websites. The system identifies how conditional CSS rules can expose user, device, or browser characteristics through externally observable effects, without relying on JavaScript execution.

The toolkit combines a browser extension with an automated crawl and preprocessing pipeline to support both real-world measurements and controlled experiments.

---

## Overview

Modern browser fingerprinting defenses primarily target JavaScript-based techniques. This toolkit focuses on a less explored vector: **declarative fingerprinting via CSS**. It detects cases where CSS rules conditionally trigger network requests based on rendering environment features, enabling inference of user or system properties.

The analysis is based on a **source–sink model**:
- **Sources** are CSS conditions whose evaluation depends on environment attributes (e.g., media queries, feature support, local fonts).
- **Sinks** are externally observable effects, such as resource loads via `url()` or `@import`.
- A fingerprinting signal is confirmed when a conditional source governs a sink and the condition value is echoed in the request.

---

## Components

### 1. Browser Extension (Manifest V3)

The browser extension performs in-page analysis during normal browsing.

- **Content Script**
  - Traverses all accessible stylesheets, including nested rules inside `@media`, `@supports`, `@container`, and `@font-face`
  - Extracts environment-dependent CSS features and network-triggering declarations
  - Links sources and sinks using token echo matching
  - Assigns per-feature risk scores and produces a structured JSON report

- **Background Service Worker**
  - Automatically injects the content script after page load
  - Receives analysis results and exports them as timestamped JSON files
  - Uses stable, domain-based filenames for reproducibility

- **Manifest**
  - Declares permissions for scripting, tab access, downloads, and cross-origin stylesheet inspection

---

### 2. Domain Reachability Filter

A Node.js utility filters large domain lists before crawling.

- Performs concurrent HTTP(S) reachability checks
- Falls back from HTTPS to HTTP when necessary
- Outputs a cleaned list of accessible domains

---

### 3. Automated CSS Crawl

A Playwright-based crawler collects CSS artifacts at scale.

- Visits each target domain using a headless browser
- Blocks heavy assets to reduce crawl overhead
- Saves:
  - External CSS files
  - Inline `<style>` blocks
  - Styles from an optional second same-origin page
- Skips infrastructure-only and CDN domains

All collected CSS files are normalized and hashed for deduplication and offline analysis.

---

## Outputs

- **Per-page JSON reports**
  - Detected CSS sources and sinks
  - Verified source–sink associations
  - Inferred feature claims
  - Aggregate risk scores and verdicts

- **Crawled CSS datasets**
  - Raw stylesheet artifacts used for large-scale analysis or controlled testing

All outputs are machine-readable and designed to support independent verification and follow-up research.

---

## Intended Use

This toolkit is intended for research and measurement purposes, including:
- Studying CSS-based fingerprinting in real-world websites
- Evaluating the prevalence and diversity of CSS tracking behaviors
- Supporting reproducible analysis of scriptless tracking vectors

It highlights an underexplored privacy risk surface in modern web platforms.
