/**
 * SanitizedPopup.ts
 *
 * Renders MTA elevator alert details and curb-cut status as a safe DOM
 * fragment — no `innerHTML` or `dangerouslySetInnerHTML` is used.  All
 * user-facing text that originates from an external API is run through
 * DOMPurify before being set on a text node or attribute.
 *
 * Usage:
 *   const popup = new SanitizedPopup(containerEl);
 *   popup.renderElevatorAlert(alertData);
 *   // or
 *   popup.renderCurbCut(curbData);
 *   popup.clear();
 */

import DOMPurify from 'dompurify';
import type { ElevatorStatus, ElevatorState, CurbCut, CurbCutStatus } from './db.js';

/**
 * Sanitize a string sourced from an external API.
 * Tags and attributes are stripped; the result is safe to assign to
 * `element.textContent`.
 */
function sanitize(raw: string): string {
  // Strip all HTML tags — we only need the plain text value.
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [] as string[],
    ALLOWED_ATTR: [] as string[],
    RETURN_DOM:   false,
  }) as string;
}

/* ── Status label maps ───────────────────────────────────────── */

const ELEVATOR_STATE_LABELS: Record<ElevatorState, string> = {
  operational:    'Operational',
  out_of_service: 'Out of Service',
  planned_work:   'Planned Work',
  unknown:        'Status Unknown',
};

const ELEVATOR_STATE_CLASS: Record<ElevatorState, string> = {
  operational:    'ok',
  out_of_service: 'danger',
  planned_work:   'warn',
  unknown:        'warn',
};

const CURB_STATUS_LABELS: Record<CurbCutStatus, string> = {
  compliant:    'Compliant',
  high_incline: 'High Incline',
  damaged:      'Damaged / Missing',
};

const CURB_STATUS_CLASS: Record<CurbCutStatus, string> = {
  compliant:    'ok',
  high_incline: 'warn',
  damaged:      'danger',
};

/* ── Helper: create a typed DOM element ──────────────────────── */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

/* ── SanitizedPopup class ────────────────────────────────────── */

export class SanitizedPopup {
  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /** Remove all child nodes from the popup container. */
  clear(): void {
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }
  }

  /* ── Elevator alert ──────────────────────────────────────── */

  /**
   * Render an MTA elevator alert.  All text from the API response is
   * sanitized before being inserted into the DOM.
   *
   * @param status – ElevatorStatus record (from IndexedDB or live API)
   */
  renderElevatorAlert(status: ElevatorStatus): void {
    this.clear();

    const wrapper = el('div', 'access-popup');

    // Station name
    const stationHeading = el('h3', 'access-popup__station');
    stationHeading.textContent = sanitize(status.stationName);
    wrapper.appendChild(stationHeading);

    // Status badge
    const stateClass  = ELEVATOR_STATE_CLASS[status.lastKnownState] ?? 'warn';
    const statusBadge = el('span', `access-popup__status access-popup__status--${stateClass}`);
    statusBadge.textContent = ELEVATOR_STATE_LABELS[status.lastKnownState] ?? 'Unknown';
    wrapper.appendChild(statusBadge);

    // Alert reason text (this is the field most likely to contain HTML injection)
    if (status.reason.trim() !== '') {
      const reasonPara = el('p', 'access-popup__alert-text');
      reasonPara.textContent = sanitize(status.reason);
      wrapper.appendChild(reasonPara);
    }

    // Timestamp
    if (status.timestamp) {
      const ts = el('p', 'access-popup__timestamp');
      ts.textContent = `Last updated: ${formatTimestamp(status.timestamp)}`;
      wrapper.appendChild(ts);
    }

    // Save for offline button (only shown when online)
    if (navigator.onLine) {
      const saveBtn = el('button', 'btn btn--primary');
      saveBtn.type = 'button';
      saveBtn.textContent = 'Save for Offline';
      // The equipmentId is safe internal data — no sanitization needed
      saveBtn.dataset['equipmentId'] = status.equipmentId;
      saveBtn.addEventListener('click', () => {
        saveBtn.dispatchEvent(
          new CustomEvent('accessnyc:saveElevator', {
            bubbles:  true,
            composed: true,
            detail:   { status },
          }),
        );
      });
      wrapper.appendChild(saveBtn);
    }

    this.container.appendChild(wrapper);
  }

  /* ── Curb-cut detail ─────────────────────────────────────── */

  /**
   * Render a curb-cut feature popup.
   *
   * Color-coded status:
   *   • Green  → compliant
   *   • Yellow → high_incline
   *   • Red    → damaged
   *
   * @param cut – CurbCut record from IndexedDB
   */
  renderCurbCut(cut: CurbCut): void {
    this.clear();

    const wrapper = el('div', 'access-popup');

    // Label
    const heading = el('h3', 'access-popup__station');
    heading.textContent = 'Curb Cut';
    wrapper.appendChild(heading);

    // Status badge
    const stateClass  = CURB_STATUS_CLASS[cut.status] ?? 'warn';
    const statusBadge = el('span', `access-popup__status access-popup__status--${stateClass}`);
    statusBadge.textContent = CURB_STATUS_LABELS[cut.status] ?? 'Unknown';
    wrapper.appendChild(statusBadge);

    // Location
    if (cut.location.trim() !== '') {
      const locPara = el('p', 'access-popup__alert-text');
      locPara.textContent = sanitize(cut.location);
      wrapper.appendChild(locPara);
    }

    // Coordinates (internal numeric data — no sanitization needed)
    const coordPara = el('p', 'access-popup__timestamp');
    coordPara.textContent = `${cut.lat.toFixed(5)}, ${cut.lon.toFixed(5)}`;
    wrapper.appendChild(coordPara);

    this.container.appendChild(wrapper);
  }

  renderInfoCard(title: string, details: string, timestamp?: string): void {
    this.clear();
    const wrapper = el('div', 'access-popup');
    const heading = el('h3', 'access-popup__station');
    heading.textContent = sanitize(title);
    wrapper.appendChild(heading);

    const statusBadge = el('span', 'access-popup__status access-popup__status--warn');
    statusBadge.textContent = 'Info';
    wrapper.appendChild(statusBadge);

    const detailsPara = el('p', 'access-popup__alert-text');
    detailsPara.textContent = sanitize(details);
    wrapper.appendChild(detailsPara);

    if (timestamp) {
      const ts = el('p', 'access-popup__timestamp');
      ts.textContent = `Reported: ${formatTimestamp(timestamp)}`;
      wrapper.appendChild(ts);
    }

    this.container.appendChild(wrapper);
  }
}

/* ── Helpers ─────────────────────────────────────────────────── */

function formatTimestamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
