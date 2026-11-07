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
- Retain all source rows, confidence threshold, two-observation acceptance, and stale-result fencing. No cloud OCR, new model, release or production changes.

## Tasks

- [ ] Header/page: add behavior tests for mode visibility, capture readiness, explicit projection takeover and stop; move controls using existing store/actions; update affected E2E selectors.
- [ ] Crop: test upper-40% default and larger editable crops; update store; keep three-row fixture coverage.
- [ ] OCR: inspect pinned SDK provider behavior; test GPU/CPU recovery and abort lifecycle; implement the smallest supported acceleration path; benchmark the same fixture corpus on available browser and Electron runtimes.
- [ ] Verification: lint, types, complete unit suite, desktop/web builds, browser camera/lyrics E2E and sandboxed Electron OCR. Record before/after latency and hardware limits. Review diff before completion.
