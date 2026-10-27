import { useEffect, useRef } from 'react';

/**
 * What this application is, and who made it.
 *
 * Kept out of the settings menu itself and rendered by the shell, for the same reason the
 * discard dialog is: the sidebar is mounted twice on a narrow viewport — once in the
 * layout and once inside the overlay — so a dialog owned by the menu could be open in both
 * at once.
 *
 * It is a modal rather than a panel because it is the one screen with nothing to interact
 * with: a reader either reads it or dismisses it, and leaving the workspace live underneath
 * would offer controls that have nothing to do with the question being answered. Escape and
 * a backdrop click both close it, and the close button takes focus on open, so it is
 * dismissible without a pointer.
 */
export function AboutDialog({ onClose = () => {} }) {
  const closeRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div
      className="about"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      // Only a click on the backdrop itself closes it. Without the identity check, a drag
      // that began inside the panel and ended on the backdrop would dismiss the dialog.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="about__panel">
        <header className="about__head">
          <span className="about__mark" aria-hidden="true" />
          <div>
            <h2 className="about__title" id="about-title">
              AI Infrastructure Planner
            </h2>
            <p className="about__subtitle">AI network infrastructure simulator</p>
          </div>
        </header>

        <p className="about__text">
          Plan a data-centre campus and check it before it is built. The Site &amp; Facility editor
          authors the campus as a facility graph on a basemap canvas — sites, buildings, halls,
          power, cooling, and network — project assets bring in the drawings and datasets a design
          already has, and validation, capacity, and governance checks run against the same
          revision. Every change is versioned, so a plan can be reviewed at any point in its
          history.
        </p>

        <h3 className="about__heading">Created by</h3>
        <p className="about__creator">Professor Weiqiang Sun</p>
        <ul className="about__links">
          <li>
            <a href="https://weiqiangsun.me/" target="_blank" rel="noreferrer noopener">
              weiqiangsun.me
            </a>
          </li>
          <li>
            <a href="https://health.sjtu.edu.cn/weiqiangsun/" target="_blank" rel="noreferrer noopener">
              health.sjtu.edu.cn/weiqiangsun
            </a>
          </li>
        </ul>

        <div className="about__actions">
          <button type="button" className="about__close" ref={closeRef} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
