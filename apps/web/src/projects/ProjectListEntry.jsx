import { useMemo, useState } from 'react';
import { Can } from '../permissions/usePermission.jsx';
import { Icon } from '../shell/icons.jsx';

/**
 * Project list entry: the default destination after sign-in.
 *
 * The list is centered in a readable constrained area and never opens a tool tab
 * (ui-pattern.md, "Project List Entry"). Each row carries the state a user needs
 * before committing to a project: site, lifecycle state, validation summary,
 * last update, and access state — all as text, so nothing depends on color.
 *
 * A field the project list does not yet carry renders as an explicit `—` rather
 * than a plausible-looking default, so an unset value is never mistaken for a
 * real one; the whole row is one target, because the row is the affordance.
 */
export function ProjectListEntry({
  projects = [],
  onOpen = () => {},
  onCreate = () => {},
  pending = false,
  error = null,
  notice = null,
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');

  /**
   * The states the list actually carries, plus `ALL`.
   *
   * The project read does not return a lifecycle state — that lives on a revision — so
   * mapping it blindly would put a state-less `<option>` with an `undefined` key in the
   * select and warn on every render. A state the list does not carry is simply not
   * offered, exactly as it renders as `—` rather than a guess.
   */
  const statuses = useMemo(
    () => ['ALL', ...new Set(projects.map((project) => project.lifecycleState).filter(Boolean))],
    [projects],
  );
  // A filter with nothing to choose between is not a filter.
  const filterable = statuses.length > 1;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return projects.filter((project) => {
      const matchesStatus = status === 'ALL' || project.lifecycleState === status;
      const matchesQuery =
        needle === '' ||
        project.name.toLowerCase().includes(needle) ||
        (project.site ?? '').toLowerCase().includes(needle);
      return matchesStatus && matchesQuery;
    });
  }, [projects, query, status]);

  const noneAtAll = projects.length === 0 && !pending;

  return (
    <div className="projects">
      <div className="projects__head">
        <h1 className="projects__title">Projects</h1>
        <Can permission="project.write" fallback={null}>
          <button type="button" className="projects__new" onClick={onCreate}>
            <Icon name="plus" size={15} />
            New project
          </button>
        </Can>
      </div>

      {notice ? (
        <p className="projects__notice" role="status">
          {notice}
        </p>
      ) : null}

      {pending ? (
        <p className="projects__pending" role="status">
          Loading projects…
        </p>
      ) : null}

      {error ? (
        <p className="projects__error" role="alert">
          {error.message}
          {error.correlationId ? <span className="projects__correlation"> correlation {error.correlationId}</span> : null}
        </p>
      ) : null}

      {/* Filters are pointless over an empty list, so they appear only when there
          is something to filter. */}
      {noneAtAll ? null : (
        <div className="projects__filters">
          <label className="projects__search">
            <span className="visually-hidden">Search projects</span>
            <Icon name="search" size={15} />
            <input
              type="search"
              placeholder="Search projects…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {/* A status filter over a list that carries no status offers nothing to
              choose, so it is not drawn at all. */}
          {filterable ? (
            <label className="projects__status">
              <span className="projects__status-label">Filter</span>
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                {statuses.map((value) => (
                  <option key={value} value={value}>
                    {value === 'ALL' ? 'All status' : value}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      )}

      {noneAtAll ? (
        <div className="surface-empty" aria-live="polite">
          <span className="surface-empty__icon">
            <Icon name="map" size={22} />
          </span>
          <h2 className="surface-empty__title">No projects yet</h2>
          <p className="surface-empty__text">
            A project holds the scenarios and revisions a facility design lives in. Create one to open its
            workspace.
          </p>
          <div className="surface-empty__actions">
            <Can permission="project.write" fallback={null}>
              <button type="button" className="projects__new" onClick={onCreate}>
                <Icon name="plus" size={15} />
                New project
              </button>
            </Can>
          </div>
        </div>
      ) : null}

      {!noneAtAll && visible.length === 0 ? (
        <p className="projects__empty">No projects match the current search and filter.</p>
      ) : null}

      {visible.length > 0 ? (
        <ul className="projects__list">
          {/* Column labels share the row's grid, so they cannot drift out of
              alignment; the classes match the cells that the narrow-viewport rule
              hides, so labels and data disappear together. */}
          <li className="projects__columns" aria-hidden="true">
            <span>Project</span>
            <span className="project-row__site">Site</span>
            <span>State</span>
            <span>Validation</span>
            <span className="project-row__updated">Updated</span>
            <span className="project-row__access">Access</span>
          </li>
          {visible.map((project) => (
            <li key={project.projectId}>
              <button type="button" className="project-row" onClick={() => onOpen(project)}>
                <span className="project-row__name">{project.name}</span>
                <span className="project-row__site" title="Site or region">
                  {project.site ?? '—'}
                </span>
                {/* The row does not invent a state the read did not return: `DRAFT`
                    would be a plausible-looking default for a project whose lifecycle
                    is simply unknown here. */}
                <span
                  className="project-row__state"
                  aria-label={project.lifecycleState ? `Lifecycle: ${project.lifecycleState}` : 'Lifecycle: not recorded'}
                >
                  {project.lifecycleState ?? '—'}
                </span>
                <span className="project-row__validation">
                  {project.validationSummary
                    ? `${project.validationSummary.errors} errors · ${project.validationSummary.warnings} warnings`
                    : 'Not validated'}
                </span>
                <span className="project-row__updated" title="Last updated">
                  {project.updatedLabel ?? '—'}
                </span>
                <span className="project-row__access">{project.accessState ?? 'Member'}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
