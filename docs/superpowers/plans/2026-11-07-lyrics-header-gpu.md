# Lyrics Header and Acceleration Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move lyrics mode to the capture Header, default OCR to the upper 40%, and measure GPU acceleration with CPU recovery.

**Architecture:** Reuse the existing lyrics store and capture/projection ownership. Keep the pinned local OCR models and worker, prefer supported GPU execution, and retain WASM recovery without changing recognition acceptance rules.

**Tech Stack:** React 19, HeroUI v3, Zustand, PaddleOCR JS 0.4.2, ONNX Runtime Web 1.24.3.

**Spec:** User-approved analysis and implementation request in this chat (2026-11-07).

## Constraints and Review Focus

- Header: switch left, existing source selectors centered, projection action right. Narrow windows must not overlap controls.
- Off restores raw framing controls and preserves transform/lock; on shows lyrics controls. Toggling mode never claims another projection owner.
- Upper 40% is a default, not a maximum; retain editable crop and validate bounds.
- GPU unavailable, initialization failure, inference failure and cancellation must leave a working CPU path or report an honest error, never a stale result.
- Retain all source rows, confidence threshold, two-observation acceptance, and stale-result fencing. No cloud OCR or new model. Release scope was subsequently authorized as version 2.8.2.

## Tasks

- [x] Header/page: add behavior tests for mode visibility, capture readiness, explicit projection takeover and stop; move controls using existing store/actions; update affected E2E selectors.
- [x] Crop: test upper-40% default and larger editable crops; update store; keep three-row fixture coverage.
- [x] OCR: inspect pinned SDK provider behavior; test GPU/CPU recovery and abort lifecycle; implement the smallest supported acceleration path; benchmark the same fixture corpus on available browser and Electron runtimes.
- [x] Local verification: lint, types, complete unit suite, desktop/web builds, browser camera/lyrics E2E and sandboxed Electron OCR. Record before/after latency and hardware limits. Review diff before completion.
- [x] Implementation-head PR CI at `86dfbaa6` passes all workflows.
- [ ] Version 2.8.2 PR checks and draft release packaging.
- [ ] Windows target-machine acceptance: Ray will perform manually; further automated device benchmarks cancelled.

## Execution record

Implementation and initial validation are recorded in `docs/reports/2026-11-07-lyrics-header-gpu.md`. The user explicitly authorized a separate Windows test chat. PR CI and Windows hardware acceptance remain distinct from local validation.

Ray directly authorized integration and version 2.8.2 on 2026-11-07, accepting cold-start latency. Engineering issue #203 records the release run and private Feature/Project links.
